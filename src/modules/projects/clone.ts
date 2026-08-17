/**
 * Clone from a repo URL (projects DESIGN §2.2; IMPLEMENTATION M3).
 *
 * §2.2's five steps, in the order they happen and with the reason each is where
 * it is:
 *
 * 1. **inspect** derives the name, the slug and `targetPath` under
 *    `projectsRoot`, and reports whether the target already exists. Cheap and
 *    read-only, like §2.1's — nothing on the network is touched;
 * 2. **create the row immediately, `status: 'provisioning'`, and return its id**.
 *    That is what lets the user close the dialog: the project exists, it simply
 *    cannot be launched against yet (§2.2 step 5, enforced in `types.ts` by
 *    `projectLaunchBlock`);
 * 3. `git clone --progress` runs as a **tracked background job**, and its stderr
 *    is parsed into `project.clone.progress` events;
 * 4. on success the row flips to `active` and `defaultBranch` is filled;
 * 5. on failure the row is deleted and the target directory removed **only if
 *    the clone created it** — a user who pre-made an empty folder keeps it.
 *
 * ## Why the failure path is this careful
 *
 * M3's acceptance is "no project row and no directory remain". Both halves have
 * a way of going wrong that is easy to miss: deleting a directory we did not
 * create would eat whatever the user had put there, and leaving the row behind
 * would leave a permanently `provisioning` project that nothing can launch and
 * nothing cleans up. So `createdTarget` is decided **before** git runs, from the
 * filesystem rather than from the request.
 *
 * ## What this file does not do
 *
 * It stores no credentials and reads none. §2.2: "credentials are the user's
 * existing git credential helper; AgentManager stores no git credentials in v1",
 * so an auth failure is git's stderr, surfaced verbatim, and not something this
 * module can retry differently.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { EventBus } from '../types.js';

import {
  CloneTargetExistsError,
  DuplicateProjectError,
  NestedProjectError,
  PathInDataRootError,
  PathNotDirectoryError,
} from './errors.js';
import { readGitFacts, type GitResult, type GitRunner } from './git.js';
import { isDirectoryEmpty, type InspectionWarning, type RegisteredPath } from './inspect.js';
import { canonicalizePath, pathRelation } from './paths.js';
import { parseRepoUrl } from './repoUrl.js';
import type { ProjectRepository } from './repository.js';
import { dedupeSlug } from './slug.js';
import type { Project, WorkspacePolicy } from './types.js';
import { removeDirectoryWithRetry, type RemoveDirectoryOptions } from './worktree.js';

// ---------------------------------------------------------------------------
// Progress (§2.2 step 3)
// ---------------------------------------------------------------------------

/** One parsed line of `git clone --progress` output. */
export interface CloneProgress {
  /** `Receiving objects`, `Resolving deltas`, `Cloning`, … — git's own wording. */
  readonly phase: string;
  /** `0`–`100`, or `null` for a phase git reports without one. */
  readonly percent: number | null;
}

/** `Receiving objects:  47% (14/29)` and its friends, plus the opening line. */
const PERCENT_LINE = /^(?:remote:\s*)?([A-Za-z][A-Za-z ]*?):\s+(\d{1,3})%/;
const COUNTED_LINE = /^(?:remote:\s*)?([A-Za-z][A-Za-z ]*?):\s+(\d+)(?:,|\s|$)/;

/**
 * Classifies one line of git's progress output.
 *
 * Returns `undefined` for anything it cannot classify rather than inventing a
 * phase: an unrecognised line is usually a warning or a hint, and turning it
 * into a progress event would put "warning: redirecting to…" in a progress bar.
 */
export function parseCloneProgress(line: string): CloneProgress | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0) return undefined;

  if (/^Cloning into/i.test(trimmed)) return { phase: 'Cloning', percent: null };

  const percent = PERCENT_LINE.exec(trimmed);
  if (percent?.[1] !== undefined && percent[2] !== undefined) {
    const value = Number.parseInt(percent[2], 10);
    return { phase: percent[1].trim(), percent: Math.min(100, Math.max(0, value)) };
  }

  const counted = COUNTED_LINE.exec(trimmed);
  if (counted?.[1] !== undefined) return { phase: counted[1].trim(), percent: null };

  return undefined;
}

/** Receives each line git writes to stderr, as it is written. */
export type CloneOutputSink = (line: string) => void;

