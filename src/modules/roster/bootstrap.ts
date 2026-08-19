/**
 * Library bootstrap — **roster's, not the installer's** (roster DESIGN §2.1,
 * IMPLEMENTATION M2; foundation §4.4).
 *
 * The installer creates and ACLs the directory and stops there. Everything
 * *inside* it is roster's, because "one component knows the library's shape,
 * which is the only way the shape stays consistent" (§2.1). On first run
 * against an empty existing directory this writes `roster.json` and
 * `.gitignore`, creates `agents/`, and runs `git init`.
 *
 * Two rules the implementation exists to enforce:
 *
 * - **`git init`, never a commit.** §2.1 says "never an auto-commit", and it is
 *   worth being explicit about why: the library is *the owner's* repository.
 *   A service that committed on their behalf would author history they did not
 *   write, and would do it at whatever moment a background reload happened to
 *   fire. Initialising the repository gives them `git log`, `git checkout` and
 *   `git diff` from the first run; what goes into it stays their decision.
 * - **A second run changes nothing.** Every step checks for its own output
 *   first, so bootstrap is safe on every boot rather than only on the first —
 *   which is what repairs a library whose `agents/` was deleted, or one that
 *   arrived by `git clone` with no `.gitignore`.
 *
 * git is spawned through an injected {@link GitCommand} rather than imported
 * from the projects element: feature modules never import each other
 * (foundation §6.1), and the two use git for entirely different things.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';

import type { Diagnostic } from './contracts.js';
import { AGENT_SCHEMA_VERSION } from './schema.js';
import { libraryPaths, writeFileAtomic, type LibraryPaths, type StoreHooks } from './store.js';

/** How a `git` invocation ended. A non-zero exit is data, never a throw. */
export interface GitCommandResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs one `git` command. Injected, so tests need neither git nor a repository. */
export type GitCommand = (args: readonly string[]) => GitCommandResult;

/** A `git init` has no business taking longer than this. */
export const DEFAULT_GIT_TIMEOUT_MS = 10_000;

/**
 * A command backed by the real `git` executable.
 *
 * `execFileSync` rather than `execSync`: there is no shell, so a library at
 * `C:\Users\Bob & Alice\library` is an argument rather than a syntax error.
 * `windowsHide` keeps a console window from flashing up on a desktop install.
 */
export function createGitCommand(timeoutMs: number = DEFAULT_GIT_TIMEOUT_MS): GitCommand {
  return (args) => {
    try {
      const stdout = execFileSync('git', [...args], {
        timeout: timeoutMs,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
      });
      return { ok: true, stdout, stderr: '' };
    } catch (cause) {
      return { ok: false, stdout: '', stderr: streamText(cause) };
    }
  };
}

/** `git`'s own words for a failure, wherever the child-process error kept them. */
function streamText(cause: unknown): string {
  const stderr = (cause as { stderr?: Buffer | string }).stderr;
  if (typeof stderr === 'string' && stderr.length > 0) return stderr;
  if (Buffer.isBuffer(stderr) && stderr.byteLength > 0) return stderr.toString('utf8');
  return cause instanceof Error ? cause.message : String(cause);
}

/** `roster.json` — "roster-level metadata: schemaVersion, seededAt" (§2.1). */
export interface RosterMetadata {
  readonly schemaVersion: number;
  /**
   * When the seeding pass ran (M10), or `null` before it has.
   *
   * It records that the **decision** was taken, not that files appeared: a
   * library that already held agents is stamped too, having deliberately been
   * left alone. That is what makes seeding a once-ever event — an owner who
   * deletes a starter agent does not find it back after a restart, which is the
   * behaviour anyone would expect and the opposite of what "seed whenever the
   * library looks empty" would give them.
   */
  readonly seededAt: string | null;
  /**
   * When the **task-template** seeding pass ran (WO5), or `null` before it has.
   *
   * A second stamp rather than a reuse of `seededAt`, because the two passes
   * are not the same decision and every existing library has already taken the
   * first one. Templates arrived after agents did, so a roster stamped
   * `seededAt` in June must still get the starter templates once — and must
   * still not get them back after the owner deletes one.
   */
  readonly templatesSeededAt: string | null;
}

