/**
 * The migration runner of DESIGN §1.3.
 *
 * "Migrations: numbered SQL files `migrations/0001_init.sql`, `0002_….sql`,
 * applied in order inside one transaction on boot, tracked by
 * `PRAGMA user_version`. Before applying any migration the DB is copied to
 * `state/backups/`. Migrations are forward-only; there is no down path in v1."
 *
 * ## Shape, and why it is a list of sets
 *
 * §1.3's "Element-owned migrations" extends this to per-module sets applied
 * after foundation's, in module topological order, tracked in
 * `schema_migrations(module, version, applied_at)` while `user_version` "stays
 * reserved for foundation's own set". Rather than growing a second runner for
 * that later, the runner here already takes an ordered list of
 * {@link MigrationSet}s, each carrying its own {@link MigrationTracker}. This
 * milestone passes exactly one set — foundation's, tracked by `user_version`
 * ({@link userVersionTracker}). M5 adds a `schema_migrations`-backed tracker and
 * appends the module sets; everything else here — ordering, one transaction per
 * migration, the pre-run backup, forward-only, fatal-with-rollback — is already
 * shared and needs no change.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { MigrationError, MigrationSetError, describeError } from './errors.js';
import { silentLog, type LogFn } from './log.js';
import type { Database } from './sqlite.js';
import { isoTimestamp, systemClock, type Clock } from './time.js';

/** `NNNN_<name>.sql`, at least four digits so the set sorts as text and as a number. */
const MIGRATION_PATTERN = /^(\d{4,})_([A-Za-z0-9][A-Za-z0-9._-]*)\.sql$/;

/** The id of foundation's own set — the one tracked by `PRAGMA user_version`. */
export const FOUNDATION_SET_ID = 'foundation';

export interface MigrationFile {
  readonly version: number;
  readonly name: string;
  readonly filename: string;
  readonly path: string;
}

/**
 * Records which versions of a set have been applied.
 *
 * Two implementations exist by design (§1.3): `user_version` for foundation's
 * set, and a `schema_migrations` row per module for element-owned sets (M5).
 * "The two mechanisms never contend" is expressed here as two trackers that
 * share no state.
 */
export interface MigrationTracker {
  /** Highest version already applied to this set. `0` when none. */
  current(): number;
  /** Marks `migration` applied. Called inside that migration's transaction. */
  record(migration: MigrationFile): void;
}

export interface MigrationSet {
  /** `foundation`, or a module id. Appears in logs and errors. */
  readonly id: string;
  /** Directory holding this set's `NNNN_*.sql` files. */
  readonly dir: string;
  readonly tracker: MigrationTracker;
}

/**
 * Tracks foundation's set in `PRAGMA user_version`.
 *
 * `user_version` is a 32-bit integer in the database header, written inside the
 * migration's own transaction, so the version and the schema it describes
 * commit or roll back together. There is no bootstrap problem: an empty
 * database reports `0` without any table having to exist first, which is why
 * the design reserves it for the set that creates the first table.
 */
export function userVersionTracker(db: Database): MigrationTracker {
  return {
    current: () => Number(db.pragma('user_version', { simple: true })),
    record: (migration) => {
      // Interpolated, not bound: SQLite does not accept parameters in a PRAGMA.
      // The value is a validated integer from the filename, never user input.
      db.pragma(`user_version = ${migration.version}`);
    },
  };
}

/**
 * Tracks one module's set in `schema_migrations` (§1.3).
 *
 * "Module migrations are tracked per module in `schema_migrations(module TEXT,
 * version INTEGER, applied_at TEXT, PRIMARY KEY (module, version))`.
 * `user_version` stays reserved for foundation's own set; the two mechanisms
 * never contend."
 *
 * A row per applied migration rather than a single high-water row: the ledger
 * then answers "when did this module's 0003 land", which is the question asked
 * when a module misbehaves after an upgrade, and it is written inside the
 * migration's own transaction so the row and the schema it describes commit
 * together.
 *
 * The table is created by foundation's `0001_init.sql`, which always runs
 * first, so a module's very first migration has somewhere to be recorded.
 */
