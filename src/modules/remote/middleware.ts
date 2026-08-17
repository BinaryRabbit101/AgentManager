/**
 * The remote listener's request policy — remote DESIGN §3.1, §4, §9.2;
 * IMPLEMENTATION §4, §5, §6.
 *
 * This file replaces M3's placeholder, which refused every request because a
 * socket existed and no credential mechanism did. What stands in its place is the
 * chain foundation's `mount` runs in front of every handler on the tailnet
 * listener, in this order:
 *
 * | # | Middleware | Refuses with |
 * |---|---|---|
 * | 1 | {@link createPeerGuard} — §9.2 #6, peer inside `100.64.0.0/10` | `403 peer_not_on_tailnet` |
 * | 2 | {@link createHostGuard} — §9.2 #8, `Host` allowlist | `421 misdirected_request` |
 * | 3 | {@link createRoutePolicy} — §3.1's four rules | `403` / `401` / `429` |
 *
 * The peer and `Host` guards are separate middlewares rather than steps inside
 * the third because §9.2 #6 says "refused **before any routing**": they must not
 * be able to end up downstream of a rule that serves something.
 *
 * ## Why rules 1–3 of §3.1 are one middleware and not three
 *
 * Rule 1 (the static shell) *grants* access; a foundation `Middleware` can only
 * refuse (by returning a result) or abstain (by returning nothing). A rule that
 * says "and stop asking questions" cannot be expressed as an early middleware in
 * a chain that keeps running, so the three rules that decide one request live in
 * one function, in the order §3.1 gives them. {@link decideRoutePolicy} holds the
 * decision as a pure function so it can be enumerated over the live route table.
 *
 * ## What is deliberately absent
 *
 * Rule 4 — the per-agent grant gate — is M8. Its absence is not a hole: with no
 * grant gate, an authenticated remote client can start a session, which is
 * exactly what the *local* client can do, and D5's consent requirement is a
 * milestone away rather than a bypassed check. Stream tickets (§3.4) are M7, and
 * until they exist a browser cannot open a WS/SSE stream remotely at all — the
 * closed direction.
 */
import type { HttpResult, Middleware, RequestContext, ResponseTools } from '../../http/types.js';
import type { Clock } from '../../storage/index.js';

import {
  BROWSE_PATH,
  ROUTE_DENIED_CODE,
  decideRoutePolicy,
  type PolicyDecision,
} from './policy.js';
import type { AuthLimiter, RouteBucket } from './rateLimit.js';
import { CGNAT_RANGE, isCgnatIPv4 } from './tailscale.js';
import { UNAUTHORIZED_CODE, UNAUTHORIZED_MESSAGE, type RemoteTokenService } from './tokens.js';

/** §9.2 #6: a peer that is not a tailnet node address. */
export const PEER_REFUSED_CODE = 'peer_not_on_tailnet';

/** §9.2 #8: the `Host` header names something this listener is not. */
export const MISDIRECTED_CODE = 'misdirected_request';

/** §4.6's lockout. `429` with `Retry-After` (§8.2). */
export const AUTH_BLOCKED_CODE = 'too_many_auth_failures';

/** §3.3's per-token route bucket. `429` with `Retry-After` (§8.2). */
export const RATE_LIMITED_CODE = 'rate_limited';

// ---------------------------------------------------------------------------
// The audit sink
// ---------------------------------------------------------------------------

/** The facts every audit line carries (§9.1 #4). */
export interface RequestFacts {
  readonly requestId: string;
  readonly method: string;
  readonly path: string;
  readonly peer: string | undefined;
}

export interface AuthFailureDetail extends RequestFacts {
  /** Failures inside the current window, including this one. */
  readonly failures: number;
  readonly at: string;
}

export interface AuthBlockDetail extends AuthFailureDetail {
  readonly until: string;
  readonly retryAfterSeconds: number;
}

export interface BrowseDetail extends RequestFacts {
  readonly tokenId: string;
  readonly prefix: string;
  readonly requested: string | null;
  /** The path as the filesystem resolves it — §3.3's audit-is-the-control line. */
  readonly resolved: string | null;
}

export interface RefusalDetail extends RequestFacts {
  readonly status: number;
  readonly code: string;
  readonly reason: string;
}

/**
 * Where this middleware's audit output goes.
 *
 * An interface rather than a logger and a bus, so the middleware has no opinion
 * about `access.log`'s format or about which events persist — foundation owns
 * both (§5, §6.5) — and so a unit test can read the audit trail as data. The
 * module wires the real implementation in `index.ts`.
 */
