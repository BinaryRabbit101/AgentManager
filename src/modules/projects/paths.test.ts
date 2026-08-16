/**
 * Path identity (projects DESIGN §1.1, §7.4; IMPLEMENTATION M1).
 *
 * The acceptance criterion this file exists for:
 *
 * > "`C:\Code\App`, `c:\code\app\`, and a junction pointing at it all resolve to
 * > the same `local_path_key`."
 *
 * The junction is created for real on NTFS rather than mocked, for the reason
 * §2.1 gives about the browse endpoint: a lexical check passes this case, and
 * that is exactly the bug. A `fs.symlink(…, 'junction')` fixture is the only
 * thing that can tell a correct implementation from a plausible one.
 */
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { canonicalizePath, nameFromPath, pathKey, pathRelation } from './paths.js';
import { InvalidPathError } from './errors.js';
import { makeTempDir, type TempDir } from './__tests__/helpers.js';

let temp: TempDir;

beforeEach(() => {
  temp = makeTempDir('agentmanager-paths-');
});

afterEach(() => {
  temp.cleanup();
});

describe('canonicalizePath', () => {
  it('collapses casing, trailing separators and a junction onto one identity key', () => {
    const real = resolve(temp.path, 'Code', 'App');
    mkdirSync(real, { recursive: true });
    const junction = resolve(temp.path, 'LinkToApp');
    symlinkSync(real, junction, 'junction');

    const direct = canonicalizePath(real);
    const lowered = canonicalizePath(real.toLowerCase());
    const trailing = canonicalizePath(`${real}\\`);
    const viaJunction = canonicalizePath(junction);

    expect(lowered.key).toBe(direct.key);
    expect(trailing.key).toBe(direct.key);
    // The one a lexical implementation gets wrong.
    expect(viaJunction.key).toBe(direct.key);

    // The display form is the filesystem's own casing, not the caller's.
    expect(lowered.path).toBe(direct.path);
    expect(direct.path.endsWith('\\')).toBe(false);
  });

  it('upcases the drive letter and lowercases the whole key', () => {
    const canonical = canonicalizePath(temp.path.toLowerCase());
    expect(canonical.path.slice(0, 2)).toBe(`${temp.path.slice(0, 1).toUpperCase()}:`);
    expect(canonical.key).toBe(canonical.path.toLowerCase());
    expect(canonical.unc).toBe(false);
  });

  it('normalises `..` and forward slashes before resolving', () => {
    const nested = resolve(temp.path, 'a', 'b');
    mkdirSync(nested, { recursive: true });
    const roundabout = `${temp.path.replace(/\\/g, '/')}/a/../a/b/`;
    expect(canonicalizePath(roundabout).key).toBe(canonicalizePath(nested).key);
  });

  it('canonicalises a path that does not exist, and says so', () => {
    const missing = resolve(temp.path, 'gone');
    const canonical = canonicalizePath(missing);
    // "Relocate a project whose drive is unplugged" (§2.3) has to be able to
    // canonicalise a path that is not there.
    expect(canonical.resolved).toBe(false);
    expect(canonical.key).toBe(missing.toLowerCase());
  });

  it('keeps a drive root a valid absolute path', () => {
    const drive = `${temp.path.slice(0, 1).toUpperCase()}:\\`;
    expect(canonicalizePath(drive).path).toBe(drive);
    expect(canonicalizePath(drive.toLowerCase()).key).toBe(drive.toLowerCase());
  });

  it('recognises a UNC path without needing it to exist', () => {
    const canonical = canonicalizePath('\\\\server\\share\\code\\app\\');
    expect(canonical.unc).toBe(true);
    expect(canonical.path).toBe('\\\\server\\share\\code\\app');
  });

  it.each([
    ['an empty string', ''],
    ['whitespace only', '   '],
    ['a number', 42],
    ['a NUL byte', 'C:\\code\\a\0b'],
  ])('refuses %s with a typed error rather than a fs failure', (_label, input) => {
    expect(() => canonicalizePath(input)).toThrow(InvalidPathError);
  });
});

describe('pathKey', () => {
  it('is the same normalisation, for a path already known to be canonical', () => {
    expect(pathKey('C:\\Code\\App\\')).toBe('c:\\code\\app');
    expect(pathKey('c:\\Code\\App')).toBe('c:\\code\\app');
  });
});

describe('pathRelation', () => {
  it('answers same, inside and contains', () => {
    expect(pathRelation('c:\\code\\app', 'c:\\code\\app')).toBe('same');
    expect(pathRelation('c:\\code\\app\\src', 'c:\\code\\app')).toBe('inside');
    expect(pathRelation('c:\\code', 'c:\\code\\app')).toBe('contains');
  });

  it('does not mistake a shared prefix for nesting', () => {
    // The bug a bare `startsWith` produces: `application` is not inside `app`.
    expect(pathRelation('c:\\code\\application', 'c:\\code\\app')).toBe('unrelated');
    expect(pathRelation('c:\\code\\app', 'c:\\code\\application')).toBe('unrelated');
  });

  it('treats different drives as unrelated', () => {
    expect(pathRelation('d:\\code\\app', 'c:\\code')).toBe('unrelated');
  });
});

describe('nameFromPath', () => {
  it('is the folder basename', () => {
    expect(nameFromPath('C:\\Code\\My App')).toBe('My App');
  });

  it('falls back to something nameable for a root', () => {
    expect(nameFromPath('C:\\')).toBe('C');
    expect(nameFromPath('\\\\server\\share')).toBe('share');
  });

  it('is derived from the canonical form of a real directory', () => {
    const folder = resolve(temp.path, 'Widget Factory');
    mkdirSync(folder);
    writeFileSync(resolve(folder, 'x.txt'), '', 'utf8');
    expect(nameFromPath(canonicalizePath(folder.toLowerCase()).path)).toBe('Widget Factory');
  });
});
