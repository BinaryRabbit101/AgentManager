/**
 * The registration failure vocabulary (projects IMPLEMENTATION M2).
 *
 * > "A path that does not exist, is a file, or is not writable each returns a
 * > distinct typed error, not a stack trace."
 *
 * Each error carries three things a caller can act on without parsing prose: a
 * stable machine-readable {@link ProjectsError.code}, the HTTP status the API
 * should answer with, and a `details` bag naming the offending values — the
 * conflicting project for a nesting refusal, the existing one for a duplicate.
 * `routes.ts` turns exactly those three into foundation's one error shape
 * (`{error, message, …}`), which is why no handler here ever surfaces a stack.
 *
 * Statuses are `400` for "the path you gave cannot be registered" and `409` for
 * "something already claims it": the distinction the UI needs is whether to fix
 * the input or to offer the existing project.
 */

/** Base class, so a route (or a test) can recognise an expected refusal. */
export class ProjectsError extends Error {
  override readonly name: string = 'ProjectsError';

  constructor(
    /** Stable, machine-readable: `path_not_found`, `nested_project`, … */
    readonly code: string,
    message: string,
    /** The status `POST /api/projects[/inspect]` answers with. */
    readonly status: number,
    /** Merged into the JSON error body; never contains a stack or a secret. */
    readonly details: Readonly<Record<string, unknown>> = {},
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** The request body was malformed — a missing field, or a value outside its union. */
export class InvalidRequestError extends ProjectsError {
  override readonly name = 'InvalidRequestError';

  constructor(
    message: string,
    readonly field?: string,
  ) {
    super('invalid_request', message, 400, field === undefined ? {} : { field });
  }
}

/** The request carried no usable path at all. */
export class InvalidPathError extends ProjectsError {
  override readonly name = 'InvalidPathError';

  constructor(detail: string) {
    super('invalid_path', `Not a usable local path: ${detail}`, 400);
  }
}

/** Nothing exists at the path — a typo, an unplugged external drive, a moved folder. */
export class PathNotFoundError extends ProjectsError {
  override readonly name = 'PathNotFoundError';

  constructor(readonly localPath: string) {
    super('path_not_found', `No folder exists at ${localPath}.`, 400, { localPath });
  }
}

/** The path exists but is a file. A project is a directory. */
export class PathNotDirectoryError extends ProjectsError {
  override readonly name = 'PathNotDirectoryError';

  constructor(readonly localPath: string) {
    super(
      'path_not_directory',
      `${localPath} is a file, not a folder. Register the folder that contains it.`,
      400,
      { localPath },
    );
  }
}

/**
 * The folder cannot be written to.
 *
 * Read-only would be enough to *look* at a project, but every agent action —
 * and the setup command of §4.4 — writes, so refusing at registration is the
 * honest moment rather than at the first failed session.
 */
export class PathNotWritableError extends ProjectsError {
  override readonly name = 'PathNotWritableError';

  constructor(
    readonly localPath: string,
    detail?: string,
  ) {
    super(
      'path_not_writable',
      `${localPath} is not writable by the AgentManager service` +
        `${detail === undefined ? '' : ` (${detail})`}. Agents need write access to the project folder.`,
      400,
      { localPath },
    );
  }
}

/**
 * The path is inside AgentManager's own data root (§1.1).
 *
 * Pointing an agent at the service's database, transcripts and secrets is never
 * what the user meant, and the transcript pruner and the registry would be
 * editing each other's files.
 */
export class PathInDataRootError extends ProjectsError {
  override readonly name = 'PathInDataRootError';

  constructor(
    readonly localPath: string,
    readonly dataRoot: string,
  ) {
    super(
      'path_in_data_root',
      `${localPath} is inside AgentManager's own data root (${dataRoot}), which cannot be registered as a project.`,
      400,
      { localPath, dataRoot },
    );
  }
}

/**
 * The folder is already a project — under any casing, and through any junction
 * (§7.4). The message names the existing project so the UI can offer to open it
 * rather than making the user go looking.
 */
export class DuplicateProjectError extends ProjectsError {
  override readonly name = 'DuplicateProjectError';

  constructor(
    readonly localPath: string,
    readonly existing: { readonly id: string; readonly name: string; readonly localPath: string },
  ) {
    super(
      'project_exists',
      `${localPath} is already registered as "${existing.name}". ` +
        'A project is identified by its canonicalised path, so the same folder — under a ' +
        'different casing, or through a junction — is the same project (§7.4).',
      409,
      {
        localPath,
        existingProjectId: existing.id,
        existingProjectName: existing.name,
        existingProjectPath: existing.localPath,
      },
    );
  }
}

/** Whether the requested path sits under the conflicting project, or above it. */
export type NestingRelation = 'inside' | 'contains';

/**
 * Registration would nest one project inside another (§1.1, §7.5).
 *
 * Refused in both directions: nesting makes workspace leasing, scope-overlap
 * detection and transcript attribution ambiguous for no real gain. A monorepo is
 * one project with path-scoped assignments.
 */
export class NestedProjectError extends ProjectsError {
  override readonly name = 'NestedProjectError';

  constructor(
    readonly localPath: string,
    readonly relation: NestingRelation,
    readonly conflicting: {
      readonly id: string;
      readonly name: string;
      readonly localPath: string;
    },
  ) {
    super(
      'nested_project',
      relation === 'inside'
        ? `${localPath} is inside the registered project "${conflicting.name}" (${conflicting.localPath}). ` +
            'Nested projects are not allowed; use path-scoped assignments on the existing project instead (§7.5).'
        : `${localPath} contains the registered project "${conflicting.name}" (${conflicting.localPath}). ` +
            'Nested projects are not allowed; remove or relocate the inner project first (§7.5).',
      409,
      {
        localPath,
        relation,
        conflictingProjectId: conflicting.id,
        conflictingProjectName: conflicting.name,
        conflictingProjectPath: conflicting.localPath,
      },
    );
  }
}

/**
 * The folder is an existing git worktree — its `.git` is a *file* pointing at
 * the real repository, not a directory (§2.1).
 *
 * Registering it would put AgentManager's own worktree management on top of
 * somebody else's, sharing one `.git` directory with no lease between them.
 */
export class GitWorktreePathError extends ProjectsError {
  override readonly name = 'GitWorktreePathError';

  constructor(readonly localPath: string) {
    super(
      'git_worktree_path',
      `${localPath} is an existing git worktree (its .git is a file, not a directory). ` +
        'Register the main repository instead.',
      400,
      { localPath },
    );
  }
}

/** Nothing is registered under that id (§5's `GET`/`PATCH` and the launch call). */
export class ProjectNotFoundError extends ProjectsError {
  override readonly name = 'ProjectNotFoundError';

  constructor(readonly projectId: string) {
    super('project_not_found', `No project is registered with id ${projectId}.`, 404, {
      projectId,
    });
  }
}

/**
 * An env variable name a project may never set (§1.4, D2).
 *
 * `ANTHROPIC_API_KEY` "silently overrides subscription auth" and
 * `CLAUDE_CODE_OAUTH_TOKEN` *is* the subscription auth. Both are foundation's to
 * place in `agentEnv`, never a project's — a project that could set either would
 * change how the session authenticates from a settings form.
 */
export class ForbiddenEnvNameError extends ProjectsError {
  override readonly name = 'ForbiddenEnvNameError';

  constructor(readonly envName: string) {
    super(
      'forbidden_env_name',
      `A project may not set ${envName}. Authentication comes from the owner's Claude ` +
        "subscription and is foundation's `agentEnv`, not a project setting: " +
        'ANTHROPIC_API_KEY silently overrides subscription auth and CLAUDE_CODE_OAUTH_TOKEN is ' +
        'that auth (architecture D2, DESIGN §1.4).',
      400,
      { field: 'defaults.env', envName },
    );
  }
}

/**
 * `permissionElevation` arrived without a justification (§1.2).
 *
 * "An elevation nobody had to justify is the failure mode the reason string
 * exists to prevent", so the field is named in the refusal rather than left for
 * the user to find.
 */
export class MissingElevationReasonError extends ProjectsError {
  override readonly name = 'MissingElevationReasonError';

  constructor() {
    super(
      'missing_elevation_reason',
      'defaults.permissionElevation.reason is required and must be non-empty: an elevation ' +
        "widens an agent's permissions, and the reason is what makes it reviewable (DESIGN §1.2).",
      400,
      { field: 'defaults.permissionElevation.reason' },
    );
  }
}

/**
 * The launch-context call was made for an assignment that holds no lease.
 *
 * `cwd` is "the leased workspace root" (§5), so there is no honest answer
 * before `acquireWorkspace` has run. Handing back `localPath` would give a
 * writer the primary tree without the hold that makes §4.1's rule work.
 */
export class WorkspaceNotLeasedError extends ProjectsError {
  override readonly name = 'WorkspaceNotLeasedError';

  constructor(
    readonly projectId: string,
    readonly assignmentId: string,
  ) {
    super(
      'workspace_not_leased',
      `Assignment ${assignmentId} holds no active workspace lease on project ${projectId}. ` +
        'Call acquireWorkspace before asking for the launch context (DESIGN §4.3).',
      409,
      { projectId, assignmentId },
    );
  }
}

/** The project cannot be launched against: `provisioning` (§2.2) or `archived` (§2.3). */
export class ProjectNotLaunchableError extends ProjectsError {
  override readonly name = 'ProjectNotLaunchableError';

  constructor(
    readonly projectId: string,
    /** Named `projectStatus`, not `status`: the base class's `status` is HTTP's. */
    readonly projectStatus: string,
  ) {
    super(
      'project_not_launchable',
      projectStatus === 'provisioning'
        ? `Project ${projectId} is still provisioning; it cannot be launched against until the clone completes (DESIGN §2.2).`
        : `Project ${projectId} is archived and accepts no new assignments (DESIGN §2.3).`,
      409,
      { projectId, projectStatus },
    );
  }
}

/** A lease id that is not this project's, or not there at all. */
export class WorkspaceLeaseNotFoundError extends ProjectsError {
  override readonly name = 'WorkspaceLeaseNotFoundError';

  constructor(readonly leaseId: string) {
    super('workspace_lease_not_found', `No workspace lease with id ${leaseId}.`, 404, { leaseId });
  }
}

/**
 * The `repoUrl` posted to the clone flow cannot be parsed (§2.2 step 1).
 *
 * The reason is carried rather than a bare "invalid URL": the two mistakes
 * people actually make — pasting a local path, or pasting a web page URL — have
 * different fixes, and only the message can say which.
 */
export class InvalidRepoUrlError extends ProjectsError {
  override readonly name = 'InvalidRepoUrlError';

  constructor(
    readonly repoUrl: string,
    reason: string,
  ) {
    super('invalid_repo_url', `"${repoUrl}" is not a repository URL: ${reason}.`, 400, {
      field: 'repoUrl',
      repoUrl,
    });
  }
}

/**
 * The clone target already holds something (§2.2, M3's fourth acceptance:
 * "target path already exists and is non-empty → refused **before any clone
 * starts**").
 *
 * Refused rather than cloned into a suffixed directory: `git clone` refuses a
 * non-empty target anyway, and doing it here means no project row is created
 * and nothing has to be rolled back.
 */
export class CloneTargetExistsError extends ProjectsError {
  override readonly name = 'CloneTargetExistsError';

  constructor(readonly targetPath: string) {
    super(
      'clone_target_exists',
      `${targetPath} already exists and is not empty. Choose another target folder, or register ` +
        'the existing one with "Add existing folder" instead.',
      409,
      { field: 'targetPath', targetPath },
    );
  }
}

/** Nothing is stored under that work-item id (§1.5). */
export class WorkItemNotFoundError extends ProjectsError {
  override readonly name = 'WorkItemNotFoundError';

  constructor(readonly workItemId: string) {
    super('work_item_not_found', `No work item is stored with id ${workItemId}.`, 404, {
      workItemId,
    });
  }
}

/**
 * A work item was linked to an assignment on a different project (§1.5).
 *
 * "Both calls are idempotent, validate that every item belongs to the
 * assignment's project" — a cross-project link would put an item `in_progress`
 * because of work happening somewhere it cannot see.
 */
export class WorkItemProjectMismatchError extends ProjectsError {
  override readonly name = 'WorkItemProjectMismatchError';

  constructor(
    readonly workItemId: string,
    readonly workItemProjectId: string,
    readonly assignmentProjectId: string,
  ) {
    super(
      'work_item_project_mismatch',
      `Work item ${workItemId} belongs to project ${workItemProjectId}, not to the assignment's ` +
        `project ${assignmentProjectId}. An assignment may only carry its own project's items (DESIGN §1.5).`,
      409,
      { workItemId, workItemProjectId, assignmentProjectId },
    );
  }
}

/**
 * `POST /api/projects/:id/relocate` was given a path that is not the project
 * (§2.3's "relocate").
 *
 * Relocation re-canonicalises a *new* path onto the same project id, so the
 * usual registration refusals still apply — and one more: relocating onto a
 * folder that some other project already claims would produce two rows for one
 * directory.
 */
export class ProjectNotMissingError extends ProjectsError {
  override readonly name = 'ProjectNotMissingError';

  constructor(
    readonly projectId: string,
    readonly localPath: string,
  ) {
    super(
      'project_not_missing',
      `Project ${projectId} still exists at ${localPath}, so there is nothing to relocate. ` +
        'Relocation is for a project whose folder has moved or whose drive is unplugged (DESIGN §2.3).',
      409,
      { projectId, localPath },
    );
  }
}

/**
 * Removal was asked for while worktrees are still on disk (§2.3).
 *
 * "Remove deletes the registry row, work items, leases and history index **after
 * confirming outstanding worktrees are cleaned up**." So the refusal names them,
 * and the caller either cleans them up itself (§4.4's "clean up" action) or
 * re-sends the request with `cleanupWorktrees`. Deleting the rows first would
 * leave directories on disk that nothing knows the owner of.
 */
export class WorktreesOutstandingError extends ProjectsError {
  override readonly name = 'WorktreesOutstandingError';

  constructor(
    readonly projectId: string,
    readonly worktrees: readonly { id: string; path: string; branch: string | null }[],
  ) {
    super(
      'worktrees_outstanding',
      `${String(worktrees.length)} worktree(s) for this project are still on disk: ` +
        `${worktrees.map((worktree) => worktree.path).join(', ')}. Clean them up first, or repeat ` +
        'the request with cleanupWorktrees=true to remove the ones that hold no unmerged work.',
      409,
      { projectId, worktrees: worktrees.map((worktree) => ({ ...worktree })) },
    );
  }
}

/**
 * The project still has sessions or assignments, so its row cannot be deleted.
 *
 * Foundation's decision, not this element's: `projects.delete` runs behind
 * `ON DELETE RESTRICT` (foundation §1.4, "deleting a project with history is
 * refused; archive instead"). Translated here so the caller gets the *advice*
 * rather than a storage-layer error class.
 */
export class ProjectHasHistoryError extends ProjectsError {
  override readonly name = 'ProjectHasHistoryError';

  constructor(readonly projectId: string) {
    super(
      'project_has_history',
      `Project ${projectId} has sessions or assignments recorded against it, so its row cannot be ` +
        'deleted — that history is what the timeline reads. Archive it instead (DESIGN §2.3).',
      409,
      { projectId },
    );
  }
}

/** No free slug was available — 9998 projects share one name. Practically unreachable. */
export class SlugExhaustedError extends ProjectsError {
  override readonly name = 'SlugExhaustedError';

  constructor(readonly base: string) {
    super(
      'slug_exhausted',
      `No unused slug is available for "${base}"; give the project an explicit name.`,
      409,
      { base },
    );
  }
}
