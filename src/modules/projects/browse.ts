/**
 * `GET /api/fs/browse?path=` — the folder picker the browser and the tailnet use
 * (projects DESIGN §2.1, §5; remote §3.3, R7).
 *
 * > "The browser (and remote) path uses `GET /api/fs/browse?path=` — a
 * > directory-only listing rooted in the configured browse roots, with `..`
 * > traversal outside a root rejected."
 *
 * ## Containment is the whole of the access control
 *
 * Remote §3.3 deliberately allows this route over the tailnet, so nothing else
 * stands between a bearer token and the filesystem. §2.1 pins how that is made
 * safe, and every clause of it is load-bearing on Windows:
 *
 * 1. **Resolve first, compare second.** The requested path — *and every entry
 *    about to be listed* — goes through `realpath` before the browse-root prefix
 *    check. A lexical check is not a control here: a junction anywhere under
 *    `%USERPROFILE%` (a default root) points wherever it likes while its path
 *    still starts with the root, so `C:\Users\me\x` can be `C:\`.
 * 2. **A path that resolves outside every root returns 403 and lists nothing.**
 * 3. **An entry whose resolved target escapes is omitted** rather than shown and
 *    refused on click — the listing never advertises a door that does not open.
 * 4. **UNC and network paths are rejected outright.** A browse root is a local
 *    tree; reaching a file server through this endpoint is not what it is for.
 * 5. **Directory names only, never file contents** — and never file *names*
 *    either, because a project is a folder and listing files would widen the
 *    exposure for nothing.
 *
 * ## Roots
 *
 * `projects.browseRoots` (foundation §2.4), or — when it is `null` — the
 * documented default of `[%USERPROFILE%, projects.root]`, minus whichever is
 * absent. A request with no `path` lists the roots themselves, which is what
 * gives the navigator somewhere to start from with no knowledge of the machine.
 */
import { readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

import { InvalidPathError, ProjectsError } from './errors.js';
import { canonicalizePath, nameFromPath, pathKey, pathRelation } from './paths.js';

/** One directory the navigator can descend into. */
export interface BrowseEntry {
  readonly name: string;
  readonly path: string;
}

export interface BrowseListing {
  /** The **resolved** path that was listed — §2.1: "the response reports the
   *  resolved path", so the client posts what the server actually looked at. */
  readonly path: string;
  /** `null` at (or above) a browse root, so the navigator knows where to stop. */
  readonly parent: string | null;
  readonly roots: readonly string[];
  readonly entries: readonly BrowseEntry[];
}

/** §2.1's refusal: outside every configured root. 403, and nothing listed. */
export class PathOutsideBrowseRootsError extends ProjectsError {
  override readonly name = 'PathOutsideBrowseRootsError';

  constructor(path: string, roots: readonly string[]) {
    super(
      'browse_root_violation',
      `"${path}" is outside the folders AgentManager may browse. Configure projects.browseRoots to widen them.`,
      403,
      { path, roots: [...roots] },
    );
  }
}

/** §2.1's other refusal: a browse root is a local tree. */
export class NetworkPathError extends ProjectsError {
  override readonly name = 'NetworkPathError';

  constructor(path: string) {
    super(
      'network_path_refused',
      `"${path}" is a network path. Browsing is limited to local drives; type the full path if the folder is reachable another way.`,
      400,
      { path },
    );
  }
}

export interface BrowseDeps {
  /** `projects.browseRoots`, or `null` for the documented default. */
  readonly browseRoots: readonly string[] | null;
  /** `projects.root`, when one is configured. */
  readonly projectsRoot: string | null;
  /** `%USERPROFILE%`; injected so the default is testable off a real profile. */
  readonly homeDirectory: string | undefined;
  /** Seams, so a test can drive the junction and permission cases. */
  readonly readDirectory?: (path: string) => readonly { name: string; isDirectory: boolean }[];
  readonly realPath?: (path: string) => string;
}

/**
 * The configured roots, canonicalised, deduplicated, and only the ones that
 * resolve.
 *
 * A configured root that does not exist is dropped rather than refused: a laptop
 * with no `D:\Code` should still be able to browse `%USERPROFILE%`, and a
 * startup failure over a stale config entry would be a worse trade.
 */
export function resolveBrowseRoots(deps: BrowseDeps): string[] {
  const configured =
    deps.browseRoots ??
    [deps.homeDirectory, deps.projectsRoot].filter(
      (candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0,
    );

  const seen = new Set<string>();
  const roots: string[] = [];
  for (const raw of configured) {
    let canonical;
    try {
      canonical = canonicalizePath(raw);
    } catch {
      continue;
    }
    if (!canonical.resolved || canonical.unc) continue;
    if (seen.has(canonical.key)) continue;
    seen.add(canonical.key);
    roots.push(canonical.path);
  }
  return roots;
}

/** Whether a canonical path sits at or under one of the roots. */
export function isInsideRoots(path: string, roots: readonly string[]): boolean {
  const key = pathKey(path);
  return roots.some((root) => {
    const relation = pathRelation(key, pathKey(root));
    return relation === 'same' || relation === 'inside';
  });
}

function defaultReadDirectory(path: string): readonly { name: string; isDirectory: boolean }[] {
  return readdirSync(path, { withFileTypes: true }).map((entry) => ({
    name: entry.name,
    // A junction or symlink is not `isDirectory()` on a Dirent, and both are
    // legitimate ways to reach a project folder — so anything that is not a
    // plain file is a candidate, and step 1's realpath decides.
    isDirectory: entry.isDirectory() || entry.isSymbolicLink(),
  }));
}

/**
 * Lists one directory, or the roots when `requested` is absent.
 *
 * @throws PathOutsideBrowseRootsError when the **resolved** path escapes.
 * @throws NetworkPathError for a UNC or mapped network path.
 * @throws InvalidPathError when the path cannot be read.
 */
export function browse(deps: BrowseDeps, requested: string | null): BrowseListing {
  const roots = resolveBrowseRoots(deps);
  const readDirectory = deps.readDirectory ?? defaultReadDirectory;
  const realPath = deps.realPath ?? ((path: string) => realpathSync.native(path));

  if (requested === null || requested.trim() === '') {
    // No path: the roots themselves, so a navigator with no knowledge of the
    // machine has somewhere to start.
    return {
      path: '',
      parent: null,
      roots,
      entries: roots.map((root) => ({ name: nameFromPath(root), path: root })),
    };
  }

  const canonical = canonicalizePath(requested);
  if (canonical.unc) throw new NetworkPathError(canonical.path);
  if (!canonical.resolved) {
    throw new InvalidPathError(`"${canonical.path}" does not exist or cannot be read`);
  }
  // Step 1, in the order §2.1 insists on: `canonicalizePath` has already run
  // `realpath`, so this prefix check is against the real path and not the
  // requested string. `..` traversal that lands outside a root fails here too,
  // because `resolve` collapsed it before the comparison.
  if (!isInsideRoots(canonical.path, roots)) {
    throw new PathOutsideBrowseRootsError(canonical.path, roots);
  }

  let raw: readonly { name: string; isDirectory: boolean }[];
  try {
    raw = readDirectory(canonical.path);
  } catch (cause) {
    throw new InvalidPathError(
      `"${canonical.path}" could not be listed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  const entries: BrowseEntry[] = [];
  for (const entry of raw) {
    if (!entry.isDirectory) continue;
    const child = join(canonical.path, entry.name);
    let resolvedChild: string;
    try {
      resolvedChild = realPath(child);
    } catch {
      // Unreadable or vanished between the readdir and here: omit it, for the
      // same reason as an escaping one — a listing must not advertise a door
      // that does not open.
      continue;
    }
    // Step 3: an entry whose *resolved target* escapes is omitted. This is the
    // junction case, and it is why the check runs per entry rather than once.
    if (!isInsideRoots(resolvedChild, roots)) continue;
    entries.push({ name: entry.name, path: child });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));

  return {
    path: canonical.path,
    parent: parentWithinRoots(canonical.path, roots),
    roots,
    entries,
  };
}

/** The parent, or `null` when the current path is itself a root. */
function parentWithinRoots(path: string, roots: readonly string[]): string | null {
  const key = pathKey(path);
  if (roots.some((root) => pathKey(root) === key)) return null;
  const parent = join(path, '..');
  const canonical = canonicalizePath(parent);
  return isInsideRoots(canonical.path, roots) ? canonical.path : null;
}
