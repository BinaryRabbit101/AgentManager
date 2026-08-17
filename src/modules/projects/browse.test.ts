/**
 * `GET /api/fs/browse`'s containment rules (projects DESIGN §2.1; remote §3.3, R7).
 *
 * This route is deliberately allowed over the tailnet, so **containment is the
 * whole of its access control** and every clause is a security control rather
 * than a nicety. Each of §2.1's five is asserted here:
 *
 * 1. resolve first, compare second — against the *real* path;
 * 2. a path resolving outside every root is 403 and lists nothing;
 * 3. an entry whose resolved target escapes is **omitted**, not shown and refused;
 * 4. UNC and network paths are refused outright;
 * 5. directory names only — never a file name, let alone a file's contents.
 *
 * The junction case is driven through the `realPath` seam rather than by
 * creating a real NTFS junction, because `mklink /J` needs a shell and the point
 * under test is that the check runs on the resolved value at all.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  browse,
  isInsideRoots,
  NetworkPathError,
  PathOutsideBrowseRootsError,
  resolveBrowseRoots,
  type BrowseDeps,
} from './browse.js';
import { InvalidPathError } from './errors.js';
import { makeTempDir, type TempDir } from './__tests__/helpers.js';

let home: TempDir;
let code: TempDir;
let outside: TempDir;

beforeEach(() => {
  home = makeTempDir('agentmanager-browse-home-');
  code = makeTempDir('agentmanager-browse-code-');
  outside = makeTempDir('agentmanager-browse-out-');
});

afterEach(() => {
  home.cleanup();
  code.cleanup();
  outside.cleanup();
});

function deps(overrides: Partial<BrowseDeps> = {}): BrowseDeps {
  return {
    browseRoots: [home.path, code.path],
    projectsRoot: null,
    homeDirectory: home.path,
    ...overrides,
  };
}

/** The canonical form of a temp path, which is what the listing reports. */
function canonical(path: string): string {
  const listing = browse(deps({ browseRoots: [path] }), path);
  return listing.path;
}

describe('the roots (§2.1)', () => {
  it('lists the roots themselves when no path is given', () => {
    const listing = browse(deps(), null);
    expect(listing.path).toBe('');
    expect(listing.parent).toBeNull();
    expect(listing.roots).toHaveLength(2);
    // A navigator with no knowledge of the machine has somewhere to start.
    expect(listing.entries.map((entry) => entry.path)).toEqual([...listing.roots]);
  });

  it('treats an empty or blank path the same as none', () => {
    for (const requested of ['', '   ']) {
      expect(browse(deps(), requested).path, JSON.stringify(requested)).toBe('');
    }
  });

  it('defaults to %USERPROFILE% and projects.root when browseRoots is null', () => {
    // foundation §2.4's documented default, resolved in one place.
    const roots = resolveBrowseRoots(
      deps({ browseRoots: null, projectsRoot: code.path, homeDirectory: home.path }),
    );
    expect(roots).toEqual([canonical(home.path), canonical(code.path)]);
  });

  it('drops a configured root that does not exist rather than refusing to boot', () => {
    // A laptop with no D:\Code should still be able to browse %USERPROFILE%.
    const roots = resolveBrowseRoots(
      deps({ browseRoots: [home.path, resolve(home.path, 'nope', 'gone')] }),
    );
    expect(roots).toEqual([canonical(home.path)]);
  });

  it('deduplicates roots that are the same directory in different clothes', () => {
    const roots = resolveBrowseRoots(
      deps({ browseRoots: [home.path, home.path.toUpperCase(), join(home.path, '.')] }),
    );
    expect(roots).toHaveLength(1);
  });

  it('never accepts a UNC path as a root', () => {
    expect(resolveBrowseRoots(deps({ browseRoots: ['\\\\server\\share'] }))).toEqual([]);
  });
});

describe('listing a directory (§2.1)', () => {
  it('returns directory names only — never a file name', () => {
    mkdirSync(join(code.path, 'my-app'));
    mkdirSync(join(code.path, 'other'));
    writeFileSync(join(code.path, 'secrets.env'), 'TOKEN=hunter2', 'utf8');
    writeFileSync(join(code.path, 'README.md'), '# x', 'utf8');

    const listing = browse(deps(), code.path);
    expect(listing.entries.map((entry) => entry.name)).toEqual(['my-app', 'other']);
    // "listing files would widen the exposure for nothing" — and the contents
    // are never in the shape at all.
    expect(JSON.stringify(listing)).not.toContain('hunter2');
    expect(JSON.stringify(listing)).not.toContain('secrets.env');
  });

  it('reports the resolved path, so the client posts what the server looked at', () => {
    mkdirSync(join(code.path, 'my-app'));
    const listing = browse(deps(), join(code.path, '.', 'my-app', '..', 'my-app'));
    expect(listing.path).toBe(join(canonical(code.path), 'my-app'));
  });

  it('sorts entries by name', () => {
    for (const name of ['zeta', 'alpha', 'Mid']) mkdirSync(join(code.path, name));
    expect(browse(deps(), code.path).entries.map((entry) => entry.name)).toEqual([
      'alpha',
      'Mid',
      'zeta',
    ]);
  });

  it('reports no parent at a root, and the parent below one', () => {
    mkdirSync(join(code.path, 'my-app'));
    expect(browse(deps(), code.path).parent).toBeNull();
    expect(browse(deps(), join(code.path, 'my-app')).parent).toBe(canonical(code.path));
  });

  it('names a path that is not there rather than answering an empty listing', () => {
    expect(() => browse(deps(), join(code.path, 'ghost'))).toThrow(InvalidPathError);
  });
});