/** What a `roster.json` that cannot be read is treated as. */
const DEFAULT_ROSTER_METADATA: RosterMetadata = {
  schemaVersion: AGENT_SCHEMA_VERSION,
  seededAt: null,
  templatesSeededAt: null,
};

/**
 * `roster.json`, or the default when it is missing or unreadable.
 *
 * Deliberately forgiving: this file gates one cosmetic decision (whether to
 * write four example agents), and a service that refused to start because the
 * owner put a comment in it would be trading a real failure for a trivial one.
 * A malformed file reads as "not seeded yet", and the folder check in
 * `seedLibrary` is what stops that from duplicating anything.
 */
export function readRosterMetadata(paths: LibraryPaths): RosterMetadata {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(paths.rosterJson, 'utf8')) as unknown;
  } catch {
    return DEFAULT_ROSTER_METADATA;
  }
  if (typeof raw !== 'object' || raw === null) return DEFAULT_ROSTER_METADATA;
  const record = raw as Record<string, unknown>;
  const schemaVersion = record['schemaVersion'];
  const seededAt = record['seededAt'];
  const templatesSeededAt = record['templatesSeededAt'];
  return {
    schemaVersion: typeof schemaVersion === 'number' ? schemaVersion : AGENT_SCHEMA_VERSION,
    seededAt: typeof seededAt === 'string' && seededAt.length > 0 ? seededAt : null,
    // Absent on every `roster.json` written before WO5, which reads as "the
    // template pass has not run here" — exactly right, because it has not.
    templatesSeededAt:
      typeof templatesSeededAt === 'string' && templatesSeededAt.length > 0
        ? templatesSeededAt
        : null,
  };
}

/** Rewrites `roster.json` through the same atomic path as any other file. */
export function writeRosterMetadata(
  paths: LibraryPaths,
  metadata: RosterMetadata,
  hooks: StoreHooks = {},
): void {
  writeFileAtomic(paths.rosterJson, `${JSON.stringify(metadata, null, 2)}\n`, hooks);
}

/**
 * `.gitignore`.
 *
 * Short on purpose. The library is meant to be committed nearly in full — that
 * is the point of file-based storage (§15.1) — so the only entries are things
 * that are *not* part of a definition: an in-flight atomic write, and the two
 * files Windows and macOS scatter through directories. `.archive/` is excluded
 * too: git history already records a deleted agent, and committing the archive
 * would carry every deletion twice.
 *
 * Note what is deliberately *not* here: any secret-shaped exclusion. Secrets
 * never enter the library at all — integrations carry references and foundation
 * holds the values (§10) — so an ignore rule for them would imply otherwise.
 */
export const LIBRARY_GITIGNORE = [
  '# AgentManager agent library.',
  '#',
  '# This directory is a git repository in its own right and is safe to hand-edit:',
  '# `agent.json` is the definition, `persona.md` is the prompt body, and roster',
  '# reloads both within a second of a save.',
  '#',
  '# Nothing here ever contains a credential — integrations carry `secretRef`',
  '# names and the values live in AgentManager\u2019s secret store.',
  '',
  '# In-flight atomic writes (temp file + rename).',
  '*.tmp-*',
  '',
  '# Soft-deleted agents. Recoverable from git history; committing them would',
  '# record every deletion twice.',
  '.archive/',
  '',
  '# Explorer and Finder litter.',
  'Thumbs.db',
  '.DS_Store',
  '',
].join('\n');

export interface BootstrapLibraryOptions {
  /** Foundation's `library.root` (§2.1), resolved from config. */
  readonly root: string;
  /** Defaults to the real `git` executable. */
  readonly git?: GitCommand;
  /** `false` skips `git init` entirely — the library still works without it. */
  readonly initGit?: boolean;
  readonly hooks?: StoreHooks;
}

