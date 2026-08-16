import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { backupDatabase, backupFilename, listBackups, newestBackup } from './backups.js';
import { closeDatabase, openDatabase } from './engine.js';
import { makeTempRoot, type TempRoot } from './__tests__/helpers.js';
import type { Database } from './sqlite.js';

let temp: TempRoot;
let databasePath: string;
let backupsDir: string;
let db: Database;

beforeEach(() => {
  temp = makeTempRoot();
  databasePath = resolve(temp.path, 'agentmanager.db');
  backupsDir = resolve(temp.path, 'backups');
  db = openDatabase({ databasePath, backupsDir });
});

afterEach(() => {
  closeDatabase(db);
  temp.cleanup();
});

/** Writes a backup-shaped file with a controlled mtime. */
function fakeBackup(filename: string, ageSeconds: number): string {
  mkdirSync(backupsDir, { recursive: true });
  const path = resolve(backupsDir, filename);
  writeFileSync(path, 'x');
  const when = new Date(Date.now() - ageSeconds * 1000);
  utimesSync(path, when, when);
  return path;
}

describe('backupFilename', () => {
  it('matches the §1.2 name and carries no character illegal on Windows', () => {
    const name = backupFilename(3, new Date('2026-08-16T10:35:00.000Z'));
    expect(name).toBe('agentmanager-3-2026-08-16T10-35-00-000Z.db');
    expect(name).not.toContain(':');
  });
});

describe('listBackups', () => {
  it('returns nothing for a directory that does not exist', () => {
    expect(listBackups(resolve(temp.path, 'nope'))).toEqual([]);
  });

  it('orders by modification time, newest first', () => {
    const oldest = fakeBackup('agentmanager-1-2026-08-16T09-00-00-000Z.db', 300);
    const newest = fakeBackup('agentmanager-2-2026-08-16T11-00-00-000Z.db', 10);
    fakeBackup('agentmanager-1-2026-08-16T10-00-00-000Z.db', 100);

    const ordered = listBackups(backupsDir);
    expect(ordered).toHaveLength(3);
    expect(ordered[0]?.path).toBe(newest);
    expect(ordered.at(-1)?.path).toBe(oldest);
    expect(newestBackup(backupsDir)?.path).toBe(newest);
  });

  it('ignores files that are not backups', () => {
    fakeBackup('agentmanager-1-2026-08-16T09-00-00-000Z.db', 10);
    writeFileSync(resolve(backupsDir, 'notes.txt'), 'x');
    writeFileSync(resolve(backupsDir, 'agentmanager.db'), 'x');

    expect(listBackups(backupsDir).map((b) => b.filename)).toEqual([
      'agentmanager-1-2026-08-16T09-00-00-000Z.db',
    ]);
  });

  it('parses the schema version out of the name', () => {
    fakeBackup('agentmanager-12-2026-08-16T09-00-00-000Z.db', 10);
    expect(newestBackup(backupsDir)?.schemaVersion).toBe(12);
  });
});

describe('backupDatabase', () => {
  it('copies a complete database, including writes still sitting in the WAL', () => {
    db.exec("CREATE TABLE t (id TEXT PRIMARY KEY); INSERT INTO t VALUES ('a');");

    const path = backupDatabase({
      db,
      databasePath,
      backupsDir,
      schemaVersion: 1,
      at: new Date('2026-08-16T10:35:00.000Z'),
    });

    expect(path).toBe(resolve(backupsDir, 'agentmanager-1-2026-08-16T10-35-00-000Z.db'));
    expect(existsSync(path)).toBe(true);

    // The copy is a real database carrying the pre-backup write.
    const copy = openDatabase({ databasePath: path, backupsDir });
    try {
      expect(copy.prepare('SELECT id FROM t').get()).toEqual({ id: 'a' });
    } finally {
      closeDatabase(copy);
    }
  });

  it('creates the backups directory if it is missing', () => {
    expect(existsSync(backupsDir)).toBe(false);
    backupDatabase({ db, databasePath, backupsDir, schemaVersion: 0 });
    expect(listBackups(backupsDir)).toHaveLength(1);
  });

  it('never overwrites an existing backup taken in the same millisecond', () => {
    const at = new Date('2026-08-16T10:35:00.000Z');
    const first = backupDatabase({ db, databasePath, backupsDir, schemaVersion: 1, at });
    const second = backupDatabase({ db, databasePath, backupsDir, schemaVersion: 1, at });

    expect(second).not.toBe(first);
    expect(existsSync(first)).toBe(true);
    expect(listBackups(backupsDir)).toHaveLength(2);
  });
});
