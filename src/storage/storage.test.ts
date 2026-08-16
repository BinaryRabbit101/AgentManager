/**
 * The five acceptance criteria of IMPLEMENTATION §4, each proven directly.
 *
 * All of it runs against a fresh temp directory — never `%LOCALAPPDATA%`, never
 * inside the repository.
 */
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decodeTime } from 'ulid';

import { listBackups } from './backups.js';
import { DatabaseIntegrityError, MigrationError } from './errors.js';
import { defaultMigrationsDir, managedDirectories } from './paths.js';
import { openStorage, type Storage } from './storage.js';
import { isIsoTimestamp } from './time.js';
import { isId } from './ids.js';
import { makeTempRoot, recordingLog, writeMigration, type TempRoot } from './__tests__/helpers.js';

/** ACL tightening is left to the installer in tests; it would mutate temp-dir permissions. */
const testOptions = { tightenAcl: false } as const;

let root: TempRoot;
let open: Storage[];

beforeEach(() => {
  root = makeTempRoot();
  open = [];
});

afterEach(() => {
  for (const storage of open) storage.close();
  root.cleanup();
});

function boot(overrides: { migrationsDir?: string } = {}): Storage {
  const storage = openStorage({
    dataRoot: root.path,
    ...testOptions,
    ...overrides,
  });
  open.push(storage);
  return storage;
}

