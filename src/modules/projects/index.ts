/**
 * The projects element — the registry of the things agents get pointed at.
 *
 * Milestones landed here: **M1** (schema, path identity, slug generation, the
 * typed repository, module registration) and **M2** (register an existing
 * folder: inspect + create). M3's clone flow, M4's defaults and launch context,
 * M5's activity timeline, M6's workspace leases and the rest of
 * `docs/projects/IMPLEMENTATION.md` are deliberately not here — the tables they
 * need exist (`migrations/projects/0001_registry.sql`), the code does not.
 */
export {
  createProjectsModule,
  PROJECTS_MODULE_ID,
  PROJECTS_SERVICE,
  type ProjectsModuleOptions,
} from './module.js';

export {
  createProjectsService,
  type CreateProjectRequest,
  type ProjectsService,
  type ProjectsServiceOptions,
} from './service.js';

export {
  createProjectRepository,
  type CreateProjectInput,
  type ProjectRepository,
  type ProjectRepositoryOptions,
  type UpdateProjectPatch,
} from './repository.js';

export {
  inspectLocalPath,
  isDirectoryEmpty,
  probeWritable,
  type InspectDeps,
  type InspectionWarning,
  type ProjectInspection,
  type RegisteredPath,
} from './inspect.js';

export { createProjectRoutes, type ProjectRoutesDeps } from './routes.js';

export {
  canonicalizePath,
  nameFromPath,
  pathKey,
  pathRelation,
  type CanonicalPath,
  type PathRelation,
} from './paths.js';

export {
  dedupeSlug,
  isSlug,
  slugify,
  FALLBACK_SLUG,
  MAX_SLUG_LENGTH,
  SLUG_PATTERN,
} from './slug.js';

export {
  parseProjectDefaults,
  parseRetention,
  serializeProjectDefaults,
  serializeRetention,
  EMPTY_PROJECT_DEFAULTS,
  type ParseWarning,
} from './defaults.js';

export {
  createGitRunner,
  detectGitPresence,
  readGitFacts,
  DEFAULT_GIT_TIMEOUT_MS,
  type GitFacts,
  type GitPresence,
  type GitResult,
  type GitRunner,
} from './git.js';

export {
  DuplicateProjectError,
  GitWorktreePathError,
  InvalidPathError,
  InvalidRequestError,
  NestedProjectError,
  PathInDataRootError,
  PathNotDirectoryError,
  PathNotFoundError,
  PathNotWritableError,
  ProjectsError,
  SlugExhaustedError,
  type NestingRelation,
} from './errors.js';

export {
  isProjectStatus,
  isVcs,
  isWorkspacePolicy,
  BUILT_IN_RETENTION_DEFAULTS,
  PROJECT_STATUSES,
  VCS_KINDS,
  WORKSPACE_POLICIES,
  type EnvEntry,
  type PermissionElevation,
  type PermissionOverride,
  type Project,
  type ProjectDefaults,
  type ProjectId,
  type ProjectStatus,
  type RetentionDefaults,
  type RetentionSettings,
  type Vcs,
  type WorkspacePolicy,
} from './types.js';
