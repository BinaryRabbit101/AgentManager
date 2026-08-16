/**
 * Git detection for the inspect flow (projects DESIGN §2.1, D1).
 *
 * > "Git operations shell out to the `git` CLI via `child_process`; no
 * > PowerShell at runtime."
 *
 * Everything here is deliberately **cheap and bounded**. §2.1's inspect step has
 * to answer in well under a second on a repository with hundreds of thousands of
 * files, which rules out anything that walks a tree: the `.git` probe is a
 * single `lstat`, and each git command is a short metadata read with a timeout
 * and no shell.
 *
 * Every command runs with `git -C <dir>` rather than a `cwd` option so the
 * directory is git's argument rather than the process's state, and none of them
 * is allowed to fail loudly: a repository with no `origin`, no commits, or a
 * detached HEAD is a perfectly registrable project that simply has less to
 * report.
 */
import { execFile } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';

/** How a `git` invocation ended. A non-zero `code` is data, never a throw. */
export interface GitResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs one `git` command. Injected, so tests need neither git nor a repository. */
export type GitRunner = (args: readonly string[]) => Promise<GitResult>;

/** §2.1's cheap read-only probe has no business taking longer than this. */
export const DEFAULT_GIT_TIMEOUT_MS = 5_000;

/**
 * A runner backed by the real `git` executable.
 *
 * `execFile` rather than `exec`: there is no shell, so a directory called
 * `C:\my repo & rm -rf` is an argument rather than a syntax error. `windowsHide`
 * keeps a console window from flashing up on a desktop install.
 */
export function createGitRunner(timeoutMs: number = DEFAULT_GIT_TIMEOUT_MS): GitRunner {
  return (args) =>
    new Promise<GitResult>((resolve) => {
      execFile(
        'git',
        [...args],
        { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
        (error, stdout, stderr) => {
          resolve({ ok: error === null, stdout: String(stdout), stderr: String(stderr) });
        },
      );
    });
}

/** What the `.git` entry says about a directory before any command is run. */
export type GitPresence =
  /** No `.git` at all — a plain folder, fully supported (§2.1). */
  | { readonly kind: 'none' }
  /** A `.git` directory — the main checkout of a repository. */
  | { readonly kind: 'repository' }
  /**
   * A `.git` **file** — an existing git worktree pointing at a repository
   * elsewhere. Refused: "register the main repo instead" (§2.1).
   */
  | { readonly kind: 'worktree' };

/**
 * Classifies a directory's `.git` entry with a single `lstat`.
 *
 * `lstat` rather than `stat` so a `.git` that is itself a symlink is not
 * silently followed into whatever it points at.
 */
export function detectGitPresence(directory: string): GitPresence {
  try {
    const stats = lstatSync(join(directory, '.git'));
    if (stats.isDirectory()) return { kind: 'repository' };
    return { kind: 'worktree' };
  } catch {
    return { kind: 'none' };
  }
}

/** What inspect learns from a repository (§2.1 step 3, step 4). */
export interface GitFacts {
  /** `git remote get-url origin`, or `null` when there is no origin. */
  readonly repoUrl: string | null;
  readonly defaultBranch: string | null;
  /** `git status --porcelain` found something — §2.1's "repo has uncommitted changes". */
  readonly dirty: boolean;
}

/**
 * Reads the three facts inspect needs from an existing repository.
 *
 * Ordering of the default-branch probes is from most to least authoritative:
 *
 * 1. `refs/remotes/origin/HEAD` — what the *remote* says its default is, and the
 *    only one of the three that is actually "the default branch" rather than
 *    "the branch that happens to be checked out";
 * 2. `symbolic-ref HEAD` — the checked-out branch. Answers even in a repository
 *    with no commits yet, which `rev-parse` cannot;
 * 3. `rev-parse --abbrev-ref HEAD` — the fallback that survives odd states.
 *
 * A detached HEAD falls through all three and yields `null`, which is honest:
 * there is no branch to report.
 */
export async function readGitFacts(directory: string, run: GitRunner): Promise<GitFacts> {
  const [origin, dirty, defaultBranch] = await Promise.all([
    readOriginUrl(directory, run),
    readDirty(directory, run),
    readDefaultBranch(directory, run),
  ]);
  return { repoUrl: origin, defaultBranch, dirty };
}

async function readOriginUrl(directory: string, run: GitRunner): Promise<string | null> {
  const result = await run(['-C', directory, 'remote', 'get-url', 'origin']);
  if (!result.ok) return null;
  const url = result.stdout.trim();
  return url.length === 0 ? null : url;
}

async function readDefaultBranch(directory: string, run: GitRunner): Promise<string | null> {
  const remote = await run([
    '-C',
    directory,
    'symbolic-ref',
    '--short',
    'refs/remotes/origin/HEAD',
  ]);
  if (remote.ok) {
    const branch = remote.stdout.trim().replace(/^origin\//, '');
    if (branch.length > 0) return branch;
  }

  const head = await run(['-C', directory, 'symbolic-ref', '--short', 'HEAD']);
  if (head.ok) {
    const branch = head.stdout.trim();
    if (branch.length > 0) return branch;
  }

  const abbrev = await run(['-C', directory, 'rev-parse', '--abbrev-ref', 'HEAD']);
  if (abbrev.ok) {
    const branch = abbrev.stdout.trim();
    if (branch.length > 0 && branch !== 'HEAD') return branch;
  }

  return null;
}

/**
 * `--untracked-files=no` deliberately: inspect is asking "would a worktree be
 * based on a clean tree", and an untracked `node_modules` or build directory is
 * the normal state of a working repository rather than something to warn about.
 */
async function readDirty(directory: string, run: GitRunner): Promise<boolean> {
  const result = await run(['-C', directory, 'status', '--porcelain', '--untracked-files=no']);
  return result.ok && result.stdout.trim().length > 0;
}
