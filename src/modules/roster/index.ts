/**
 * The roster element's public surface (roster DESIGN.md §1).
 *
 * M1 is the schema and nothing else: the types every other element joins on,
 * the one validator, and the canonical byte-form. The file store and registry
 * (M2), the CRUD service and routes (M3) and the option compiler (M4) land
 * behind this same barrel, so consumers never learn a second import path.
 *
 * The SDK (`@anthropic-ai/claude-agent-sdk`, pinned by M0 —
 * `docs/roster/SDK-NOTES.md`) is reached from exactly three modules behind this
 * barrel: `sessionOptions.ts`, for the `Options` type, `compileSession.ts`,
 * which constructs it, and — since M8 — `draft.ts`, which holds the one
 * `query()` call roster makes (§12.2, §13: "Roster never calls `query()` except
 * for the drafting call in §12"). Every other module here, the schema included,
 * still has no import of it.
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
  grantTool,
  isScopedRule,
  outcomeForTool,
  removesToolDefinition,
  ruleTool,
  sortRules,
} from './permissions.js';

// The two SDK-spike corrections the compiler applies before composing
// (runner SDK-NOTES C2, orchestrator SDK-NOTES C1).
export {
  ASK_USER_QUESTION_TOOL,
  CANONICAL_FILE_EDIT_TOOL,
  FILE_EDIT_ALIASES,
  FILE_EDIT_TOOLS,
  allowsAskUserQuestion,
  collapsesToBareTool,
  normaliseAllowRules,
  normaliseGuardRules,
  ruleContent,
} from './sdkRules.js';
export type { NormalisedRules } from './sdkRules.js';

// M5 — skills packaging (DESIGN §7).
export {
  SKILL_TOOL,
  isAbsoluteAgentDir,
  listSkillNames,
  missingSkillFolders,
  pluginConfigFor,
  skillsEnableSet,
  validateSkills,
} from './skills.js';
export type { AgentPluginConfig, SkillsEnableSet } from './skills.js';

// M5/M6 — the session-start assertion and §10's MCP status mapping.
export { MCP_SERVER_STATUSES, assertSessionStart, mcpServerDiagnostics } from './initMessage.js';
export type { McpServerStatus, RequestedSessionSurface, SessionInitFacts } from './initMessage.js';

// M6 — integrations and secret resolution (DESIGN §10).
export {
  compileIntegrations,
  integrationCredentialStatus,
  integrationSecretRefs,
  mcpToolPrefix,
  validateIntegrationAllowRules,
} from './integrations.js';
export type {
  CompiledHttpServer,
  CompiledIntegrations,
  CompiledMcpServer,
  CompiledSseServer,
  CompiledStdioServer,
  CompileIntegrationsInput,
  IntegrationCredentialStatus,
  IntegrationSecretRef,
} from './integrations.js';

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

// M7 — capabilities, roles and the overseer surface (DESIGN §11, §13/R1).
export {
  ORCHESTRATION_SERVER,
  ORCHESTRATION_TOOL_PREFIX,
  OVERSEER_DEFAULT_MAX_BUDGET_USD,
  OVERSEER_DEFAULT_MAX_TURNS,
  OVERSEER_MODEL_FLOOR,
  OVERSEER_ONLY_TOOL_NAMES,
  OVERSEER_PROJECTION_FORBIDDEN_KEYS,
  OVERSEER_TOOL_NAMES,
  SUBAGENT_TOOL_NAMES,
  WORKER_TOOL_NAMES,
  applyOrchestrationGrant,
  isOrchestrationRule,
  isOverseer,
  modelTierRelativeToFloor,
  orchestrationRule,
  orchestrationToolNames,
  overseerModelDiagnostic,
  projectRosterForOverseer,
} from './overseer.js';
export type {
  OrchestrationGrant,
  OrchestrationGrantInput,
  OverseerRosterEntry,
} from './overseer.js';

export {
  ROLES_DIRNAME as ROLE_ADDENDA_DIRNAME,
  readRoleAddenda,
  roleAddendumFile,
} from './roleAddenda.js';
export type { RoleAddenda } from './roleAddenda.js';

// M8 — draft-from-description (DESIGN §12).
export {
  CATALOGUE_RULES,
  DRAFT_MAX_TURNS,
  DRAFT_MODEL,
  DRAFT_P50_BUDGET_MS,
  MODEL_TIERS,
  PERMISSION_RULE_CATALOGUE,
  draftFromDescription,
  draftOptions,
  draftRepairPrompt,
  draftRequestSchema,
  draftSystemPrompt,
  draftUserPrompt,
  extractFencedJson,
  realDraftQuery,
  sanitisePermissions,
} from './draft.js';
export type {
  AgentDraft,
  DraftDeps,
  DraftMessage,
  DraftQueryFn,
  DraftRequest,
  DraftResponse,
  ModelTier,
  SuggestedIntegration,
  SuggestedSkill,
} from './draft.js';

export { SessionCompileError } from './sessionOptions.js';
export type {
  AssignmentContext,
  ClaudeAgentSdkOptions,
  CompilableAgent,
  CompileSessionInput,
  CompiledSession,
  ProjectContext,
  SessionToolsetHandle,
  SessionToolsetProvider,
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
  TEMPLATES_DIRNAME,
  TEMP_PREFIX,
  archiveStamp,
  createRosterStore,
  ensurePluginManifest,
  folderRelativePathProblem,
  libraryPaths,
  parseArchiveFolder,
  parseArchiveStamp,
  pluginManifest,
  writeFileAtomic,
} from './store.js';
export type {
  ArchiveEntry,
  FolderFile,
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
  readRosterMetadata,
  writeRosterMetadata,
} from './bootstrap.js';

// M10 — the starter roster and the library README (DESIGN §2.1).
export {
  ADA,
  EMAIL_REPLY_DRAFTS,
  LIBRARY_README,
  LIBRARY_README_FILENAME,
  MIRA,
  PRIYA,
  SAM,
  SEED_AGENTS,
  SEED_TEMPLATES,
  TODO_TICKET_REPLIES,
  seedDefinition,
  seedLibrary,
  seedTemplateDefinition,
  seedTemplates,
  writeLibraryReadme,
} from './seed.js';
export type {
  SeedAgent,
  SeedLibraryOptions,
  SeedResult,
  SeedTemplate,
  SeedTemplatesOptions,
  SeedTemplatesResult,
} from './seed.js';
export type {
  BootstrapLibraryOptions,
  BootstrapResult,
  GitCommand,
  GitCommandResult,
  RosterMetadata,
} from './bootstrap.js';

export { createRosterRegistry } from './registry.js';
export type { RegistryChange, RosterRegistry } from './registry.js';

// WO5 — task templates (DESIGN §2.4): the library's second kind of file.
export {
  TASK_TEMPLATE_SCHEMA_VERSION,
  TEMPLATE_JSON_FILENAME,
  TEMPLATE_VARIABLES,
  createTemplateRegistry,
  createTemplateStore,
  missingIntegrations,
  parseTaskTemplate,
  parseTaskTemplateJson,
  renderTemplateText,
  safeParseTaskTemplate,
  serialiseTaskTemplate,
  taskTemplateSchema,
  templateIdProblem,
  templateIdSchema,
  templateVariables,
} from './templates.js';
export type {
  ResolvedTemplate,
  TaskTemplate,
  TemplateIntegrationGap,
  TemplateLoadOutcome,
  TemplateParseResult,
  TemplateRegistry,
  TemplateRegistryChange,
  TemplateStore,
  TemplateStoreOptions,
  TemplateVariable,
} from './templates.js';

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

// M9 — import / export (DESIGN §9.4).
export {
  PACK_AGENT_PREFIX,
  PACK_CONTENT_TYPE,
  PACK_EXTENSION,
  PACK_MANIFEST_FILENAME,
  PACK_VERSION,
  assertNoSecretValues,
  buildAgentPack,
  packEntryProblem,
  packFilename,
  packManifestSchema,
  readAgentPack,
  requiredSecretSchema,
  requiredSecretsFor,
  secretValueViolations,
} from './pack.js';
export type {
  BuildAgentPackInput,
  PackFile,
  PackManifest,
  ReadAgentPack,
  RequiredSecret,
  SecretValueViolation,
} from './pack.js';

export { createRosterService } from './service.js';
export type {
  AgentView,
  AllowRuleResult,
  DeleteResult,
  ExportedPack,
  ImportPreview,
  ImportResult,
  ProjectDefaultsProvider,
  RosterChangeReason,
  RosterListView,
  RosterService,
  RosterServiceOptions,
  TaskTemplateListView,
  TaskTemplateView,
  ValidateResult,
} from './service.js';

// The preflight §9.1 hangs off `validate`: which tools would stop and ask.
export { PREFLIGHT_TOOL_CATALOGUE, gateLiableTools } from './preflight.js';
export type { GateLiableTool } from './preflight.js';

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
  InvalidAgentPackError,
  InvalidRosterRequestError,
  LibraryWriteError,
  PackSchemaVersionError,
  PackSecretValueError,
  PurgeBlockedError,
  RosterServiceError,
  TemplateNotFoundError,
  UnknownBoardOrderIdError,
} from './serviceErrors.js';
