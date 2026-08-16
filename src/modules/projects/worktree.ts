/**
 * Worktree mechanics on Windows/NTFS (projects DESIGN §4.4; IMPLEMENTATION M6).
 *
 * Everything in this file is the *how* of a worktree; the *whether* is
 * `workspaces.ts`, which implements §4.1's rule. Split because the rule is a
 * decision about leases and this is a collection of things Windows and git make
 * awkward:
 *
 * - **`MAX_PATH`.** A worktree path is `<root>\<slug>\<id8>` and everything the
 *   repository contains hangs off it. 260 characters is not the limit of the
 *   directory we create, it is the limit of the deepest file inside it, which is
 *   why {@link worktreePathBudget} reserves headroom for the repository's own
 *   tree rather than checking the root alone.
 * - **`LongPathsEnabled`.** When it is on, the limit above is not a limit at
 *   all. §4.4 asks for a check and a single warning — repeated per-acquisition
 *   warnings about a machine-wide registry setting are noise nobody reads.
 * - **Deleting directories.** Antivirus and editor handles hold files briefly;
 *   a single `rm -rf` that fails is a lease left dangling for a reason that
 *   would have cleared in 200 ms. Hence retry with backoff, and a caller that
 *   marks the lease `orphaned` rather than throwing when it genuinely will not
 *   go (§4.4).
 *
 * Git is reached through the same injected {@link GitRunner} the inspect flow
 * uses, so every test in this element runs without a shell when it wants to and
 * against a real repository when that is the point.
 */
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import type { GitResult, GitRunner } from './git.js';

// ---------------------------------------------------------------------------
// Naming (§4.4)
// ---------------------------------------------------------------------------

/** Windows' classic path limit; the ceiling `LongPathsEnabled` removes. */
export const MAX_PATH = 260;

/**
 * Characters reserved inside a worktree for the repository's own deepest file.
 *
 * A checkout's deepest path is what actually hits the limit — `node_modules`
 * chains are the usual offender — so the budget is spent on the *root* and the
 * rest is left for the tree. 120 covers a deep but ordinary repository; the
 * check exists to warn before `git worktree add` fails cryptically, not to
 * predict every repository.
 */
export const WORKTREE_PATH_HEADROOM = 120;

/** How many characters of the assignment id go into a path and a branch (§4.4). */
export const SHORT_ASSIGNMENT_ID_LENGTH = 8;

/**
 * The last 8 characters of the assignment id, lowercased and sanitised.
 *
 * The **last**, deliberately. Assignment ids are ULIDs and a ULID's first ten
 * characters are its millisecond timestamp, so two assignments created in the
 * same millisecond — the normal case when the orchestrator starts a pair — share
 * a prefix and would collide on both the worktree path and the branch name.
 * The tail is the random component. §4.4 says "truncated to 8" without saying
 * from which end, and only one end is safe.
 */
export function shortAssignmentId(assignmentId: string): string {
  const sanitised = assignmentId.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  return sanitised.slice(-SHORT_ASSIGNMENT_ID_LENGTH);
}

/** Where a worktree goes and what its branch is called (§4.4). */
export interface WorktreeNaming {
  readonly shortId: string;
  /** `<worktreesRoot>\<slug>\<id8>` — outside the user's repo folder. */
  readonly path: string;
  /** `agentmanager/<id8>-<slug>` — named, never a detached HEAD. */
  readonly branch: string;
}

export function worktreeNaming(
  worktreesRoot: string,
  slug: string,
  assignmentId: string,
): WorktreeNaming {
  const shortId = shortAssignmentId(assignmentId);
  return {
    shortId,
    path: join(worktreesRoot, slug, shortId),
    branch: `agentmanager/${shortId}-${slug}`,
  };
}

export interface PathBudget {
  /** The longest worktree root the configured root can produce (§1.1's 24-char slug). */
  readonly worstCaseRootLength: number;
  /** `MAX_PATH` minus the headroom reserved for the repository's own tree. */
  readonly limit: number;
  readonly withinLimit: boolean;
}

/**
 * Checks the configured worktrees root against `MAX_PATH` for the worst case the
 * slug rules allow: a 24-character slug (§1.1) and an 8-character id (§4.4).
 */
export function worktreePathBudget(
  worktreesRoot: string,
  slugLength = 24,
  shortIdLength: number = SHORT_ASSIGNMENT_ID_LENGTH,
): PathBudget {
  const worstCaseRootLength = worktreesRoot.length + 1 + slugLength + 1 + shortIdLength;
  const limit = MAX_PATH - WORKTREE_PATH_HEADROOM;
  return { worstCaseRootLength, limit, withinLimit: worstCaseRootLength <= limit };
}

