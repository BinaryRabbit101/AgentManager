/**
 * Failed-authentication accounting, per-peer lockout, and the per-token route
 * bucket — remote DESIGN §4.6, §3.3, §10.1; IMPLEMENTATION §5.
 *
 * ## What this is for, stated honestly
 *
 * §4.6 and §10.1 both say it outright: a 256-bit token does not fall to a
 * ten-attempts-per-five-minutes budget, so **this is not cryptographic margin**.
 * It exists so that an attempt is *visible* (one `warn` line and one persisted
 * event per window, not a log flood) and so that a misconfigured client cannot
 * spin against the socket unnoticed. Designing it as though it were the control
 * would lead somewhere worse — which §4.6 also says, and this file obeys:
 *
 * > "**Deliberately not implemented: auto-revoking a token after N failures.** It
 * > sounds stronger and is weaker — the 6-character prefix is visible in the UI
 * > and in logs, so anyone who could brute-force could instead cheaply *revoke*
 * > every device by failing against known prefixes."
 *
 * There is therefore no code path from this file to `remote_tokens`. It holds
 * timestamps in memory and answers yes or no; it cannot revoke, disable, or
 * modify a credential, and that is the point.
 *
 * ## In-memory, and why that is not a gap
 *
 * §4.6: "In-memory; a process restart clears it, which is acceptable because an
 * attacker on the tailnet cannot restart our process, and because the outer
 * boundary (tailnet membership) has already been passed by anyone who can reach
 * the socket at all."
 *
 * ## Nothing here reads a clock
 *
 * Every method takes `at` — the caller's `ctx.clock` reading. That is what lets
 * IMPLEMENTATION §5's "the block lifts exactly after `blockMs`, verified with the
 * injected `ctx.clock`, not a real sleep" be a deterministic assertion rather
 * than a fifteen-minute test.
 */

/** What {@link AuthLimiter.recordFailure} answers. */
export interface FailureOutcome {
  /** Failures still inside the sliding window, including this one. */
  readonly failures: number;
  /** True when *this* failure is the one that closed the window. */
  readonly blocked: boolean;
  /** Milliseconds; present exactly when {@link blocked} is true. */
  readonly until?: number;
  /** True when this was the first failure of a fresh window (§4.6's one event). */
  readonly firstInWindow: boolean;
}

export interface AuthLimiter {
  /**
   * The moment a blocked peer becomes free again, or `undefined` when it is not
   * blocked.
   */
  blockedUntil(peer: string, at: number): number | undefined;
  /** Records one failed authentication from `peer`. */
  recordFailure(peer: string, at: number): FailureOutcome;
  /** Drops expired windows and lifted blocks. Idempotent and cheap. */
  sweep(at: number): void;
  /** Peers currently tracked — a leak check, not a product surface. */
  size(): number;
}

export interface AuthLimiterDeps {
  /** `remote.auth.maxFailures` (10). */
  readonly maxFailures: number;
  /** `remote.auth.failWindowMs` (5 min). */
  readonly failWindowMs: number;
  /** `remote.auth.blockMs` (15 min). */
  readonly blockMs: number;
}

interface PeerState {
  /** Failure timestamps inside the window, ascending. */
  failures: number[];
  /** When the current block lifts, or `undefined` when the peer is not blocked. */
  blockedUntil: number | undefined;
}

export function createAuthLimiter(deps: AuthLimiterDeps): AuthLimiter {
  const peers = new Map<string, PeerState>();

  /** Trims a peer's window and clears a block that has lifted. */
  const refresh = (state: PeerState, at: number): void => {
    state.failures = state.failures.filter((stamp) => at - stamp < deps.failWindowMs);
    if (state.blockedUntil !== undefined && at >= state.blockedUntil) {
      state.blockedUntil = undefined;
      // A lifted block starts the peer's budget again from zero. Carrying the
      // failures that caused it over would make the second block instant, so a
      // single fat-fingered pairing would cost the device the rest of the day.
      state.failures = [];
    }
  };

  return {
    blockedUntil: (peer, at) => {
      const state = peers.get(peer);
      if (state === undefined) return undefined;
      refresh(state, at);
      return state.blockedUntil;
    },

    recordFailure: (peer, at) => {
      const state = peers.get(peer) ?? { failures: [], blockedUntil: undefined };
      peers.set(peer, state);
      refresh(state, at);

      const firstInWindow = state.failures.length === 0;
      state.failures.push(at);

      if (state.blockedUntil === undefined && state.failures.length >= deps.maxFailures) {
        // The failure that reaches the limit is itself answered with the block —
        // IMPLEMENTATION §5: "10 failures inside 5 minutes from one peer produce
        // a 429". Answering the tenth with a 401 and only the eleventh with a
        // 429 would leave the budget one attempt wider than the config says.
        state.blockedUntil = at + deps.blockMs;
        return {
          failures: state.failures.length,
          blocked: true,
          until: state.blockedUntil,
          firstInWindow,
        };
      }

      return { failures: state.failures.length, blocked: false, firstInWindow };
    },

    sweep: (at) => {
      for (const [peer, state] of peers) {
        refresh(state, at);
        if (state.failures.length === 0 && state.blockedUntil === undefined) peers.delete(peer);
      }
    },

    size: () => peers.size,
  };
}

// ---------------------------------------------------------------------------
// The per-token route bucket (§3.3)
// ---------------------------------------------------------------------------

/**
 * A sliding-window counter keyed by token id.
 *
 * §3.3's second hardening on `GET /api/fs/browse`: "it is subject to a
 * 60-requests-per-minute per-token bucket so a token holder cannot cheaply
 * enumerate the profile tree." Per *token*, not per peer — the token is the
 * device identity (§14), and a peer IP is a property of the network.
 */
export interface RouteBucket {
  /** Consumes one unit. `false` means the window is full — answer `429`. */
  take(key: string, at: number): boolean;
  /** Seconds until the oldest unit in the window falls out, for `Retry-After`. */
  retryAfterSeconds(key: string, at: number): number;
  sweep(at: number): void;
  size(): number;
}

export interface RouteBucketDeps {
  /** Requests permitted per window. `remote.browseRateLimitPerMin` (60). */
  readonly limit: number;
  readonly windowMs: number;
}

export function createRouteBucket(deps: RouteBucketDeps): RouteBucket {
  const windows = new Map<string, number[]>();

  const trim = (key: string, at: number): number[] => {
    const kept = (windows.get(key) ?? []).filter((stamp) => at - stamp < deps.windowMs);
    windows.set(key, kept);
    return kept;
  };

  return {
    take: (key, at) => {
      const kept = trim(key, at);
      if (kept.length >= deps.limit) return false;
      kept.push(at);
      return true;
    },

    retryAfterSeconds: (key, at) => {
      const kept = trim(key, at);
      const oldest = kept[0];
      if (oldest === undefined) return 1;
      return Math.max(1, Math.ceil((deps.windowMs - (at - oldest)) / 1000));
    },

    sweep: (at) => {
      for (const key of [...windows.keys()]) {
        if (trim(key, at).length === 0) windows.delete(key);
      }
    },

    size: () => windows.size,
  };
}
