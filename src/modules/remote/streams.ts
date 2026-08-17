/**
 * The `tokenId → Set<connection>` map, the heartbeat, and the reaper — remote
 * DESIGN §3.4 and §4.5; IMPLEMENTATION §7.
 *
 * ## Why the map exists at all
 *
 * §4.5: "Revocation is effective immediately and **also terminates every live
 * WS/SSE connection bound to that token**. The listener keeps a
 * `tokenId → Set<connection>` map for exactly this; without it, a revoked device
 * keeps streaming session output indefinitely, which would make the revoke button
 * a lie." That sentence is the whole specification of this file.
 *
 * ## How a stream created by *another* module's handler gets registered
 *
 * The streams remote authenticates are not remote's: `/api/events` is
 * foundation's (`src/http/routes/events.ts`), `/api/logs/stream` is foundation's,
 * and the per-session stream is runner's. Remote is a transport and adds no
 * routes of its own for them (§3.4: "Remote does not add streams; it makes the
 * existing ones authenticable from a browser").
 *
 * So {@link decorateSse} wraps `res.sse` on the request that has just
 * authenticated, before the handler runs. The handler calls the same `res.sse()`
 * it always called and receives the same {@link SseStream}; the wrapper's only
 * effect is that the stream it returns has been registered against the
 * authenticating `tokenId` and given a heartbeat.
 *
 * The alternative was a new `onStream` hook in foundation's `ListenerOptions` —
 * a cross-element change to a file remote does not own, for a fact remote is the
 * only consumer of. A decorator on the per-request tools object keeps the whole
 * mechanism inside this module, and it cannot silently stop working: a middleware
 * that failed to decorate would leave `registry.count()` at zero while streams
 * were open, which is what the revoke and leak tests assert on.
 *
 * ## The heartbeat, and what "two missed pongs" means for SSE
 *
 * §3.4: "Server pings every `remote.stream.heartbeatMs` (30 s); two missed pongs
 * closes. SSE gets a comment-frame keepalive on the same interval." Foundation
 * chose SSE over WebSockets deliberately (`src/http/sse.ts`), and **SSE has no
 * client-originated pong** — there is no frame for the browser to send back. The
 * honest realisation of the same guarantee is therefore: each tick writes the
 * keep-alive comment and then asks the transport whether it is still writable. A
 * silently dropped client (no FIN, so the server learns nothing until it writes)
 * fails the *next* tick, which is why the reaper's bound is two intervals and not
 * one. Named here rather than left implicit, because "two missed pongs" for a
 * one-way transport is otherwise a promise nobody can check.
 */
import type { ResponseTools, SseStream } from '../../http/types.js';

/** One live stream, as the registry sees it. */
export interface StreamConnection {
  readonly tokenId: string;
  /** Ends the stream. Safe to call more than once. */
  close(): void;
  /**
   * Writes one keep-alive and answers whether the transport is still writable.
   *
   * `false` counts as a missed beat; two consecutive misses reap the entry.
   */
  beat(): boolean;
}

export interface StreamRegistry {
  /** Registers a connection. The returned function deregisters it. */
  add(connection: StreamConnection): () => void;
  /** §4.5: closes and deregisters every stream bound to `tokenId`. */
  closeToken(tokenId: string): number;
  /** Closes everything — the module's `stop()`. */
  closeAll(): number;
  /** One heartbeat tick across every live connection; returns how many it reaped. */
  beat(): number;
  /** Live connections, in total and per token — the leak check of §7. */
  count(tokenId?: string): number;
  readonly tokens: readonly string[];
}

/** §3.4: two consecutive missed beats closes. */
export const MISSED_BEATS_BEFORE_CLOSE = 2;

interface Tracked {
  readonly connection: StreamConnection;
  misses: number;
}

export function createStreamRegistry(): StreamRegistry {
  /** `tokenId` → its live connections. Empty sets are removed, never kept. */
  const byToken = new Map<string, Set<Tracked>>();

  const forget = (tracked: Tracked): void => {
    const set = byToken.get(tracked.connection.tokenId);
    if (set === undefined) return;
    set.delete(tracked);
    if (set.size === 0) byToken.delete(tracked.connection.tokenId);
  };

  return {
    add: (connection) => {
      const tracked: Tracked = { connection, misses: 0 };
      const set = byToken.get(connection.tokenId) ?? new Set<Tracked>();
      set.add(tracked);
      byToken.set(connection.tokenId, set);
      return () => forget(tracked);
    },

    closeToken: (tokenId) => {
      const set = byToken.get(tokenId);
      if (set === undefined) return 0;
      // The set is copied first: `close()` fires the stream's own close listeners,
      // which deregister through `forget` and would otherwise mutate mid-iteration.
      const tracked = [...set];
      byToken.delete(tokenId);
      for (const entry of tracked) entry.connection.close();
      return tracked.length;
    },

    closeAll: () => {
      let closed = 0;
      for (const tokenId of [...byToken.keys()]) {
        const set = byToken.get(tokenId);
        if (set === undefined) continue;
        const tracked = [...set];
        byToken.delete(tokenId);
        for (const entry of tracked) {
          entry.connection.close();
          closed += 1;
        }
      }
      return closed;
    },

    beat: () => {
      let reaped = 0;
      for (const set of [...byToken.values()]) {
        for (const tracked of [...set]) {
          if (tracked.connection.beat()) {
            tracked.misses = 0;
            continue;
          }
          tracked.misses += 1;
          if (tracked.misses < MISSED_BEATS_BEFORE_CLOSE) continue;
          // Close *and* forget: a half-open connection must leave no map entry
          // behind, which is the leak the 100-cycle test looks for.
          tracked.connection.close();
          forget(tracked);
          reaped += 1;
        }
      }
      return reaped;
    },

    count: (tokenId) => {
      if (tokenId !== undefined) return byToken.get(tokenId)?.size ?? 0;
      let total = 0;
      for (const set of byToken.values()) total += set.size;
      return total;
    },

    get tokens() {
      return [...byToken.keys()];
    },
  };
}

/** An SSE stream as a {@link StreamConnection}. */
export function asConnection(tokenId: string, stream: SseStream): StreamConnection {
  return {
    tokenId,
    close: () => stream.close(),
    beat: () => {
      if (stream.closed) return false;
      // A write to a socket the client abandoned surfaces as an error or a close
      // on the response, which `openSse` turns into `stream.closed` — so the miss
      // is observed on the following tick.
      stream.comment('keep-alive');
      return !stream.closed;
    },
  };
}

/**
 * Replaces `res.sse` so the stream the handler opens is registered and beaten.
 *
 * Called by the route policy on a request that has authenticated — never on one
 * that has not, so an unauthenticated stream can never appear in the map.
 */
export function decorateSse(
  response: ResponseTools,
  tokenId: string,
  registry: StreamRegistry,
): void {
  const open = response.sse.bind(response);
  const mutable = response as { sse: ResponseTools['sse'] };
  mutable.sse = (init) => {
    const stream = open(init);
    const release = registry.add(asConnection(tokenId, stream));
    // The registry entry lives exactly as long as the stream: a client that goes
    // away cleanly fires `close` and deregisters without waiting for a heartbeat.
    stream.onClose(release);
    return stream;
  };
}
