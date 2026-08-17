/**
 * The bearer-token store — remote DESIGN §4.1–§4.5, IMPLEMENTATION §4.
 *
 * ## The three properties this file exists to guarantee
 *
 * 1. **A token is recoverable from nothing.** {@link RemoteTokenService.mint}
 *    returns the plaintext once, to its caller, and keeps no copy: what reaches
 *    `remote_tokens` is `sha256(token)` plus a six-character display prefix
 *    (§4.1). There is no method here that answers "what was the token", because
 *    there is no way to write one.
 * 2. **Verification reads no secret.** Reconciliation **R5** is explicit that
 *    remote never calls `SecretResolver.reveal()` — the credential is not in the
 *    secret store at all. {@link RemoteTokenService.verify} hashes what the
 *    client presented and compares that digest, in constant time, against the
 *    `token_hash` column. Nothing else is consulted, and there is no code path
 *    from a database row back to a usable credential.
 * 3. **Every refusal is the same refusal.** §4.6: "unknown, malformed, expired,
 *    and revoked are indistinguishable to the caller. No oracle." So `verify`
 *    answers `{ok: false}` with no reason attached — the reason cannot leak into
 *    a response body because it never leaves this function.
 *
 * ## Why the lookup is by digest rather than by prefix
 *
 * DESIGN §4.6 describes "an indexed lookup by `token_prefix`" followed by the
 * constant-time compare. This implementation looks the row up by `token_hash` —
 * foundation's `findByHash`, backed by that column's UNIQUE index — and then
 * performs the same `timingSafeEqual` over the two digests. It is the same
 * narrowing with three advantages and no cost:
 *
 * - **It leaks strictly less.** A prefix lookup makes the *first six characters*
 *   of a credential a queryable key; a digest lookup makes no substring of the
 *   presented token a key for anything, because SHA-256 stands between them.
 *   That is also what makes the timing criterion of IMPLEMENTATION §4
 *   unfalsifiable rather than merely unmeasured: response time cannot correlate
 *   with the number of matching leading bytes when nothing downstream of the
 *   hash ever sees a leading byte.
 * - **Prefixes collide** — R3 says so in as many words ("prefixes collide in
 *   principle and are not a stable join key"), so a prefix lookup returns a
 *   *set* and the caller has to decide which row to compare against. A UNIQUE
 *   digest returns one row or none.
 * - **It needs no new repository method**, so foundation's storage surface is
 *   unchanged.
 *
 * The prefix keeps its stated job (§4.3: the list view shows it, and the audit
 * line carries it) and gains no other one.
 */
import { createHash, randomBytes as cryptoRandomBytes, timingSafeEqual } from 'node:crypto';

import type { Clock, RemoteTokenRecord, RemoteTokensRepository } from '../../storage/index.js';
import { isoTimestamp } from '../../storage/index.js';

/** §4.2: "32 bytes from `crypto.randomBytes`, base64url — 43 characters, 256 bits." */
export const TOKEN_BYTES = 32;

/** §4.3's display prefix. Six characters, for human recognition — never a key. */
export const TOKEN_PREFIX_LENGTH = 6;

/**
 * §4.6: "Success updates `last_used_at` / `last_used_peer`, throttled to at most
 * one write per token per 60 s."
 */
export const TOUCH_THROTTLE_MS = 60_000;

/** The one error code every authentication failure answers with (§4.6). */
export const UNAUTHORIZED_CODE = 'unauthorized';

/**
 * The one authentication failure message.
 *
 * Deliberately constant and deliberately uninformative: §4.6 requires unknown,
 * malformed, expired and revoked tokens to be **byte-identical** to the caller,
 * and the cheapest way to guarantee that is for there to be exactly one string.
 */
export const UNAUTHORIZED_MESSAGE =
  'This request needs a valid remote access token. Pair this device from AgentManager on the ' +
  'machine itself (Settings → Remote Access) and send the token as "Authorization: Bearer <token>".';

/** A token as every list and response shows it — never the plaintext (§4.3). */
export interface TokenView {
  readonly id: string;
  readonly label: string;
  readonly device: string | null;
  /** `token_prefix`: six characters for recognition (§4.3). */
  readonly prefix: string;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  /** Peer IP, plus the tailnet node name when the peer map resolved it (§4.1). */
  readonly lastUsedPeer: string | null;
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
  /** Derived, so the UI greys an expired row without re-implementing the clock. */
  readonly expired: boolean;
}

