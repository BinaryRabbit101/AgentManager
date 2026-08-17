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
  /** `http://<magicdns-or-ip>:<port>` — what a phone would open (§4.2). */
  readonly clientUrl: string | null;
  /** Tokens that are neither revoked nor expired (§5). */
  readonly activeTokenCount: number;
  /** §12 contract 7 — the effective deny list, over the live route table. */
  readonly deniedRemotely: readonly DenyListEntry[];
  /** Remote's own hardcoded backstop, so the UI can explain a 403 it did not expect. */
  readonly backstopPatterns: readonly { methods: readonly string[]; pattern: string }[];
}

/**
 * `http://<magicdns-or-ip>:<port>` — the origin a phone opens (§4.2).
 *
 * `null` while nothing is bound, because a client URL for a socket that does not
 * exist is a QR code that leads nowhere.
 */
export function clientUrl(status: RemoteStatus, hostnameHint: string | null): string | null {
  const host = status.magicDnsName ?? hostnameHint ?? status.boundAddress?.address ?? null;
  if (host === null || status.boundAddress === null) return null;
  return `http://${host}:${String(status.boundAddress.port)}`;
}

export function remoteStatusBody(
  status: RemoteStatus,
  hostnameHint: string | null,
  extra: {
    readonly activeTokenCount: number;
    readonly routes: readonly RegisteredRoute[];
  },
): RemoteStatusBody {
  return {
    ...status,
    clientUrl: clientUrl(status, hostnameHint),
    activeTokenCount: extra.activeTokenCount,
    deniedRemotely: effectiveDenyList(extra.routes),
    backstopPatterns: BACKSTOP_DENY_PATTERNS.map((entry) => ({
      methods: entry.methods,
      pattern: entry.pattern,
    })),
  };
}

export function createRemoteRoutes(
  deps: RemoteRouteDeps & { readonly hostnameHint: string | null },
): readonly RouteDefinition[] {
  const body = (): RemoteStatusBody =>
    remoteStatusBody(deps.listener.status(), deps.hostnameHint, {
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
