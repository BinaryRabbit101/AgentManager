/**
 * The projects service — inspect, then create (projects DESIGN §2.1).
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
 */
import type { EventBus } from '../types.js';

import { InvalidRequestError, ProjectNotFoundError } from './errors.js';
import { createGitRunner, type GitRunner } from './git.js';
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
import { readProjectPatch } from './settings.js';
import { dedupeSlug } from './slug.js';
import {
  isWorkspacePolicy,
  type AcquireWorkspaceResult,
  type LaunchContext,
  type Project,
  type ProjectHealth,
  type ProjectHealthCondition,
  type WorkspaceListEntry,
  type WorkspacePolicy,
} from './types.js';
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

/** The element's service surface, as published on the registry. */
export interface ProjectsService {
  /** §2.1 steps 2–4: everything the create form needs, pre-filled. */
  inspect(localPath: unknown): Promise<ProjectInspection>;
  /** §2.1 step 5: creates the row, `status: 'active'`, and emits `project.created`. */
  create(request: CreateProjectRequest): Promise<Project>;
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
  /** §2.3's derived health, for the conditions M4 and M6 own. */
  health(id: string): ProjectHealth;

  // --- §4.3, the lease API ------------------------------------------------
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

  // --- §5, the internal surface runner and orchestrator consume ------------
  /** Raw inputs for roster's compiler — never an effective anything (§5). */
  getEffectiveLaunchContext(projectId: string, assignmentId: string): Promise<LaunchContext>;

  /** Typed CRUD, for the milestones that build on this one. */
  readonly repository: ProjectRepository;
}

export interface ProjectsServiceOptions {
  readonly repository: ProjectRepository;
  /** §4.3's lease API, which `cwd` on the launch context comes from. */
  readonly workspaces: WorkspaceService;
  readonly bus: EventBus;
  /** AgentManager's data root; nothing inside it is registrable (§1.1). */
  readonly dataRoot: string;
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
  readonly log?: (message: string, detail?: Record<string, unknown>) => void;
}

export function createProjectsService(options: ProjectsServiceOptions): ProjectsService {
  const { repository, bus, workspaces } = options;
  const allowPermissionElevation = options.allowPermissionElevation ?? true;
  const git = options.git ?? createGitRunner();
  const probe = options.probeWritable ?? realProbeWritable;
  const dataRoot = canonicalizePath(options.dataRoot);

  const deps: InspectDeps = {
    dataRoot: dataRoot.path,
    dataRootKey: dataRoot.key,
    // Archived projects count: their folder is still theirs, and registering it
    // a second time would produce two rows for one directory the moment the
    // first is restored.
    registered: (): readonly RegisteredPath[] =>
      repository.list({ includeArchived: true }).map((project) => ({
        id: project.id,
        name: project.name,
        localPath: project.localPath,
        localPathKey: project.localPathKey,
      })),
    allocateSlug: (name) => repository.allocateSlug(name),
    git,
    probeWritable: probe,
  };

  function mustGet(id: string): Project {
    const project = repository.get(id);
    if (project === undefined) throw new ProjectNotFoundError(id);
    return project;
  }

  return {
    inspect: (localPath) => inspectLocalPath(localPath, deps),
    repository,

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

    health(id) {
      const project = mustGet(id);
      const conditions: ProjectHealthCondition[] = [];

      const dangling = repository.danglingDefaultAgents(id);
      if (dangling.length > 0) {
        conditions.push({
          code: 'stale-agents',
          level: 'warn',
          message:
            `${String(dangling.length)} default agent(s) are no longer in the roster and were ` +
            "dropped from this project's defaults: " +
            dangling.join(', '),
          detail: { agentIds: [...dangling] },
        });
      }

      const orphans = workspaces.orphaned(id);
      if (orphans.length > 0) {
        conditions.push({
          code: 'orphaned-worktrees',
          level: 'warn',
          message:
            `${String(orphans.length)} workspace lease(s) are orphaned — the service stopped while ` +
            'they were held, or a worktree could not be removed. Review them on the project page.',
          detail: {
            leases: orphans.map((lease) => ({
              id: lease.id,
              assignmentId: lease.assignmentId,
              kind: lease.kind,
              path: lease.path,
              branch: lease.branch,
            })),
          },
        });
      }

      if (project.defaults.permissionElevation !== undefined && !allowPermissionElevation) {
        conditions.push({
          code: 'elevation-refused',
          level: 'warn',
          message:
            'This project declares a permissionElevation, but policy.allowPermissionElevation is ' +
            'false on this install, so roster drops it with a diagnostic and the widening is not in ' +
            'force (DESIGN §1.2).',
          detail: {
            allow: [...project.defaults.permissionElevation.allow],
            reason: project.defaults.permissionElevation.reason,
          },
        });
      }

      return { projectId: id, conditions };
    },

    acquireWorkspace: (projectId, assignmentId, acquireOptions) =>
      workspaces.acquire(projectId, assignmentId, acquireOptions),
    releaseWorkspace: (leaseId, releaseOptions) => workspaces.release(leaseId, releaseOptions),
    listWorkspaces: (projectId) => workspaces.list(projectId),
    cleanupWorkspace: (leaseId) => workspaces.cleanup(leaseId),
    reconcileWorkspaces: () => workspaces.reconcileOrphans(),

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
