/**
 * The projects service — inspect, then create (projects DESIGN §2.1), and every
 * later milestone's entry point.
 *
 * This is the object the routes call and the object other modules will reach
 * through `ctx.require('projects')`. It owns the one rule that matters for
 * correctness here: **`create` re-runs every check `inspect` ran**.
 *
 * That is not belt-and-braces. Inspect is a separate HTTP call, so between the
 * two the folder can be deleted, renamed, made read-only, or registered by
 * another client; and the values the form posts back are the *user's*, not the
 * server's, so a client could post a `localPath` that was never inspected at
 * all. Re-inspecting makes the checks a property of registration rather than a
 * property of having politely asked first, and it is cheap enough (§2.1) that
 * there is no reason to skip it.
 *
 * What the client *may* decide is exactly what §2.1 calls "the reviewed values":
 * the display name, the slug, the notes, and the workspace policy. Everything
 * else — the canonical path, the identity key, `vcs`, `repoUrl`,
 * `defaultBranch` — is derived by the server on the create call itself. A client
 * that could post its own `repoUrl` could describe a folder as something it is
 * not.
 *
 * ## The internal surface
 *
 * Runner and orchestrator reach this object rather than importing the element
 * (foundation §6.1). Four of its methods exist for them and not for the UI:
 * `acquireWorkspace` / `releaseWorkspace` (§4.3), `getEffectiveLaunchContext`
 * (§5), and `linkWorkItems` / `unlinkWorkItems` (§1.5) — the last pair probed by
 * orchestrator rather than assumed, because it only exists from M8 onwards.
 */
import { RestrictedDeleteError } from '../../storage/index.js';
import type {
  AssignmentsRepository,
  SessionsRepository,
  TranscriptStore,
  UsageRepository,
} from '../../storage/index.js';
import type { EventBus } from '../types.js';

import { readProjectActivity, type ActivityOptions, type ProjectActivityPage } from './activity.js';
import type { CloneProjectRequest, CloneService, CloneStarted, RepoInspection } from './clone.js';
import {
  InvalidRequestError,
  ProjectHasHistoryError,
  ProjectNotFoundError,
  ProjectNotMissingError,
  WorkItemNotFoundError,
  WorkItemProjectMismatchError,
  WorktreesOutstandingError,
} from './errors.js';
import { createGitRunner, type GitRunner } from './git.js';
import { deriveProjectHealth } from './health.js';
import {
  inspectLocalPath,
  probeWritable as realProbeWritable,
  type InspectDeps,
  type ProjectInspection,
  type RegisteredPath,
} from './inspect.js';
import { getEffectiveLaunchContext } from './launchContext.js';
import { canonicalizePath } from './paths.js';
import type { ListProjectsOptions, ProjectRepository } from './repository.js';
import { runRetention, type RetentionRunResult } from './retention.js';
import { readProjectPatch } from './settings.js';
import { dedupeSlug } from './slug.js';
import {
  isWorkspacePolicy,
  type AcquireWorkspaceResult,
  type LaunchContext,
  type Project,
  type ProjectHealth,
  type RetentionDefaults,
  type WorkItem,
  type WorkspaceListEntry,
  type WorkspacePolicy,
} from './types.js';
import type {
  CreateWorkItemInput,
  ListWorkItemsOptions,
  UpdateWorkItemPatch,
  WorkItemRepository,
} from './workItems.js';
import type {
  AcquireWorkspaceOptions,
  OrphanReconciliation,
  ReleaseWorkspaceOptions,
  WorkspaceReleaseResult,
  WorkspaceService,
} from './workspaces.js';

/** What `POST /api/projects` accepts (§2.1 step 5). */
export interface CreateProjectRequest {
  readonly localPath: string;
  /** Defaults to the folder basename. */
  readonly name?: string;
  /** Must match `^[a-z0-9-]+$` and be ≤ 24 chars; deduplicated if taken. */
  readonly slug?: string;
  readonly notes?: string;
  readonly workspacePolicy?: WorkspacePolicy;
}

