/**
 * Workspace leases (projects DESIGN §4; IMPLEMENTATION M6).
 *
 * The whole element exists so that several agents can be pointed at one project
 * at once, and this file is where that actually gets decided. §4.1's rule, in
 * full:
 *
 * > An assignment gets its own git worktree **if and only if** all three hold:
 * > the project is a git repo, **and** the assignment is write-capable, **and**
 * > another write-capable assignment already holds the primary tree.
 *
 * Everything else follows from it. Read-only and planning assignments always run
 * in the primary tree and never take the hold, so the adversarial-pair pattern
 * and the lone bug-fixer — the two common cases — never pay the worktree cost.
 * `workspacePolicy` overrides the middle of the rule (`shared` never creates
 * one, `worktree` always does for a writer) and a non-git project is forced to
 * `shared` regardless.
 *
 * ## Serialization
 *
 * Every acquisition and release runs inside the per-project mutex (`mutex.ts`),
 * because the decision above is a read of the lease table followed by a write to
 * it with `git worktree add` in between. The partial unique index is the other
 * half: it is what still holds after a crash, when no mutex exists (§4.3).
 *
 * ## What this file will not do
 *
 * - **It never discards agent output.** A worktree with commits or uncommitted
 *   changes is retained on release and listed as "review needed"; branches are
 *   deleted with `git branch -d`, never `-D` (§4.4, §7.12).
 * - **It never resolves a `secretRef`.** The setup command gets the project's
 *   *literal* env entries only. Foundation §3.2 names two authorized reveal
 *   sites and neither of them is here.
 * - **It never throws for a refusal.** §4.4 requires "a typed refusal with a
 *   reason string, not a generic error", carrying runner §15.4's `retryable`
 *   flag so a queue can tell "wait" from "this can never work".
 */
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { isoTimestamp, type Clock } from '../../storage/index.js';
import type { EventBus } from '../types.js';

import { ProjectNotFoundError, WorkspaceLeaseNotFoundError } from './errors.js';
import type { GitRunner } from './git.js';
import type { WorkspaceLeaseRepository } from './leases.js';
import type { KeyedMutex } from './mutex.js';
import type { ProjectRepository } from './repository.js';
import { findScopeOverlaps, type ScopeClaim, type ScopeOverlap } from './scope.js';
import {
  isWorkspaceRefusal,
  projectLaunchBlock,
  type AcquireWorkspaceResult,
  type EnvEntry,
  type Project,
  type WorkspaceLease,
  type WorkspaceListEntry,
  type WorkspaceRefusal,
  type WorkspaceRefusalCode,
  type WorkspaceReview,
} from './types.js';
import {
  addWorktree,
  commitsSince,
  deleteBranch,
  headCommit,
  isDirty,
  pruneWorktrees,
  removeDirectoryWithRetry,
  removeWorktree,
  repositoryBusyReason,
  worktreeNaming,
  worktreePathBudget,
  type CommandRunner,
  type LongPathProbe,
  type RemoveDirectoryOptions,
} from './worktree.js';

export interface AcquireWorkspaceOptions {
  /** `false` = a read/plan assignment: primary tree, no hold (§4.1). */
  readonly write: boolean;
  /**
   * Repo-relative scopes (§4.3).
   *
   * Recorded on the lease (M7) so that `getEffectiveLaunchContext` can rewrite
   * them onto the leased workspace root and so that the overlap warning can
   * compare them against everything else holding the same workspace. Omitted
   * means whole-project.
   */
  readonly scopePaths?: readonly string[];
  /** §4.4's third refusal: refuse when the primary tree is dirty. */
  readonly requireCleanBase?: boolean;
}

export interface ReleaseWorkspaceOptions {
  /**
   * `keep` retains the worktree whatever its state; `remove` is the confirmed
   * user action of §4.4's "clean up". Omitted is the automatic rule: remove an
   * untouched worktree, retain anything else.
   */
  readonly cleanup?: 'keep' | 'remove';
}

export interface WorkspaceReleaseResult {
  readonly lease: WorkspaceLease;
  /** True when the worktree directory is gone from disk. */
  readonly removed: boolean;
  /** True when `git branch -d` succeeded — i.e. the branch held nothing unmerged. */
  readonly branchDeleted: boolean;
  /** True when the worktree was kept: §4.4's "review needed". */
  readonly retained: boolean;
  /** Why it was kept, and what is in it. */
  readonly review?: WorkspaceReview;
}

