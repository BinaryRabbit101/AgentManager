/**
 * `POST /api/remote/stream-ticket` and the per-agent grant routes — remote
 * DESIGN §5, §3.4, §6.1; IMPLEMENTATION §7 and §8.
 *
 * ```
 * POST /api/remote/stream-ticket      single-use WS/SSE ticket (§3.4)
 * GET  /api/remote/agents             per-agent grants (§5, §12 contract 4)
 * PUT  /api/remote/agents/:id/access  { enabled: boolean } — the grant gate (§6.1)
 * ```
 *
 * ## All three are reachable remotely, and one of them is an exception
 *
 * `stream-ticket` must be: a phone that cannot mint a ticket cannot watch
 * anything, which is the product. `GET /api/remote/agents` is a read. And
 * `PUT …/access` is §3.2's **one deliberate exception** to the loosening
 * principle, called out there so it is a decision rather than an inconsistency:
 *
 * > "the per-agent remote-access grant (§6.1) is a loosening action that is
 * > allowed remotely, because D5 mandates it and because it is bounded three
 * > ways — scoped to one agent, time-limited (§6.3), and reachable only by an
 * > already-valid token."
 *
 * ## Why a ticket route needs a token identity, and what it does without one
 *
 * A ticket is *bound to the token that minted it* (§3.4) and its whole purpose is
 * to let a connection inherit that token's identity. On the **local** listener
 * there is no bearer identity at all — foundation §6.4 makes that the intended
 * trust boundary (R6) — so there is nothing to bind to, and local streams need no
 * ticket because they need no credential. Rather than mint an unbound ticket (a
 * credential belonging to nobody, which no revoke could ever kill), the route
 * answers `400` locally and says why.
 */
import type { Logger } from 'pino';

import type { Clock } from '../../storage/index.js';
import type { RouteDefinition } from '../types.js';

import type { GrantStore } from './grants.js';
import type { StreamRegistry } from './streams.js';
import type { TicketStore } from './tickets.js';

export interface StreamRouteDeps {
  readonly tickets: TicketStore;
  readonly streams: StreamRegistry;
  readonly clock: Clock;
  readonly logger: Logger;
}

export interface GrantRouteDeps {
  readonly grants: GrantStore;
  readonly clock: Clock;
  readonly logger: Logger;
}

/** The refusal when a ticket is asked for where there is no token to bind it to. */
export const TICKET_NEEDS_TOKEN_MESSAGE =
  'A stream ticket is bound to the remote access token that minted it, and this request carries ' +
  'none. On the local listener there is no bearer identity by design (foundation DESIGN §6.4), ' +
  'and local streams need no ticket: open /api/events directly. From another device, send ' +
  '"Authorization: Bearer <token>" (remote DESIGN §3.4).';

export function createStreamRoutes(deps: StreamRouteDeps): readonly RouteDefinition[] {
  return [
    {
      method: 'POST',
      path: '/api/remote/stream-ticket',
      description:
        'Mints a single-use, 30-second ticket so a browser can authenticate an SSE or WS ' +
        'connection it cannot set a header on (remote DESIGN §3.4).',
      handler: (request, response) => {
        const tokenId = request.tokenId;
        if (tokenId === undefined) {
          return response.error(400, 'invalid_request', TICKET_NEEDS_TOKEN_MESSAGE);
        }
        const at = deps.clock().getTime();
        deps.tickets.sweep(at);
        const minted = deps.tickets.mint(tokenId, at);
        // The ticket value is never logged: it is a (short-lived) credential, and
        // R3 has the redactor scrub `ticket=` out of logged URLs for the same
        // reason. Only the fact and the deadline are recorded.
        deps.logger.debug(
          { tokenId, expiresAt: minted.expiresAt, live: deps.tickets.size() },
          'minted a single-use stream ticket',
        );
        return response.json(minted, { status: 201 });
      },
    },
  ];
}

function readEnabled(body: unknown): boolean | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  const enabled = (body as Record<string, unknown>)['enabled'];
  return typeof enabled === 'boolean' ? enabled : undefined;
}

export function createGrantRoutes(deps: GrantRouteDeps): readonly RouteDefinition[] {
  return [
    {
      method: 'GET',
      path: '/api/remote/agents',
      description:
        'Every live per-agent remote-access grant, with the deadline the UI must show ' +
        '(remote DESIGN §5, §12 contract 4).',
      handler: (_request, response) =>
        response.json({ agents: deps.grants.list(deps.clock().getTime()) }),
    },
    {
      method: 'PUT',
      path: '/api/remote/agents/:id/access',
      // §3.2's one deliberate exception: a loosening action that is allowed
      // remotely, because D5 mandates it and it is bounded three ways.
      description:
        'Grants or revokes remote start permission for one agent. Allowed remotely — §3.2’s one ' +
        'deliberate exception to the loosening principle (remote DESIGN §6.1, §6.3).',
      handler: (request, response) => {
        const agentId = request.params['id'] ?? '';
        if (agentId.length === 0) {
          return response.error(400, 'invalid_request', 'A grant needs an agent id in the path.');
        }
        const enabled = readEnabled(request.body);
        if (enabled === undefined) {
          return response.error(
            400,
            'invalid_request',
            'This route expects { "enabled": true } or { "enabled": false } (remote DESIGN §6.1).',
          );
        }

        const at = deps.clock().getTime();
        if (!enabled) {
          // §6.3's "explicit toggle off — immediate", from either listener. Absence
          // is the disabled state, so this deletes rather than rewrites.
          const revoked = deps.grants.revoke(agentId, 'toggled_off');
          return response.json({ agentId, enabled: false, revoked, grant: null });
        }

        const grant = deps.grants.grant(agentId, at, {
          via: request.origin === 'remote' ? 'remote' : 'local',
          ...(request.tokenId === undefined ? {} : { tokenId: request.tokenId }),
        });
        return response.json({ agentId, enabled: true, revoked: false, grant });
      },
    },
  ];
}