/**
 * Runs one long git command, streaming stderr line by line.
 *
 * Separate from {@link GitRunner} because the two answer different questions:
 * `GitRunner` is for short metadata reads that are awaited whole, and a clone is
 * minutes long and only useful if its progress is visible while it runs. Both
 * are injected, so a test can drive either without a network.
 */
export type GitCloneRunner = (
  args: readonly string[],
  onStderrLine: CloneOutputSink,
) => Promise<GitResult>;

/**
 * The real runner: `spawn`, not `execFile`.
 *
 * Progress is written to **stderr** and separated by carriage returns rather
 * than newlines — that is how git redraws one line in place — so the buffer is
 * split on both. `windowsHide` keeps a console window from flashing up.
 */
export function createGitCloneRunner(timeoutMs = 30 * 60_000): GitCloneRunner {
  return (args, onStderrLine) =>
    new Promise<GitResult>((resolve) => {
      const child = spawn('git', [...args], { windowsHide: true });
      let stdout = '';
      let stderr = '';
      let pending = '';
      let settled = false;

      const timer = setTimeout(() => {
        stderr += `\nfatal: the clone did not finish within ${String(timeoutMs)} ms and was stopped.`;
        child.kill();
      }, timeoutMs);
      timer.unref();

      const finish = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (pending.trim().length > 0) onStderrLine(pending);
        resolve({ ok, stdout, stderr });
      };

      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        stdout += chunk;
      });

      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        stderr += chunk;
        pending += chunk;
        const parts = pending.split(/\r\n|\r|\n/);
        pending = parts.pop() ?? '';
        for (const part of parts) if (part.trim().length > 0) onStderrLine(part);
      });

      child.on('error', (error: Error) => {
        stderr += `\n${error.message}`;
        finish(false);
      });
      child.on('close', (code) => {
        finish(code === 0);
      });
    });
}

// ---------------------------------------------------------------------------
// Inspect (§2.2 step 1)
// ---------------------------------------------------------------------------

/** What `POST /api/projects/inspect { repoUrl }` returns — the clone form, filled. */
export interface RepoInspection {
  readonly repoUrl: string;
  readonly host: string | null;
  readonly name: string;
  readonly slug: string;
  /** `<projectsRoot>\<name>`, canonicalised. */
  readonly targetPath: string;
  readonly targetExists: boolean;
  /** True when the target exists and holds nothing — a clone into it is fine. */
  readonly targetEmpty: boolean;
  readonly warnings: readonly InspectionWarning[];
}

// ---------------------------------------------------------------------------
// The job (§2.2 steps 2–5)
// ---------------------------------------------------------------------------

export interface CloneProjectRequest {
  readonly repoUrl: string;
  /** Defaults to `<projectsRoot>\<name>`. */
  readonly targetPath?: string;
  readonly name?: string;
  readonly slug?: string;
  readonly notes?: string;
  readonly workspacePolicy?: WorkspacePolicy;
}

/** How a clone ended. Never a throw: the job runs after the request answered. */
export type CloneOutcome =
  | { readonly status: 'completed'; readonly project: Project }
  | {
      readonly status: 'failed';
      readonly projectId: string;
      /** Git's stderr, verbatim — §2.2 step 4. */
      readonly stderr: string;
      readonly rowDeleted: boolean;
      readonly directoryRemoved: boolean;
    };

/**
 * What `POST /api/projects/clone` answers with, plus a handle on the job.
 *
 * The route serialises `project` and returns; `completed` exists so a test — and
 * a future "wait for it" caller — can await the background job without polling
 * the event bus. §2.2's point is that the *user* does not have to wait, not that
 * the job is unobservable.
 */
export interface CloneStarted {
  readonly project: Project;
  readonly completed: Promise<CloneOutcome>;
}

export interface CloneServiceOptions {
  readonly repository: ProjectRepository;
  readonly bus: EventBus;
  /** `projects.root`, already defaulted by the module (§2.2 step 1). */
  readonly projectsRoot: string;
  /** AgentManager's own data root; nothing inside it is a clone target (§1.1). */
  readonly dataRoot: string;
  /** Every registered project, archived included — the nesting checks of §2.1. */
  readonly registered: () => readonly RegisteredPath[];
  /** Short metadata reads (`defaultBranch`) once the clone has landed. */
  readonly git: GitRunner;
  readonly clone: GitCloneRunner;
  readonly removeDirectory?: RemoveDirectoryOptions;
  readonly log?: (
    level: 'info' | 'warn',
    message: string,
    detail?: Record<string, unknown>,
  ) => void;
}

