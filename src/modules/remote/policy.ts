/**
 * The remote route policy — remote DESIGN §3.1, §3.2; IMPLEMENTATION §6.
 *
 * ## Default-allow-authenticated, and why an allowlist would be worse
 *
 * §3.1 decided this and the reasoning is the whole shape of this file:
 *
 * > "An allowlist would mean every route any element adds is remotely broken
 * > until someone remembers to add it here — and the failure is silent,
 * > discovered on a phone, at the worst moment. […] The safe default for a
 * > transport whose only user is the machine's owner, holding a 256-bit token,
 * > over a WireGuard mesh, is *allow*."
 *
 * So this file is a **deny** list, from two independent sources, both enforced:
 *
 * 1. **Declared at registration** — foundation's per-route `{ remote: 'deny' }`
 *    metadata (foundation §6.4, remote R1). The authoritative source, because it
 *    lives next to the code that makes a route dangerous. Foundation records it
 *    and enforces nothing; this file is the only enforcement there is.
 * 2. **{@link BACKSTOP_DENY_PATTERNS}** — remote's own hardcoded list, "as
 *    belt-and-braces for a future route that forgets the flag" (§3.2b).
 *
 * ## Order, and the one thing the order is protecting
 *
 * §3.1's four rules, in order: static shell bypass → deny list → bearer auth →
 * per-agent grant gate (M8). Deny before auth is not cosmetic — §3.1 rule 2
 * spells out the reason: "Evaluated *before* auth so a denied route cannot be
 * used as a token oracle." A caller with no token and a caller with a good one
 * must get the identical `403` from a denied route, or the 403/401 boundary
 * becomes a way to test credentials.
 *
 * ## The one deliberate strengthening of §3.1's order
 *
 * Rule 1 grants *unauthenticated* access, and rule 2 runs after it. Taken
 * literally, a non-`/api` `GET` route that some element registered
 * `remote: 'deny'` would be served to anyone who can open the socket. §3.1
 * assumes the only such route is foundation's SPA bundle (registered
 * `remote: 'allow'`), and today it is — but the bypass here additionally requires
 * that the matched route is **not** declared `deny`, so the assumption is
 * enforced rather than relied upon. Nothing in the v1 inventory changes
 * behaviour; a future non-`/api` denied route fails closed instead of open.
 */
import type { RemotePolicy } from '../types.js';
import type { RegisteredRoute } from '../types.js';

/** §3.1 rule 2 / §8.2: "Show 'not available remotely'; **never retry**." */
export const ROUTE_DENIED_CODE = 'route_denied_remotely';

/** `GET /api/fs/browse` — the one route with its own bucket (§3.3). */
export const BROWSE_PATH = '/api/fs/browse';

/**
 * The routes a §3.4 stream ticket may authenticate — and **only** these.
 *
 * §3.4 names the three live surfaces: foundation's `/api/events` and
 * `/api/logs/stream`, and runner's `/api/sessions/:id/stream`. The list is an
 * allowlist rather than a heuristic ("any GET that opens an SSE stream") because
 * a ticket is a credential that travels in a URL, and the set of places a URL
 * credential is accepted must be short, fixed, and readable at a glance. A route
 * not on this list refuses a ticket exactly as it refuses a missing header, so
 * the ticket scheme can never become a general-purpose `?access_token=`.
 *
 * `/api/sessions/:id/stream` is listed although this build's runner has not
 * registered it yet: an entry that matches nothing costs nothing, and the
 * alternative is that the route arrives unauthenticable from a browser.
 */
export const STREAM_TICKET_PATHS: readonly string[] = [
  '/api/events',
  '/api/logs/stream',
  '/api/sessions/:id/stream',
];

/**
 * Matches an exact path, a `:name`-segmented pattern, or a `/**` suffix.
 *
 * Deliberately not a regex — a security list a reader cannot verify at a glance
 * is not belt-and-braces.
 */
export function pathMatchesPattern(pattern: string, path: string): boolean {
  if (pattern.endsWith('/**')) {
    const prefix = pattern.slice(0, -3);
    return path === prefix || path.startsWith(`${prefix}/`);
  }
  if (!pattern.includes(':')) return path === pattern;
  const expected = pattern.split('/');
  const actual = path.split('/');
  if (expected.length !== actual.length) return false;
  return expected.every(
    (segment, index) => segment.startsWith(':') || segment === (actual[index] ?? ''),
  );
}

