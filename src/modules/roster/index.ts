/**
 * The roster element's public surface (roster DESIGN.md §1).
 *
 * M1 is the schema and nothing else: the types every other element joins on,
 * the one validator, and the canonical byte-form. The file store and registry
 * (M2), the CRUD service and routes (M3) and the option compiler (M4) land
 * behind this same barrel, so consumers never learn a second import path.
 *
 * Nothing here imports `@anthropic-ai/claude-agent-sdk`. The dependency is
 * pinned (M0, `docs/roster/SDK-NOTES.md`) for M4's option compiler, which is
 * the only file in the system allowed to see SDK option shapes (§13).
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
