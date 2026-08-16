/**
 * The `remote_tokens` repository (§1.4, §3.4).
 *
 * "Bearer tokens are generated (32 random bytes, base64url), shown to the user
 * exactly once, and stored only as `sha256(token)` … Verification is a
 * constant-time hash comparison."
 *
 * This repository therefore never sees a token, only a hash and a display
 * prefix. The consequence is deliberate: a token can be revoked and reissued
 * but never recovered, so compromising `secrets.json` does not yield remote
 * access. Hashing and the constant-time compare belong to the remote module;
 * storage's job is to hold the hash and not to invent a second way in.
 *
 * The table exists in both editions — harmless in the work edition, where
 * nothing reads it (§1.4).
 */
import { newId } from '../ids.js';
import type { Database } from '../sqlite.js';
import type { Clock } from '../time.js';
import { isoTimestamp } from '../time.js';
import { orNull } from './sql.js';

export interface RemoteTokenRecord {
  readonly id: string;
  readonly label: string;
  readonly device: string | null;
  /** `sha256(token)`. The token itself is never stored (§3.4). */
  readonly tokenHash: string;
  /** Six characters, for human recognition. Not a join key — prefixes collide (§5.1). */
  readonly tokenPrefix: string;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
}

export interface RemoteTokenInput {
  readonly id?: string;
  readonly label: string;
  readonly device?: string | null;
  readonly tokenHash: string;
  readonly tokenPrefix: string;
  readonly createdAt?: string;
  readonly expiresAt?: string | null;
}

export interface RemoteTokensRepository {
  create(input: RemoteTokenInput): RemoteTokenRecord;
  get(id: string): RemoteTokenRecord | undefined;
  /** The verification lookup. Backed by the UNIQUE index on `token_hash`. */
  findByHash(tokenHash: string): RemoteTokenRecord | undefined;
  list(options?: { includeRevoked?: boolean }): readonly RemoteTokenRecord[];
  /** Stamps `last_used_at`. One write per authenticated request. */
  touch(id: string, at?: string): void;
  revoke(id: string, at?: string): boolean;
  delete(id: string): boolean;
}

interface RemoteTokenRow {
  readonly id: string;
  readonly label: string;
  readonly device: string | null;
  readonly token_hash: string;
  readonly token_prefix: string;
  readonly created_at: string;
  readonly last_used_at: string | null;
  readonly expires_at: string | null;
  readonly revoked_at: string | null;
}

const COLUMNS =
  'id, label, device, token_hash, token_prefix, created_at, last_used_at, expires_at, revoked_at';

function toRecord(row: RemoteTokenRow): RemoteTokenRecord {
  return {
    id: row.id,
    label: row.label,
    device: row.device,
    tokenHash: row.token_hash,
    tokenPrefix: row.token_prefix,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
}

export function createRemoteTokensRepository(db: Database, clock: Clock): RemoteTokensRepository {
  const insert = db.prepare(
    `INSERT INTO remote_tokens (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const getStatement = db.prepare<[string], RemoteTokenRow>(
    `SELECT ${COLUMNS} FROM remote_tokens WHERE id = ?`,
  );
  const byHash = db.prepare<[string], RemoteTokenRow>(
    `SELECT ${COLUMNS} FROM remote_tokens WHERE token_hash = ?`,
  );
  const listAll = db.prepare<[], RemoteTokenRow>(
    `SELECT ${COLUMNS} FROM remote_tokens ORDER BY created_at DESC, id DESC`,
  );
  const listLive = db.prepare<[], RemoteTokenRow>(
    `SELECT ${COLUMNS} FROM remote_tokens WHERE revoked_at IS NULL ORDER BY created_at DESC, id DESC`,
  );
  const touch = db.prepare<[string, string]>(
    'UPDATE remote_tokens SET last_used_at = ? WHERE id = ?',
  );
  // `revoked_at IS NULL` in the WHERE clause keeps the first revocation's time:
  // when a credential was withdrawn is an incident-review fact.
  const revoke = db.prepare<[string, string]>(
    'UPDATE remote_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL',
  );
  const deleteStatement = db.prepare<[string]>('DELETE FROM remote_tokens WHERE id = ?');

  return {
    create(input) {
      const record: RemoteTokenRecord = {
        id: input.id ?? newId(),
        label: input.label,
        device: orNull(input.device),
        tokenHash: input.tokenHash,
        tokenPrefix: input.tokenPrefix,
        createdAt: input.createdAt ?? isoTimestamp(clock()),
        lastUsedAt: null,
        expiresAt: orNull(input.expiresAt),
        revokedAt: null,
      };
      insert.run(
        record.id,
        record.label,
        record.device,
        record.tokenHash,
        record.tokenPrefix,
        record.createdAt,
        record.lastUsedAt,
        record.expiresAt,
        record.revokedAt,
      );
      return record;
    },

    get: (id) => {
      const row = getStatement.get(id);
      return row === undefined ? undefined : toRecord(row);
    },

    findByHash: (tokenHash) => {
      const row = byHash.get(tokenHash);
      return row === undefined ? undefined : toRecord(row);
    },

    list: (options = {}) =>
      (options.includeRevoked === true ? listAll : listLive).all().map(toRecord),

    touch: (id, at) => void touch.run(at ?? isoTimestamp(clock()), id),

    revoke: (id, at) => revoke.run(at ?? isoTimestamp(clock()), id).changes > 0,

    delete: (id) => deleteStatement.run(id).changes > 0,
  };
}
