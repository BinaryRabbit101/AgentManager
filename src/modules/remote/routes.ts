/**
 * Remote's own routes, as far as M3 has anything to report — DESIGN §5.
 *
 * Two of the nine routes §5 lists exist at this milestone, and only because M3's
 * own work produces exactly what they carry:
 *
 * - **`GET /api/remote/status`** — §2.3 requires the *local* UI to be able to say
 *   "Remote access unavailable — Tailscale is `<state>`". That sentence is
 *   unreachable without this route, so shipping the state machine without it would
 *   ship a `waiting` state nobody can see. `activeTokenCount` and the effective
 *   deny list join it in M4 and M6.
 * - **`POST /api/remote/restart`** — named in M3's acceptance as the way out of
 *   `down`. Registered `remote: 'deny'` (§3.2) so it is local-only from the moment
 *   it exists: "a remote action that can brick the transport it travels on needs
 *   someone at the machine". Foundation records the flag; remote's middleware
 *   enforces it, and until M6 the hard deny of `middleware.ts` refuses it too.
 *
 * The token, grant, stream-ticket and kill-switch routes belong to M4, M7 and M8
 * and are deliberately absent rather than stubbed: a route that exists and does
 * nothing is worse for the UI than one that is honestly not there yet (§12
 * contract 6 — feature-detect, never 404-detect).
 */
import type { Logger } from 'pino';

import type { RouteDefinition } from '../types.js';

import type { RemoteListener, RemoteStatus } from './listener.js';

export interface RemoteRouteDeps {
  readonly listener: RemoteListener;
  readonly logger: Logger;
}

/** The body `GET /api/remote/status` answers with. */
export interface RemoteStatusBody extends RemoteStatus {
  /** `http://<magicdns-or-ip>:<port>` — what a phone would open (§4.2). */
  readonly clientUrl: string | null;
}

export function remoteStatusBody(
  status: RemoteStatus,
  hostnameHint: string | null,
): RemoteStatusBody {
  const host = status.magicDnsName ?? hostnameHint ?? status.boundAddress?.address ?? null;
  return {
    ...status,
    clientUrl:
      host === null || status.boundAddress === null
        ? null
        : `http://${host}:${String(status.boundAddress.port)}`,
  };
}

export function createRemoteRoutes(
  deps: RemoteRouteDeps & { readonly hostnameHint: string | null },
): readonly RouteDefinition[] {
  return [
    {
      method: 'GET',
      path: '/api/remote/status',
      description: "The remote listener's state, bound address and last error (remote DESIGN §5).",
      handler: (_request, response) =>
        response.json(remoteStatusBody(deps.listener.status(), deps.hostnameHint)),
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
        return response.json(remoteStatusBody(deps.listener.status(), deps.hostnameHint));
      },
    },
  ];
}