describe('containment is checked against the real path (§2.1)', () => {
  it('refuses a path outside every root with 403, and lists nothing', () => {
    let thrown: unknown;
    try {
      browse(deps(), outside.path);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PathOutsideBrowseRootsError);
    const failure = thrown as PathOutsideBrowseRootsError;
    expect(failure.status).toBe(403);
    expect(failure.code).toBe('browse_root_violation');
    // The message names the path and says how to widen the roots.
    expect(failure.message).toContain(canonical(outside.path));
    expect(failure.message).toContain('projects.browseRoots');
  });

  it('refuses `..` traversal that lands outside a root', () => {
    // `resolve` collapses it before the comparison, so this is the same check.
    expect(() => browse(deps(), join(code.path, '..', '..'))).toThrow(PathOutsideBrowseRootsError);
  });

  it('omits an entry whose resolved target escapes, rather than showing a door that does not open', () => {
    mkdirSync(join(code.path, 'real'));
    mkdirSync(join(code.path, 'junction'));
    const listing = browse(
      deps({
        // The junction case: the *path* starts with the root, the *target* does
        // not. A lexical check would let this through, which is the whole
        // reason §2.1 insists on realpath first.
        realPath: (path) => (path.endsWith('junction') ? outside.path : path),
      }),
      code.path,
    );
    expect(listing.entries.map((entry) => entry.name)).toEqual(['real']);
  });

  it('omits an entry that vanished or cannot be read between the readdir and the check', () => {
    mkdirSync(join(code.path, 'kept'));
    const listing = browse(
      deps({
        readDirectory: () => [
          { name: 'kept', isDirectory: true },
          { name: 'gone', isDirectory: true },
        ],
        realPath: (path) => {
          if (path.endsWith('gone')) throw new Error('ENOENT');
          return path;
        },
      }),
      code.path,
    );
    expect(listing.entries.map((entry) => entry.name)).toEqual(['kept']);
  });

  it('follows a junction that stays inside a root, because that is a legitimate project folder', () => {
    mkdirSync(join(code.path, 'link'));
    mkdirSync(join(code.path, 'target'));
    const listing = browse(
      deps({
        realPath: (path) => (path.endsWith('link') ? join(canonical(code.path), 'target') : path),
      }),
      code.path,
    );
    expect(listing.entries.map((entry) => entry.name)).toEqual(['link', 'target']);
  });

  it('treats a symlinked directory entry as a candidate, leaving realpath to decide', () => {
    // A junction is not `isDirectory()` on a Dirent, so anything that is not a
    // plain file has to be a candidate or real projects become unreachable.
    const listing = browse(
      deps({
        readDirectory: () => [
          { name: 'linked', isDirectory: true },
          { name: 'notes.txt', isDirectory: false },
        ],
        realPath: (path) => path,
      }),
      code.path,
    );
    expect(listing.entries.map((entry) => entry.name)).toEqual(['linked']);
  });

  it('reports a directory that cannot be listed with its own reason', () => {
    expect(() =>
      browse(
        deps({
          readDirectory: () => {
            throw new Error('EPERM: operation not permitted');
          },
        }),
        code.path,
      ),
    ).toThrow(/EPERM/u);
  });
});

describe('network paths are refused outright (§2.1)', () => {
  it('refuses a UNC path with its own message, not a containment failure', () => {
    let thrown: unknown;
    try {
      browse(deps(), '\\\\fileserver\\share\\project');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(NetworkPathError);
    const failure = thrown as NetworkPathError;
    expect(failure.status).toBe(400);
    expect(failure.code).toBe('network_path_refused');
    expect(failure.message).toContain('network path');
  });
});

describe('isInsideRoots', () => {
  it('accepts a root itself and anything under it, and rejects a sibling by prefix', () => {
    const roots = [canonical(code.path)];
    expect(isInsideRoots(canonical(code.path), roots)).toBe(true);
    expect(isInsideRoots(join(canonical(code.path), 'deep', 'deeper'), roots)).toBe(true);
    // `…\code` must not contain `…\code-backup`.
    expect(isInsideRoots(`${canonical(code.path)}-backup`, roots)).toBe(false);
    expect(isInsideRoots(canonical(outside.path), roots)).toBe(false);
  });

  it('compares case-insensitively, as NTFS does', () => {
    expect(isInsideRoots(canonical(code.path).toUpperCase(), [canonical(code.path)])).toBe(true);
  });

  it('is false against no roots at all', () => {
    expect(isInsideRoots(canonical(code.path), [])).toBe(false);
  });
});
