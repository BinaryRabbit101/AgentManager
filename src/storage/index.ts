/**
 * Storage — the SQLite engine, the data-root tree, the migration runner, the
 * core schema's typed repositories, and the transcript writer.
 *
 * Foundation milestones M4 (DESIGN §1.2, §1.3) and M5 (§1.4, §1.5). Module
 * registration and the wiring to config and logging are M7. Everything here
 * takes plain options, so nothing in `src/storage/` imports another module.
 *
 * The headline of M5 is {@link Store}: `ctx.store` is this object, and every
 * other element codes against the repositories hanging off it rather than
 * against SQL.
 */
export {
  openStorage,
  DEFAULT_EVENT_RETENTION,
  type OpenStorageOptions,
  type Storage,
} from './storage.js';

export { createStore, type CreateStoreOptions, type Store } from './repositories/index.js';
export type {
  AgentInput,
  AgentRecord,
  AgentsRepository,
  AnswerInput,
  AnsweredVia,
  AssignmentInput,
  AssignmentMember,
  AssignmentMemberInput,
  AssignmentPattern,
  AssignmentRecord,
  AssignmentRole,
  AssignmentStatus,
  AssignmentsRepository,
  EventInput,
  EventPruneResult,
  EventQuery,
  EventRecord,
  EventRetention,
  EventsRepository,
  ListAgentsOptions,
  ListAssignmentsOptions,
  ListProjectsOptions,
  ListSessionsFilter,
  MailboxOptions,
  MessageInput,
  MessageRecord,
  MessagesRepository,
  ProjectInput,
  ProjectPatch,
  ProjectRecord,
  ProjectsRepository,
  QuestionInput,
  QuestionKind,
  QuestionRecommendation,
  QuestionRecord,
  QuestionStatus,
  QuestionsRepository,
  RecommendationInput,
  RemoteTokenInput,
  RemoteTokenRecord,
  RemoteTokensRepository,
  SessionInput,
  SessionOrigin,
  SessionPatch,
  SessionRecord,
  SessionStatus,
  SessionsRepository,
  SettingRecord,
  SettingsRepository,
  UsageDelta,
  UsageEvent,
  UsageRepository,
  UsageTotals,
} from './repositories/index.js';

export {
  createTranscriptStore,
  transcriptRelativePath,
  DEFAULT_FSYNC_EVERY_LINES,
  DEFAULT_FSYNC_INTERVAL_MS,
  TRANSCRIPT_EXTENSION,
  type TranscriptEntry,
  type TranscriptPrunedReason,
  type TranscriptStore,
  type TranscriptStoreOptions,
  type TranscriptTail,
  type TranscriptTailOk,
  type TranscriptTailOptions,
  type TranscriptTailPruned,
  type TranscriptWriter,
  type TranscriptWriterOptions,
} from './transcripts.js';

export { bootstrapDataRoot, type BootstrapOptions, type BootstrapResult } from './bootstrap.js';
export {
  dataRootPaths,
  defaultMigrationsDir,
  managedDirectories,
  DATABASE_FILENAME,
  type DataRootPathOptions,
  type DataRootPaths,
} from './paths.js';

export {
  assertIntegrity,
  closeDatabase,
  isDatabaseOpen,
  openDatabase,
  OPEN_PRAGMAS,
  type OpenDatabaseOptions,
} from './engine.js';

export {
  discoverMigrations,
  moduleMigrationSets,
  runMigrations,
  schemaMigrationsTracker,
  userVersionTracker,
  FOUNDATION_SET_ID,
  type AppliedMigration,
  type BackupFn,
  type MigrationFile,
  type MigrationRunResult,
  type MigrationSet,
  type MigrationTracker,
  type ModuleMigrations,
  type RunMigrationsOptions,
} from './migrations.js';

export {
  backupDatabase,
  backupFilename,
  listBackups,
  newestBackup,
  type BackupInfo,
  type BackupRequest,
} from './backups.js';

export {
  currentUserPrincipal,
  describeAclOutcome,
  tightenDirectoryAcl,
  type AclOutcome,
  type IcaclsRunner,
  type TightenAclOptions,
} from './acl.js';

export {
  DatabaseAlreadyOpenError,
  DatabaseIntegrityError,
  MigrationError,
  MigrationSetError,
  RecordNotFoundError,
  RestrictedDeleteError,
  StorageError,
} from './errors.js';

export { isId, newId, newIdAt, ULID_LENGTH } from './ids.js';
export {
  filenameTimestamp,
  isIsoTimestamp,
  isoTimestamp,
  systemClock,
  ISO_TIMESTAMP_PATTERN,
  type Clock,
} from './time.js';
export { silentLog, type LogFn, type LogLevel } from './log.js';
export type { Database } from './sqlite.js';
