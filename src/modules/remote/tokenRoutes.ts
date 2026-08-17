/**
 * Remote's token routes and the global kill switch — remote DESIGN §5, §4.2–§4.5.
 *
 * ```
 * GET    /api/remote/tokens        list; never plaintext
 * POST   /api/remote/tokens        LOCAL ONLY — { label, device?, ttlDays? }
 *                                  → { id, token, prefix, expiresAt, qrUrl }
 * DELETE /api/remote/tokens/:id    revoke; allowed remotely
 * PUT    /api/remote/enabled       { enabled }; false remotely, true LOCAL ONLY
 * ```
 *
 * ## The loosening principle, declared twice on purpose
 *
 * §3.2: "*a remote client may always reduce remote privilege; only a local action
 * may restore it.* Revoke a token remotely — yes. Mint one — no. Disable remote
 * access entirely from your phone — yes. Re-enable it — no."
 *
 * `POST /api/remote/tokens` therefore registers `remote: 'deny'`, and remote's
 * hardcoded backstop names the same path — the two sources of §3.2 agreeing about
 * the route that matters most, because "minting a *new* long-lived credential
 * from a stolen one is privilege continuation".
 *
 * `PUT /api/remote/enabled` cannot be declared either way: the direction of the
 * change decides. It registers as the default `allow` and is denied remotely by
 * the body-conditional backstop entry — and then **again** by the handler below,
 * which refuses `{enabled: true}` from a remote origin on its own. Two checks
 * because the first one lives in a middleware chain and this one lives next to the
 * write.
 *
 * ## The plaintext appears once, here
 *
 * §4.2's display-once rule is a property of this file: the value returned by
 * `mint()` goes straight into the creation response and is not logged, not
 * retained, and not obtainable again. §4.2 also explains the QR code — "because
 * typing 43 base64url characters into a phone is how a good security decision
 * becomes a user who writes the token in a note app" — and why the token rides in
 * the URL **fragment**, which browsers never send to a server and which therefore
 * never reaches `access.log`.
 */
import type { Logger } from 'pino';

import type { SettingsRepository } from '../../storage/index.js';
import type { RouteDefinition } from '../types.js';

import type { RemoteListener } from './listener.js';
import { ROUTE_DENIED_CODE } from './policy.js';
import { clientUrl } from './routes.js';
import { RemoteTokenError, type MintRequest, type RemoteTokenService } from './tokens.js';

export interface TokenRouteDeps {
  readonly tokens: RemoteTokenService;
  readonly listener: RemoteListener;
  readonly settings: SettingsRepository;
  readonly hostnameHint: string | null;
  readonly logger: Logger;
  /**
   * Called after the kill switch is written, with the new value.
   *
   * The socket must not close before the response describing the closure has been
   * written, so the module schedules the detect-and-bind cycle rather than
   * awaiting it here (§5: "Setting it false closes the socket and enters
   * `waiting`").
   */
  readonly onEnabledChanged: (enabled: boolean) => void;
}

/** The `settings` key of §5. Deliberately not configuration. */
export const REMOTE_ENABLED_SETTING = 'remote.enabled';

/** §4.2's QR payload: `http://<magicdns-name>:7478/#t=<token>`. */
export function pairingUrl(base: string | null, token: string): string | null {
  return base === null ? null : `${base}/#t=${token}`;
}

function asObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new RemoteTokenError(400, 'invalid_request', 'This route expects a JSON object body.');
  }
  return body as Record<string, unknown>;
}

/** Parses `{ label, device?, ttlDays? }`, refusing anything else (§4.3). */
export function readMintRequest(body: unknown): MintRequest {
  const object = asObject(body);
  const label = object['label'];
  if (typeof label !== 'string') {
    throw new RemoteTokenError(
      400,
      'invalid_request',
      'A remote token needs a "label" naming the device it is for. §4.3: one token per device, ' +
        'always — per-device tokens are what make revocation surgical.',
    );
  }

  const device = object['device'];
  if (device !== undefined && device !== null && typeof device !== 'string') {
    throw new RemoteTokenError(400, 'invalid_request', '"device" must be a string when present.');
  }

  const raw = object['ttlDays'];
  let ttlDays: number | null | undefined;
  if (raw === undefined) {
    ttlDays = undefined;
  } else if (raw === null) {
    // §4.4: "`null` = never expire, allowed but flagged in the UI".
    ttlDays = null;
  } else if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) {
    ttlDays = raw;
  } else {
    throw new RemoteTokenError(
      400,
      'invalid_request',
      '"ttlDays" must be a positive whole number of days, or null to never expire (§4.4).',
    );
  }

  return {
    label,
    device: typeof device === 'string' ? device : null,
    ...(ttlDays === undefined ? {} : { ttlDays }),
  };
}

