/**
 * The roster element's public surface (roster DESIGN.md §1).
 *
 * M1 is the schema and nothing else: the types every other element joins on,
 * the one validator, and the canonical byte-form. The file store and registry
 * (M2), the CRUD service and routes (M3) and the option compiler (M4) land
 * behind this same barrel, so consumers never learn a second import path.
 *
 * The SDK (`@anthropic-ai/claude-agent-sdk`, pinned by M0 —
 * `docs/roster/SDK-NOTES.md`) is reached from exactly two modules behind this
 * barrel: `sessionOptions.ts`, for the `Options` type, and `compileSession.ts`,
 * which constructs it. That pair is "the only place SDK option shapes appear"
 * (§13); every other module here, the schema included, still has no import of
 * it.
 */

export {
  AGENT_ID_MAX_LENGTH,
  AGENT_ID_MIN_LENGTH,
  AGENT_ID_PATTERN,
  RESERVED_AGENT_IDS,
  agentIdProblem,
  isAgentId,
} from './ids.js';

export { credentialShapedKeyMessage, isCredentialShapedKey } from './credentialKeys.js';

export {
  AGENT_SCHEMA_VERSION,
  DEFAULT_PERSONA_FILE,
  DEFAULT_SETTING_SOURCES,
  EFFORT_LEVELS,
  IMMUTABLE_FIELDS,
  MODEL_ALIASES,
  ORIGINS,
  PERMISSION_MODES,
  PERSONA_MODES,
  ROLES,
  SKILL_MODES,
  SPECIALTIES,
  agentDefaultsSchema,
  agentDefinitionSchema,
  agentIdSchema,
  agentMetaSchema,
  avatarSchema,
  capabilitiesSchema,
  effortSchema,
  immutableFieldViolations,
  integrationConfigSchema,
  integrationsSchema,
  isSecretRef,
  modelSelectionSchema,
  originSchema,
  permissionModeRank,
  permissionModeSchema,
  permissionSetSchema,
  personaModeSchema,
  personaSchema,
  roleSchema,
  secretRefSchema,
  secretValueSchema,
  settingSourceSchema,
  skillModeSchema,
  skillsSchema,
  specialtySchema,
} from './schema.js';

export type {
  AgentDefaults,
  AgentDefinition,
  AgentId,
  AgentMeta,
  Avatar,
  Capabilities,
  Effort,
  IntegrationConfig,
  Integrations,
  ModelSelection,
  Origin,
  PermissionMode,
  PermissionSet,
  Persona,
  PersonaMode,
  Role,
  SecretRef,
  SecretValue,
  SettingSource,
  SkillMode,
  Skills,
  Specialty,
} from './schema.js';

export {
  DIAGNOSTIC_LEVELS,
  diagnosticLevelSchema,
  diagnosticSchema,
  effectivePermissionsSchema,
  permissionElevationSchema,
} from './contracts.js';

export type {
  Diagnostic,
  DiagnosticLevel,
  EffectivePermissions,
  PermissionElevation,
} from './contracts.js';

export { MIGRATIONS, migrate } from './migrate.js';
export type { AgentMigration } from './migrate.js';

export {
  canonicaliseAgentDefinition,
  parseAgentDefinition,
  parseAgentDefinitionJson,
  safeParseAgentDefinition,
  serialiseAgentDefinition,
} from './parse.js';
export type { ParseResult } from './parse.js';

export { RosterValidationError, formatIssuePath, issuesFromZod } from './errors.js';
export type { RosterIssue } from './errors.js';

// M4 — permission composition and the option compiler (DESIGN §6.2, §5, §13).
// `compileSession` is the only function in the system that constructs SDK
// option shapes; `compilePermissions` is the only composer of permission rules.

export {
  DEFAULT_DENY_MESSAGE,
  DEFAULT_PERMISSION_MODE,
  MUTATING_TOOL_DENY_RULES,
  MUTATING_TOOL_NAMES,
  compilePermissions,
  isScopedRule,
  outcomeForTool,
  removesToolDefinition,
  ruleTool,
} from './permissions.js';

export type {
  AssignmentPermissionLayer,
  CanUseToolPolicy,
  CompiledPermissions,
  PermissionPolicy,
  ProjectPermissionLayer,
  RawPermissionElevation,
  RawPermissionSet,
  ToolCallOutcome,
} from './permissions.js';

