/**
 * Storage — the SQLite engine, the data-root tree, and the migration runner.
 *
 * Foundation milestone M4 (DESIGN §1.2, §1.3). The core schema and the typed
 * repositories of §1.4 are M5 and land on top of this; module registration and
 * the wiring to config and logging are M7. Everything here takes plain options,
 * so nothing in `src/storage/` imports another module.
 */
export { openStorage, type OpenStorageOptions, type Storage } from './storage.js';

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
  runMigrations,
  userVersionTracker,
  FOUNDATION_SET_ID,
  type AppliedMigration,
  type BackupFn,
  type MigrationFile,
  type MigrationRunResult,
  type MigrationSet,
  type MigrationTracker,
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