export interface CloneService {
  /** §2.2 step 1. Read-only; nothing on the network is contacted. */
  inspect(repoUrl: unknown, requestedTarget?: unknown): RepoInspection;
  /** §2.2 steps 2–5. Resolves as soon as the row exists, not when git is done. */
  start(request: CloneProjectRequest): CloneStarted;
}

/** `<projectsRoot>\<name>` — the proposal, which the form may overwrite. */
export function defaultTargetPath(projectsRoot: string, name: string): string {
  return join(projectsRoot, name);
}

export function createCloneService(options: CloneServiceOptions): CloneService {
  const { repository, bus, git } = options;
  const log = options.log ?? ((): void => {});
  const dataRoot = canonicalizePath(options.dataRoot);

  /**
   * Everything §2.1 refuses, applied to a directory that does not exist yet.
   *
   * The overlap with `inspectLocalPath` is deliberate rather than shared code:
   * that function's first three checks are "the folder exists, is a directory
   * and is writable", which are exactly the checks a clone target must *fail*.
   */
  function checkTarget(target: ReturnType<typeof canonicalizePath>): {
    exists: boolean;
    empty: boolean;
  } {
    const againstDataRoot = pathRelation(target.key, dataRoot.key);
    if (againstDataRoot === 'same' || againstDataRoot === 'inside') {
      throw new PathInDataRootError(target.path, dataRoot.path);
    }

    for (const project of options.registered()) {
      const relation = pathRelation(target.key, project.localPathKey);
      if (relation === 'same') throw new DuplicateProjectError(target.path, project);
      if (relation === 'inside' || relation === 'contains') {
        throw new NestedProjectError(target.path, relation, project);
      }
    }

    if (!existsSync(target.path)) return { exists: false, empty: true };
    if (!statSync(target.path).isDirectory()) throw new PathNotDirectoryError(target.path);
    return { exists: true, empty: isDirectoryEmpty(target.path) };
  }

  function inspect(repoUrl: unknown, requestedTarget?: unknown): RepoInspection {
    const parsed = parseRepoUrl(repoUrl);
    const target = canonicalizePath(
      typeof requestedTarget === 'string' && requestedTarget.trim().length > 0
        ? requestedTarget
        : defaultTargetPath(options.projectsRoot, parsed.name),
    );
    const state = checkTarget(target);

    const warnings: InspectionWarning[] = [];
    if (state.exists && !state.empty) {
      warnings.push({
        code: 'target-not-empty',
        message: `${target.path} already exists and is not empty; the clone will be refused until it is emptied or another folder is chosen.`,
      });
    }
    if (target.unc) {
      warnings.push({
        code: 'unc-path',
        message: `${target.path} is on a network share. The clone will work, but git worktrees are refused on a network path (§4.4).`,
      });
    }

    return {
      repoUrl: parsed.url,
      host: parsed.host,
      name: parsed.name,
      slug: repository.allocateSlug(parsed.name),
      targetPath: target.path,
      targetExists: state.exists,
      targetEmpty: state.empty,
      warnings,
    };
  }

  function start(request: CloneProjectRequest): CloneStarted {
    const parsed = parseRepoUrl(request.repoUrl);
    const target = canonicalizePath(
      request.targetPath !== undefined && request.targetPath.trim().length > 0
        ? request.targetPath
        : defaultTargetPath(options.projectsRoot, parsed.name),
    );
    const state = checkTarget(target);
    // M3's fourth acceptance, and the reason it is checked here rather than
    // caught from git: refused **before any clone starts**, so no row exists to
    // roll back and no directory was touched.
    if (state.exists && !state.empty) throw new CloneTargetExistsError(target.path);

    const requestedName = request.name?.trim();
    const name =
      requestedName === undefined || requestedName.length === 0 ? parsed.name : requestedName;
    const requestedSlug = request.slug?.trim();
    const slug = dedupeSlug(
      requestedSlug === undefined || requestedSlug.length === 0 ? name : requestedSlug,
      (candidate) => repository.getBySlug(candidate) !== undefined,
    );

    // Decided from the filesystem, before git can blur the answer: only a
    // directory *we* caused to exist may be removed on failure (§2.2 step 4).
    const createdTarget = !state.exists;

    const project = repository.create({
      name,
      slug,
      localPath: target.path,
      localPathKey: target.key,
      vcs: 'git',
      repoUrl: parsed.url,
      defaultBranch: null,
      notes: request.notes ?? '',
      status: 'provisioning',
      workspacePolicy: request.workspacePolicy ?? 'auto',
    });

    bus.emit({
      type: 'project.created',
      ids: { projectId: project.id },
      persist: true,
      payload: {
        id: project.id,
        slug: project.slug,
        name: project.name,
        localPath: project.localPath,
        vcs: project.vcs,
        repoUrl: project.repoUrl,
        // Named so a UI that lists projects can show the spinner rather than a
        // project that looks ready and refuses every launch.
        status: project.status,
      },
    });

    return { project, completed: run(project, parsed.url, target.path, createdTarget) };
  }

  async function run(
    project: Project,
    repoUrl: string,
    targetPath: string,
    createdTarget: boolean,
  ): Promise<CloneOutcome> {
    let last = '';
    const onLine: CloneOutputSink = (line) => {
      const progress = parseCloneProgress(line);
      if (progress === undefined) return;
      // Git redraws one line per percent, so the raw stream is thousands of
      // lines for one clone. Only a change is an event; the rest is the same
      // bar being repainted.
      const key = `${progress.phase}:${String(progress.percent)}`;
      if (key === last) return;
      last = key;
      bus.emit({
        type: 'project.clone.progress',
        ids: { projectId: project.id },
        // Not persisted: a progress bar is the definition of a live-only event,
        // and foundation's `events` cap is not there to hold percentages.
        persist: false,
        payload: { projectId: project.id, phase: progress.phase, percent: progress.percent },
      });
    };

    // git creates the leaf itself; its *parent* is ours to make, or the clone
    // fails with a message about a path rather than about the repository.
    try {
      mkdirSync(dirname(targetPath), { recursive: true });
    } catch {
      // A parent that cannot be created will surface as git's own failure
      // below, with a message that names the path.
    }

    const result = await options.clone(['clone', '--progress', repoUrl, targetPath], onLine);

    if (result.ok) {
      const facts = await readGitFacts(targetPath, git);
      const updated = repository.update(project.id, {
        status: 'active',
        defaultBranch: facts.defaultBranch,
        repoUrl: facts.repoUrl ?? repoUrl,
      });
      bus.emit({
        type: 'project.clone.completed',
        ids: { projectId: project.id },
        persist: true,
        payload: {
          projectId: project.id,
          localPath: updated.localPath,
          defaultBranch: updated.defaultBranch,
        },
      });
      log('info', `cloned ${repoUrl} into ${targetPath}`, { projectId: project.id });
      return { status: 'completed', project: updated };
    }

    // --- Failure: §2.2 step 4's rollback, in the order that cannot strand
    // either half. The row goes first, because a row pointing at a directory
    // that is about to disappear is the state nothing recovers from.
    const stderr = (result.stderr.trim().length > 0 ? result.stderr : result.stdout).trim();
    let rowDeleted = false;
    try {
      rowDeleted = repository.delete(project.id);
    } catch (error) {
      // Only possible if something already attached a session to a project that
      // never finished cloning. Logged rather than thrown: the caller is a
      // background job with nobody to throw at.
      log('warn', `the provisioning row for ${project.id} could not be deleted`, {
        projectId: project.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    let directoryRemoved = false;
    if (createdTarget && existsSync(targetPath)) {
      const removal = await removeDirectoryWithRetry(targetPath, options.removeDirectory ?? {});
      directoryRemoved = removal.removed;
      if (!removal.removed) {
        log('warn', `the failed clone left ${targetPath} behind`, {
          projectId: project.id,
          error: removal.error ?? null,
        });
      }
    } else {
      // Nothing to remove, either because git cleaned up after itself or
      // because the folder was the user's before we started.
      directoryRemoved = !existsSync(targetPath);
    }

    bus.emit({
      type: 'project.clone.failed',
      ids: { projectId: project.id },
      persist: true,
      payload: {
        projectId: project.id,
        repoUrl,
        targetPath,
        // Verbatim (§2.2 step 4): an auth failure's fix is in git's own wording,
        // and paraphrasing it would hide the credential helper it names.
        stderr,
        rowDeleted,
        directoryRemoved,
      },
    });
    log('warn', `cloning ${repoUrl} failed`, { projectId: project.id });

    return { status: 'failed', projectId: project.id, stderr, rowDeleted, directoryRemoved };
  }

  return { inspect, start };
}