/** What `DELETE /api/projects/:id` accepts (§2.3, §7.10). */
export interface RemoveProjectOptions {
  /** §3.3: transcripts are deleted **only** when the user ticks the option. */
  readonly pruneTranscripts?: boolean;
  /** The confirmation §2.3 asks for before outstanding worktrees are removed. */
  readonly cleanupWorktrees?: boolean;
}

export interface RemoveProjectResult {
  readonly projectId: string;
  /** Always the project's folder: never deleted (§7.10). Returned so the UI can say so. */
  readonly localPath: string;
  readonly transcriptsPruned: number;
  readonly worktreesRemoved: number;
}

/** The element's service surface, as published on the registry. */
export interface ProjectsService {
  /** §2.1 steps 2–4: everything the create form needs, pre-filled. */
  inspect(localPath: unknown): Promise<ProjectInspection>;
  /** §2.2 step 1: the same, for a repository URL. */
  inspectRepoUrl(repoUrl: unknown, targetPath?: unknown): RepoInspection;
  /** §2.1 step 5: creates the row, `status: 'active'`, and emits `project.created`. */
  create(request: CreateProjectRequest): Promise<Project>;
  /** §2.2 steps 2–5: the row exists immediately; the clone runs in the background. */
  clone(request: CloneProjectRequest): CloneStarted;
  list(options?: ListProjectsOptions): readonly Project[];
  /** @throws ProjectNotFoundError — the id is the caller's, so absence is a 404. */
  get(id: string): Project;
  /**
   * `PATCH /api/projects/:id` (§5): name, notes, defaults, policy, retention.
   *
   * Takes the raw body rather than a parsed patch because the validation *is*
   * the behaviour here — D2's forbidden env names and §1.2's mandatory elevation
   * reason are refusals this element owes every caller, not just the HTTP one.
   */
  update(id: string, body: unknown): Project;
  /**
   * §2.3's derived health.
   *
   * Asynchronous because `dirty` is `git status` (health.ts): the alternative is
   * blocking the event loop on every project on every poll.
   */
  health(id: string): Promise<ProjectHealth>;

  // --- §2.3, lifecycle -----------------------------------------------------
  /** Hides the project from the board and blocks new assignments. Touches no file. */
  archive(id: string): Project;
  /** Puts it back, history intact. */
  restore(id: string): Project;
  /** Deletes registry rows only — **never** the project folder (§7.10). */
  remove(id: string, options?: RemoveProjectOptions): Promise<RemoveProjectResult>;
  /** Re-canonicalises a new path onto the same project id, preserving history. */
  relocate(id: string, localPath: unknown): Promise<Project>;

  // --- §3, history ---------------------------------------------------------
  /** §3.1's timeline, grouped by assignment and newest first. */
  activity(id: string, options?: ActivityOptions): ProjectActivityPage;
  /** §3.3's daily prune, over every project. Wired to a timer by the module. */
  pruneTranscripts(now?: Date): RetentionRunResult;
  /** Stamps `last_activity_at` — the module calls it on `session.started` (§1.1). */
  noteSessionStarted(projectId: string, at?: string): void;

  // --- §4.3, the lease API -------------------------------------------------
  acquireWorkspace(
    projectId: string,
    assignmentId: string,
    options: AcquireWorkspaceOptions,
  ): Promise<AcquireWorkspaceResult>;
  releaseWorkspace(
    leaseId: string,
    options?: ReleaseWorkspaceOptions,
  ): Promise<WorkspaceReleaseResult>;
  listWorkspaces(projectId: string): Promise<readonly WorkspaceListEntry[]>;
  /** §4.4's "clean up" action, taken only on explicit user confirmation. */
  cleanupWorkspace(leaseId: string): Promise<WorkspaceReleaseResult>;
  /** The boot task of §4.4; wired by the module, exposed for tests. */
  reconcileWorkspaces(): Promise<OrphanReconciliation>;