export { composePersona, renderRuntimeBlock } from './persona.js';
export type {
  PersonaComposition,
  PersonaInput,
  PersonaSection,
  RuntimeBlockInput,
} from './persona.js';

export { lookupEnv, mergeAgentEnv } from './envMerge.js';
export type {
  EnvEntry,
  EnvLayer,
  LiteralEnvEntry,
  MergeEnvInput,
  MergedEnv,
  SecretEnvEntry,
} from './envMerge.js';

export { DEFAULT_MAX_BUDGET_USD, DEFAULT_MAX_TURNS, compileSession } from './compileSession.js';

export { SessionCompileError } from './sessionOptions.js';
export type {
  AssignmentContext,
  ClaudeAgentSdkOptions,
  CompilableAgent,
  CompileSessionInput,
  CompiledSession,
  ProjectContext,
} from './sessionOptions.js';
// M2+M3 — the file store, the registry, the CRUD service and its routes.

export {
  AGENTS_DIRNAME,
  AGENT_JSON_FILENAME,
  ARCHIVE_DIRNAME,
  AVATAR_FILENAME,
  GITIGNORE_FILENAME,
  PLUGIN_MANIFEST_DIRNAME,
  PLUGIN_MANIFEST_FILENAME,
  ROLES_DIRNAME,
  ROSTER_JSON_FILENAME,
  SKILLS_DIRNAME,
  TEMP_PREFIX,
  archiveStamp,
  createRosterStore,
  ensurePluginManifest,
  libraryPaths,
  parseArchiveFolder,
  parseArchiveStamp,
  pluginManifest,
  writeFileAtomic,
} from './store.js';
export type {
  ArchiveEntry,
  LibraryPaths,
  LoadOutcome,
  ResolvedAgent,
  RosterStore,
  RosterStoreOptions,
  StoreHooks,
} from './store.js';

export {
  DEFAULT_GIT_TIMEOUT_MS,
  LIBRARY_GITIGNORE,
  bootstrapLibrary,
  createGitCommand,
  isEmptyDirectory,
  libraryCommitCount,
} from './bootstrap.js';
export type {
  BootstrapLibraryOptions,
  BootstrapResult,
  GitCommand,
  GitCommandResult,
  RosterMetadata,
} from './bootstrap.js';

export { createRosterRegistry } from './registry.js';
export type { RegistryChange, RosterRegistry } from './registry.js';

export { DEFAULT_DEBOUNCE_MS, createRosterWatcher, inertWatcher } from './watcher.js';
export type { RosterWatcher, RosterWatcherOptions } from './watcher.js';

export { createAgentUiStateRepository } from './uiState.js';
export type { AgentUiState, AgentUiStatePatch, AgentUiStateRepository } from './uiState.js';

export {
  ACCEPTED_AVATAR_TYPES,
  DEFAULT_AVATAR_MAX_BYTES,
  firstFilePart,
  initialsAvatarFor,
  initialsFor,
  multipartBoundary,
  placeholderAvatar,
  placeholderColour,
  readAvatarUpload,
  sniffImageType,
} from './avatar.js';
export type { AcceptedAvatarType, AvatarImage, AvatarUpload } from './avatar.js';

export {
  FALLBACK_AGENT_SLUG,
  MAX_SLUG_ATTEMPTS,
  mintAgentId,
  slugifyAgentName,
  suffixAgentId,
} from './slug.js';

export { duplicateAgentId, duplicateDefinition } from './duplicate.js';
export type { DuplicateIdRequest } from './duplicate.js';

export { createRosterService } from './service.js';
export type {
  AgentView,
  DeleteResult,
  RosterChangeReason,
  RosterListView,
  RosterService,
  RosterServiceOptions,
} from './service.js';

export { ROSTER_API_PREFIX, createRosterRoutes } from './routes.js';
export type { RosterRoutesDeps } from './routes.js';

export { ROSTER_MODULE_ID, ROSTER_SERVICE, createRosterModule } from './module.js';
export type { RosterModuleOptions } from './module.js';

export {
  AgentArchivedError,
  AgentIdTakenError,
  AgentNotFoundError,
  AvatarNotAnImageError,
  AvatarTooLargeError,
  ImmutableFieldError,
  InvalidRosterRequestError,
  LibraryWriteError,
  PurgeBlockedError,
  RosterServiceError,
  UnknownBoardOrderIdError,
} from './serviceErrors.js';
