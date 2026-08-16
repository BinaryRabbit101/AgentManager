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

import { InvalidRequestError } from './errors.js';
import { createGitRunner, type GitRunner } from './git.js';
import {
  inspectLocalPath,
  probeWritable as realProbeWritable,
  type InspectDeps,
  type ProjectInspection,
  type RegisteredPath,
} from './inspect.js';
import { canonicalizePath } from './paths.js';
import type { ProjectRepository } from './repository.js';
import { dedupeSlug } from './slug.js';
import { isWorkspacePolicy, type Project, type WorkspacePolicy } from './types.js';

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
  /** Typed CRUD, for the milestones that build on this one. */
  readonly repository: ProjectRepository;
}

export interface ProjectsServiceOptions {
  readonly repository: ProjectRepository;
  readonly bus: EventBus;
  /** AgentManager's data root; nothing inside it is registrable (§1.1). */
  readonly dataRoot: string;
  /** Defaults to the real `git` executable. */
  readonly git?: GitRunner;
  /** Defaults to {@link realProbeWritable}. */
  readonly probeWritable?: (directory: string) => string | undefined;
}

export function createProjectsService(options: ProjectsServiceOptions): ProjectsService {
  const { repository, bus } = options;
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

  return {
    inspect: (localPath) => inspectLocalPath(localPath, deps),
    repository,

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
