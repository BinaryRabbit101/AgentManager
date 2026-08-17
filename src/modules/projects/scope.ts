/**
 * Scope handling and conflict warnings (projects DESIGN §1.3, §4.3;
 * IMPLEMENTATION M7).
 *
 * Two jobs, and they are unrelated to each other except that both need the
 * assignment's scope paths.
 *
 * ## 1. Rewriting scopes onto the leased workspace
 *
 * > "If an assignment carries path scopes, the orchestrator states them relative
 * > to the repo root, and a worktree has a different absolute prefix; projects
 * > rewrites them onto the leased workspace's actual root and returns them as
 * > rule strings. **Those are input rules for roster to compose, not an
 * > effective set.**"
 *
 * That last sentence is the whole contract. What comes out of here goes into
 * roster's `compilePermissions` as the assignment-scope layer (roster §6.2)
 * alongside the agent baseline and the project override; it is not a permission
 * decision and nothing here intersects, unions or ranks anything.
 *
 * **One tool, `Edit`.** Orchestrator's SDK-NOTES **C1** established that the
 * SDK's rule engine canonicalises every file-editing tool onto `Edit(path)` and
 * that `Write(path)` / `NotebookEdit(path)` / `MultiEdit(path)` rules are
 * accepted and then never consulted. Emitting three rules would read like
 * defence in depth while resting entirely on one of them, so this file emits the
 * one that works — the same choice orchestrator's own `emitScopeRules` makes,
 * for the same reason.
 *
 * **Forward slashes, always.** The rewritten rule content is an absolute Windows
 * path, and a backslash is an escape character to every glob matcher there is.
 * `C:/Users/.../worktrees/app/1a2b3c4d/src/api/**` is both valid on Windows and
 * unambiguous to the matcher; `C:\Users\...` is neither.
 *
 * **Never `Edit(*)`.** C1's third required change: rule content of exactly `*`
 * collapses to the bare tool name, and a bare entry in `allowedTools`
 * auto-approves ahead of `canUseTool`. An assignment with no scope paths is a
 * whole-project assignment and gets **no rule at all** — never a rule that
 * happens to match everything.
 *
 * ## 2. Overlap warnings
 *
 * > "When a second write-capable assignment lands in the *same* workspace …
 * > projects computes prefix overlap between the active scope path sets and
 * > emits `project.scope.overlap` with the offending paths. It is a warning …
 * > it does not block."
 *
 * §7.13 is explicit that blocking is deferred: "path prefixes are a crude proxy
 * for real conflict; a false-positive block would stall legitimate work, while a
 * warning costs nothing". So every function here returns data, and the caller
 * emits an event — nothing in this file can refuse anything.
 */
import { statSync } from 'node:fs';

/** A scope path, normalised: forward slashes, no leading `./`, no `..`. */
export interface NormalisedScopePath {
  readonly input: string;
  /** Segments joined with `/`; `undefined` when the input was unusable. */
  readonly path?: string;
  /** True when the input, or the filesystem, says this names a directory. */
  readonly directory?: boolean;
}

/** The rule set §1.3 hands to roster — input rules, never an effective set. */
export interface WorkspaceScopeRules {
  readonly allow: readonly string[];
}

/**
 * Normalises one repo-relative scope path.
 *
 * Absolute paths, `..` traversal and globs are dropped rather than repaired.
 * Orchestrator already refuses all three at assignment-creation time
 * (orchestrator §9-11), so anything that reaches here wearing one of those
 * shapes came from a hand-edited row — and silently rewriting it into a valid
 * rule would grant a scope nobody wrote.
 */
export function normaliseScopePath(input: string): NormalisedScopePath {
  const trimmed = input.trim().replace(/\\/g, '/');
  if (trimmed.length === 0) return { input };
  if (/^[A-Za-z]:/.test(trimmed) || trimmed.startsWith('/')) return { input };
  if (trimmed.includes('*') || trimmed.includes('?')) return { input };

  const segments: string[] = [];
  for (const segment of trimmed.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') return { input };
    segments.push(segment);
  }
  if (segments.length === 0) return { input };

  return {
    input,
    path: segments.join('/'),
    // An explicit trailing slash is the orchestrator's directory marker; when it
    // is absent the caller decides, because only it knows the workspace root.
    ...(trimmed.endsWith('/') ? { directory: true } : {}),
  };
}

/**
 * Whether a normalised scope path names a directory in `workspaceRoot`.
 *
 * The filesystem is asked first because it is the only source that actually
 * knows. The fallback — "a last segment with no extension is a directory" — is
 * for a scope naming a path the agent is about to *create*, which is a normal
 * thing for a feature assignment to be scoped to.
 */
function looksLikeDirectory(
  workspaceRoot: string,
  relative: string,
  declared: boolean | undefined,
): boolean {
  if (declared === true) return true;
  try {
    return statSync(`${workspaceRoot}/${relative}`).isDirectory();
  } catch {
    const last = relative.split('/').at(-1) ?? '';
    return !/\.[A-Za-z0-9]+$/.test(last);
  }
}

