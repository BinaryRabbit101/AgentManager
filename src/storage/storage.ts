/**
 * `openStorage` — the whole of DESIGN §1.2/§1.3 boot sequence in one call.
 *
 * Bootstrap the data root → open the database with the §1.3 pragmas →
 * `quick_check` → apply pending migrations behind a backup (foundation's core
 * set first, then each module's, §1.3) → seed `schema_meta` → build the `Store`
 * repositories of §1.4 → prune `events` to its retention (§1.4). Storage is the
 * first `critical` module (§6.2), so every step here either succeeds or throws;
 * nothing degrades quietly.
 *
 * It takes plain options rather than a `ModuleContext`: config (§2) and logging
 * (§5) are separate modules that the composition root (M7) wires together, and
 * storage must also be openable from an install script and from a test with
 * neither present.
 */
import { backupDatabase, newestBackup, type BackupInfo } from './backups.js';
import { closeDatabase, openDatabase } from './engine.js';
import { bootstrapDataRoot, type BootstrapOptions } from './bootstrap.js';
import { newIdAt } from './ids.js';
import { silentLog, type LogFn } from './log.js';
import {
  FOUNDATION_SET_ID,
  moduleMigrationSets,
  runMigrations,
  userVersionTracker,
  type AppliedMigration,
  type MigrationSet,
  type ModuleMigrations,
} from './migrations.js';
import { defaultMigrationsDir, type DataRootPaths } from './paths.js';
import { createStore, type Store } from './repositories/index.js';
import type { EventRetention } from './repositories/events.js';
import type { Database } from './sqlite.js';
import { isoTimestamp, systemClock, type Clock } from './time.js';

/**
 * §1.4's "Retention: 30 days or 200k rows, pruned on boot", which is also
 * §2.3's `retention.eventDays` / `retention.eventMaxRows` default pair.
 *
 * Restated here rather than imported from the config module because storage
 * must open without config present (install scripts, tests); the composition
 * root passes the configured values through.
 */
export const DEFAULT_EVENT_RETENTION: EventRetention = {
  eventDays: 30,
  eventMaxRows: 200_000,
};

export interface OpenStorageOptions extends Omit<BootstrapOptions, 'log'> {
  /** Foundation's numbered set. Defaults to the packaged `migrations/` directory. */
  readonly migrationsDir?: string;
  /**
   * Element-owned migration sets, **in module topological order** (§1.3).
   *
   * The order is the module system's to produce (M7); storage applies what it
   * is given, after foundation's core set, and tracks each in
   * `schema_migrations`.
   */
  readonly moduleMigrations?: readonly ModuleMigrations[];
  /** `events` retention. Defaults to {@link DEFAULT_EVENT_RETENTION}. */
  readonly retention?: EventRetention;
  /** Skip the boot-time `events` prune. For tests that assert on it themselves. */
  readonly pruneEvents?: boolean;
  readonly log?: LogFn;
  /** Injectable clock, so `schema_meta.created_at` is testable (§6.1). */
  readonly clock?: Clock;
}

export interface Storage {
  /**
   * The one open handle.
   *
   * Present for foundation's own use — the composition root, the migration
   * runner, diagnostics. Feature modules receive {@link Storage.store} through
   * `ctx.store` and never this (§1.3).
   */
  readonly db: Database;
  /** The typed repositories of §1.4 — this is `ctx.store`. */
  readonly store: Store;
  readonly paths: DataRootPaths;
  /** `PRAGMA user_version` after migrations — foundation's schema version. */
  readonly schemaVersion: number;
  /** Final version of every applied set, keyed by set id (`foundation`, module ids). */
  readonly setVersions: Readonly<Record<string, number>>;
  /** Stable identifier for this installation, minted on first run. */
  readonly installId: string;
  /** Migrations applied by this boot. Empty on a re-run. */
  readonly applied: readonly AppliedMigration[];
  /** Backup taken by this boot, if any migration ran. */
  readonly backupPath?: string;
  /** Newest backup on disk, whether or not this boot wrote it. */
  newestBackup(): BackupInfo | undefined;
  /** Checkpoints the WAL and closes the handle (§4.2). Idempotent. */
  close(): void;
}