/** What the boot task did (§4.4's orphan recovery). */
export interface OrphanReconciliation {
  readonly orphaned: readonly string[];
  readonly pruned: readonly string[];
}

export interface WorkspaceService {
  acquire(
    projectId: string,
    assignmentId: string,
    options: AcquireWorkspaceOptions,
  ): Promise<AcquireWorkspaceResult>;
  release(leaseId: string, options?: ReleaseWorkspaceOptions): Promise<WorkspaceReleaseResult>;
  /** Every lease on a project, with §4.4's review state for retained worktrees. */
  list(projectId: string): Promise<readonly WorkspaceListEntry[]>;
  /** The confirmed "clean up" action of §4.4, on an already-released worktree. */
  cleanup(leaseId: string): Promise<WorkspaceReleaseResult>;
  /** The boot task: orphan every lease from a previous life and prune (§4.4). */
  reconcileOrphans(): Promise<OrphanReconciliation>;
  /** Orphaned leases on one project — the `orphaned-worktrees` health condition. */
  orphaned(projectId: string): readonly WorkspaceLease[];
  readonly leases: WorkspaceLeaseRepository;
}

export interface WorkspaceServiceOptions {
  readonly projects: ProjectRepository;
  readonly leases: WorkspaceLeaseRepository;
  readonly mutex: KeyedMutex;
  readonly bus: EventBus;
  readonly clock: Clock;
  /** `<dataRoot>\worktrees` unless `projects.worktreesRoot` relocates it. */
  readonly worktreesRoot: string;
  readonly git: GitRunner;
  /** Runs `defaults.setupCommand`; injected in tests. */
  readonly runCommand: CommandRunner;
  /** Spread under the setup command; defaults to `process.env`. */
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
  /** Reads `LongPathsEnabled`; injected so a test is not a test of this machine. */
  readonly longPaths?: LongPathProbe;
  readonly removeDirectory?: RemoveDirectoryOptions;
  readonly log?: (
    level: 'info' | 'warn',
    message: string,
    detail?: Record<string, unknown>,
  ) => void;
}

function refusal(code: WorkspaceRefusalCode, reason: string, retryable: boolean): WorkspaceRefusal {
  return { refused: true, code, reason, retryable };
}

/** A network path: worktrees on one are refused outright (§4.4). */
function isUncPath(localPath: string): boolean {
  return localPath.startsWith('\\\\') || localPath.startsWith('//');
}

