import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase } from './engine.js';
import { MigrationError, MigrationSetError } from './errors.js';
import {
  FOUNDATION_SET_ID,
  discoverMigrations,
  runMigrations,
  userVersionTracker,
  type MigrationSet,
  type MigrationTracker,
} from './migrations.js';
import { makeTempRoot, recordingLog, writeMigration, type TempRoot } from './__tests__/helpers.js';
import type { Database } from './sqlite.js';

let temp: TempRoot;
let db: Database;
let dir: string;
let backups: number[];

beforeEach(() => {
  temp = makeTempRoot();
  dir = resolve(temp.path, 'migrations');
  mkdirSync(dir, { recursive: true });
  db = openDatabase({
    databasePath: resolve(temp.path, 'agentmanager.db'),
    backupsDir: resolve(temp.path, 'backups'),
  });
  backups = [];
});

afterEach(() => {
  closeDatabase(db);
  temp.cleanup();
});

/** Records the version each backup was asked for; returns a fake path. */
const backup = (schemaVersion: number): string => {
  backups.push(schemaVersion);
  return `backup-${schemaVersion}.db`;
};

function foundationSet(): MigrationSet {
  return { id: FOUNDATION_SET_ID, dir, tracker: userVersionTracker(db) };
}

function tableExists(name: string): boolean {
  return (
    db
      .prepare<[string], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(name) !== undefined
  );
}

describe('discoverMigrations', () => {
  it('returns files in ascending version order regardless of directory order', () => {
    writeMigration(dir, '0010_ten.sql', '');
    writeMigration(dir, '0002_two.sql', '');
    writeMigration(dir, '0001_one.sql', '');

    expect(discoverMigrations(dir).map((m) => m.version)).toEqual([1, 2, 10]);
    expect(discoverMigrations(dir).map((m) => m.name)).toEqual(['one', 'two', 'ten']);
  });

  it('skips subdirectories, because element-owned sets live in them (§1.3)', () => {
    writeMigration(dir, '0001_init.sql', '');
    writeMigration(resolve(dir, 'roster'), '0001_agent_ui_state.sql', '');

    expect(discoverMigrations(dir).map((m) => m.filename)).toEqual(['0001_init.sql']);
  });

  it('ignores non-SQL files but rejects a misnamed .sql file', () => {
    writeMigration(dir, '0001_init.sql', '');
    writeFileSync(resolve(dir, 'README.md'), '# not a migration');
    expect(discoverMigrations(dir)).toHaveLength(1);

    writeFileSync(resolve(dir, 'oops.sql'), '');
    expect(() => discoverMigrations(dir)).toThrow(MigrationSetError);
  });

  it('rejects two migrations claiming the same version', () => {
    writeMigration(dir, '0001_one.sql', '');
    writeMigration(dir, '0001_also_one.sql', '');
    expect(() => discoverMigrations(dir)).toThrow(/share version 1/);
  });

  it('reports a missing directory as a set error, not a bare ENOENT', () => {
    expect(() => discoverMigrations(resolve(temp.path, 'nope'))).toThrow(MigrationSetError);
  });
});

describe('userVersionTracker', () => {
  it('starts at 0 on an empty database and records inside the migration', () => {
    const tracker = userVersionTracker(db);
    expect(tracker.current()).toBe(0);
    tracker.record({ version: 7, name: 'x', filename: '0007_x.sql', path: 'x' });
    expect(tracker.current()).toBe(7);
  });
});