// ---------------------------------------------------------------------------
// LongPathsEnabled (§4.4)
// ---------------------------------------------------------------------------

/** `true` / `false` when the machine could be asked, `undefined` when it could not. */
export type LongPathProbe = () => boolean | undefined;

/**
 * Reads `HKLM\SYSTEM\CurrentControlSet\Control\FileSystem\LongPathsEnabled`.
 *
 * `reg.exe`, not PowerShell: CLAUDE.md's stack rule keeps PowerShell to
 * install/setup scripts, and this runs inside the service. Non-Windows and any
 * failure answer `undefined` — "could not tell", which is not the same as "off"
 * and must not produce a warning about a registry that does not exist.
 */
export function readLongPathsEnabled(): boolean | undefined {
  if (process.platform !== 'win32') return undefined;
  try {
    const output = execFileSync(
      'reg',
      ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem', '/v', 'LongPathsEnabled'],
      { encoding: 'utf8', windowsHide: true, timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const match = /LongPathsEnabled\s+REG_DWORD\s+0x([0-9a-fA-F]+)/.exec(output);
    if (match?.[1] === undefined) return undefined;
    return Number.parseInt(match[1], 16) !== 0;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Repository state
// ---------------------------------------------------------------------------

/**
 * Why a repository cannot have a worktree cut from it right now, or `undefined`.
 *
 * Read from the control files rather than by parsing `git status`: they are one
 * `existsSync` each, they are what git itself keys on, and the answer does not
 * depend on a locale-specific string.
 */
export function repositoryBusyReason(localPath: string): string | undefined {
  const git = join(localPath, '.git');
  const states: readonly [string, string][] = [
    ['rebase-merge', 'a rebase is in progress'],
    ['rebase-apply', 'a rebase or `git am` is in progress'],
    ['MERGE_HEAD', 'a merge is in progress'],
    ['CHERRY_PICK_HEAD', 'a cherry-pick is in progress'],
    ['REVERT_HEAD', 'a revert is in progress'],
    ['BISECT_LOG', 'a bisect is in progress'],
  ];
  for (const [entry, reason] of states) {
    if (existsSync(join(git, entry))) return reason;
  }
  return undefined;
}

/** The commit a worktree's branch is cut from — recorded as `baseCommit` (§4.4). */
export async function headCommit(git: GitRunner, directory: string): Promise<string | undefined> {
  const result = await git(['-C', directory, 'rev-parse', 'HEAD']);
  if (!result.ok) return undefined;
  const commit = result.stdout.trim();
  return commit.length === 0 ? undefined : commit;
}

/**
 * `git status --porcelain`, **including untracked files** when asked.
 *
 * The default here differs from the inspect flow's on purpose. Inspect asks "is
 * this a tidy repository to register" and ignores untracked build output;
 * releasing a worktree asks "did the agent leave anything behind", and an
 * untracked file it wrote is exactly the thing that must not be deleted (§4.4:
 * "agent output must never be silently discarded").
 */
export async function isDirty(
  git: GitRunner,
  directory: string,
  options: { readonly untracked?: boolean } = {},
): Promise<boolean> {
  const args = ['-C', directory, 'status', '--porcelain'];
  if (options.untracked === false) args.push('--untracked-files=no');
  const result = await git(args);
  return result.ok && result.stdout.trim().length > 0;
}

/** Commits on the worktree's branch beyond `baseCommit`. `0` when unknowable. */
export async function commitsSince(
  git: GitRunner,
  directory: string,
  baseCommit: string,
): Promise<number> {
  const result = await git(['-C', directory, 'rev-list', '--count', `${baseCommit}..HEAD`]);
  if (!result.ok) return 0;
  const count = Number.parseInt(result.stdout.trim(), 10);
  return Number.isFinite(count) && count > 0 ? count : 0;
}

/** `git worktree add -b <branch> <path> <baseCommit>` (§4.4). */
export function addWorktree(
  git: GitRunner,
  primaryPath: string,
  worktreePath: string,
  branch: string,
  baseCommit: string,
): Promise<GitResult> {
  return git(['-C', primaryPath, 'worktree', 'add', '-b', branch, worktreePath, baseCommit]);
}

/** `git worktree remove` — refuses on its own if the tree is dirty, which is wanted. */
export function removeWorktree(
  git: GitRunner,
  primaryPath: string,
  worktreePath: string,
): Promise<GitResult> {
  return git(['-C', primaryPath, 'worktree', 'remove', worktreePath]);
}

/** `git worktree prune` — the startup half of orphan recovery (§4.4). */
export function pruneWorktrees(git: GitRunner, primaryPath: string): Promise<GitResult> {
  return git(['-C', primaryPath, 'worktree', 'prune']);
}

/**
 * `git branch -d` — the *safe* delete, and never `-D`.
 *
 * §4.4: "AgentManager never merges, pushes, or deletes a branch with unmerged
 * commits." `-d` refuses exactly that case, so the guarantee is git's rather
 * than a check of ours that could disagree with it.
 */
export async function deleteBranch(
  git: GitRunner,
  primaryPath: string,
  branch: string,
): Promise<boolean> {
  const result = await git(['-C', primaryPath, 'branch', '-d', branch]);
  return result.ok;
}

// ---------------------------------------------------------------------------
// The setup command (§4.4)
// ---------------------------------------------------------------------------

export interface CommandResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs `defaults.setupCommand` in a freshly created worktree. Injected in tests. */
export type CommandRunner = (
  command: string,
  cwd: string,
  env: Readonly<Record<string, string>>,
) => Promise<CommandResult>;

/**
 * The real runner: the platform shell, because a setup command is a command
 * line (`npm ci && npm run build`), not an executable and an argv.
 *
 * The user typed it into their own project's settings, so there is no injection
 * boundary to defend here — but there *is* one on the environment, which is why
 * the caller passes literal values only and never resolves a `secretRef`
 * (foundation §3.2 names the two authorized reveal sites, and this is not one).
 */
export function createCommandRunner(timeoutMs = 10 * 60_000): CommandRunner {
  return (command, cwd, env) =>
    new Promise<CommandResult>((resolve) => {
      const shell =
        process.platform === 'win32' ? (process.env['ComSpec'] ?? 'cmd.exe') : '/bin/sh';
      const args = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command];
      execFile(
        shell,
        args,
        { cwd, env: { ...env }, timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout, stderr) => {
          resolve({ ok: error === null, stdout: String(stdout), stderr: String(stderr) });
        },
      );
    });
}

// ---------------------------------------------------------------------------
// Removal (§4.4's "Windows removal")
// ---------------------------------------------------------------------------

export interface RemoveDirectoryOptions {
  readonly attempts?: number;
  /** Doubled after each failure: 50, 100, 200, … */
  readonly initialDelayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  /**
   * The delete itself; defaults to `rmSync(recursive, force)`.
   *
   * A seam for the same reason `probeWritable` is one: the failure this retry
   * loop exists for — a handle held by antivirus or an editor — cannot be
   * provoked reliably from a test, and `rmSync(force)` swallows most other
   * errors, so the loop would otherwise be unexercised.
   */
  readonly remove?: (directory: string) => void;
}

export interface RemoveDirectoryResult {
  readonly removed: boolean;
  readonly attempts: number;
  /** The last failure, already stringified — never an Error with a stack. */
  readonly error?: string;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    // Unrefed: a pending backoff must never hold the process open at shutdown.
    setTimeout(resolve, ms).unref();
  });
}

/**
 * Deletes a directory tree, retrying with backoff.
 *
 * > "Windows removal: directory deletion retries a few times with backoff —
 * > antivirus and editor handles routinely hold files briefly. Persistent
 * > failure marks the lease `orphaned` rather than throwing."
 *
 * Which is why this returns a result instead of throwing: the caller's job on
 * failure is to record a lease state, not to fail a release.
 */
export async function removeDirectoryWithRetry(
  directory: string,
  options: RemoveDirectoryOptions = {},
): Promise<RemoveDirectoryResult> {
  const attempts = options.attempts ?? 4;
  const sleep = options.sleep ?? defaultSleep;
  const remove =
    options.remove ?? ((target: string): void => rmSync(target, { recursive: true, force: true }));
  let delay = options.initialDelayMs ?? 50;
  let lastError: string | undefined;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      remove(directory);
      if (!existsSync(directory)) return { removed: true, attempts: attempt };
      lastError = 'the directory still exists after a successful delete call';
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (attempt < attempts) {
      await sleep(delay);
      delay *= 2;
    }
  }

  return {
    removed: false,
    attempts,
    ...(lastError === undefined ? {} : { error: lastError }),
  };
}
