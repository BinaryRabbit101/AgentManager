/**
 * Remote's own status and restart routes — DESIGN §5.
 *
 * - **`GET /api/remote/status`** — §2.3 requires the *local* UI to be able to say
 *   "Remote access unavailable — Tailscale is `<state>`". That sentence is
 *   unreachable without this route, so shipping the state machine without it would
 *   ship a `waiting` state nobody can see. M4 adds `activeTokenCount` and M6 the
 *   **effective deny list**, which §12 contract 7 makes load-bearing: "the deny
 *   list is short, stable, and enumerated in `GET /api/remote/status` so the UI can
 *   grey the affected controls rather than let the user discover them by 403."
 * - **`POST /api/remote/restart`** — the way out of `down`. Registered
 *   `remote: 'deny'` (§3.2) so it is local-only from the moment it exists: "a
 *   remote action that can brick the transport it travels on needs someone at the
 *   machine". Foundation records the flag; remote's middleware enforces it.
 *
 * The token and kill-switch routes live in `tokenRoutes.ts` (M4/M6). The
 * stream-ticket and grant routes belong to M7 and M8 and are deliberately absent
 * rather than stubbed: a route that exists and does nothing is worse for the UI
 * than one that is honestly not there yet (§12 contract 6 — feature-detect, never
 * 404-detect).
 */
import type { Logger } from 'pino';

import type { RegisteredRoute, RouteDefinition } from '../types.js';

import { publicHostname, publicOrigin } from './config.js';
import type { RemoteListener, RemoteStatus } from './listener.js';
import { BACKSTOP_DENY_PATTERNS, effectiveDenyList, type DenyListEntry } from './policy.js';
import type { RemoteTokenService } from './tokens.js';

export interface RemoteRouteDeps {
  readonly listener: RemoteListener;
  readonly logger: Logger;
  readonly tokens: RemoteTokenService;
  /** Foundation's live route table, so the deny list is computed and not restated. */
  readonly routes: () => readonly RegisteredRoute[];
}

/** The body `GET /api/remote/status` answers with. */
export interface RemoteStatusBody extends RemoteStatus {
  /** The origin a phone opens: `remote.publicUrl`, else `http://<magicdns-or-ip>:<port>` (§4.2). */
  readonly clientUrl: string | null;
  /** Tokens that are neither revoked nor expired (§5). */
  readonly activeTokenCount: number;
  /** §12 contract 7 — the effective deny list, over the live route table. */
  readonly deniedRemotely: readonly DenyListEntry[];
  /** Remote's own hardcoded backstop, so the UI can explain a 403 it did not expect. */
  readonly backstopPatterns: readonly { methods: readonly string[]; pattern: string }[];
}

/**
 * How the client URL is spelled — the two declarations of §4.2, in precedence
 * order.
 *
 * They are one parameter rather than two because every caller needs both and a
 * caller that passed only one would silently build the wrong URL in proxy mode,
 * which is the exact bug this pair exists to close.
 */
export interface RemoteClientHints {
  /** `remote.publicUrl` — the front door, when it is not this listener's socket. */
  readonly publicUrl: string | null;
  /** `remote.hostnameHint` — this machine's name, when the CLI cannot supply it. */
  readonly hostnameHint: string | null;
}

/**
 * `http://<magicdns-or-ip>:<port>` — the origin a phone opens (§4.2).
 *
 * `null` while nothing is bound, because a client URL for a socket that does not
 * exist is a QR code that leads nowhere. That holds for a declared front door
 * too: the proxy is reachable, but everything behind it is this listener.
 *
 * `remote.publicUrl` wins when it is set, and wins whole — scheme, host and port
 * together. The fallback below reaches for a *name* and then keeps this process's
 * own scheme and port, which is right only while the phone talks to this socket
 * directly. In proxy mode it is not, and no amount of host substitution can fix a
 * port this process never hears about.
 */
export function clientUrl(status: RemoteStatus, hints: RemoteClientHints): string | null {
  if (status.boundAddress === null) return null;
  const declared = publicOrigin(hints.publicUrl);
  if (declared !== null) return declared;
  const host = status.magicDnsName ?? hints.hostnameHint ?? status.boundAddress.address;
  return `http://${host}:${String(status.boundAddress.port)}`;
}

/**
 * §9.2 #8's allowlist: every name this listener answers to.
 *
 * Built from the same two declarations as {@link clientUrl} and next to it on
 * purpose — the host a phone is *told* to dial and the host this listener will
 * *accept* are the same fact seen from two ends, and the bug in proxy mode is
 * always that one of them was updated alone.
 *
 * Both hints are kept, and both may be present: a proxy that preserves `Host`
 * sends `publicUrl`'s name, one that rewrites it sends something the owner has
 * to declare through `hostnameHint`. The caller re-reads this per request,
 * because the MagicDNS name and the bound address change when the tailnet
 * re-keys (§2.3).
 */
export function allowedHosts(status: RemoteStatus, hints: RemoteClientHints): readonly string[] {
  return [
    status.boundAddress?.address,
    status.magicDnsName,
    hints.hostnameHint,
    publicHostname(hints.publicUrl),
  ].filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

export function remoteStatusBody(
  status: RemoteStatus,
  hints: RemoteClientHints,
  extra: {
    readonly activeTokenCount: number;
    readonly routes: readonly RegisteredRoute[];
  },
): RemoteStatusBody {
  return {
    ...status,
    clientUrl: clientUrl(status, hints),
    activeTokenCount: extra.activeTokenCount,
    deniedRemotely: effectiveDenyList(extra.routes),
    backstopPatterns: BACKSTOP_DENY_PATTERNS.map((entry) => ({
      methods: entry.methods,
      pattern: entry.pattern,
    })),
  };
}

export function createRemoteRoutes(
  deps: RemoteRouteDeps & { readonly clientHints: RemoteClientHints },
): readonly RouteDefinition[] {
  const body = (): RemoteStatusBody =>
    remoteStatusBody(deps.listener.status(), deps.clientHints, {
      activeTokenCount: deps.tokens.activeCount(),
      routes: deps.routes(),
    });

  return [
    {
      method: 'GET',
      path: '/api/remote/status',
      description: "The remote listener's state, bound address and last error (remote DESIGN §5).",
      handler: (_request, response) => response.json(body()),
    },
    {
      method: 'POST',
      path: '/api/remote/restart',
      // §3.2's loosening principle: a remote client may reduce remote privilege,
      // never restore it, and a bricked listener needs someone at the machine.
      remote: 'deny',
      description: 'Forces a full detect-and-rebind cycle. Local only (remote DESIGN §5, §10.3).',
      handler: async (_request, response) => {
        deps.logger.info('remote listener restart requested');
        await deps.listener.restart();
        return response.json(body());
      },
    },
  ];
}
