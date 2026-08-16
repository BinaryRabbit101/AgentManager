import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase, isDatabaseOpen, openDatabase } from './engine.js';
import { DatabaseAlreadyOpenError, DatabaseIntegrityError } from './errors.js';
import { makeTempRoot, type TempRoot } from './__tests__/helpers.js';
import type { Database } from './sqlite.js';

let temp: TempRoot;
let databasePath: string;
let backupsDir: string;
let handles: Database[];

beforeEach(() => {
  temp = makeTempRoot();
  databasePath = resolve(temp.path, 'state', 'agentmanager.db');
  backupsDir = resolve(temp.path, 'state', 'backups');
  mkdirSync(backupsDir, { recursive: true });
  handles = [];
});

afterEach(() => {
  for (const db of handles) closeDatabase(db);
  temp.cleanup();
});

function open(): Database {
  const db = openDatabase({ databasePath, backupsDir });
  handles.push(db);
  return db;
}

describe('openDatabase', () => {
  it('creates the file and applies every §1.3 pragma', () => {
    const db = open();

    expect(existsSync(databasePath)).toBe(true);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('synchronous', { simple: true })).toBe(1);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
  });

  it('creates the containing directory when it is missing', () => {
    const nested = resolve(temp.path, 'deeper', 'state', 'agentmanager.db');
    const db = openDatabase({ databasePath: nested, backupsDir });
    handles.push(db);
    expect(existsSync(nested)).toBe(true);
  });

  it('refuses a second handle on the same file (§1.3 single owner)', () => {
    open();
    expect(() => open()).toThrow(DatabaseAlreadyOpenError);
  });

  it('releases the file for reopening after a close', () => {
    const db = open();
    expect(isDatabaseOpen(databasePath)).toBe(true);
    closeDatabase(db);
    handles = [];
    expect(isDatabaseOpen(databasePath)).toBe(false);
    expect(() => open()).not.toThrow();
  });

  it('rejects a file that is not a database, naming the newest backup', () => {
    writeFileSync(resolve(backupsDir, 'agentmanager-1-2026-08-16T10-00-00-000Z.db'), 'older');
    writeFileSync(resolve(backupsDir, 'agentmanager-2-2026-08-16T11-00-00-000Z.db'), 'newest');
    writeFileSync(databasePath, 'not a database');

    let thrown: unknown;
    try {
      open();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(DatabaseIntegrityError);
    expect((thrown as Error).message).toContain('agentmanager-2-2026-08-16T11-00-00-000Z.db');
    // And no handle was leaked by the failed open.
    expect(isDatabaseOpen(databasePath)).toBe(false);
  });

  it('can skip the integrity check when a caller has already done it', () => {
    const db = openDatabase({ databasePath, backupsDir, integrityCheck: false });
    handles.push(db);
    expect(db.pragma('quick_check', { simple: true })).toBe('ok');
  });
});

describe('closeDatabase', () => {
  it('checkpoints so no -wal or -shm survives the close (§4.2)', () => {
    const db = open();
    db.exec("CREATE TABLE t (id TEXT PRIMARY KEY); INSERT INTO t VALUES ('a');");

    expect(existsSync(`${databasePath}-wal`)).toBe(true);
    expect(existsSync(`${databasePath}-shm`)).toBe(true);

    closeDatabase(db);
    handles = [];

    expect(existsSync(`${databasePath}-wal`)).toBe(false);
    expect(existsSync(`${databasePath}-shm`)).toBe(false);

    // The write survived into the main file, not just the WAL.
    const reopened = open();
    expect(reopened.prepare('SELECT id FROM t').get()).toEqual({ id: 'a' });
  });

  it('is idempotent', () => {
    const db = open();
    closeDatabase(db);
    handles = [];
    expect(() => closeDatabase(db)).not.toThrow();
  });
});