export interface BootstrapResult {
  readonly paths: LibraryPaths;
  /** Absolute paths this run created. Empty on every run after the first. */
  readonly created: readonly string[];
  /** True when this run ran `git init` (not when a repository already existed). */
  readonly gitInitialised: boolean;
  /** True when the library is a git repository, however it got that way. */
  readonly isGitRepository: boolean;
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * Brings the library up to the §2.1 shape, creating only what is missing.
 *
 * Never throws for a git problem: a machine with no `git` on `PATH` gets a
 * warning diagnostic and a perfectly working library, because version control
 * is a feature of the library rather than a precondition for loading agents.
 * A filesystem failure *is* fatal — a library that cannot be written is a
 * roster that cannot be edited, and pretending otherwise defers the error to
 * the first save.
 */
export function bootstrapLibrary(options: BootstrapLibraryOptions): BootstrapResult {
  const paths = libraryPaths(options.root);
  const hooks = options.hooks ?? {};
  const created: string[] = [];
  const diagnostics: Diagnostic[] = [];

  if (!existsSync(paths.root)) {
    mkdirSync(paths.root, { recursive: true });
    created.push(paths.root);
  }
  if (!existsSync(paths.agents)) {
    mkdirSync(paths.agents, { recursive: true });
    created.push(paths.agents);
  }
  // `templates/` alongside it (§2.4, WO5). Created unconditionally rather than
  // on first use, and by the same idempotent check as everything else here, so a
  // library that predates task templates grows the folder on its next boot
  // instead of on the first write — which is what makes the watcher able to
  // start on a directory that exists.
  if (!existsSync(paths.templates)) {
    mkdirSync(paths.templates, { recursive: true });
    created.push(paths.templates);
  }
  // `connectors/` on the same terms (§10.3, WO3): created on every boot rather
  // than on first write, so a library that predates the connector library grows
  // the folder before anything tries to watch or list it.
  if (!existsSync(paths.connectors)) {
    mkdirSync(paths.connectors, { recursive: true });
    created.push(paths.connectors);
  }
  if (!existsSync(paths.rosterJson)) {
    writeRosterMetadata(paths, DEFAULT_ROSTER_METADATA, hooks);
    created.push(paths.rosterJson);
  }
  if (!existsSync(paths.gitignore)) {
    writeFileAtomic(paths.gitignore, LIBRARY_GITIGNORE, hooks);
    created.push(paths.gitignore);
  }

  let isGitRepository = existsSync(paths.gitDir);
  let gitInitialised = false;

  if (!isGitRepository && options.initGit !== false) {
    const git = options.git ?? createGitCommand();
    // `--initial-branch` is named rather than inherited so the library's first
    // branch does not depend on the owner's `init.defaultBranch`; a roster
    // shared between two machines should not have two different branch names.
    const result = git(['init', '--initial-branch=main', paths.root]);
    if (result.ok) {
      gitInitialised = true;
      isGitRepository = existsSync(paths.gitDir);
    } else {
      diagnostics.push({
        level: 'warn',
        code: 'roster.git-unavailable',
        message:
          `the agent library at ${paths.root} could not be initialised as a git repository ` +
          `(${result.stderr.trim().split('\n')[0] ?? 'git failed'}). Agents load normally; ` +
          'version history for the roster will not be available until git is installed (DESIGN §2.1).',
        path: paths.root,
      });
    }
  }

  return { paths, created, gitInitialised, isGitRepository, diagnostics };
}

/**
 * How many commits the library repository has.
 *
 * Exists for the M2 acceptance — "an initialised git repo with **zero
 * commits**" — and for nothing else. Roster never commits; this only ever
 * *observes*.
 */
export function libraryCommitCount(root: string, git: GitCommand): number {
  const paths = libraryPaths(root);
  if (!existsSync(paths.gitDir)) return 0;
  const result = git(['-C', paths.root, 'rev-list', '--all', '--count']);
  // A repository with no commits at all still answers `0` here; a git that
  // could not run answers nothing, which is the same "no commits" as far as the
  // only caller (a test) is concerned.
  if (!result.ok) return 0;
  const parsed = Number.parseInt(result.stdout.trim(), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * True when the directory holds nothing at all — "what the installer leaves
 * behind" (§4.4), and the state the first-run path is specified against.
 */
export function isEmptyDirectory(path: string): boolean {
  try {
    return readdirSync(path).length === 0;
  } catch {
    return false;
  }
}