/** True when a ticket may stand in for the bearer header on this request (§3.4). */
export function isStreamTicketRequest(method: string, path: string): boolean {
  if (method !== 'GET') return false;
  return STREAM_TICKET_PATHS.some((pattern) => pathMatchesPattern(pattern, path));
}

/** Methods a backstop entry matches. `'*'` matches every method. */
export type BackstopMethods = readonly string[];

export interface BackstopPattern {
  readonly methods: BackstopMethods;
  /**
   * A path pattern: an exact path, or one ending in `/**` which matches that
   * prefix and everything under it. Deliberately not a regex — a security list
   * a reader cannot verify at a glance is not belt-and-braces.
   */
  readonly pattern: string;
  /** Why, in the words of §3.2, for the log line and `GET /api/remote/status`. */
  readonly reason: string;
  /**
   * When present, the entry denies only requests whose body satisfies this.
   *
   * Exactly one entry needs it — `PUT /api/remote/enabled` is denied for
   * `{enabled: true}` and allowed for `{enabled: false}`, because §3.2's
   * loosening principle is about the *direction* of the change, not the route.
   */
  readonly deniesBody?: (body: unknown) => boolean;
}

/**
 * §3.2's "remote's own hardcoded pattern list", entry for entry.
 *
 * The one widening of the table as written: the secrets entry matches every
 * *write* method rather than `POST` alone. §3.2's stated purpose for it is that
 * "the pattern exists so the first one is denied by default rather than by
 * memory", and a credential written with `PUT` is the same act as one written
 * with `POST`. Reads are untouched, so a future route that lists secret *names*
 * is not caught by the backstop and can declare its own policy.
 */
export const BACKSTOP_DENY_PATTERNS: readonly BackstopPattern[] = [
  {
    methods: ['POST'],
    pattern: '/api/service/shutdown',
    reason:
      'Shutting down the core kills the listener that would restart it — the one action whose ' +
      'effect removes the ability to undo it. Remote users stop sessions, not the service ' +
      '(remote DESIGN §3.2).',
  },
  {
    methods: ['POST', 'PUT', 'PATCH', 'DELETE'],
    pattern: '/api/secrets/**',
    reason:
      'A remote token must not be able to write a credential into the machine’s secret store ' +
      '(remote DESIGN §3.2).',
  },
  {
    methods: ['POST'],
    pattern: '/api/remote/tokens',
    reason:
      'Minting a new long-lived credential from a stolen one is privilege continuation. Creating ' +
      'a device credential is a deliberate act performed at the machine (remote DESIGN §3.2, §4.2).',
  },
  {
    methods: ['POST'],
    pattern: '/api/remote/restart',
    reason:
      'Restarting the listener is not a reduction of remote privilege, and a bricked listener ' +
      'needs someone at the machine anyway (remote DESIGN §3.2, §10.3).',
  },
  {
    methods: ['PUT'],
    pattern: '/api/remote/enabled',
    reason:
      'A remote client may always reduce remote privilege; only a local action may restore it. ' +
      'Switching remote access off is allowed remotely; switching it back on is not ' +
      '(remote DESIGN §3.2’s loosening principle).',
    // Fail closed: anything that is not an explicit `{enabled: false}` is treated
    // as the loosening direction, so a malformed body cannot slip through as a
    // "not obviously true" enable.
    deniesBody: (body) => !isDisableRequest(body),
  },
];

/** Whether a `PUT /api/remote/enabled` body is the *reducing* direction. */
export function isDisableRequest(body: unknown): boolean {
  return (
    typeof body === 'object' && body !== null && (body as { enabled?: unknown }).enabled === false
  );
}

/** Whether a path is part of the API surface — everything under `/api`. */
export function isApiPath(path: string): boolean {
  return path === '/api' || path.startsWith('/api/');
}

/**
 * §3.1 rule 1's static shell.
 *
 * > "the SPA bundle foundation §6.4 serves on both listeners (`GET /`,
 * > `/assets/*`, `/index.html`, favicon, service worker) **and its history
 * > fallback** for any other non-`/api` `GET`: served **without** a bearer token.
 * > They contain no data; the phone must be able to load the app — including a
 * > deep-linked route arriving from an ntfy notification — before it can
 * > authenticate."
 *
 * Expressed as "a read of something that is not the API" rather than as a list of
 * five paths, because the enumerated paths *and the history fallback* are exactly
 * that set, and a literal list would drift the moment the bundle gains a file.
 * `HEAD` rides along: it is a `GET` that returns no body, and refusing it while
 * allowing `GET` would only break caching.
 */