describe('openStorage — first run', () => {
  it('creates the full §1.2 tree and a database at user_version = 1', () => {
    const log = recordingLog();
    const storage = openStorage({ dataRoot: root.path, ...testOptions, log });
    open.push(storage);

    for (const directory of managedDirectories(storage.paths)) {
      expect(statSync(directory).isDirectory(), `${directory} should exist`).toBe(true);
    }

    expect(existsSync(storage.paths.database)).toBe(true);
    expect(storage.db.pragma('user_version', { simple: true })).toBe(1);
    expect(storage.schemaVersion).toBe(1);
    expect(storage.applied).toEqual([{ setId: 'foundation', version: 1, name: 'init' }]);
    expect(log.records.some((r) => r.msg === 'storage ready')).toBe(true);
  });

  it('applies the §1.3 pragmas', () => {
    const storage = boot();
    expect(storage.db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(storage.db.pragma('synchronous', { simple: true })).toBe(1); // NORMAL
    expect(storage.db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(storage.db.pragma('busy_timeout', { simple: true })).toBe(5000);
  });

  it('seeds schema_meta with the schema version, install id and created_at (§1.4)', () => {
    const storage = boot();
    const rows = storage.db
      .prepare<[], { key: string; value: string }>('SELECT key, value FROM schema_meta')
      .all();
    const meta = Object.fromEntries(rows.map((r) => [r.key, r.value]));

    expect(meta['schema_version']).toBe('1');
    expect(isId(meta['install_id'] ?? '')).toBe(true);
    expect(isIsoTimestamp(meta['created_at'] ?? '')).toBe(true);
    expect(storage.installId).toBe(meta['install_id']);
  });

  it('backs up before applying 0001, naming the version being left behind', () => {
    // §1.3 is unconditional — "before applying any migration the DB is copied"
    // — and IMPLEMENTATION §4's "no *second* backup is written" on a re-run
    // says the first run wrote one. The copy is of the empty pre-migration
    // database, at version 0.
    const storage = boot();
    const backups = listBackups(storage.paths.backups);

    expect(backups).toHaveLength(1);
    expect(storage.backupPath).toBe(backups[0]?.path);
    expect(backups[0]?.schemaVersion).toBe(0);
    expect(backups[0]?.filename).toMatch(/^agentmanager-0-.+\.db$/);
  });

  it('takes created_at, the install id and the backup name from the injected clock', () => {
    const at = new Date('2026-08-16T10:35:00.000Z');
    const storage = openStorage({ dataRoot: root.path, ...testOptions, clock: () => at });
    open.push(storage);

    expect(metaValue(storage, 'created_at')).toBe('2026-08-16T10:35:00.000Z');
    expect(decodeTime(storage.installId)).toBe(at.getTime());
    expect(listBackups(storage.paths.backups)[0]?.filename).toBe(
      'agentmanager-0-2026-08-16T10-35-00-000Z.db',
    );
  });

  it('recreates run/ and cache/ on a later boot when they are missing (§1.2)', () => {
    const first = boot();
    const { run, cache } = first.paths;
    first.close();
    open = [];

    rmDir(run);
    rmDir(cache);
    expect(existsSync(run)).toBe(false);

    const second = boot();
    expect(statSync(second.paths.run).isDirectory()).toBe(true);
    expect(statSync(second.paths.cache).isDirectory()).toBe(true);
  });
});

describe('openStorage — re-running', () => {
  it('is a no-op: user_version unchanged, no second backup, install id preserved', () => {
    const first = boot();
    const installId = first.installId;
    const createdAt = metaValue(first, 'created_at');
    const backupsAfterFirst = listBackups(first.paths.backups).length;
    first.close();
    open = [];

    const second = boot();
    expect(second.schemaVersion).toBe(1);
    expect(second.db.pragma('user_version', { simple: true })).toBe(1);
    expect(second.applied).toEqual([]);
    expect(second.backupPath).toBeUndefined();
    expect(listBackups(second.paths.backups)).toHaveLength(backupsAfterFirst);
    expect(second.installId).toBe(installId);
    expect(metaValue(second, 'created_at')).toBe(createdAt);
  });
});

describe('openStorage — integrity', () => {
  it('fails boot on a corrupt database with a message naming the newest backup file', () => {
    // A real installation with history: boot once, then force a backup by
    // applying a migration, so there is something to be told to restore.
    const migrations = copyFoundationMigrations();
    const first = boot({ migrationsDir: migrations });
    first.close();
    open = [];

    writeMigration(migrations, '0002_add_probe.sql', 'CREATE TABLE probe (id TEXT PRIMARY KEY);');
    const second = boot({ migrationsDir: migrations });
    const backupPath = second.backupPath;
    second.close();
    open = [];

    expect(backupPath).toBeDefined();

    // Corrupt it: overwrite the header so SQLite refuses the file outright.
    const databasePath = resolve(root.path, 'state', 'agentmanager.db');
    writeFileSync(databasePath, 'this is not a SQLite database, not even a little bit');

    let thrown: unknown;
    try {
      boot({ migrationsDir: migrations });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(DatabaseIntegrityError);
    const message = (thrown as Error).message;
    expect(message).toContain(databasePath);
    expect(message).toContain(backupPath as string);
    expect((thrown as DatabaseIntegrityError).backup?.path).toBe(backupPath);
  });

  it('says so plainly when there is no backup to restore from', () => {
    const storage = boot();
    const databasePath = storage.paths.database;
    const backupsDir = storage.paths.backups;
    storage.close();
    open = [];

    // Both halves of the disaster: a corrupt database and no backups left.
    rmDir(backupsDir);
    writeFileSync(databasePath, 'corrupt');

    let thrown: unknown;
    try {
      boot();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(DatabaseIntegrityError);
    expect((thrown as DatabaseIntegrityError).backup).toBeUndefined();
    expect((thrown as Error).message).toMatch(
      new RegExp(`No backup is available in ${escapeRegExp(backupsDir)}`),
    );
  });
});

describe('openStorage — migrations', () => {
  it('applying 0002 produces a backup and advances user_version', () => {
    const migrations = copyFoundationMigrations();
    const first = boot({ migrationsDir: migrations });
    expect(first.schemaVersion).toBe(1);
    const before = listBackups(first.paths.backups).length;
    first.close();
    open = [];

    writeMigration(
      migrations,
      '0002_add_probe.sql',
      'CREATE TABLE probe (id TEXT PRIMARY KEY, note TEXT);',
    );

    const second = boot({ migrationsDir: migrations });
    expect(second.schemaVersion).toBe(2);
    expect(second.db.pragma('user_version', { simple: true })).toBe(2);
    expect(second.applied).toEqual([{ setId: 'foundation', version: 2, name: 'add_probe' }]);

    const backups = listBackups(second.paths.backups);
    expect(backups).toHaveLength(before + 1);
    expect(second.backupPath).toBe(backups[0]?.path);
    // Named for the version being left behind, per §1.2.
    expect(backups[0]?.schemaVersion).toBe(1);
    expect(backups[0]?.filename).toMatch(/^agentmanager-1-.+\.db$/);
    expect(tableExists(second, 'probe')).toBe(true);
  });

  it('rolls a failing migration back entirely and leaves the DB at the prior version', () => {
    const migrations = copyFoundationMigrations();
    const first = boot({ migrationsDir: migrations });
    first.close();
    open = [];

    writeMigration(
      migrations,
      '0002_broken.sql',
      [
        'CREATE TABLE half_applied (id TEXT PRIMARY KEY);',
        'THIS IS NOT SQL AND WILL NOT PARSE;',
      ].join('\n'),
    );

    expect(() => boot({ migrationsDir: migrations })).toThrowError(MigrationError);

    // The failed boot must leave nothing open, and nothing half-applied.
    const after = boot({ migrationsDir: copyFoundationMigrations('migrations-clean') });
    expect(after.schemaVersion).toBe(1);
    expect(after.db.pragma('user_version', { simple: true })).toBe(1);
    expect(tableExists(after, 'half_applied')).toBe(false);
    expect(tableExists(after, 'schema_meta')).toBe(true);
  });

  it('takes exactly one backup even when several migrations are pending', () => {
    const migrations = copyFoundationMigrations();
    const first = boot({ migrationsDir: migrations });
    const before = listBackups(first.paths.backups).length;
    first.close();
    open = [];

    writeMigration(migrations, '0002_a.sql', 'CREATE TABLE a (id TEXT PRIMARY KEY);');
    writeMigration(migrations, '0003_b.sql', 'CREATE TABLE b (id TEXT PRIMARY KEY);');

    const second = boot({ migrationsDir: migrations });
    expect(second.schemaVersion).toBe(3);
    expect(second.applied.map((m) => m.version)).toEqual([2, 3]);
    // Two migrations, one backup: the restore point is "before this upgrade".
    expect(listBackups(second.paths.backups)).toHaveLength(before + 1);
  });
});

describe('openStorage — WAL lifecycle', () => {
  it('keeps WAL files during operation and removes them on graceful close', () => {
    const storage = boot();
    storage.db.prepare("INSERT INTO schema_meta (key, value) VALUES ('probe', 'x')").run();

    const wal = `${storage.paths.database}-wal`;
    const shm = `${storage.paths.database}-shm`;
    expect(existsSync(wal), '-wal should exist during operation').toBe(true);
    expect(existsSync(shm), '-shm should exist during operation').toBe(true);

    storage.close();
    open = [];

    expect(existsSync(wal), '-wal should be gone after a graceful close').toBe(false);
    expect(existsSync(shm), '-shm should be gone after a graceful close').toBe(false);
    expect(existsSync(storage.paths.database)).toBe(true);

    // The checkpointed data survived into the main file.
    const reopened = boot();
    expect(metaValue(reopened, 'probe')).toBe('x');
  });

  it('close is idempotent', () => {
    const storage = boot();
    storage.close();
    expect(() => storage.close()).not.toThrow();
    open = [];
  });
});

// ---------------------------------------------------------------------------

function metaValue(storage: Storage, key: string): string | undefined {
  return storage.db
    .prepare<[string], { value: string }>('SELECT value FROM schema_meta WHERE key = ?')
    .get(key)?.value;
}

function tableExists(storage: Storage, name: string): boolean {
  return (
    storage.db
      .prepare<[string], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(name) !== undefined
  );
}

/**
 * A writable copy of foundation's real migration directory.
 *
 * Tests add a `0002` to exercise the runner; they must never write into the
 * repository's own `migrations/`, so the shipped files are copied out first.
 */
function copyFoundationMigrations(name = 'migrations'): string {
  const source = defaultMigrationsDir();
  const dir = resolve(root.path, name);
  for (const filename of readdirSync(source)) {
    if (!filename.endsWith('.sql')) continue;
    writeMigration(dir, filename, readFileSync(resolve(source, filename), 'utf8'));
  }
  return dir;
}

function rmDir(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
