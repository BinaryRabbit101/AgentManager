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