export function schemaMigrationsTracker(
  db: Database,
  moduleId: string,
  clock: Clock = systemClock,
): MigrationTracker {
  return {
    current: () =>
      db
        .prepare<[string], { version: number | null }>(
          'SELECT MAX(version) AS version FROM schema_migrations WHERE module = ?',
        )
        .get(moduleId)?.version ?? 0,
    record: (migration) => {
      db.prepare<[string, number, string]>(
        'INSERT INTO schema_migrations (module, version, applied_at) VALUES (?, ?, ?)',
      ).run(moduleId, migration.version, isoTimestamp(clock()));
    },
  };
}

/** One module's shipped migration directory: `migrations/<moduleId>/`. */
export interface ModuleMigrations {
  /** The module id, exactly as `Module.id` and `dependsOn` spell it. */
  readonly moduleId: string;
  /** Absolute path to `migrations/<moduleId>/`. */
  readonly dir: string;
}

/**
 * Turns an **already topologically ordered** module list into migration sets.
 *
 * §1.3: module sets are applied "in module topological order — the same order
 * `dependsOn` produces at start-up, so a module's tables exist before any
 * module that depends on it runs". The ordering itself is the module system's
 * (M7): it owns `dependsOn` and the cycle detection, and duplicating a
 * topological sort here would give the project two answers to the same
 * question. This function preserves the order it is given and does not sort.
 *
 * Modules with no `migrations/<moduleId>/` directory are skipped rather than
 * failing: shipping migrations is optional, and most modules have no tables.
 */
export function moduleMigrationSets(
  db: Database,
  modules: readonly ModuleMigrations[],
  clock: Clock = systemClock,
): readonly MigrationSet[] {
  const seen = new Set<string>();
  const sets: MigrationSet[] = [];

  for (const module of modules) {
    if (module.moduleId === FOUNDATION_SET_ID) {
      throw new MigrationSetError(
        `A module may not use the reserved set id "${FOUNDATION_SET_ID}": ` +
          "`user_version` tracks foundation's own set and the two must not contend (§1.3).",
      );
    }
    if (seen.has(module.moduleId)) {
      throw new MigrationSetError(
        `Module "${module.moduleId}" appears twice in the migration order; ` +
          'each module contributes exactly one set.',
      );
    }
    seen.add(module.moduleId);

    if (!existsSync(module.dir)) continue;
    sets.push({
      id: module.moduleId,
      dir: module.dir,
      tracker: schemaMigrationsTracker(db, module.moduleId, clock),
    });
  }

  return sets;
}

/**
 * Reads a set's migration files, in ascending version order.
 *
 * Subdirectories are skipped: §1.3 places element-owned sets at
 * `migrations/<moduleId>/`, so foundation's own directory contains module
 * directories that are emphatically not part of foundation's set.
 *
 * A `.sql` file whose name does not match `NNNN_<name>.sql` is an error rather
 * than something quietly ignored — a migration silently skipped because of a
 * typo is the worst outcome available here.
 */
export function discoverMigrations(dir: string): readonly MigrationFile[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (error) {
    throw new MigrationSetError(`Cannot read migration directory ${dir}: ${describeError(error)}`, {
      cause: error,
    });
  }

  const found = new Map<number, MigrationFile>();
  for (const filename of entries) {
    const path = resolve(dir, filename);
    if (statSync(path).isDirectory()) continue;
    if (!filename.toLowerCase().endsWith('.sql')) continue;

    const match = MIGRATION_PATTERN.exec(filename);
    if (match === null) {
      throw new MigrationSetError(
        `Migration filename ${filename} in ${dir} does not match NNNN_<name>.sql`,
      );
    }

    const version = Number(match[1]);
    if (version <= 0) {
      throw new MigrationSetError(
        `Migration ${filename} has version ${version}; versions start at 1`,
      );
    }
    const clash = found.get(version);
    if (clash !== undefined) {
      throw new MigrationSetError(
        `Migrations ${clash.filename} and ${filename} in ${dir} share version ${version}`,
      );
    }

    found.set(version, { version, name: match[2] as string, filename, path });
  }

  return [...found.values()].sort((a, b) => a.version - b.version);
}