  // --- §1.5, work items ----------------------------------------------------
  listWorkItems(projectId: string, options?: ListWorkItemsOptions): readonly WorkItem[];
  createWorkItem(projectId: string, input: Omit<CreateWorkItemInput, 'projectId'>): WorkItem;
  updateWorkItem(id: string, patch: UpdateWorkItemPatch): WorkItem;
  /** One item's project — orchestrator §2.3's "an id from another project is refused by name". */
  getWorkItem(id: string): { readonly id: string; readonly projectId: string } | undefined;
  /**
   * §1.5's link call, made by orchestrator's assignment-creation path.
   *
   * Idempotent, and validates that every item belongs to the assignment's
   * project. Orchestrator probes for this method (`hasWorkItemLinker`) rather
   * than assuming it, so its presence here is what turns that refusal off.
   */
  linkWorkItems(assignmentId: string, workItemIds: readonly string[]): void;
  /** §1.5's close call: unlinks, and returns items nothing else is working on to `open`. */
  unlinkWorkItems(assignmentId: string): void;
  /** An assignment started: its `open` items become `in_progress` (§1.5). */
  noteAssignmentStarted(assignmentId: string): void;

  // --- §5, the internal surface runner and orchestrator consume ------------
  /** Raw inputs for roster's compiler — never an effective anything (§5). */
  getEffectiveLaunchContext(projectId: string, assignmentId: string): Promise<LaunchContext>;

  /** Typed CRUD, for the milestones that build on this one. */
  readonly repository: ProjectRepository;
  readonly workItems: WorkItemRepository;
}

export interface ProjectsServiceOptions {
  readonly repository: ProjectRepository;
  /** §4.3's lease API, which `cwd` on the launch context comes from. */
  readonly workspaces: WorkspaceService;
  /** §1.5's backlog, this element's own table. */
  readonly workItems: WorkItemRepository;
  /** §2.2's background clone job. */
  readonly clone: CloneService;
  readonly bus: EventBus;
  /** AgentManager's data root; nothing inside it is registrable (§1.1). */
  readonly dataRoot: string;

  // --- Foundation's repositories: the sanctioned cross-element read path (§3.1)
  readonly sessions: SessionsRepository;
  readonly assignments: AssignmentsRepository;
  readonly usage: UsageRepository;
  /** Foundation owns the transcript layout, the delete and the row update (§3.2). */
  readonly transcripts: Pick<TranscriptStore, 'prune'>;
  /** §3.3's globals, which a project may override either number of. */
  readonly retentionDefaults: RetentionDefaults;

  /**
   * Foundation's `policy.allowPermissionElevation` (§1.2).
   *
   * Read here for one purpose only — telling the user *before* a launch that a
   * stored elevation will not be honoured. Whether it applies is still roster's
   * and foundation's decision, taken in `compilePermissions`.
   */
  readonly allowPermissionElevation?: boolean;
  /** Defaults to the real `git` executable. */
  readonly git?: GitRunner;
  /** Defaults to {@link realProbeWritable}. */
  readonly probeWritable?: (directory: string) => string | undefined;
  /** Reads `defaults.instructionsPath`; injected in tests. */
  readonly readInstructions?: (absolutePath: string) => string | undefined;
  readonly clock?: () => Date;
  readonly log?: (message: string, detail?: Record<string, unknown>) => void;
}