/** `{ enabled: boolean }` for the kill switch (§5). */
export function readEnabledRequest(body: unknown): boolean {
  const object = asObject(body);
  const enabled = object['enabled'];
  if (typeof enabled !== 'boolean') {
    throw new RemoteTokenError(
      400,
      'invalid_request',
      'This route expects { "enabled": true } or { "enabled": false } (remote DESIGN §5).',
    );
  }
  return enabled;
}

export function createTokenRoutes(deps: TokenRouteDeps): readonly RouteDefinition[] {
  return [
    {
      method: 'GET',
      path: '/api/remote/tokens',
      // Allowed remotely: the list is label, prefix and last-used, which is what
      // lets the "I left my tablet on a train" case find the row to revoke.
      description: 'Lists paired devices. Never a token value (remote DESIGN §4.3).',
      handler: (_request, response) => response.json({ tokens: deps.tokens.list() }),
    },

    {
      method: 'POST',
      path: '/api/remote/tokens',
      // §3.2 and §4.2: creating a device credential is a deliberate act performed
      // at the machine. Remote's backstop names this path too.
      remote: 'deny',
      description:
        'Mints a remote access token and returns its plaintext exactly once. Local only ' +
        '(remote DESIGN §4.2, §3.2).',
      handler: (request, response) => {
        let minted;
        try {
          minted = deps.tokens.mint(readMintRequest(request.body));
        } catch (error) {
          if (error instanceof RemoteTokenError) {
            return response.error(error.status, error.code, error.message);
          }
          throw error;
        }

        // The one log line about a mint, and it names the token by its id and
        // prefix — never by its value (§9.1 #3).
        deps.logger.info(
          { tokenId: minted.view.id, prefix: minted.view.prefix, label: minted.view.label },
          'minted a remote access token; its plaintext is in this response and nowhere else',
        );

        const base = clientUrl(deps.listener.status(), deps.hostnameHint);
        return response.json(
          {
            id: minted.view.id,
            label: minted.view.label,
            device: minted.view.device,
            // Display-once. Everything else about this token is fetchable later;
            // this field is not.
            token: minted.token,
            prefix: minted.view.prefix,
            createdAt: minted.view.createdAt,
            expiresAt: minted.view.expiresAt,
            qrUrl: pairingUrl(base, minted.token),
          },
          { status: 201, headers: { location: `/api/remote/tokens/${minted.view.id}` } },
        );
      },
    },

    {
      method: 'DELETE',
      path: '/api/remote/tokens/:id',
      // §4.5: "**Allowed remotely** — the 'I left my tablet on a train' case is
      // the one where you are, by definition, not at the machine."
      description: 'Revokes a token. Effective immediately, and allowed remotely (§4.5).',
      handler: (request, response) => {
        const id = request.params['id'] ?? '';
        const existing = deps.tokens.get(id);
        if (existing === undefined) {
          return response.error(404, 'not_found', `No remote token with id ${id}.`);
        }
        const revoked = deps.tokens.revoke(id);
        deps.logger.warn(
          { tokenId: id, prefix: existing.prefix, label: existing.label, origin: request.origin },
          revoked
            ? 'revoked a remote access token'
            : 'a remote access token was already revoked; nothing changed',
        );
        // M7 adds the other half of §4.5 — terminating that token's live WS/SSE
        // connections — and M8 the clearing of per-agent grants when the last
        // active token goes. Neither exists yet, and neither weakens this: the
        // token stops authenticating on the very next request.
        return response.json({ id, revoked, token: deps.tokens.get(id) });
      },
    },

    {
      method: 'PUT',
      path: '/api/remote/enabled',
      // Not declarable: `false` is a reduction and allowed remotely, `true` is a
      // restoration and is not. The backstop's body condition and the check below
      // are the two enforcements.
      description:
        'The global remote kill switch. Switching it off is allowed remotely; switching it on is ' +
        'local only (remote DESIGN §5, §3.2).',
      handler: (request, response) => {
        let enabled;
        try {
          enabled = readEnabledRequest(request.body);
        } catch (error) {
          if (error instanceof RemoteTokenError) {
            return response.error(error.status, error.code, error.message);
          }
          throw error;
        }

        if (enabled && request.origin === 'remote') {
          // Unreachable while the backstop is in front of this route, and kept
          // anyway: the loosening principle should not depend on one middleware
          // list staying correct.
          return response.error(
            403,
            ROUTE_DENIED_CODE,
            'Remote access can be switched off from anywhere, but only switched back on from the ' +
              'machine itself (remote DESIGN §3.2’s loosening principle).',
          );
        }

        deps.settings.set(REMOTE_ENABLED_SETTING, enabled);
        deps.logger.warn(
          { enabled, origin: request.origin },
          enabled
            ? 'remote access switched on; the listener will detect and bind'
            : 'remote access switched off; the listener socket will close',
        );
        // §5: grants and tokens survive, "so re-enabling does not re-nag the user
        // through every consent prompt again".
        deps.onEnabledChanged(enabled);
        return response.json({ enabled });
      },
    },
  ];
}