export function isStaticShellRequest(method: string, path: string): boolean {
  return (method === 'GET' || method === 'HEAD') && !isApiPath(path);
}

function patternMatches(pattern: string, path: string): boolean {
  return pathMatchesPattern(pattern, path);
}

function methodMatches(methods: BackstopMethods, method: string): boolean {
  return methods.includes('*') || methods.includes(method);
}

/** The backstop entry a request trips, if any (§3.2b). */
export function backstopMatch(
  method: string,
  path: string,
  body: unknown,
): BackstopPattern | undefined {
  for (const entry of BACKSTOP_DENY_PATTERNS) {
    if (!methodMatches(entry.methods, method)) continue;
    if (!patternMatches(entry.pattern, path)) continue;
    if (entry.deniesBody !== undefined && !entry.deniesBody(body)) continue;
    return entry;
  }
  return undefined;
}

/**
 * What §3.1's first two rules decided about a request.
 *
 * `authenticate` is the default and carries no payload: everything that is not
 * the static shell and not denied is "allowed, once you prove who you are".
 */
export type PolicyDecision =
  | { readonly kind: 'static' }
  | { readonly kind: 'denied'; readonly source: 'declared' | 'backstop'; readonly reason: string }
  | { readonly kind: 'authenticate' };

export interface PolicyInput {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
  /** `req.route?.remote` — foundation binds the route before the middleware runs. */
  readonly routeRemote: RemotePolicy | undefined;
}

/**
 * Rules 1 and 2 of §3.1, as a pure function.
 *
 * Pure because IMPLEMENTATION §6's last criterion is a table test over the *live*
 * route table — "so a new route is covered automatically" — and a policy that can
 * only be exercised through a socket cannot be enumerated that way.
 */
export function decideRoutePolicy(input: PolicyInput): PolicyDecision {
  const declaredDeny = input.routeRemote === 'deny';

  // Rule 1, with the strengthening described in this file's header: the shell
  // bypass never covers a route whose author declared it must not be remote.
  if (!declaredDeny && isStaticShellRequest(input.method, input.path)) return { kind: 'static' };

  if (declaredDeny) {
    return {
      kind: 'denied',
      source: 'declared',
      reason:
        'This route is registered `remote: "deny"` by the module that owns it, so it is reachable ' +
        'only from the machine itself (foundation DESIGN §6.4, remote DESIGN §3.2).',
    };
  }

  const backstop = backstopMatch(input.method, input.path, input.body);
  if (backstop !== undefined) {
    return { kind: 'denied', source: 'backstop', reason: backstop.reason };
  }

  return { kind: 'authenticate' };
}

/** One line of the effective deny list `GET /api/remote/status` publishes. */
export interface DenyListEntry {
  readonly method: string;
  readonly path: string;
  readonly source: 'declared' | 'backstop';
  readonly reason: string;
  /** True when the denial depends on the request body (`{enabled: true}`). */
  readonly conditional: boolean;
}

/**
 * The deny list as it applies to the live route table (§12 contract 7).
 *
 * > "the deny list is short, stable, and enumerated in `GET /api/remote/status`
 * > so the UI can grey the affected controls rather than let the user discover
 * > them by 403."
 *
 * Computed from the real table rather than restated, so a route that gains the
 * flag appears here with no second edit — the same property the table test
 * asserts from the other direction.
 */
export function effectiveDenyList(routes: readonly RegisteredRoute[]): readonly DenyListEntry[] {
  const entries: DenyListEntry[] = [];
  for (const route of routes) {
    if (route.remote === 'deny') {
      entries.push({
        method: route.method,
        path: route.path,
        source: 'declared',
        reason: `Registered \`remote: "deny"\` by the "${route.moduleId}" module.`,
        conditional: false,
      });
      continue;
    }
    // `undefined` for the body: the conditional entry is reported as denied-by-
    // default, which is both the fail-closed behaviour and the honest thing to
    // show a UI that is deciding whether to grey a control.
    const backstop = backstopMatch(route.method, route.path, undefined);
    if (backstop !== undefined) {
      entries.push({
        method: route.method,
        path: route.path,
        source: 'backstop',
        reason: backstop.reason,
        conditional: backstop.deniesBody !== undefined,
      });
    }
  }
  return entries;
}
