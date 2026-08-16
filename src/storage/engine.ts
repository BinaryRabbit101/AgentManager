/**
 * The SQLite engine wrapper: open with the DESIGN §1.3 pragmas, verify
 * integrity, close cleanly.
 *
 * §1.3 in full: better-sqlite3 (synchronous, in-process, no pool); one process
 * — the core — ever opens the file; pragmas `journal_mode=WAL`,
 * `synchronous=NORMAL`, `foreign_keys=ON`, `busy_timeout=5000`;
 * `PRAGMA quick_check` on boot with failure fatal and reported with the backup
 * path to restore from.
 */
import { dirname } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';

import SqliteDatabase from 'better-sqlite3';

import { newestBackup } from './backups.js';
import {
  DatabaseAlreadyOpenError,
  DatabaseIntegrityError,
  describeError,
  sqliteCode,
} from './errors.js';
import { silentLog, type LogFn } from './log.js';
import type { Database } from './sqlite.js';

/** The pragmas of §1.3, in the order they are applied. */
export const OPEN_PRAGMAS = [
  'journal_mode = WAL',
  'synchronous = NORMAL',
  'foreign_keys = ON',
  'busy_timeout = 5000',
] as const;

/**
 * SQLite result codes that mean "this file is not a usable database".
 *
 * Distinguished from the rest so that a missing directory or a permission
 * problem does not tell the owner to restore a backup they do not need.
 */
const CORRUPTION_CODES = new Set(['SQLITE_NOTADB', 'SQLITE_CORRUPT']);

export interface OpenDatabaseOptions {
  /** `<dataRoot>\state\agentmanager.db`. */
  readonly databasePath: string;
  /** `<dataRoot>\state\backups\` — read only to name a restore target on failure. */
  readonly backupsDir: string;
  /** Run `PRAGMA quick_check` after opening. Default `true`; §1.3 requires it on boot. */
  readonly integrityCheck?: boolean;
  readonly log?: LogFn;
}

/**
 * Database files this process holds open.
 *
 * §1.3's single-writer guarantee has two halves. Across processes it is the
 * exclusive `run/core.lock` handle of §4.2 (lifecycle, M9). Within this process
 * it is this registry: a second `openDatabase` of the same file would produce
 * two connections racing for the same WAL, which is the exact failure mode the
 * design rules out — so it fails loudly instead.
 */
const openDatabases = new Map<string, Database>();

/** True when this process already holds `databasePath` open. */
export function isDatabaseOpen(databasePath: string): boolean {
  return openDatabases.has(databasePath);
}

function applyPragmas(db: Database): void {
  for (const pragma of OPEN_PRAGMAS) db.pragma(pragma);
}

/**
 * Runs `PRAGMA quick_check`, throwing {@link DatabaseIntegrityError} on anything
 * other than `ok`.
 *
 * `quick_check` rather than `integrity_check`: it catches the corruption that
 * matters at boot without the full index-vs-table cross-verification, which on
 * a database of this size is the difference between a boot delay nobody
 * notices and one they do.
 */
export function assertIntegrity(db: Database, databasePath: string, backupsDir: string): void {
  const result = db.pragma('quick_check', { simple: true });
  if (result === 'ok') return;
  throw new DatabaseIntegrityError(
    databasePath,
    `quick_check reported ${JSON.stringify(result)}`,
    newestBackup(backupsDir),
    backupsDir,
  );
}

/**
 * Opens the database with the §1.3 pragmas and verifies its integrity.
 *
 * Creates the file if it does not exist — a first run has no database and must
 * not need one seeded by hand.
 */
export function openDatabase(options: OpenDatabaseOptions): Database {
  const { databasePath, backupsDir } = options;
  const log = options.log ?? silentLog;

  if (openDatabases.has(databasePath)) throw new DatabaseAlreadyOpenError(databasePath);

  const directory = dirname(databasePath);
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true });

  let db: Database;
  try {
    db = new SqliteDatabase(databasePath);
  } catch (error) {
    throw asFatal(error, databasePath, backupsDir);
  }

  try {
    applyPragmas(db);
    if (options.integrityCheck !== false) assertIntegrity(db, databasePath, backupsDir);
  } catch (error) {
    db.close();
    throw asFatal(error, databasePath, backupsDir);
  }

  openDatabases.set(databasePath, db);
  log('debug', 'database opened', { databasePath, pragmas: OPEN_PRAGMAS.length });
  return db;
}

function asFatal(error: unknown, databasePath: string, backupsDir: string): unknown {
  if (error instanceof DatabaseIntegrityError) return error;
  const code = sqliteCode(error);
  if (code !== undefined && CORRUPTION_CODES.has(code)) {
    return new DatabaseIntegrityError(
      databasePath,
      `${code} (${describeError(error)})`,
      newestBackup(backupsDir),
      backupsDir,
      { cause: error },
    );
  }
  return error;
}

/**
 * Checkpoints and closes the database.
 *
 * §4.2's graceful shutdown ends with "WAL checkpoint and close the DB". The
 * `TRUNCATE` checkpoint writes every committed page back into the main file and
 * empties the WAL, so the close leaves a single self-contained `.db` with no
 * `-wal`/`-shm` siblings — which is what makes a copy of that one file (a
 * backup, a support bundle, a machine migration) complete.
 *
 * Safe to call twice: a closed handle is simply ignored.
 */
export function closeDatabase(db: Database, log: LogFn = silentLog): void {
  const databasePath = db.name;
  if (!db.open) {
    openDatabases.delete(databasePath);
    return;
  }

  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch (error) {
    // A failed checkpoint must not prevent the close — the WAL is recovered on
    // next open, and refusing to shut down is strictly worse than leaving one.
    log('warn', 'WAL checkpoint before close failed', {
      databasePath,
      error: describeError(error),
    });
  }

  db.close();
  openDatabases.delete(databasePath);
  log('debug', 'database closed', { databasePath });
}
