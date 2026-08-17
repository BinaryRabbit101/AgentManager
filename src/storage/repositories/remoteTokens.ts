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
  /**
   * Which device last presented this token — the peer IP, plus the tailnet node
   * name when remote's cached peer map resolved it (`100.64.0.7 (pixel-9)`).
   *
   * The column is added by `migrations/remote/0001_last_used_peer.sql`, so it
   * exists in every database foundation opens. It is an **audit** field and
   * never an authentication input: remote DESIGN §9.3 is explicit that "if the
   * map is stale or absent, the request proceeds and the field is null", and
   * nothing anywhere may branch on it.
   */
  readonly lastUsedPeer: string | null;
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
  /**
   * Stamps `last_used_at`, and `last_used_peer` when a peer is supplied.
   *
   * Remote throttles this to one write per token per 60 s (its §4.6) — "every
   * authenticated request writing a row would make an SSE reconnect storm a
   * write storm" — so this is not once per request in practice.
   *
   * @param peer omit to leave the existing peer untouched; pass `null` to clear
   *   it. Only the caller that authenticated the request knows the peer, so it
   *   is never derived here.
   */
  touch(id: string, at?: string, peer?: string | null): void;
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
  /** Absent from the row when remote's module migration has not been applied. */
  readonly last_used_peer?: string | null;
  readonly expires_at: string | null;
  readonly revoked_at: string | null;
}

/** The columns `0001_init.sql` creates — present in every database (§1.4). */
const CORE_COLUMNS =
  'id, label, device, token_hash, token_prefix, created_at, last_used_at, expires_at, revoked_at';

const INSERT_COLUMNS = CORE_COLUMNS;

/**
 * `last_used_peer` (remote DESIGN §4.1) arrives with
 * `migrations/remote/0001_last_used_peer.sql`, and a **module** migration set is
 * applied only when its module is loaded — so the column exists in the home
 * edition with remote enabled and nowhere else (§1.3, §6.2).
 *
 * The repository is built in *every* edition, so it asks the schema rather than
 * assuming: with the column absent the field reads `null`, and remote — the only
 * caller that ever writes it, and one that cannot exist without its own
 * migration — sees it exactly as it left it. Preparing a statement naming a
 * column that a work-edition database has never heard of would fail the boot of
 * the edition that has no remote listener at all.
 */
function hasPeerColumn(db: Database): boolean {
  const row = db
    .prepare<[], { n: number }>(
      "SELECT COUNT(*) AS n FROM pragma_table_info('remote_tokens') WHERE name = 'last_used_peer'",
    )
    .get();
  return (row?.n ?? 0) > 0;
}

function toRecord(row: RemoteTokenRow): RemoteTokenRecord {
  return {
    id: row.id,
    label: row.label,
    device: row.device,
    tokenHash: row.token_hash,
    tokenPrefix: row.token_prefix,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    lastUsedPeer: row.last_used_peer ?? null,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
}

export function createRemoteTokensRepository(db: Database, clock: Clock): RemoteTokensRepository {
  const peerColumn = hasPeerColumn(db);
  const columns = peerColumn ? `${CORE_COLUMNS}, last_used_peer` : CORE_COLUMNS;

  const insert = db.prepare(
    `INSERT INTO remote_tokens (${INSERT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const getStatement = db.prepare<[string], RemoteTokenRow>(
    `SELECT ${columns} FROM remote_tokens WHERE id = ?`,
  );
  const byHash = db.prepare<[string], RemoteTokenRow>(
    `SELECT ${columns} FROM remote_tokens WHERE token_hash = ?`,
  );
  const listAll = db.prepare<[], RemoteTokenRow>(
    `SELECT ${columns} FROM remote_tokens ORDER BY created_at DESC, id DESC`,
  );
  const listLive = db.prepare<[], RemoteTokenRow>(
    `SELECT ${columns} FROM remote_tokens WHERE revoked_at IS NULL ORDER BY created_at DESC, id DESC`,
  );
  const touch = db.prepare<[string, string]>(
    'UPDATE remote_tokens SET last_used_at = ? WHERE id = ?',
  );
  const touchWithPeer = peerColumn
    ? db.prepare<[string, string | null, string]>(
        'UPDATE remote_tokens SET last_used_at = ?, last_used_peer = ? WHERE id = ?',
      )
    : undefined;
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
        lastUsedPeer: null,
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

    touch: (id, at, peer) => {
      const stamp = at ?? isoTimestamp(clock());
      // `peer === undefined` means "leave it alone", which is why this is two
      // statements rather than one with a COALESCE: a caller that does not know
      // the peer must not be able to blank an audit field by omission.
      if (peer === undefined || touchWithPeer === undefined) {
        touch.run(stamp, id);
        return;
      }
      touchWithPeer.run(stamp, peer, id);
    },

    revoke: (id, at) => revoke.run(at ?? isoTimestamp(clock()), id).changes > 0,

    delete: (id) => deleteStatement.run(id).changes > 0,
  };
}