export function createProjectsService(options: ProjectsServiceOptions): ProjectsService {
  const { repository, bus, workspaces, workItems, assignments } = options;
  const allowPermissionElevation = options.allowPermissionElevation ?? true;
  const git = options.git ?? createGitRunner();
  const probe = options.probeWritable ?? realProbeWritable;
  const dataRoot = canonicalizePath(options.dataRoot);
  const clock = options.clock ?? ((): Date => new Date());

  const registered = (): readonly RegisteredPath[] =>
    // Archived projects count: their folder is still theirs, and registering it
    // a second time would produce two rows for one directory the moment the
    // first is restored.
    repository.list({ includeArchived: true }).map((project) => ({
      id: project.id,
      name: project.name,
      localPath: project.localPath,
      localPathKey: project.localPathKey,
    }));

  const deps: InspectDeps = {
    dataRoot: dataRoot.path,
    dataRootKey: dataRoot.key,
    registered,
    allocateSlug: (name) => repository.allocateSlug(name),
    git,
    probeWritable: probe,
  };

  function mustGet(id: string): Project {
    const project = repository.get(id);
    if (project === undefined) throw new ProjectNotFoundError(id);
    return project;
  }

  /** The assignment's project, for §1.5's cross-project validation. */
  function projectOfAssignment(assignmentId: string, workItemIds: readonly string[]): string {
    const assignment = assignments.get(assignmentId);
    if (assignment !== undefined) return assignment.projectId;

    // No assignment row yet (orchestrator links inside its own creation
    // transaction, and a test may link against an id it never created). Falling
    // back to the items' own project keeps the call idempotent without
    // inventing a project — but a mixed set is still refused, because "they all
    // belong to the same project" is the property §1.5 is protecting.
    const projectIds = new Set<string>();
    for (const id of workItemIds) {
      const item = workItems.get(id);
      if (item === undefined) throw new WorkItemNotFoundError(id);
      projectIds.add(item.projectId);
    }
    const [first, second] = [...projectIds];
    if (first === undefined) return '';
    if (second !== undefined) {
      throw new WorkItemProjectMismatchError(workItemIds[0] ?? '', first, second);
    }
    return first;
  }

  return {
    inspect: (localPath) => inspectLocalPath(localPath, deps),
    inspectRepoUrl: (repoUrl, targetPath) => options.clone.inspect(repoUrl, targetPath),
    clone: (request) => options.clone.start(request),
    repository,
    workItems,

    list: (listOptions) => repository.list(listOptions),
    get: mustGet,

    update(id, body) {
      const current = mustGet(id);
      // Validation first, and all of it, before a single column is written: a
      // patch that sets `notes` and a forbidden env name must change neither.
      const patch = readProjectPatch(body, current);
      const updated = repository.update(id, patch);

      bus.emit({
        type: 'project.updated',
        ids: { projectId: id },
        persist: true,
        payload: {
          id,
          // Named rather than diffed: the UI wants "what changed", and the values
          // themselves are one `GET` away — while `defaults.env` may name secret
          // refs that have no business being replayed in an event log.
          fields: Object.keys(patch),
          slug: updated.slug,
          name: updated.name,
        },
      });
      return updated;
    },

    health: (id) =>
      Promise.resolve()
        .then(() => mustGet(id))
        .then((project) =>
          deriveProjectHealth(project, {
            repository,
            workspaces,
            git,
            allowPermissionElevation,
          }),
        ),

    // --- §2.3 -------------------------------------------------------------

    archive(id) {
      const project = mustGet(id);
      if (project.status === 'archived' && project.archivedAt !== null) return project;
      // Both halves, because they are read by different owners: `status` is this
      // element's column and `archived_at` is what foundation's `list` filters
      // on (§1.1). Setting one and not the other is how a project ends up
      // hidden from the board but still launchable, or the reverse.
      const updated = repository.update(id, {
        status: 'archived',
        archivedAt: new Date(clock().getTime()).toISOString().replace(/\.\d{3}Z$/, '.000Z'),
      });
      bus.emit({
        type: 'project.archived',
        ids: { projectId: id },
        persist: true,
        payload: { id, slug: updated.slug, name: updated.name, archivedAt: updated.archivedAt },
      });
      return updated;
    },

    restore(id) {
      const project = mustGet(id);
      if (project.status !== 'archived' && project.archivedAt === null) return project;
      const updated = repository.update(id, { status: 'active', archivedAt: null });
      bus.emit({
        type: 'project.updated',
        ids: { projectId: id },
        persist: true,
        payload: {
          id,
          fields: ['status', 'archivedAt'],
          slug: updated.slug,
          name: updated.name,
          status: updated.status,
        },
      });
      return updated;
    },

    async remove(id, removeOptions = {}) {
      const project = mustGet(id);

      // §2.3: "after confirming outstanding worktrees are cleaned up". A
      // worktree still on disk after the rows are gone is a directory nothing
      // knows the owner of, so it is the first thing checked.
      const outstanding = (await workspaces.list(id)).filter(
        (entry) => entry.kind === 'worktree' && entry.review?.present === true,
      );
      if (outstanding.length > 0 && removeOptions.cleanupWorktrees !== true) {
        throw new WorktreesOutstandingError(
          id,
          outstanding.map((entry) => ({
            id: entry.id,
            path: entry.path,
            branch: entry.branch,
          })),
        );
      }

      let worktreesRemoved = 0;
      for (const entry of outstanding) {
        const result = await workspaces.cleanup(entry.id);
        if (result.removed) worktreesRemoved += 1;
      }

      // §3.3 / §7.10: "Transcript files are deleted **only** if the user ticks
      // the explicit option." Everything else on disk — the project folder above
      // all — is untouched, whatever the caller asks for.
      let transcriptsPruned = 0;
      if (removeOptions.pruneTranscripts === true) {
        for (const session of options.sessions.list({ projectId: id })) {
          if (session.transcriptPath === null) continue;
          if (options.transcripts.prune(session.id)) transcriptsPruned += 1;
        }
      }

      try {
        repository.delete(id);
      } catch (error) {
        if (error instanceof RestrictedDeleteError) throw new ProjectHasHistoryError(id);
        throw error;
      }

      bus.emit({
        type: 'project.removed',
        ids: { projectId: id },
        persist: true,
        payload: {
          id,
          slug: project.slug,
          name: project.name,
          // Stated in the event because it is the guarantee §7.10 makes: the
          // folder outlives the registration.
          localPath: project.localPath,
          folderDeleted: false,
          transcriptsPruned,
          worktreesRemoved,
        },
      });

      return {
        projectId: id,
        localPath: project.localPath,
        transcriptsPruned,
        worktreesRemoved,
      };
    },

    async relocate(id, localPath) {
      const project = mustGet(id);
      // Relocation is for a project whose folder has *gone*. Refusing when it is
      // still there is what keeps this from becoming a second, unchecked way to
      // repoint a project at an arbitrary directory.
      const health = await deriveProjectHealth(project, {
        repository,
        workspaces,
        git,
        allowPermissionElevation,
      });
      if (!health.conditions.some((condition) => condition.code === 'missing')) {
        throw new ProjectNotMissingError(id, project.localPath);
      }

      // Every registration check runs again, minus the duplicate rule against
      // *this* project — it is allowed to claim the path it is moving onto.
      const inspection = await inspectLocalPath(localPath, {
        ...deps,
        registered: () => registered().filter((candidate) => candidate.id !== id),
      });

      const updated = repository.update(id, {
        localPath: inspection.localPath,
        localPathKey: inspection.localPathKey,
        vcs: inspection.vcs,
        repoUrl: inspection.repoUrl,
        defaultBranch: inspection.defaultBranch,
      });
      bus.emit({
        type: 'project.updated',
        ids: { projectId: id },
        persist: true,
        payload: {
          id,
          fields: ['localPath', 'localPathKey', 'vcs', 'repoUrl', 'defaultBranch'],
          slug: updated.slug,
          name: updated.name,
          localPath: updated.localPath,
          relocatedFrom: project.localPath,
        },
      });
      return updated;
    },

    // --- §3 ---------------------------------------------------------------

    activity(id, activityOptions) {
      mustGet(id);
      return readProjectActivity(
        id,
        {
          sessions: options.sessions,
          assignments,
          usage: options.usage,
          leases: workspaces.leases,
          workItems,
        },
        activityOptions ?? {},
      );
    },

    pruneTranscripts: (now) =>
      runRetention(
        {
          projects: repository,
          sessions: options.sessions,
          transcripts: options.transcripts,
          defaults: options.retentionDefaults,
          ...(options.log === undefined ? {} : { log: options.log }),
        },
        now ?? clock(),
      ),

    noteSessionStarted(projectId, at) {
      // Cheap enough to call per session event (foundation's `touch` says so),
      // and unknown ids are ignored rather than thrown at: this is driven by a
      // bus subscription, and a listener that throws takes the emitter with it.
      if (repository.get(projectId) === undefined) return;
      repository.touch(projectId, at);
    },

    // --- §4.3 -------------------------------------------------------------

    acquireWorkspace: (projectId, assignmentId, acquireOptions) =>
      workspaces.acquire(projectId, assignmentId, acquireOptions),
    releaseWorkspace: (leaseId, releaseOptions) => workspaces.release(leaseId, releaseOptions),
    listWorkspaces: (projectId) => workspaces.list(projectId),
    cleanupWorkspace: (leaseId) => workspaces.cleanup(leaseId),
    reconcileWorkspaces: () => workspaces.reconcileOrphans(),

    // --- §1.5 -------------------------------------------------------------

    listWorkItems(projectId, listOptions) {
      mustGet(projectId);
      return workItems.list(projectId, listOptions);
    },

    createWorkItem(projectId, input) {
      mustGet(projectId);
      const item = workItems.create({ ...input, projectId });
      bus.emit({
        type: 'workitem.created',
        ids: { projectId },
        persist: true,
        payload: { id: item.id, projectId, kind: item.kind, title: item.title, rank: item.rank },
      });
      return item;
    },

    updateWorkItem(id, patch) {
      const item = workItems.update(id, patch);
      bus.emit({
        type: 'workitem.updated',
        ids: { projectId: item.projectId },
        persist: true,
        payload: {
          id: item.id,
          projectId: item.projectId,
          fields: Object.keys(patch),
          status: item.status,
          rank: item.rank,
        },
      });
      return item;
    },

    getWorkItem(id) {
      const item = workItems.get(id);
      return item === undefined ? undefined : { id: item.id, projectId: item.projectId };
    },

    linkWorkItems(assignmentId, workItemIds) {
      const ids = [...new Set(workItemIds)].filter((id) => id.length > 0);
      if (ids.length === 0) return;
      workItems.link(assignmentId, projectOfAssignment(assignmentId, ids), ids);
    },

    unlinkWorkItems(assignmentId) {
      workItems.unlink(assignmentId);
    },

    noteAssignmentStarted(assignmentId) {
      workItems.noteAssignmentStarted(assignmentId);
    },

    // `.then` rather than a bare `Promise.resolve(...)`: the gather itself is
    // synchronous, and a caller awaiting the documented `Promise` result should
    // get a rejection for an unknown project rather than a synchronous throw.
    getEffectiveLaunchContext: (projectId, assignmentId) =>
      Promise.resolve().then(() =>
        getEffectiveLaunchContext(projectId, assignmentId, {
          projects: repository,
          leases: workspaces.leases,
          ...(options.readInstructions === undefined
            ? {}
            : { readInstructions: options.readInstructions }),
          ...(options.log === undefined ? {} : { log: options.log }),
        }),
      ),

    async create(request) {
      const inspection = await inspectLocalPath(request.localPath, deps);

      const name = chooseName(request.name, inspection.name);
      const slug = chooseSlug(request.slug, name, repository);
      const policy = request.workspacePolicy;
      if (policy !== undefined && !isWorkspacePolicy(policy)) {
        throw new InvalidRequestError(
          `Unknown workspacePolicy "${String(policy)}". Expected auto, shared or worktree.`,
          'workspacePolicy',
        );
      }

      const project = repository.create({
        name,
        slug,
        localPath: inspection.localPath,
        localPathKey: inspection.localPathKey,
        vcs: inspection.vcs,
        repoUrl: inspection.repoUrl,
        defaultBranch: inspection.defaultBranch,
        notes: request.notes ?? '',
        status: 'active',
        workspacePolicy: policy ?? 'auto',
      });

      // Persisted: `project.created` is part of the audit trail the UI replays
      // after a reconnect (foundation §6.5), not just a live notification.
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
          defaultBranch: project.defaultBranch,
          warnings: inspection.warnings,
        },
      });

      return project;
    },
  };
}

function chooseName(requested: string | undefined, derived: string): string {
  const trimmed = requested?.trim() ?? '';
  return trimmed.length === 0 ? derived : trimmed;
}

/**
 * A free slug, derived from the requested one when there is one and from the
 * name otherwise.
 *
 * A slug that is well-formed but taken is deduplicated rather than refused: the
 * user picked a name, not a primary key, and `app-2` is a better answer than an
 * error telling them to pick again. `dedupeSlug` normalises its base, so a
 * requested slug is also the thing that gets `[a-z0-9-]`-ified.
 */
function chooseSlug(
  requested: string | undefined,
  name: string,
  repository: ProjectRepository,
): string {
  const trimmed = requested?.trim() ?? '';
  return dedupeSlug(
    trimmed.length > 0 ? trimmed : name,
    (candidate) => repository.getBySlug(candidate) !== undefined,
  );
}
