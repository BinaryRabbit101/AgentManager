/**
 * The `settings` repository (§1.4, §2.4).
 *
 * Settings are *not* configuration: config is immutable for the process
 * lifetime, and anything the UI toggles lives here so a config-file rewrite
 * cannot clobber it.
 *
 * Two of the three methods below are shipped by foundation specifically because
 * more than one element needs them (§1.4):
 *
 * - {@link SettingsRepository.listByPrefix} — remote stores one row per agent
 *   under `remote.agentAccess.<id>` so granting and revoking are independent
 *   writes rather than a read-modify-write over a single blob; both the expiry
 *   sweep and the list endpoint need the scan.
 * - {@link SettingsRepository.deleteByKey} — absence *is* the disabled state
 *   for those rows, so revocation deletes rather than rewrites.
 */
import type { Database } from '../sqlite.js';
import type { Clock } from '../time.js';
import { isoTimestamp } from '../time.js';

export interface SettingRecord<T = unknown> {
  readonly key: string;
  /** The parsed value. `value_json` is the storage form, never the contract. */
  readonly value: T;
  readonly updatedAt: string;
}

export interface SettingsRepository {
  /** The parsed value, or `undefined` when the key is absent. */
  get<T>(key: string): T | undefined;
  /** The value with its metadata. */
  getRecord<T>(key: string): SettingRecord<T> | undefined;
  /** Insert or replace. `updated_at` is stamped here, never by the caller. */
  set(key: string, value: unknown, at?: string): SettingRecord;
  /** A prefix scan over the key space, ordered by key (§1.4). */
  listByPrefix<T>(prefix: string): readonly SettingRecord<T>[];
  list(): readonly SettingRecord[];
  /** Deletes the row. Absence is the disabled state (§1.4). */
  deleteByKey(key: string): void;
  has(key: string): boolean;
}

interface SettingRow {
  readonly key: string;
  readonly value_json: string;
  readonly updated_at: string;
}

function toRecord<T>(row: SettingRow): SettingRecord<T> {
  return { key: row.key, value: JSON.parse(row.value_json) as T, updatedAt: row.updated_at };
}

/**
 * Escapes the LIKE metacharacters in a prefix.
 *
 * Setting keys are dotted paths that can carry a ULID or a user-chosen label,
 * so `%` and `_` are not hypothetical — `_` in particular appears in ordinary
 * identifiers and would silently widen the scan to a single-character wildcard.
 */
function likePrefix(prefix: string): string {
  return `${prefix.replace(/[\\%_]/g, '\\$&')}%`;
}

export function createSettingsRepository(db: Database, clock: Clock): SettingsRepository {
  const getStatement = db.prepare<[string], SettingRow>(
    'SELECT key, value_json, updated_at FROM settings WHERE key = ?',
  );
  const upsert = db.prepare<[string, string, string]>(
    `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json,
                                    updated_at = excluded.updated_at`,
  );
  const byPrefix = db.prepare<[string], SettingRow>(
    "SELECT key, value_json, updated_at FROM settings WHERE key LIKE ? ESCAPE '\\' ORDER BY key",
  );
  const listAll = db.prepare<[], SettingRow>(
    'SELECT key, value_json, updated_at FROM settings ORDER BY key',
  );
  const deleteStatement = db.prepare<[string]>('DELETE FROM settings WHERE key = ?');

  return {
    get: <T>(key: string) => {
      const row = getStatement.get(key);
      return row === undefined ? undefined : (JSON.parse(row.value_json) as T);
    },

    getRecord: <T>(key: string) => {
      const row = getStatement.get(key);
      return row === undefined ? undefined : toRecord<T>(row);
    },

    set(key, value, at) {
      const updatedAt = at ?? isoTimestamp(clock());
      upsert.run(key, JSON.stringify(value ?? null), updatedAt);
      return { key, value, updatedAt };
    },

    listByPrefix: <T>(prefix: string) =>
      byPrefix.all(likePrefix(prefix)).map((r) => toRecord<T>(r)),

    list: () => listAll.all().map((r) => toRecord(r)),

    deleteByKey: (key) => void deleteStatement.run(key),

    has: (key) => getStatement.get(key) !== undefined,
  };
}