export interface RemoteAuditSink {
  /**
   * The first failure of a window: one `warn` line and one persisted
   * `remote.auth.failed` event (§4.6). Repeat failures inside the window are
   * deliberately silent — "that is how a brute-force attempt becomes a
   * self-inflicted log flood".
   */
  authFailed(detail: AuthFailureDetail): void;
  /** The peer just became blocked: one `warn` line and one persisted event (§4.6). */
  authBlocked(detail: AuthBlockDetail): void;
  /** §3.3: every remote `fs/browse` request, with its resolved path, at `info`. */
  browsed(detail: BrowseDetail): void;
  /** Everything this chain refused, at `warn`. */
  refused(detail: RefusalDetail): void;
}

// ---------------------------------------------------------------------------
// Peer and Host normalisation
// ---------------------------------------------------------------------------

/**
 * The peer address as a bare IPv4 literal where possible.
 *
 * A dual-stack socket reports IPv4 peers as `::ffff:100.64.0.7`, and a CGNAT
 * check against that string fails — which would refuse every legitimate request
 * on a host where Node happened to open the socket that way. Normalising is the
 * difference between a guard and an outage.
 */
export function normalisePeer(address: string | undefined): string | undefined {
  if (address === undefined) return undefined;
  const value = address.trim();
  if (value.length === 0) return undefined;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(value);
  return mapped?.[1] ?? value;
}

/** The `Host` header's host part, lower-cased, without its port. */
export function normaliseHost(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const value = header.trim().toLowerCase();
  if (value.length === 0) return undefined;
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    return end === -1 ? undefined : value.slice(1, end);
  }
  const colon = value.indexOf(':');
  const host = colon === -1 ? value : value.slice(0, colon);
  // A MagicDNS name may arrive fully qualified with the root dot; the allowlist
  // holds it without one (§2.2 strips it), so both spellings must compare equal.
  return host.endsWith('.') ? host.slice(0, -1) : host;
}

/** `Retry-After`, in whole seconds and never zero (RFC 9110 §10.2.3). */
function withRetryAfter(result: HttpResult, seconds: number): HttpResult {
  return {
    ...result,
    headers: { ...result.headers, 'retry-after': String(Math.max(1, Math.ceil(seconds))) },
  };
}

function facts(request: RequestContext): RequestFacts {
  return {
    requestId: request.requestId,
    method: request.method,
    path: request.path,
    peer: normalisePeer(request.remoteAddress),
  };
}

// ---------------------------------------------------------------------------
// 1 — the peer guard (§9.2 #6)
// ---------------------------------------------------------------------------

export interface PeerGuardDeps {
  /**
   * Whether a peer may be served. Defaults to §2.1's CGNAT check.
   *
   * §9.2 #6: "Bound to a Tailscale-only address this should be unreachable; it
   * costs five lines and catches the misconfiguration that would otherwise be
   * silent." It is injectable for the same reason the detector is: a test drives
   * the mounted listener over loopback, and loopback is — correctly — refused by
   * the production predicate.
   */
  readonly allowPeer?: (address: string) => boolean;
  readonly audit: RemoteAuditSink;
}

export function createPeerGuard(deps: PeerGuardDeps): Middleware {
  const allow = deps.allowPeer ?? isCgnatIPv4;
  return (request: RequestContext, response: ResponseTools): HttpResult | undefined => {
    const peer = normalisePeer(request.remoteAddress);
    if (peer !== undefined && allow(peer)) return undefined;
    const reason =
      `the peer address ${peer ?? '(unknown)'} is not a Tailscale node address ` +
      `(${CGNAT_RANGE}), so this connection did not arrive over the tailnet`;
    deps.audit.refused({ ...facts(request), status: 403, code: PEER_REFUSED_CODE, reason });
    return response.error(
      403,
      PEER_REFUSED_CODE,
      'This listener serves the tailnet only. The connection did not arrive from a Tailscale ' +
        'node address (architecture D5, remote DESIGN §9.2).',
    );
  };
}

// ---------------------------------------------------------------------------
// 2 — the Host allowlist (§9.2 #8)
// ---------------------------------------------------------------------------

export interface HostGuardDeps {
  /** The bound IP, the MagicDNS name and `remote.hostnameHint` (§9.2 #8). */
  readonly allowedHosts: () => readonly string[];
  readonly audit: RemoteAuditSink;
}

/**
 * `421 Misdirected Request` for a `Host` this listener does not answer to.
 *
 * §9.2 #8: "Defence in depth against DNS rebinding from a browser that is itself
 * on the tailnet. The bearer token already defends this, which is why it is a
 * cheap second layer rather than the primary one." It runs ahead of the static
 * shell so a rebinding page cannot even load the bundle from us.
 */
