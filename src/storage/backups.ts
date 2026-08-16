/**
 * Pre-migration database backups.
 *
 * DESIGN §1.2 fixes the name — `state/backups/agentmanager-<schemaVersion>-<ts>.db`
 * — and §1.3 fixes when one is taken: "Before applying any migration the DB is
 * copied to `state/backups/`." The version in the name is the version being
 * *left behind*, so the file answers "what did the database look like before
 * this upgrade" without opening it.
 *
 * §1.3 also makes the newest backup the thing an integrity failure points at,
 * so finding it ({@link newestBackup}) lives here next to writing it.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Database } from './sqlite.js';
import { filenameTimestamp } from './time.js';

/** `agentmanager-<schemaVersion>-<filenameTimestamp>.db`. */
const BACKUP_PATTERN = /^agentmanager-(\d+)-(.+)\.db$/;

export interface BackupInfo {
  readonly path: string;
  readonly filename: string;
  /** Schema version the backup was taken at. */
  readonly schemaVersion: number;
  /** Modification time, milliseconds since the epoch. */
  readonly modifiedAt: number;
}

/** The backup filename for a schema version and instant. */
export function backupFilename(schemaVersion: number, at: Date = new Date()): string {
  return `agentmanager-${schemaVersion}-${filenameTimestamp(at)}.db`;
}

/**
 * Every backup in `backupsDir`, newest first.
 *
 * Ordered by modification time rather than by filename: the version segment
 * sorts numerically wrong as text (`10` before `2`), and mtime is the property
 * the "restore from the newest one" instruction actually means.
 */
export function listBackups(backupsDir: string): readonly BackupInfo[] {
  let entries: string[];
  try {
    entries = readdirSync(backupsDir);
  } catch {
    return [];
  }

  const found: BackupInfo[] = [];
  for (const filename of entries) {
    const match = BACKUP_PATTERN.exec(filename);
    if (match === null) continue;
    const path = resolve(backupsDir, filename);
    let modifiedAt: number;
    try {
      const stats = statSync(path);
      if (!stats.isFile()) continue;
      modifiedAt = stats.mtimeMs;
    } catch {
      continue;
    }
    found.push({ path, filename, schemaVersion: Number(match[1]), modifiedAt });
  }

  return found.sort((a, b) => b.modifiedAt - a.modifiedAt || b.filename.localeCompare(a.filename));
}

/** The most recent backup, or `undefined` when none has been taken yet. */
export function newestBackup(backupsDir: string): BackupInfo | undefined {
  return listBackups(backupsDir)[0];
}

export interface BackupRequest {
  /** Open handle, checkpointed before the copy so the WAL holds no unwritten pages. */
  readonly db: Database;
  readonly databasePath: string;
  readonly backupsDir: string;
  /** The version being left behind — the one that names the file. */
  readonly schemaVersion: number;
  readonly at?: Date;
}

/**
 * Copies the live database to `state/backups/`, returning the backup's path.
 *
 * A WAL-mode database is two files, and the committed tail of the WAL has not
 * necessarily reached the main file. A `TRUNCATE` checkpoint moves everything
 * across and empties the WAL first, so copying the single `.db` file yields a
 * complete database rather than one missing its most recent transactions. That
 * is safe here precisely because §1.3 gives the core sole ownership of the
 * file: there is no second connection to hold the checkpoint off.
 */
export function backupDatabase(request: BackupRequest): string {
  const { db, databasePath, backupsDir, schemaVersion } = request;

  db.pragma('wal_checkpoint(TRUNCATE)');
  if (!existsSync(backupsDir)) mkdirSync(backupsDir, { recursive: true });

  let at = request.at ?? new Date();
  let target = resolve(backupsDir, backupFilename(schemaVersion, at));

  // Two migrations applied inside the same millisecond would otherwise collide
  // and the first backup would be lost — the one case where overwriting is
  // exactly the wrong recovery behaviour.
  while (existsSync(target)) {
    at = new Date(at.getTime() + 1);
    target = resolve(backupsDir, backupFilename(schemaVersion, at));
  }

  copyFileSync(databasePath, target);
  return target;
}