/** Takes the pre-migration backup and returns its path. */
export type BackupFn = (schemaVersion: number) => string;

export interface RunMigrationsOptions {
  readonly db: Database;
  /** Applied in this order. M5 appends module sets in topological order. */
  readonly sets: readonly MigrationSet[];
  /** Called at most once per run, immediately before the first migration is applied. */
  readonly backup: BackupFn;
  readonly log?: LogFn;
}

export interface AppliedMigration {
  readonly setId: string;
  readonly version: number;
  readonly name: string;
}

export interface MigrationRunResult {
  readonly applied: readonly AppliedMigration[];
  /** Present only when at least one migration ran. */
  readonly backupPath?: string;
  /** Final version of each set, keyed by set id. */
  readonly versions: Readonly<Record<string, number>>;
}

/**
 * Applies every pending migration, in set order then version order.
 *
 * One transaction per migration, so a failure rolls back only the migration
 * that failed and leaves the database at the previous version — the guarantee
 * that makes "fix it and re-run" a safe instruction.
 *
 * The backup is taken **once per run**, immediately before the first migration
 * is applied, and is named for the version being left behind. Per-migration
 * backups would name the same restore point several times over: the state an
 * operator wants back is the one from before this boot's upgrade, and a
 * half-upgraded intermediate is not a state anything was ever tested against.
 * A run with nothing pending takes no backup at all, which is what keeps a
 * restart from filling `state/backups/` with copies of an unchanged database.
 */
export function runMigrations(options: RunMigrationsOptions): MigrationRunResult {
  const { db, sets } = options;
  const log = options.log ?? silentLog;

  const applied: AppliedMigration[] = [];
  const versions: Record<string, number> = {};
  let backupPath: string | undefined;

  for (const set of sets) {
    const available = discoverMigrations(set.dir);
    const startingVersion = set.tracker.current();
    versions[set.id] = startingVersion;

    const highestAvailable = available.at(-1)?.version ?? 0;
    if (startingVersion > highestAvailable) {
      throw new MigrationSetError(
        `Database is at version ${startingVersion} for set "${set.id}" but only ${highestAvailable} ` +
          `migrations are available in ${set.dir}. This database was written by a newer build; ` +
          'migrations are forward-only and cannot go back.',
      );
    }

    for (const migration of available) {
      if (migration.version <= startingVersion) continue;

      if (backupPath === undefined) {
        backupPath = options.backup(set.tracker.current());
        log('info', 'pre-migration backup written', { backupPath });
      }

      applyOne(db, set, migration);
      applied.push({ setId: set.id, version: migration.version, name: migration.name });
      versions[set.id] = migration.version;
      log('info', 'migration applied', {
        set: set.id,
        version: migration.version,
        name: migration.name,
      });
    }
  }

  return backupPath === undefined ? { applied, versions } : { applied, backupPath, versions };
}

function applyOne(db: Database, set: MigrationSet, migration: MigrationFile): void {
  let sql: string;
  try {
    sql = readFileSync(migration.path, 'utf8');
  } catch (error) {
    throw new MigrationError(set.id, migration.path, describeError(error), { cause: error });
  }

  // `db.transaction` issues BEGIN/COMMIT and rolls back on any throw. SQLite's
  // DDL is transactional, so a migration that creates three tables and then
  // fails leaves none of them behind. Migration files must therefore not
  // contain their own BEGIN/COMMIT.
  const apply = db.transaction(() => {
    db.exec(sql);
    set.tracker.record(migration);
  });

  try {
    apply();
  } catch (error) {
    throw new MigrationError(set.id, migration.path, describeError(error), { cause: error });
  }
}
