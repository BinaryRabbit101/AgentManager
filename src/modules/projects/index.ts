/**
 * The projects element — the registry of the things agents get pointed at.
 *
 * Every v1 milestone through M9 is landed here: **M1** (schema, path identity,
 * slug generation, the typed repository, module registration), **M2** (register
 * an existing folder: inspect + create), **M3** (clone from a repo URL, as a
 * tracked background job with streamed progress), **M4** (defaults, permission
 * override storage, environment entries and the launch-context call), **M5**
 * (the activity timeline and transcript retention), **M6** (workspace leases:
 * the primary tree, git worktrees, orphan reconciliation), **M7** (scope
 * rewriting onto the leased workspace and the overlap warning), **M8** (the
 * backlog and its derived statuses) and **M9** (archive/restore, remove,
 * relocate, the derived health payload, and `GET /api/fs/browse`).
 *
 * Three files are worth knowing about before reading any of the others:
 * `types.ts` holds the vocabulary and defines nothing anybody else owns;
 * `service.ts` is what `ctx.require('projects')` answers with; and `scope.ts`
 * is the one place a permission-shaped string is produced — as **input** for
 * roster's compiler, never as an effective set (§1.3, §7.6).
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
  type RemoveProjectOptions,
  type RemoveProjectResult,
} from './service.js';

export {
  createCloneService,
  createGitCloneRunner,
  defaultTargetPath,
  parseCloneProgress,
  type CloneOutcome,
  type CloneProgress,
  type CloneProjectRequest,
  type CloneService,
  type CloneServiceOptions,
  type CloneStarted,
  type GitCloneRunner,
  type RepoInspection,
} from './clone.js';

export { parseRepoUrl, type ParsedRepoUrl, type RepoUrlScheme } from './repoUrl.js';

export {
  deriveOutcome,
  readProjectActivity,
  DEFAULT_ACTIVITY_LIMIT,
  MAX_ACTIVITY_LIMIT,
  type ActivityDeps,
  type ActivityOptions,
  type ActivitySession,
  type AssignmentOutcome,
  type ProjectActivityEntry,
  type ProjectActivityPage,
} from './activity.js';

export {
  effectiveRetention,
  pruneProject,
  runRetention,
  transcriptAge,
  RETENTION_INTERVAL_MS,
  type ProjectPruneResult,
  type RetentionDeps,
  type RetentionRunResult,
} from './retention.js';

export {
  findScopeOverlaps,
  normaliseScopePath,
  overlappingPrefixes,
  rewriteScopeRules,
  summariseScope,
  toRuleRoot,
  type NormalisedScopePath,
  type ScopeClaim,
  type ScopeOverlap,
  type WorkspaceScopeRules,
} from './scope.js';

export {
  createWorkItemRepository,
  type CreateWorkItemInput,
  type ListWorkItemsOptions,
  type UpdateWorkItemPatch,
  type WorkItemRepository,
} from './workItems.js';

export { deriveProjectHealth, type HealthDeps } from './health.js';

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
  CloneTargetExistsError,
  DuplicateProjectError,
  ForbiddenEnvNameError,
  GitWorktreePathError,
  InvalidPathError,
  InvalidRepoUrlError,
  InvalidRequestError,
  MissingElevationReasonError,
  NestedProjectError,
  PathInDataRootError,
  PathNotDirectoryError,
  PathNotFoundError,
  PathNotWritableError,
  ProjectHasHistoryError,
  ProjectNotFoundError,
  ProjectNotLaunchableError,
  ProjectNotMissingError,
  ProjectsError,
  SlugExhaustedError,
  WorkItemNotFoundError,
  WorkItemProjectMismatchError,
  WorkspaceLeaseNotFoundError,
  WorkspaceNotLeasedError,
  WorktreesOutstandingError,
  type NestingRelation,
} from './errors.js';

export {
  isProjectStatus,
  isVcs,
  isWorkItemKind,
  isWorkItemSource,
  isWorkItemStatus,
  isWorkspaceKind,
  isWorkspaceLeaseState,
  isWorkspacePolicy,
  isWorkspaceRefusal,
  projectLaunchBlock,
  BUILT_IN_RETENTION_DEFAULTS,
  PROJECT_STATUSES,
  VCS_KINDS,
  WORK_ITEM_KINDS,
  WORK_ITEM_SOURCES,
  WORK_ITEM_STATUSES,
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
  type WorkItem,
  type WorkItemKind,
  type WorkItemSource,
  type WorkItemStatus,
  type WorkspaceKind,
  type WorkspaceLease,
  type WorkspaceLeaseState,
  type WorkspaceListEntry,
  type WorkspacePolicy,
  type WorkspaceRefusal,
  type WorkspaceRefusalCode,
  type WorkspaceReview,
} from './types.js';