/** What `POST /api/remote/tokens` answers with, exactly once (§4.2). */
export interface MintedToken {
  readonly view: TokenView;
  /**
   * The plaintext, 43 base64url characters.
   *
   * It exists in this object and in the creation response body, and nowhere
   * else — not in a log, not in a column, not in a second response. §9.1 #3.
   */
  readonly token: string;
}

/**
 * The result of a verification.
 *
 * `{ok: false}` carries no reason **by construction**: a discriminated union
 * with one empty arm is how §4.6's "no oracle" survives a later refactor that
 * wants to be helpful.
 */
export type TokenVerdict =
  { readonly ok: true; readonly record: RemoteTokenRecord } | { readonly ok: false };

/** A refusal the token routes turn straight into a response. */
export class RemoteTokenError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RemoteTokenError';
  }
}

export interface MintRequest {
  readonly label: string;
  readonly device?: string | null;
  /** Overrides `remote.token.ttlDays`. `null` means "never expires" (§4.4). */
  readonly ttlDays?: number | null;
}

export interface RemoteTokenService {
  /** Creates a token and returns its plaintext **once** (§4.2). */
  mint(request: MintRequest): MintedToken;
  /** Every token, revoked ones included, newest first. Never a plaintext. */
  list(): readonly TokenView[];
  /** Live tokens: neither revoked nor expired (§5's `activeTokenCount`). */
  activeCount(): number;
  /** §4.5. `false` when the id is unknown or was already revoked. */
  revoke(id: string): boolean;
  get(id: string): TokenView | undefined;
  /**
   * The whole of authentication (§4.6).
   *
   * @param presented what the client sent, or `undefined` when it sent nothing.
   */
  verify(presented: string | undefined): TokenVerdict;
  /**
   * Records a successful use, throttled to one write per token per 60 s (§4.6).
   *
   * @returns whether a write actually happened — asserted by the burst test.
   */
  noteUse(id: string, peer: string | undefined, peerName?: string | null): boolean;
}

export interface RemoteTokenServiceDeps {
  readonly tokens: RemoteTokensRepository;
  readonly clock: Clock;
  /** `remote.token.ttlDays`; `null` means tokens never expire by default (§4.4). */
  readonly defaultTtlDays: number | null;
  /** `remote.token.maxActive` (§4.2) — hygiene, not a security control. */
  readonly maxActive: number;
  /** Injected only so a test can pin a token's bytes. Defaults to `crypto`. */
  readonly randomBytes?: (size: number) => Buffer;
  /**
   * The deciding comparison.
   *
   * Defaults to `crypto.timingSafeEqual` and is injected for exactly one
   * reason: a test needs to *count* the comparisons to prove there is always
   * precisely one, over two full 32-byte digests, whatever was presented.
   */
  readonly compare?: (left: Buffer, right: Buffer) => boolean;
}

/** `sha256(token)` as lower-case hex — the value the `token_hash` column holds. */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** 32 random bytes as 43 base64url characters (§4.2). */
export function generateTokenValue(
  randomBytes: (size: number) => Buffer = cryptoRandomBytes,
): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/**
 * Whether an expiry has passed.
 *
 * The boundary is inclusive — a token is dead *at* its `expires_at`, not one
 * millisecond after — because §10.4 wants clock handling to be unambiguous, and
 * "expired" is the safe side of an off-by-one on a credential.
 */
export function hasExpired(expiresAt: string | null, now: number): boolean {
  if (expiresAt === null) return false;
  const deadline = Date.parse(expiresAt);
  // An unparseable timestamp is treated as expired: a credential whose lifetime
  // cannot be established has no established lifetime.
  if (Number.isNaN(deadline)) return true;
  return deadline <= now;
}

function toView(record: RemoteTokenRecord, now: number): TokenView {
  return {
    id: record.id,
    label: record.label,
    device: record.device,
    prefix: record.tokenPrefix,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
    lastUsedPeer: record.lastUsedPeer,
    expiresAt: record.expiresAt,
    revokedAt: record.revokedAt,
    expired: hasExpired(record.expiresAt, now),
  };
}

