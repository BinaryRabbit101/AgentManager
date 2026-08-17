/**
 * The projects element — the registry of the things agents get pointed at.
 *
 * Milestones landed here: **M1** (schema, path identity, slug generation, the
 * typed repository, module registration), **M2** (register an existing folder:
 * inspect + create), **M4** (defaults, permission override storage, environment
 * entries and the launch-context call) and **M6** (workspace leases: the primary
 * tree, git worktrees, orphan reconciliation).
 *
 * M3's clone flow, M5's activity timeline and retention, M7's scope rewriting,
 * M8's work items and M9's lifecycle endpoints are deliberately not here — the
 * tables they need exist (`migrations/projects/0001_registry.sql`), the code
 * does not.
 *
 * `GET /api/fs/browse` (`browse.ts`) is the exception, and it is pulled forward
 * on purpose: it was scheduled with M9, but ui M2's quick-add is the *only*
 * consumer it has and cannot register a folder from a browser without it (ui
 * §8.1). It is implemented to §2.1's rules in full — resolve first, compare
 * second; escaping entries omitted; UNC refused — rather than as a stub.
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
  type ListProjectsOptions,
  type ProjectRepository,
  type ProjectRepositoryOptions,
  type UpdateProjectPatch,
} from './repository.js';

export {
  createWorkspaceService,
  type AcquireWorkspaceOptions,
  type OrphanReconciliation,
  type ReleaseWorkspaceOptions,
  type WorkspaceReleaseResult,
  type WorkspaceService,
  type WorkspaceServiceOptions,
} from './workspaces.js';

export {
  createWorkspaceLeaseRepository,
  type CreateLeaseInput,
  type WorkspaceLeaseRepository,
} from './leases.js';

export { createKeyedMutex, type KeyedMutex, type Release } from './mutex.js';

export {
  browse,
  isInsideRoots,
  NetworkPathError,
  PathOutsideBrowseRootsError,
  resolveBrowseRoots,
  type BrowseDeps,
  type BrowseEntry,
  type BrowseListing,
} from './browse.js';

export {
  addWorktree,
  commitsSince,
  createCommandRunner,
  deleteBranch,
  headCommit,
  isDirty,
  pruneWorktrees,
  readLongPathsEnabled,
  removeDirectoryWithRetry,
  removeWorktree,
  repositoryBusyReason,
  shortAssignmentId,
  worktreeNaming,
  worktreePathBudget,
  MAX_PATH,
  SHORT_ASSIGNMENT_ID_LENGTH,
  WORKTREE_PATH_HEADROOM,
  type CommandResult,
  type CommandRunner,
  type LongPathProbe,
  type PathBudget,
  type RemoveDirectoryOptions,
  type RemoveDirectoryResult,
  type WorktreeNaming,
} from './worktree.js';

export {
  getEffectiveLaunchContext,
  readInstructionsFile,
  resolveInstructionsPath,
  type LaunchContextDeps,
} from './launchContext.js';

export {
  mergeDefaults,
  readAgentIds,
  readEnvEntries,
  readInstructionsPath,
  readPermissionElevation,
  readPermissionOverride,
  readProjectPatch,
  FORBIDDEN_ENV_NAMES,
  type ProjectPatchRequest,
} from './settings.js';

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
  ForbiddenEnvNameError,
  GitWorktreePathError,
  InvalidPathError,
  InvalidRequestError,
  MissingElevationReasonError,
  NestedProjectError,
  PathInDataRootError,
  PathNotDirectoryError,
  PathNotFoundError,
  PathNotWritableError,
  ProjectNotFoundError,
  ProjectNotLaunchableError,
  ProjectsError,
  SlugExhaustedError,
  WorkspaceLeaseNotFoundError,
  WorkspaceNotLeasedError,
  type NestingRelation,
} from './errors.js';

export {
  isProjectStatus,
  isVcs,
  isWorkspaceKind,
  isWorkspaceLeaseState,
  isWorkspacePolicy,
  isWorkspaceRefusal,
  BUILT_IN_RETENTION_DEFAULTS,
  PROJECT_STATUSES,
  VCS_KINDS,
  WORKSPACE_KINDS,
  WORKSPACE_LEASE_STATES,
  WORKSPACE_POLICIES,
  type AcquireWorkspaceResult,
  type EnvEntry,
  type LaunchContext,
  type PermissionElevation,
  type PermissionOverride,
  type Project,
  type ProjectDefaults,
  type ProjectHealth,
  type ProjectHealthCondition,
  type ProjectId,
  type ProjectStatus,
  type RetentionDefaults,
  type RetentionSettings,
  type Vcs,
  type WorkspaceKind,
  type WorkspaceLease,
  type WorkspaceLeaseState,
  type WorkspaceListEntry,
  type WorkspacePolicy,
  type WorkspaceRefusal,
  type WorkspaceRefusalCode,
  type WorkspaceReview,
} from './types.js';
