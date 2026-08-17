/**
 * Single-use stream tickets — remote DESIGN §3.4, IMPLEMENTATION §7.
 *
 * The problem this solves is not hypothetical and has no cheaper answer:
 * **`new WebSocket(url)` and `new EventSource(url)` cannot set an
 * `Authorization` header.** §3.4 weighed the alternatives and rejected all of
 * them — the `Sec-WebSocket-Protocol` smuggle (WS only, abuses a field with its
 * own semantics), `?access_token=` (a *durable* credential in URLs, history and
 * `access.log`), and a session cookie (needs `Secure`, which needs TLS, which v1
 * does not have, and adds a CSRF surface where a header-only scheme has none).
 *
 * ```
 * POST /api/remote/stream-ticket        Authorization: Bearer <token>
 *   → { ticket: "<32 bytes base64url>", expiresAt, ttlSec: 30 }
 * GET  /api/events?ticket=<ticket>      (SSE)
 * ```
 *
 * ## The four properties this file exists to guarantee
 *
 * 1. **In memory only, never persisted.** There is no repository here and no
 *    migration for one. A ticket is worth 30 seconds; a restart discarding every
 *    live ticket costs a reconnect, and a `tickets` table would be a credential
 *    at rest for no benefit at all.
 * 2. **Single use.** {@link TicketStore.consume} *removes* the entry before it
 *    answers, so the second caller of the same string gets the same refusal an
 *    unknown string gets. Replay is not "detected"; it is arithmetically
 *    impossible, because the value is gone.
 * 3. **Bound to the token that minted it.** A ticket carries a `tokenId` and
 *    nothing else. The connection it opens inherits that token's identity for the
 *    whole of its life (§3.4), which is what makes revoking the token kill the
 *    stream (§4.5) — and the consuming caller re-checks that the token is still
 *    live, so a ticket minted a moment before a revoke is worth nothing.
 * 4. **Every refusal is the same refusal.** {@link ConsumeResult} carries no
 *    reason: unknown, already-used and expired are indistinguishable to the
 *    caller, exactly as §4.6 requires of bearer failures. A ticket is a
 *    credential; a credential with a helpful error message is an oracle.
 *
 * ## Nothing here reads a clock
 *
 * Every method takes `at` — the caller's `ctx.clock` reading — so "an expired
 * ticket is refused" is a deterministic assertion rather than a 30-second test.
 */
import { randomBytes as cryptoRandomBytes } from 'node:crypto';

/** §3.4: "32 bytes base64url" — the same entropy as a bearer token. */
export const TICKET_BYTES = 32;

/** The one error code every ticket failure answers with. */
export const TICKET_REFUSED_CODE = 'unauthorized';

/** A minted ticket, as `POST /api/remote/stream-ticket` returns it. */
export interface MintedTicket {
  /** The value the client puts in `?ticket=`. Scrubbed from `access.log` (R3). */
  readonly ticket: string;
  readonly expiresAt: string;
  readonly ttlSec: number;
}

/**
 * The result of consuming a ticket.
 *
 * A discriminated union with one empty arm, for the same reason `TokenVerdict`
 * is one: it is how "no oracle" survives a later refactor that wants to be
 * helpful about *why*.
 */
export type ConsumeResult =
  { readonly ok: true; readonly tokenId: string } | { readonly ok: false };

export interface TicketStore {
  /** Mints a ticket bound to `tokenId`. */
  mint(tokenId: string, at: number): MintedTicket;
  /**
   * Redeems a ticket **once**.
   *
   * The entry is removed whether or not it was still valid, so an expired ticket
   * cannot be retried into existence and a valid one cannot be used twice.
   */
  consume(ticket: string | null | undefined, at: number): ConsumeResult;
  /** Drops expired entries. Idempotent; called on the heartbeat tick. */
  sweep(at: number): void;
  /** Live tickets — a leak check, not a product surface. */
  size(): number;
}

export interface TicketStoreDeps {
  /** `remote.stream.ticketTtlSec` (§3.4, default 30). */
  readonly ttlSec: number;
  /** Injected only so a test can pin a ticket's bytes. Defaults to `crypto`. */
  readonly randomBytes?: (size: number) => Buffer;
}

interface TicketEntry {
  readonly tokenId: string;
  readonly expiresAtMs: number;
}

export function createTicketStore(deps: TicketStoreDeps): TicketStore {
  const randomBytes = deps.randomBytes ?? cryptoRandomBytes;
  const ttlMs = Math.max(1, Math.round(deps.ttlSec * 1000));
  const live = new Map<string, TicketEntry>();

  return {
    mint: (tokenId, at) => {
      const ticket = randomBytes(TICKET_BYTES).toString('base64url');
      const expiresAtMs = at + ttlMs;
      live.set(ticket, { tokenId, expiresAtMs });
      return {
        ticket,
        expiresAt: new Date(expiresAtMs).toISOString(),
        ttlSec: deps.ttlSec,
      };
    },

    consume: (ticket, at) => {
      if (typeof ticket !== 'string' || ticket.length === 0) return { ok: false };
      const entry = live.get(ticket);
      // Removed before the deadline is even looked at: "used" and "expired" leave
      // the store in the same state, so neither can be probed by retrying.
      live.delete(ticket);
      if (entry === undefined) return { ok: false };
      // Inclusive, like token expiry: a ticket is dead *at* its deadline.
      if (entry.expiresAtMs <= at) return { ok: false };
      return { ok: true, tokenId: entry.tokenId };
    },

    sweep: (at) => {
      for (const [ticket, entry] of [...live]) {
        if (entry.expiresAtMs <= at) live.delete(ticket);
      }
    },

    size: () => live.size,
  };
}