/**
 * Constant-time comparison of two hex digests.
 *
 * `timingSafeEqual` throws on a length mismatch, which would be both a crash and
 * a timing signal, so the lengths are checked first — on values that are always
 * 32 bytes in any correct build, making the guard a diagnostic rather than a
 * branch an attacker can steer.
 */
export function digestsEqual(
  left: string,
  right: string,
  compare: (a: Buffer, b: Buffer) => boolean = timingSafeEqual,
): boolean {
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  if (a.byteLength === 0 || a.byteLength !== b.byteLength) return false;
  return compare(a, b);
}

export function createRemoteTokenService(deps: RemoteTokenServiceDeps): RemoteTokenService {
  const randomBytes = deps.randomBytes ?? cryptoRandomBytes;
  const compare = deps.compare ?? timingSafeEqual;
  /** `tokenId` → the millisecond of its last `last_used_at` write (§4.6). */
  const touchedAt = new Map<string, number>();

  const now = (): number => deps.clock().getTime();

  return {
    mint: (request) => {
      const label = request.label.trim();
      if (label.length === 0) {
        throw new RemoteTokenError(
          400,
          'invalid_request',
          'A remote token needs a label naming the device it is for ("Pixel 9", "work laptop"). ' +
            'Per-device tokens are what make revocation surgical (remote DESIGN §4.3).',
        );
      }

      const at = now();
      const live = deps.tokens.list().filter((record) => !hasExpired(record.expiresAt, at));
      if (live.length >= deps.maxActive) {
        throw new RemoteTokenError(
          409,
          'token_limit_reached',
          `There are already ${String(live.length)} active remote tokens, which is the configured ` +
            `maximum (remote.token.maxActive = ${String(deps.maxActive)}). Revoke a device you no ` +
            'longer use, or raise the limit.',
        );
      }

      const token = generateTokenValue(randomBytes);
      const ttlDays = request.ttlDays === undefined ? deps.defaultTtlDays : request.ttlDays;
      const expiresAt = ttlDays === null ? null : isoTimestamp(new Date(at + ttlDays * 86_400_000));

      const record = deps.tokens.create({
        label,
        device: request.device ?? null,
        // The only place the plaintext is turned into anything, and the only
        // thing that is kept.
        tokenHash: sha256Hex(token),
        tokenPrefix: token.slice(0, TOKEN_PREFIX_LENGTH),
        createdAt: isoTimestamp(new Date(at)),
        expiresAt,
      });

      return { view: toView(record, at), token };
    },

    list: () => {
      const at = now();
      return deps.tokens.list({ includeRevoked: true }).map((record) => toView(record, at));
    },

    activeCount: () => {
      const at = now();
      return deps.tokens.list().filter((record) => !hasExpired(record.expiresAt, at)).length;
    },

    revoke: (id) => deps.tokens.revoke(id),

    get: (id) => {
      const record = deps.tokens.get(id);
      return record === undefined ? undefined : toView(record, now());
    },

    verify: (presented) => {
      if (presented === undefined || presented.length === 0) return { ok: false };

      // The presented value is hashed *before* anything is looked up, so no
      // substring of it is ever a key, an index probe, or a comparand.
      const digest = sha256Hex(presented);
      const record = deps.tokens.findByHash(digest);
      if (record === undefined) return { ok: false };

      // R5: the deciding comparison, in constant time, over the stored digest —
      // not over a revealed secret, of which there is none.
      if (!digestsEqual(digest, record.tokenHash, compare)) return { ok: false };

      if (record.revokedAt !== null) return { ok: false };
      if (hasExpired(record.expiresAt, now())) return { ok: false };
      return { ok: true, record };
    },

    noteUse: (id, peer, peerName) => {
      const at = now();
      const last = touchedAt.get(id);
      if (last !== undefined && at - last < TOUCH_THROTTLE_MS) return false;
      touchedAt.set(id, at);
      // §4.1: one text column, because the node name is best-effort enrichment
      // and a second nullable column would invite code that treats it as
      // identity. Nothing branches on this value anywhere.
      const label =
        peer === undefined || peer.length === 0
          ? null
          : peerName === undefined || peerName === null || peerName.length === 0
            ? peer
            : `${peer} (${peerName})`;
      deps.tokens.touch(id, isoTimestamp(new Date(at)), label);
      return true;
    },
  };
}