export function createWorkspaceService(options: WorkspaceServiceOptions): WorkspaceService {
  const { projects, leases, mutex, bus, clock, git, runCommand } = options;
  const log = options.log ?? ((): void => {});
  const longPaths = options.longPaths;
  let longPathWarningIssued = false;

  function now(): string {
    return isoTimestamp(clock());
  }

  function emit(type: string, lease: WorkspaceLease, extra: Record<string, unknown> = {}): void {
    bus.emit({
      type,
      ids: { projectId: lease.projectId, assignmentId: lease.assignmentId },
      // Persisted: which directory an assignment ran in is part of the record
      // the activity timeline replays (§3.1), not just a live notification.
      persist: true,
      payload: { ...lease, ...extra },
    });
  }

  function mustGetProject(projectId: string): Project {
    const project = projects.get(projectId);
    if (project === undefined) throw new ProjectNotFoundError(projectId);
    return project;
  }

  /**
   * §4.4's one-shot `LongPathsEnabled` warning, plus the `MAX_PATH` budget.
   *
   * Warned about rather than refused: the budget is a worst case over a 24-char
   * slug and a deep repository, and refusing a worktree that would in fact have
   * fitted is worse than letting git say so.
   */
  function checkPathBudget(project: Project, worktreePath: string): void {
    if (longPathWarningIssued) return;
    const budget = worktreePathBudget(options.worktreesRoot);
    const enabled = longPaths?.();
    if (budget.withinLimit && enabled !== false) return;

    longPathWarningIssued = true;
    log(
      'warn',
      budget.withinLimit
        ? 'Windows long paths are disabled (LongPathsEnabled = 0). Worktrees stay under MAX_PATH ' +
            'by design, but a deep repository can still exceed 260 characters inside one.'
        : `the configured worktrees root leaves only ${String(budget.limit - budget.worstCaseRootLength)} ` +
            'characters before MAX_PATH for a 24-character slug; move projects.worktreesRoot closer to ' +
            'the drive root or enable LongPathsEnabled.',
      {
        projectId: project.id,
        worktreePath,
        worstCaseRootLength: budget.worstCaseRootLength,
        limit: budget.limit,
        longPathsEnabled: enabled ?? null,
      },
    );
  }

  /** The project's literal env entries, for the setup command only (§4.4). */
  function setupEnv(project: Project): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(options.baseEnv ?? process.env)) {
      if (value !== undefined) env[name] = value;
    }
    for (const entry of project.defaults.env ?? []) {
      if (isLiteral(entry)) env[entry.name] = entry.value;
    }
    return env;
  }

  function isLiteral(entry: EnvEntry): entry is { name: string; value: string } {
    return 'value' in entry;
  }

  /**
   * §4.3's overlap warning, emitted after the lease exists (M7).
   *
   * **After**, deliberately: the event names the workspace the two assignments
   * share, and until the lease is written there is no workspace to name. It is
   * emitted rather than returned because it changes nothing — §7.13: "a
   * false-positive block would stall legitimate work, while a warning costs
   * nothing", so acquisition has already succeeded by the time this runs.
   */
  function warnOnScopeOverlap(lease: WorkspaceLease): readonly ScopeOverlap[] {
    const candidate: ScopeClaim = {
      assignmentId: lease.assignmentId,
      workspacePath: lease.path,
      scopePaths: lease.scopePaths,
    };
    const active: ScopeClaim[] = leases
      .list(lease.projectId, { state: 'active' })
      .filter((other) => other.id !== lease.id)
      .map((other) => ({
        assignmentId: other.assignmentId,
        workspacePath: other.path,
        scopePaths: other.scopePaths,
      }));

    const overlaps = findScopeOverlaps(candidate, active);
    for (const overlap of overlaps) {
      bus.emit({
        type: 'project.scope.overlap',
        ids: { projectId: lease.projectId, assignmentId: lease.assignmentId },
        // Persisted: the UI shows it on the project page, and a warning that
        // vanished because nobody was connected is a warning nobody ever sees.
        persist: true,
        payload: {
          projectId: lease.projectId,
          workspacePath: overlap.workspacePath,
          assignmentIds: [...overlap.assignmentIds],
          paths: [...overlap.paths],
        },
      });
      log(
        'warn',
        `assignments ${overlap.assignmentIds[0]} and ${overlap.assignmentIds[1]} share ` +
          `${overlap.workspacePath} with overlapping scopes (${overlap.paths.join(', ')})`,
        { projectId: lease.projectId },
      );
    }
    return overlaps;
  }

  async function createWorktree(
    project: Project,
    assignmentId: string,
    acquire: AcquireWorkspaceOptions,
    /** False when the caller could not fall back to the primary tree either. */
    retryable: boolean,
  ): Promise<AcquireWorkspaceResult> {
    if (isUncPath(project.localPath)) {
      return refusal(
        'unc_path',
        `${project.localPath} is on a network share, and a git worktree cannot be created for a ` +
          'project on one (DESIGN §4.4). ' +
          (retryable
            ? 'This assignment has to wait for the primary tree instead.'
            : 'With workspacePolicy "worktree" there is no other workspace it could use; change the ' +
              'policy or move the project onto a local drive.'),
        retryable,
      );
    }

    const busy = repositoryBusyReason(project.localPath);
    if (busy !== undefined) {
      return refusal(
        'repository_busy',
        `The repository at ${project.localPath} cannot be branched from right now: ${busy}. ` +
          'Finish or abort it, then start the assignment again.',
        false,
      );
    }

    if (
      acquire.requireCleanBase === true &&
      (await isDirty(git, project.localPath, { untracked: false }))
    ) {
      return refusal(
        'dirty_primary',
        `The primary tree at ${project.localPath} has uncommitted changes and this assignment ` +
          'requires a clean base. Commit or stash them first (DESIGN §4.4).',
        false,
      );
    }

    const naming = worktreeNaming(options.worktreesRoot, project.slug, assignmentId);
    checkPathBudget(project, naming.path);

    const baseCommit = await headCommit(git, project.localPath);
    if (baseCommit === undefined) {
      return refusal(
        'worktree_failed',
        `The repository at ${project.localPath} has no commit to branch from; make one commit first.`,
        false,
      );
    }

    mkdirSync(dirname(naming.path), { recursive: true });
    const added = await addWorktree(git, project.localPath, naming.path, naming.branch, baseCommit);
    if (!added.ok) {
      return refusal(
        'worktree_failed',
        `git worktree add failed for ${naming.path}: ${added.stderr.trim() || added.stdout.trim()}`,
        false,
      );
    }

    const setup = project.defaults.setupCommand;
    if (setup !== undefined && setup.trim().length > 0) {
      const result = await runCommand(setup, naming.path, setupEnv(project));
      // §4.4 wants the output on the activity timeline; that read model is M5's,
      // so for now it is logged and, on failure, carried in the refusal reason.
      log(result.ok ? 'info' : 'warn', `setup command finished for ${naming.path}`, {
        projectId: project.id,
        assignmentId,
        ok: result.ok,
        stdout: result.stdout.slice(-2000),
        stderr: result.stderr.slice(-2000),
      });
      if (!result.ok) {
        await removeWorktree(git, project.localPath, naming.path);
        await removeDirectoryWithRetry(naming.path, options.removeDirectory ?? {});
        await pruneWorktrees(git, project.localPath);
        await deleteBranch(git, project.localPath, naming.branch);
        return refusal(
          'setup_failed',
          `The setup command failed in the new worktree, which was removed again: ` +
            `${(result.stderr.trim() || result.stdout.trim()).slice(-500)}`,
          false,
        );
      }
    }

    const lease = leases.create({
      projectId: project.id,
      assignmentId,
      kind: 'worktree',
      path: naming.path,
      branch: naming.branch,
      baseCommit,
      write: true,
      acquiredAt: now(),
      scopePaths: acquire.scopePaths ?? [],
    });
    emit('workspace.acquired', lease);
    return lease;
  }

  function takePrimary(
    project: Project,
    assignmentId: string,
    write: boolean,
    scopePaths: readonly string[],
  ): WorkspaceLease {
    const lease = leases.create({
      projectId: project.id,
      assignmentId,
      kind: 'primary',
      path: project.localPath,
      // Null, not `defaultBranch`: §1.6 says `branch` is "worktree only", and a
      // primary lease does not pin a branch — whatever the user has checked out
      // is what the assignment sees.
      branch: null,
      baseCommit: null,
      write,
      acquiredAt: now(),
      scopePaths,
    });
    emit('workspace.acquired', lease);
    return lease;
  }

  async function decide(
    project: Project,
    assignmentId: string,
    acquire: AcquireWorkspaceOptions,
  ): Promise<AcquireWorkspaceResult> {
    // Read/plan assignments: always the primary tree, never a hold (§4.1). This
    // is checked before policy on purpose — `workspacePolicy: 'worktree'` keeps
    // the *user's checkout* pristine against writers, and a reader writes
    // nothing to keep it pristine against.
    const scopePaths = acquire.scopePaths ?? [];
    if (!acquire.write) return takePrimary(project, assignmentId, false, scopePaths);

    // A non-git project behaves as `shared` regardless of the setting (§4.2).
    const policy = project.vcs === 'git' ? project.workspacePolicy : 'shared';
    const holder = leases
      .list(project.id, { state: 'active' })
      .find((lease) => lease.write && lease.kind === 'primary');

    if (policy === 'worktree') {
      return createWorktree(project, assignmentId, acquire, false);
    }

    if (holder === undefined) return takePrimary(project, assignmentId, true, scopePaths);

    if (policy === 'shared') {
      return project.vcs === 'git'
        ? refusal(
            'shared_policy',
            `Assignment ${holder.assignmentId} holds the primary tree at ${project.localPath} and ` +
              'this project\'s workspacePolicy is "shared", so no worktree will be created. ' +
              'The assignment can start once the current one finishes (DESIGN §4.2).',
            true,
          )
        : refusal(
            'not_a_repository',
            `${project.localPath} is not a git repository, so there is no worktree to create and ` +
              `assignment ${holder.assignmentId} currently holds the tree. ` +
              'The assignment can start once the current one finishes (DESIGN §4.2).',
            true,
          );
    }

    // `auto`, and somebody already holds the primary tree: the one case §4.1
    // says is worth a worktree.
    return createWorktree(project, assignmentId, acquire, true);
  }

  /**
   * Reuses the lease this assignment already had.
   *
   * Three cases, and all three are "do not double-lease":
   *
   * - an `active` lease means the caller asked twice — the runner starting a
   *   second session of one assignment;
   * - an `orphaned` worktree whose directory survived means the service was
   *   killed and restarted mid-assignment (§4.4's orphan recovery);
   * - a `released` worktree whose directory survived is one that was **retained**
   *   because it had commits or uncommitted work (§4.4), and the assignment it
   *   belongs to is asking for a workspace again.
   *
   * In each case, cutting a second worktree would strand the first one's work on
   * a branch nobody is looking at — and would fail anyway, because
   * `git worktree add` refuses a path that already exists.
   */
  function adopt(
    projectId: string,
    assignmentId: string,
    scopePaths: readonly string[] | undefined,
  ): WorkspaceLease | undefined {
    /** The caller's scope wins over the stored one — it is the newer statement. */
    const withScope = (lease: WorkspaceLease): WorkspaceLease =>
      scopePaths === undefined ? lease : leases.setScopePaths(lease.id, scopePaths);

    const active = leases.activeFor(projectId, assignmentId);
    if (active !== undefined) return withScope(active);

    for (const state of ['orphaned', 'released'] as const) {
      const previous = leases.latestFor(projectId, assignmentId, state);
      if (previous === undefined || previous.kind !== 'worktree') continue;
      if (!existsSync(previous.path)) continue;
      return withScope(leases.reactivate(previous.id, now()));
    }
    return undefined;
  }

  async function reviewOf(lease: WorkspaceLease): Promise<WorkspaceReview> {
    if (lease.kind !== 'worktree' || !existsSync(lease.path)) {
      return { commits: 0, dirty: false, present: false };
    }
    const dirty = await isDirty(git, lease.path);
    const commits =
      lease.baseCommit === null ? 0 : await commitsSince(git, lease.path, lease.baseCommit);
    return { commits, dirty, present: true };
  }

  async function releaseLease(
    leaseId: string,
    options_: ReleaseWorkspaceOptions,
  ): Promise<WorkspaceReleaseResult> {
    const lease = leases.get(leaseId);
    if (lease === undefined) throw new WorkspaceLeaseNotFoundError(leaseId);

    if (lease.kind === 'primary') {
      const released =
        lease.state === 'active' ? leases.setState(lease.id, 'released', now()) : lease;
      emit('workspace.released', released, { retained: false, removed: false });
      return { lease: released, removed: false, branchDeleted: false, retained: false };
    }

    const project = projects.get(lease.projectId);
    const review = await reviewOf(lease);
    const untouched = review.present && review.commits === 0 && !review.dirty;
    const remove =
      options_.cleanup === 'remove' ||
      (options_.cleanup !== 'keep' && (untouched || !review.present));

    if (!remove) {
      const released =
        lease.state === 'active' ? leases.setState(lease.id, 'released', now()) : lease;
      emit('workspace.released', released, { retained: true, removed: false, review });
      return { lease: released, removed: false, branchDeleted: false, retained: true, review };
    }

    const primaryPath = project?.localPath;
    let removed = !review.present;
    if (review.present) {
      if (primaryPath !== undefined) {
        const byGit = await removeWorktree(git, primaryPath, lease.path);
        removed = byGit.ok && !existsSync(lease.path);
      }
      if (!removed) {
        // Windows: antivirus and editor handles. Retry with backoff, then let
        // git forget the administrative entry either way (§4.4).
        const result = await removeDirectoryWithRetry(lease.path, options.removeDirectory ?? {});
        removed = result.removed;
        if (!removed) {
          log('warn', `could not remove the worktree at ${lease.path}; the lease is orphaned`, {
            projectId: lease.projectId,
            leaseId: lease.id,
            attempts: result.attempts,
            error: result.error ?? null,
          });
        }
      }
      if (primaryPath !== undefined) await pruneWorktrees(git, primaryPath);
    }

    let branchDeleted = false;
    if (removed && primaryPath !== undefined && lease.branch !== null) {
      // `-d`, never `-D`: a branch carrying unmerged commits survives, which is
      // the whole of §4.4's "merge-back is manual".
      branchDeleted = await deleteBranch(git, primaryPath, lease.branch);
    }

    const finalState = removed ? 'released' : 'orphaned';
    const settled = leases.setState(lease.id, finalState, now());
    emit(removed ? 'workspace.released' : 'workspace.orphaned', settled, {
      retained: !removed,
      removed,
      branchDeleted,
      review,
    });
    return {
      lease: settled,
      removed,
      branchDeleted,
      retained: !removed,
      ...(removed ? {} : { review }),
    };
  }

  return {
    leases,

    acquire(projectId, assignmentId, acquireOptions) {
      return mutex.runExclusive(projectId, async () => {
        const project = mustGetProject(projectId);
        const blocked = projectLaunchBlock(project);
        if (blocked !== undefined) {
          return refusal(
            'project_not_launchable',
            blocked === 'provisioning'
              ? `Project ${project.name} is still provisioning; the clone has not finished (DESIGN §2.2).`
              : `Project ${project.name} is archived and accepts no new assignments (DESIGN §2.3).`,
            // A clone finishes on its own; an archived project needs a human to
            // restore it, so queueing and retrying would never come good.
            blocked === 'provisioning',
          );
        }

        const existing = adopt(projectId, assignmentId, acquireOptions.scopePaths);
        if (existing !== undefined) {
          emit('workspace.acquired', existing, { adopted: true });
          warnOnScopeOverlap(existing);
          return existing;
        }

        const result = await decide(project, assignmentId, acquireOptions);
        if (isWorkspaceRefusal(result)) {
          log('info', `workspace refused for assignment ${assignmentId}: ${result.reason}`, {
            projectId,
            code: result.code,
            retryable: result.retryable,
          });
          return result;
        }

        // §4.3: a warning, after the fact. `acquire` has already succeeded and
        // nothing below it can change that (§7.13).
        warnOnScopeOverlap(result);
        return result;
      });
    },

    release(leaseId, releaseOptions = {}) {
      const lease = leases.get(leaseId);
      if (lease === undefined) throw new WorkspaceLeaseNotFoundError(leaseId);
      return mutex.runExclusive(lease.projectId, () => releaseLease(leaseId, releaseOptions));
    },

    cleanup(leaseId) {
      const lease = leases.get(leaseId);
      if (lease === undefined) throw new WorkspaceLeaseNotFoundError(leaseId);
      return mutex.runExclusive(lease.projectId, () =>
        releaseLease(leaseId, { cleanup: 'remove' }),
      );
    },

    async list(projectId) {
      const entries: WorkspaceListEntry[] = [];
      for (const lease of leases.list(projectId)) {
        if (lease.kind !== 'worktree') {
          entries.push(lease);
          continue;
        }
        const review = await reviewOf(lease);
        entries.push(review.present ? { ...lease, review } : lease);
      }
      return entries;
    },

    async reconcileOrphans() {
      const orphaned: string[] = [];
      const pruned: string[] = [];
      const projectIds = new Set<string>();

      // Every `active` lease is by definition from a previous life: nothing can
      // be running one tick after boot, which is the same reasoning that makes
      // the runner move `running` sessions to `orphaned` here (§4.4).
      for (const lease of leases.listActiveEverywhere()) {
        const settled = leases.setState(lease.id, 'orphaned', now());
        orphaned.push(settled.id);
        projectIds.add(settled.projectId);
        emit('workspace.orphaned', settled, { reason: 'startup-reconciliation' });
      }

      for (const projectId of projectIds) {
        const project = projects.get(projectId);
        if (project === undefined || project.vcs !== 'git') continue;
        const result = await pruneWorktrees(git, project.localPath);
        if (result.ok) pruned.push(projectId);
      }

      if (orphaned.length > 0) {
        log(
          'warn',
          `${String(orphaned.length)} workspace lease(s) from a previous run were orphaned`,
          {
            leaseIds: orphaned,
          },
        );
      }
      return { orphaned, pruned };
    },

    orphaned: (projectId) => leases.list(projectId, { state: 'orphaned' }),
  };
}