export function createHostGuard(deps: HostGuardDeps): Middleware {
  return (request: RequestContext, response: ResponseTools): HttpResult | undefined => {
    const host = normaliseHost(
      typeof request.headers.host === 'string' ? request.headers.host : undefined,
    );
    const allowed = deps.allowedHosts().map((entry) => normaliseHost(entry) ?? entry.toLowerCase());
    if (host !== undefined && allowed.includes(host)) return undefined;
    const reason = `the Host header "${host ?? '(absent)'}" is not one this listener answers to`;
    deps.audit.refused({ ...facts(request), status: 421, code: MISDIRECTED_CODE, reason });
    return response.error(
      421,
      MISDIRECTED_CODE,
      'This listener does not answer to that Host. Reach AgentManager by its tailnet address or ' +
        'its MagicDNS name (remote DESIGN §9.2).',
    );
  };
}

// ---------------------------------------------------------------------------
// 3 — §3.1's rules 1 to 3
// ---------------------------------------------------------------------------

export interface RoutePolicyDeps {
  readonly tokens: RemoteTokenService;
  readonly limiter: AuthLimiter;
  /** §3.3's per-token `fs/browse` bucket. */
  readonly browseBucket: RouteBucket;
  readonly clock: Clock;
  readonly audit: RemoteAuditSink;
  /** §9.3's best-effort peer → node name map. **Never** an authorisation input. */
  readonly peerName?: (address: string) => string | null;
  /**
   * Resolves a browse path for the audit line only (§3.3).
   *
   * Injected because it touches the filesystem, and defaulted to a no-op-safe
   * `realpath`: a path that cannot be resolved is logged as it was asked for
   * rather than making an audit line the reason a request fails.
   */
  readonly resolvePath?: (path: string) => string;
}

export function createRoutePolicy(deps: RoutePolicyDeps): Middleware {
  const resolvePath = deps.resolvePath;

  const refuseDenied = (
    request: RequestContext,
    response: ResponseTools,
    decision: Extract<PolicyDecision, { kind: 'denied' }>,
  ): HttpResult => {
    deps.audit.refused({
      ...facts(request),
      status: 403,
      code: ROUTE_DENIED_CODE,
      reason: `${decision.source}: ${decision.reason}`,
    });
    return response.error(403, ROUTE_DENIED_CODE, decision.reason);
  };

  return (request: RequestContext, response: ResponseTools): HttpResult | undefined => {
    const decision = decideRoutePolicy({
      method: request.method,
      path: request.path,
      body: request.body,
      routeRemote: request.route?.remote,
    });

    // Rule 1 — the static shell, unauthenticated by design (§3.1).
    if (decision.kind === 'static') return undefined;

    // Rule 2 — the deny list, *before* auth, so a denied route is not a token
    // oracle (§3.1 rule 2). A caller with no token and a caller with a valid one
    // receive the identical 403.
    if (decision.kind === 'denied') return refuseDenied(request, response, decision);

    // Rule 3 — bearer authentication (§4).
    const at = deps.clock().getTime();
    const peer = normalisePeer(request.remoteAddress) ?? 'unknown';
    deps.limiter.sweep(at);

    const blockedUntil = deps.limiter.blockedUntil(peer, at);
    if (blockedUntil !== undefined) {
      const seconds = (blockedUntil - at) / 1000;
      deps.audit.refused({
        ...facts(request),
        status: 429,
        code: AUTH_BLOCKED_CODE,
        reason: `the peer is locked out until ${new Date(blockedUntil).toISOString()}`,
      });
      return withRetryAfter(
        response.error(
          429,
          AUTH_BLOCKED_CODE,
          'Too many failed remote sign-ins from this device. Wait for the lockout to lift and try ' +
            'again with a token paired at the machine (remote DESIGN §4.6).',
        ),
        seconds,
      );
    }

    const presented = readBearerToken(request);
    const verdict = deps.tokens.verify(presented);

    if (!verdict.ok) {
      // A request that presented *nothing* is not a sign-in attempt and must not
      // consume the budget: a browser that has not paired yet would otherwise
      // lock itself out of the pairing screen, and the brute-force this counter
      // exists to make visible necessarily presents a credential (§4.6, §10.1).
      if (presented !== undefined) {
        const outcome = deps.limiter.recordFailure(peer, at);
        if (outcome.firstInWindow) {
          deps.audit.authFailed({
            ...facts(request),
            failures: outcome.failures,
            at: new Date(at).toISOString(),
          });
        }
        if (outcome.blocked && outcome.until !== undefined) {
          const seconds = (outcome.until - at) / 1000;
          deps.audit.authBlocked({
            ...facts(request),
            failures: outcome.failures,
            at: new Date(at).toISOString(),
            until: new Date(outcome.until).toISOString(),
            retryAfterSeconds: Math.max(1, Math.ceil(seconds)),
          });
          return withRetryAfter(
            response.error(
              429,
              AUTH_BLOCKED_CODE,
              'Too many failed remote sign-ins from this device. Wait for the lockout to lift and ' +
                'try again with a token paired at the machine (remote DESIGN §4.6).',
            ),
            seconds,
          );
        }
      }
      // §4.6: "Every failure returns an identical `401 {"error":"unauthorized"}`
      // — unknown, malformed, expired, and revoked are indistinguishable to the
      // caller. No oracle." One constant status, one constant code, one constant
      // message, and nothing derived from the request.
      return response.error(401, UNAUTHORIZED_CODE, UNAUTHORIZED_MESSAGE);
    }

    const record = verdict.record;
    const nodeName = deps.peerName?.(peer) ?? null;
    // R3: `access.log` joins on `tokenId`, not on the colliding prefix. Both go
    // on the line; only the id is a key.
    request.attributeToken(record.id, {
      prefix: record.tokenPrefix,
      ...(nodeName === null ? {} : { peerName: nodeName }),
    });
    deps.tokens.noteUse(record.id, peer, nodeName);

    // §3.3's two additions on the one route where the audit trail is the control.
    if (request.method === 'GET' && request.path === BROWSE_PATH) {
      if (!deps.browseBucket.take(record.id, at)) {
        const seconds = deps.browseBucket.retryAfterSeconds(record.id, at);
        deps.audit.refused({
          ...facts(request),
          status: 429,
          code: RATE_LIMITED_CODE,
          reason: 'the per-token fs/browse bucket is full (remote DESIGN §3.3)',
        });
        return withRetryAfter(
          response.error(
            429,
            RATE_LIMITED_CODE,
            'Too many folder listings from this device in the last minute. This bucket exists so a ' +
              'token holder cannot cheaply enumerate the profile tree (remote DESIGN §3.3).',
          ),
          seconds,
        );
      }
      const requested = request.query.get('path');
      deps.audit.browsed({
        ...facts(request),
        tokenId: record.id,
        prefix: record.tokenPrefix,
        requested,
        resolved: resolveForAudit(requested, resolvePath),
      });
    }

    // Rule 4 — the per-agent grant gate — is M8. Nothing stands here yet.
    return undefined;
  };
}

