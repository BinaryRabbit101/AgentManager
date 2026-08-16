/**
 * `POST /api/projects/inspect { localPath }` (projects DESIGN §2.1, IMPLEMENTATION M2).
 *
 * > "Both flows are two steps: **inspect** (cheap, read-only, returns everything
 * > the form needs pre-filled plus warnings) then **create**. The split is what
 * > makes the UI's one-minute quick-add possible — the user types or picks one
 * > thing and confirms a filled form."
 *
 * Two properties this module is built around.
 *
 * **It is cheap.** §2.1 and M2 both require inspect to finish well under a
 * second on a large repository, so nothing here walks a tree. "Is the folder
 * empty" reads *one* directory entry and stops (`opendir` + a single `read`)
 * rather than listing the folder; git facts are three short metadata commands;
 * the `.git` classification is one `lstat`. The cost of inspecting a repository
 * with 300 000 files is the same as inspecting one with three.
 *
 * **It refuses with a reason.** Every rejection is one of `errors.ts`'s typed
 * failures carrying the offending value — the conflicting project for a nesting
 * refusal, the existing one for a duplicate — because M2's acceptance is that
 * each is "a distinct typed error, not a stack trace".
 *
 * The checks run in the order a user would want to hear about them: what is
 * wrong with the folder itself, then what is wrong with registering *this*
 * folder, then what is merely worth mentioning.
 */
import { opendirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  DuplicateProjectError,
  GitWorktreePathError,
  NestedProjectError,
  PathInDataRootError,
  PathNotDirectoryError,
  PathNotFoundError,
  PathNotWritableError,
} from './errors.js';
import { detectGitPresence, readGitFacts, type GitRunner } from './git.js';
import { canonicalizePath, nameFromPath, pathRelation } from './paths.js';
import type { Vcs } from './types.js';

/** A project as the nesting and duplicate checks need to see it. */
export interface RegisteredPath {
  readonly id: string;
  readonly name: string;
  readonly localPath: string;
  readonly localPathKey: string;
}

/** A non-blocking observation the form shows next to the pre-filled values (§2.1). */
export interface InspectionWarning {
  /** Stable code: `unc-path`, `empty-folder`, `dirty-repo`. */
  readonly code: string;
  readonly message: string;
}

/** Everything the create form needs, pre-filled (§2.1 step 4). */
export interface ProjectInspection {
  /** Canonical display form — the path that will be stored (§1.1). */
  readonly localPath: string;
  /** Canonical lowercased identity key (§7.4). Echoed so the UI can show it. */
  readonly localPathKey: string;
  /** Derived from the folder basename. */
  readonly name: string;
  /** Derived from the name and already deduplicated against the registry (§1.1). */
  readonly slug: string;
  readonly vcs: Vcs;
  /** `null` for a non-git folder, and for a repository with no `origin`. */
  readonly repoUrl: string | null;
  readonly defaultBranch: string | null;
  /** `\\server\share\…` — accepted and stored, but worktrees on one are refused (§4.4). */
  readonly unc: boolean;
  readonly warnings: readonly InspectionWarning[];
}

export interface InspectDeps {
  /** Canonical key of AgentManager's data root; nothing inside it is registrable (§1.1). */
  readonly dataRootKey: string;
  /** Display form of the same, for the refusal message. */
  readonly dataRoot: string;
  /** Every already-registered project, archived ones included. */
  readonly registered: () => readonly RegisteredPath[];
  /** Proposes a free slug for a name (§1.1's `app`, `app-2`, `app-3`). */
  readonly allocateSlug: (name: string) => string;
  readonly git: GitRunner;
  /**
   * Answers "can the service write here". Injected because Windows makes this
   * genuinely hard to answer: `fs.access(W_OK)` only reports the read-only
   * *attribute* and ignores ACLs, so the real implementation
   * ({@link probeWritable}) writes a file and deletes it, and a test that needs
   * the refusal path substitutes a probe that says no.
   */
  readonly probeWritable: (directory: string) => string | undefined;
}

/**
 * The real writability probe: create a uniquely named file, then remove it.
 *
 * The only honest test on Windows. `fs.accessSync(dir, W_OK)` succeeds on a
 * directory the current user has no write ACE for, so a project would register
 * cleanly and fail at the first agent action instead.
 *
 * @returns `undefined` when the directory is writable, or the reason it is not.
 */
