/**
 * Path identity (projects DESIGN §1.1, §7.4).
 *
 * > "`local_path_key` is the identity of a project, not the name.
 * > Canonicalization: `path.resolve` → resolve any junction/symlink via
 * > `fs.realpath` → uppercase the drive letter → strip trailing separators →
 * > lowercase the whole string for the key."
 *
 * Each of those four steps closes a way the same directory can arrive wearing a
 * different string, and none of them is optional on Windows:
 *
 * - `resolve` normalises `.`, `..` and forward slashes;
 * - `realpath` is the only one that survives a **junction**. A lexical check
 *   cannot see that `C:\Users\me\app` is `D:\src\app`, and NTFS hands out
 *   junctions freely — this is the same class of bug §2.1 calls out for the
 *   browse endpoint, and the same fix: resolve first, compare second;
 * - the drive letter is upcased so the *display* form is stable (`c:\` and `C:\`
 *   are one drive, and only one of them should ever be shown);
 * - lowercasing produces the key, because NTFS is case-insensitive, so
 *   `C:\Code\App` and `c:\code\app` must collide.
 *
 * Comparison between paths happens on **keys only** — `isSamePath`,
 * {@link pathRelation} — never on display forms.
 */
import { realpathSync } from 'node:fs';
import { basename, resolve, sep } from 'node:path';

import { InvalidPathError } from './errors.js';

/** A path reduced to its canonical display form and its identity key. */
export interface CanonicalPath {
  /**
   * Canonical absolute path, no trailing separator (except a bare root), drive
   * letter upcased, and — when the path exists — the casing the filesystem
   * actually holds.
   */
  readonly path: string;
  /** {@link CanonicalPath.path} lowercased. The value stored in `local_path_key`. */
  readonly key: string;
  /** `\\server\share\…`. Accepted and stored, but worktrees on one are refused (§4.4). */
  readonly unc: boolean;
  /**
   * Whether `realpath` succeeded — i.e. whether the canonical form is the *real*
   * path or only the lexically resolved one. A caller that cares about the
   * difference reports the missing path itself; this module never throws for it,
   * because "relocate a project whose drive is unplugged" (§2.3) has to be able
   * to canonicalise a path that is not there.
   */
  readonly resolved: boolean;
}

/** Strips the Win32 long-path and UNC long-path prefixes `realpath` may return. */
function stripLongPathPrefix(input: string): string {
  if (input.startsWith('\\\\?\\UNC\\')) return `\\\\${input.slice(8)}`;
  if (input.startsWith('\\\\?\\')) return input.slice(4);
  return input;
}

/** True for `C:\`, `C:`, `\\server\share` and `/` — the forms that own no parent. */
function isRoot(input: string): boolean {
  if (/^[A-Za-z]:[\\/]?$/.test(input)) return true;
  if (input === sep || input === '/') return true;
  // `\\server\share` — a UNC share root, which cannot be trimmed any further.
  const unc = /^\\\\[^\\/]+\\[^\\/]+$/.exec(input);
  return unc !== null;
}

/** Removes trailing separators, leaving a bare root intact. */
function stripTrailingSeparators(input: string): string {
  let result = input;
  while (result.length > 1 && (result.endsWith('\\') || result.endsWith('/')) && !isRoot(result)) {
    result = result.slice(0, -1);
  }
  // `C:` on its own is not an absolute path — it means "the current directory on
  // C:" — so a drive root keeps its separator.
  if (/^[A-Za-z]:$/.test(result)) return `${result}\\`;
  return result;
}

/** Upcases a leading drive letter; leaves UNC and POSIX paths alone. */
function upcaseDriveLetter(input: string): string {
  return /^[a-z]:/.test(input) ? input.charAt(0).toUpperCase() + input.slice(1) : input;
}

/**
 * Canonicalises one path per §1.1.
 *
 * `realpathSync.native` is preferred over the JavaScript implementation because
 * it is the one that returns the filesystem's own casing — the JS version
 * follows the junction but hands back whatever casing it was given, which would
 * make the *display* path depend on how the user typed it. Both resolve
 * junctions, so identity is unaffected either way; only the display form is.
 *
 * @throws InvalidPathError when the input is empty or not a string.
 */
export function canonicalizePath(input: unknown): CanonicalPath {
  if (typeof input !== 'string') {
    throw new InvalidPathError(`expected a string, got ${typeof input}`);
  }
  const trimmed = input.trim();
  if (trimmed.length === 0) throw new InvalidPathError('the path is empty');
  // A NUL byte makes every subsequent `fs` call throw a bare ERR_INVALID_ARG_VALUE.
  if (trimmed.includes('\0')) throw new InvalidPathError('the path contains a NUL byte');

  const lexical = resolve(trimmed);

  let real = lexical;
  let resolved = true;
  try {
    real = realpathSync.native(lexical);
  } catch {
    try {
      real = realpathSync(lexical);
    } catch {
      real = lexical;
      resolved = false;
    }
  }

  const canonical = stripTrailingSeparators(upcaseDriveLetter(stripLongPathPrefix(real)));
  return {
    path: canonical,
    key: canonical.toLowerCase(),
    unc: canonical.startsWith('\\\\'),
    resolved,
  };
}

/** The identity key of an already-canonical path. */
export function pathKey(canonical: string): string {
  return stripTrailingSeparators(upcaseDriveLetter(canonical)).toLowerCase();
}

/** How two canonical **keys** sit relative to one another. */
export type PathRelation = 'same' | 'inside' | 'contains' | 'unrelated';

/**
 * Compares two identity keys.
 *
 * The separator is appended before the prefix test so that `c:\code\app` and
 * `c:\code\application` come back `unrelated` — a bare `startsWith` would call
 * the second one nested inside the first and refuse a perfectly good folder.
 *
 * @param subject the path being asked about
 * @param other the path it is being compared to
 * @returns `inside` when `subject` sits under `other`; `contains` when it is the
 *   other way round.
 */
export function pathRelation(subject: string, other: string): PathRelation {
  if (subject === other) return 'same';
  if (subject.startsWith(withSeparator(other))) return 'inside';
  if (other.startsWith(withSeparator(subject))) return 'contains';
  return 'unrelated';
}

function withSeparator(key: string): string {
  return key.endsWith(sep) || key.endsWith('/') ? key : `${key}${sep}`;
}

/**
 * The display name a folder suggests: its basename.
 *
 * A drive root has no basename, so it falls back to the drive letter — `C:\`
 * becomes `C`, which is at least something a slug can be made of.
 */
export function nameFromPath(canonical: string): string {
  const base = basename(canonical);
  if (base.length > 0) return base;
  const drive = /^([A-Za-z]):/.exec(canonical);
  if (drive?.[1] !== undefined) return drive[1];
  const share = /^\\\\([^\\/]+)\\([^\\/]+)/.exec(canonical);
  if (share?.[2] !== undefined) return share[2];
  return 'project';
}