/** `C:\Code\App` → `C:/Code/App`, with any trailing separator removed. */
export function toRuleRoot(workspaceRoot: string): string {
  return workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * Rewrites repo-relative scope paths onto the leased workspace root (§1.3).
 *
 * @param workspaceRoot the lease's `path` — the *worktree* for an isolated
 *   assignment, which is exactly why the rewrite exists: rules rooted at
 *   `project.localPath` would scope a worktree assignment to a directory it is
 *   not working in.
 * @returns `{ allow: [] }` for a whole-project scope. See C1-3: no rule, never
 *   `Edit(*)`.
 */
export function rewriteScopeRules(
  workspaceRoot: string,
  scopePaths: readonly string[] | undefined,
): WorkspaceScopeRules {
  const root = toRuleRoot(workspaceRoot);
  const allow: string[] = [];

  for (const raw of scopePaths ?? []) {
    const normalised = normaliseScopePath(raw);
    if (normalised.path === undefined) continue;
    const directory = looksLikeDirectory(root, normalised.path, normalised.directory);
    allow.push(
      directory ? `Edit(${root}/${normalised.path}/**)` : `Edit(${root}/${normalised.path})`,
    );
  }

  // Deduplicated and sorted so two assignments with the same scope written in
  // two orders compile to byte-identical rule sets.
  return { allow: [...new Set(allow)].sort() };
}

/**
 * A one-line rendering of a scope, for the activity timeline's `scopeSummary`.
 */
export function summariseScope(scopePaths: readonly string[] | undefined): string | null {
  const paths = (scopePaths ?? [])
    .map((raw) => normaliseScopePath(raw).path)
    .filter((path): path is string => path !== undefined);
  return paths.length === 0 ? null : [...new Set(paths)].sort().join(', ');
}

// ---------------------------------------------------------------------------
// Overlap (§4.3, §7.13)
// ---------------------------------------------------------------------------

/** One assignment's claim on a workspace, as the overlap check sees it. */
export interface ScopeClaim {
  readonly assignmentId: string;
  /** The lease path, compared case-insensitively: NTFS is (§7.4). */
  readonly workspacePath: string;
  readonly scopePaths: readonly string[];
}

/** Two assignments sharing a workspace whose scopes touch. */
export interface ScopeOverlap {
  readonly assignmentIds: readonly [string, string];
  readonly workspacePath: string;
  /** The shorter of each overlapping pair — the prefix that actually collides. */
  readonly paths: readonly string[];
}

/** Segment-wise prefix test: `src/api` contains `src/api/routes`, not `src/apiv2`. */
function isPrefixOf(shorter: string, longer: string): boolean {
  return longer === shorter || longer.startsWith(`${shorter}/`);
}

/**
 * The overlapping prefixes between two scope sets, or `[]` when they are
 * disjoint.
 *
 * A **whole-project** scope (no paths at all) overlaps everything, and is
 * reported as the empty prefix `.` rather than skipped: two assignments in one
 * tree with no stated scope is precisely the case the warning is for.
 */
export function overlappingPrefixes(
  first: readonly string[],
  second: readonly string[],
): readonly string[] {
  const left = normaliseAll(first);
  const right = normaliseAll(second);
  if (left.length === 0 || right.length === 0) return ['.'];

  const prefixes = new Set<string>();
  for (const a of left) {
    for (const b of right) {
      if (isPrefixOf(a, b)) prefixes.add(a);
      else if (isPrefixOf(b, a)) prefixes.add(b);
    }
  }
  return [...prefixes].sort();
}

function normaliseAll(paths: readonly string[]): readonly string[] {
  return paths
    .map((raw) => normaliseScopePath(raw).path)
    .filter((path): path is string => path !== undefined);
}

/**
 * Every overlap between `candidate` and the assignments already holding the
 * same workspace.
 *
 * Only the *same workspace* is compared: two assignments in two worktrees have
 * two checkouts and cannot collide on a file, whatever their paths say (§4.1).
 */
export function findScopeOverlaps(
  candidate: ScopeClaim,
  active: readonly ScopeClaim[],
): readonly ScopeOverlap[] {
  const overlaps: ScopeOverlap[] = [];
  const workspace = candidate.workspacePath.toLowerCase();

  for (const other of active) {
    if (other.assignmentId === candidate.assignmentId) continue;
    if (other.workspacePath.toLowerCase() !== workspace) continue;
    const paths = overlappingPrefixes(candidate.scopePaths, other.scopePaths);
    if (paths.length === 0) continue;
    overlaps.push({
      assignmentIds: [candidate.assignmentId, other.assignmentId],
      workspacePath: candidate.workspacePath,
      paths,
    });
  }
  return overlaps;
}