export function probeWritable(directory: string): string | undefined {
  const probe = join(directory, `.agentmanager-write-probe-${String(process.pid)}-${Date.now()}`);
  try {
    writeFileSync(probe, '', { flag: 'wx' });
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  try {
    unlinkSync(probe);
  } catch {
    // The write succeeded, which is the question that was asked. A probe file
    // left behind is untidy, not a reason to refuse the folder.
  }
  return undefined;
}

/**
 * True when the directory holds no entries.
 *
 * One entry is read and the handle is closed — the point where a `readdir` would
 * have materialised 300 000 names for a question with a one-entry answer.
 */
export function isDirectoryEmpty(directory: string): boolean {
  let handle;
  try {
    handle = opendirSync(directory);
  } catch {
    return false;
  }
  try {
    return handle.readSync() === null;
  } catch {
    return false;
  } finally {
    try {
      handle.closeSync();
    } catch {
      // Nothing useful left to do with a directory handle that will not close.
    }
  }
}

/**
 * Inspects a folder for registration (§2.1 steps 2–4).
 *
 * @throws PathNotFoundError | PathNotDirectoryError | PathNotWritableError |
 *   PathInDataRootError | DuplicateProjectError | NestedProjectError |
 *   GitWorktreePathError — each naming what is in the way.
 */
export async function inspectLocalPath(
  requestedPath: unknown,
  deps: InspectDeps,
): Promise<ProjectInspection> {
  const canonical = canonicalizePath(requestedPath);

  // --- The folder itself.
  let stats;
  try {
    stats = statSync(canonical.path);
  } catch {
    throw new PathNotFoundError(canonical.path);
  }
  if (!stats.isDirectory()) throw new PathNotDirectoryError(canonical.path);

  const notWritable = deps.probeWritable(canonical.path);
  if (notWritable !== undefined) throw new PathNotWritableError(canonical.path, notWritable);

  // --- Registering *this* folder. The data root is checked before the registry
  // because "that is AgentManager's own state" is a better answer than "that is
  // already a project" would be if the two ever overlapped.
  const againstDataRoot = pathRelation(canonical.key, deps.dataRootKey);
  if (againstDataRoot === 'same' || againstDataRoot === 'inside') {
    throw new PathInDataRootError(canonical.path, deps.dataRoot);
  }

  for (const project of deps.registered()) {
    const relation = pathRelation(canonical.key, project.localPathKey);
    if (relation === 'same') throw new DuplicateProjectError(canonical.path, project);
    if (relation === 'inside' || relation === 'contains') {
      throw new NestedProjectError(canonical.path, relation, project);
    }
  }

  // --- Version control (§2.1 step 3).
  const presence = detectGitPresence(canonical.path);
  if (presence.kind === 'worktree') throw new GitWorktreePathError(canonical.path);

  const facts =
    presence.kind === 'repository'
      ? await readGitFacts(canonical.path, deps.git)
      : { repoUrl: null, defaultBranch: null, dirty: false };

  // --- Derived values and warnings (§2.1 step 4).
  const name = nameFromPath(canonical.path);
  const warnings: InspectionWarning[] = [];

  if (canonical.unc) {
    warnings.push({
      code: 'unc-path',
      message:
        `${canonical.path} is on a network share. The project can be registered, but git ` +
        'worktrees are refused on a network path, so a second concurrent write assignment ' +
        'will have to wait for the primary tree (§4.4).',
    });
  }
  if (isDirectoryEmpty(canonical.path)) {
    warnings.push({
      code: 'empty-folder',
      message: `${canonical.path} is empty. That is allowed — there will simply be nothing to work on yet.`,
    });
  }
  if (facts.dirty) {
    warnings.push({
      code: 'dirty-repo',
      message:
        'The repository has uncommitted changes. Agents will see them, and an assignment that ' +
        'requires a clean base will be refused until the tree is committed or stashed (§4.4).',
    });
  }

  return {
    localPath: canonical.path,
    localPathKey: canonical.key,
    name,
    slug: deps.allocateSlug(name),
    vcs: presence.kind === 'repository' ? 'git' : 'none',
    repoUrl: facts.repoUrl,
    defaultBranch: facts.defaultBranch,
    unc: canonical.unc,
    warnings,
  };
}