/**
 * Seeds `schema_meta` with the rows §1.4 names: schema version, install id,
 * created_at.
 *
 * Application code rather than SQL because two of the three values cannot be
 * written by a migration file: the install id is a ULID minted at runtime
 * (§1.3) and `created_at` comes from the injectable clock. `INSERT OR IGNORE`
 * for both, so they are written once on first run and never rewritten — an
 * install id that changed on the second boot would not be an install id.
 */
function seedSchemaMeta(db: Database, schemaVersion: number, now: Date): string {
  const insertOnce = db.prepare<[string, string]>(
    'INSERT OR IGNORE INTO schema_meta (key, value) VALUES (?, ?)',
  );
  const upsert = db.prepare<[string, string]>(
    'INSERT INTO schema_meta (key, value) VALUES (?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );

  const seed = db.transaction(() => {
    insertOnce.run('install_id', newIdAt(now));
    insertOnce.run('created_at', isoTimestamp(now));
    // The one row that tracks rather than records: kept equal to
    // `user_version` so a DB browser shows the schema version without a pragma.
    upsert.run('schema_version', String(schemaVersion));
  });
  seed();

  const row = db
    .prepare<[string], { value: string }>('SELECT value FROM schema_meta WHERE key = ?')
    .get('install_id');
  return row?.value ?? '';
}

/**
 * Brings storage up for a data root, returning the open {@link Storage}.
 *
 * Throws `DatabaseIntegrityError` when `quick_check` fails (naming the newest
 * backup to restore from), `MigrationError` when a migration fails (having
 * rolled it back), and `MigrationSetError` when the migration directory itself
 * is malformed. All three are fatal at boot by §1.3.
 */
export function openStorage(options: OpenStorageOptions): Storage {
  const log = options.log ?? silentLog;
  const clock = options.clock ?? systemClock;
  const migrationsDir = options.migrationsDir ?? defaultMigrationsDir();

  const { paths } = bootstrapDataRoot({ ...options, log });

  const db = openDatabase({
    databasePath: paths.database,
    backupsDir: paths.backups,
    log,
  });

  const backup = (schemaVersion: number): string =>
    backupDatabase({
      db,
      databasePath: paths.database,
      backupsDir: paths.backups,
      schemaVersion,
      at: clock(),
    });

  try {
    const foundationSet: MigrationSet = {
      id: FOUNDATION_SET_ID,
      dir: migrationsDir,
      tracker: userVersionTracker(db),
    };

    // Foundation's core set first, unconditionally: `schema_migrations` and
    // every table a module might reference come from it.
    const sets: MigrationSet[] = [
      foundationSet,
      ...moduleMigrationSets(db, options.moduleMigrations ?? [], clock),
    ];

    const result = runMigrations({ db, sets, backup, log });
    const schemaVersion = result.versions[FOUNDATION_SET_ID] ?? 0;
    const installId = seedSchemaMeta(db, schemaVersion, clock());

    const store = createStore({ db, transcriptsRoot: paths.transcripts, clock });

    if (options.pruneEvents !== false) {
      const retention = options.retention ?? DEFAULT_EVENT_RETENTION;
      const pruned = store.events.prune(retention, clock());
      if (pruned.byAge + pruned.byCap > 0) {
        log('info', 'pruned events to retention', { ...pruned, ...retention });
      }
    }

    log('info', 'storage ready', {
      dataRoot: paths.dataRoot,
      schemaVersion,
      migrationsApplied: result.applied.length,
    });

    const base = {
      db,
      store,
      paths,
      schemaVersion,
      setVersions: result.versions,
      installId,
      applied: result.applied,
      newestBackup: () => newestBackup(paths.backups),
      close: () => closeDatabase(db, log),
    };
    return result.backupPath === undefined ? base : { ...base, backupPath: result.backupPath };
  } catch (error) {
    // A half-opened storage must not leave a handle (and a WAL) behind for a
    // caller that is about to exit on this error.
    closeDatabase(db, log);
    throw error;
  }
}