describe('runMigrations', () => {
  it('applies pending migrations in order and advances the tracked version', () => {
    writeMigration(dir, '0001_init.sql', 'CREATE TABLE a (id TEXT PRIMARY KEY);');
    writeMigration(dir, '0002_more.sql', 'CREATE TABLE b (id TEXT PRIMARY KEY);');

    const result = runMigrations({ db, sets: [foundationSet()], backup });

    expect(result.applied.map((m) => m.version)).toEqual([1, 2]);
    expect(result.versions[FOUNDATION_SET_ID]).toBe(2);
    expect(tableExists('a')).toBe(true);
    expect(tableExists('b')).toBe(true);
  });

  it('backs up once per run, naming the version being left behind', () => {
    writeMigration(dir, '0001_init.sql', 'CREATE TABLE a (id TEXT PRIMARY KEY);');
    writeMigration(dir, '0002_more.sql', 'CREATE TABLE b (id TEXT PRIMARY KEY);');

    const result = runMigrations({ db, sets: [foundationSet()], backup });

    expect(backups).toEqual([0]);
    expect(result.backupPath).toBe('backup-0.db');
  });

  it('takes no backup and applies nothing when the set is already current', () => {
    writeMigration(dir, '0001_init.sql', 'CREATE TABLE a (id TEXT PRIMARY KEY);');
    runMigrations({ db, sets: [foundationSet()], backup });
    backups = [];

    const second = runMigrations({ db, sets: [foundationSet()], backup });

    expect(second.applied).toEqual([]);
    expect(second.backupPath).toBeUndefined();
    expect(backups).toEqual([]);
  });

  it('rolls back a failing migration entirely and keeps the prior version', () => {
    writeMigration(dir, '0001_init.sql', 'CREATE TABLE a (id TEXT PRIMARY KEY);');
    runMigrations({ db, sets: [foundationSet()], backup });

    writeMigration(
      dir,
      '0002_broken.sql',
      'CREATE TABLE b (id TEXT PRIMARY KEY);\nNOT VALID SQL AT ALL;',
    );

    expect(() => runMigrations({ db, sets: [foundationSet()], backup })).toThrow(MigrationError);

    expect(userVersionTracker(db).current()).toBe(1);
    expect(tableExists('a')).toBe(true);
    expect(tableExists('b')).toBe(false);
  });

  it('names the failing file and says the schema is unchanged', () => {
    writeMigration(dir, '0001_broken.sql', 'NOT VALID SQL;');
    try {
      runMigrations({ db, sets: [foundationSet()], backup });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(MigrationError);
      expect((error as MigrationError).migrationPath).toContain('0001_broken.sql');
      expect((error as Error).message).toMatch(/rolled back/);
      expect((error as Error).message).toMatch(/forward-only/);
    }
  });

  it('refuses a database written by a newer build (forward-only, §1.3)', () => {
    writeMigration(dir, '0001_init.sql', 'CREATE TABLE a (id TEXT PRIMARY KEY);');
    db.pragma('user_version = 9');

    expect(() => runMigrations({ db, sets: [foundationSet()], backup })).toThrow(
      /written by a newer build/,
    );
  });

  it('applies several sets in the order given, sharing one backup (the M5 shape)', () => {
    // Foundation's set, then a module's — exactly how M5 extends this runner.
    writeMigration(dir, '0001_init.sql', 'CREATE TABLE core (id TEXT PRIMARY KEY);');
    const moduleDir = resolve(dir, 'roster');
    writeMigration(moduleDir, '0001_agent_ui_state.sql', 'CREATE TABLE agent_ui_state (id TEXT);');

    const applied: Array<[string, number]> = [];
    const moduleTracker: MigrationTracker = {
      current: () => 0,
      record: (m) => void applied.push(['roster', m.version]),
    };

    const log = recordingLog();
    const result = runMigrations({
      db,
      sets: [foundationSet(), { id: 'roster', dir: moduleDir, tracker: moduleTracker }],
      backup,
      log,
    });

    expect(result.applied.map((m) => `${m.setId}:${m.version}`)).toEqual([
      'foundation:1',
      'roster:1',
    ]);
    expect(applied).toEqual([['roster', 1]]);
    expect(backups).toEqual([0]);
    expect(tableExists('core')).toBe(true);
    expect(tableExists('agent_ui_state')).toBe(true);
    expect(log.records.filter((r) => r.msg === 'migration applied')).toHaveLength(2);
  });
});