/**
 * The `Bearer` credential, or `undefined` when the request carried none.
 *
 * §12 contract 2: "All `/api/**` requests carry `Authorization: Bearer <token>`.
 * Never a query parameter, never a cookie." So a `?access_token=` or a cookie is
 * not read here — not even as a fallback, because a fallback is the thing that
 * puts a durable credential in `access.log` (§3.4's rejected option).
 */
export function readBearerToken(request: RequestContext): string | undefined {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return undefined;
  const trimmed = header.trim();
  if (trimmed.length === 0) return undefined;
  const match = /^bearer[ \t]+(.*)$/i.exec(trimmed);
  // A header that is present but not a Bearer credential still counts as a
  // presented credential: §4.6 puts "malformed" in the same indistinguishable
  // bucket as "unknown", and treating it as absent would make the lockout
  // trivially avoidable by sending `Basic`.
  const value = (match?.[1] ?? trimmed).trim();
  return value.length === 0 ? trimmed : value;
}

/** Best-effort resolution for §3.3's audit line. Never affects the response. */
function resolveForAudit(
  requested: string | null,
  resolvePath: ((path: string) => string) | undefined,
): string | null {
  if (requested === null || requested.trim().length === 0) return null;
  if (resolvePath === undefined) return requested;
  try {
    return resolvePath(requested);
  } catch {
    return requested;
  }
}

// ---------------------------------------------------------------------------
// The chain
// ---------------------------------------------------------------------------

export type RemoteMiddlewareDeps = PeerGuardDeps & HostGuardDeps & RoutePolicyDeps;

/**
 * The middleware chain the remote listener mounts, in §3.1/§9.2 order.
 *
 * Returned as an array rather than composed into one function so the order is
 * visible at the call site and assertable in a test — the ordering *is* the
 * security property here, twice over (peer before routing, deny before auth).
 */
export function createRemoteMiddleware(deps: RemoteMiddlewareDeps): readonly Middleware[] {
  return [createPeerGuard(deps), createHostGuard(deps), createRoutePolicy(deps)];
}
