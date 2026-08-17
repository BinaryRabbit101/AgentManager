/**
 * Settings → Remote access (DESIGN §13.2, §13.4; IMPLEMENTATION §10).
 *
 * Present only in the home edition — the caller decides that by feature
 * detection, because §13.5 says the work edition hides the section rather than
 * disabling it, and a section that renders itself empty is still a section.
 *
 * Everything denied over the tailnet is **shown disabled with its reason**, and
 * every reason is remote's own sentence, read from `GET /api/remote/status`'s
 * deny list. Nothing here decides for itself what is refused.
 */

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactElement } from 'react';

import { queryKeys, useRemoteAgents, useRemoteStatus, useRemoteTokens } from '../api/queries';
import type { MintedToken, RemoteStatus } from '../api/types';
import { useServices } from '../app/AppContext';
import { useAppStore } from '../state/store';

import {
  controlState,
  grantExpiryLabel,
  isRemoteClient,
  listenerLine,
  tokenExpiryWarning,
} from './access';
import { encodeQr, qrPath } from './qr';

export function RemoteSection(): ReactElement {
  const { client } = useServices();
  const queryClient = useQueryClient();
  const pushToast = useAppStore((store) => store.pushToast);
  const remote = isRemoteClient(client);
  const status = useRemoteStatus(client, true);
  const tokens = useRemoteTokens(client, true);
  const grants = useRemoteAgents(client, true);
  const [minted, setMinted] = useState<MintedToken | undefined>();
  const [busy, setBusy] = useState(false);
  const now = Date.now();

  const data: RemoteStatus | undefined = status.data;
  const mint = controlState(data, remote, { method: 'POST', path: '/api/remote/tokens' });
  const restart = controlState(data, remote, { method: 'POST', path: '/api/remote/restart' });
  // §13.2: turning the kill switch **off** works from anywhere; turning it
  // **on** is local-only, which is exactly what remote's conditional backstop
  // entry says. So the enable direction is asked about and the disable one is not.
  const enable = controlState(data, remote, { method: 'PUT', path: '/api/remote/enabled' });
  const expiry = tokenExpiryWarning(tokens.data?.tokens ?? [], now);

  async function call(path: string, body: unknown, method = 'POST'): Promise<unknown> {
    setBusy(true);
    const result = await client.request(path, { method, body });
    setBusy(false);
    if (result.kind !== 'ok') {
      pushToast(result.message);
      return undefined;
    }
    await queryClient.invalidateQueries({ queryKey: queryKeys.remoteTokens });
    await queryClient.invalidateQueries({ queryKey: queryKeys.remoteStatus });
    await queryClient.invalidateQueries({ queryKey: queryKeys.remoteAgents });
    return result.value;
  }

  return (
    <section className="settings__section" aria-labelledby="settings-remote" data-section="remote">
      <h3 id="settings-remote">Remote access</h3>

      {/* remote §4.4: never let a credential expire silently. */}
      {expiry === undefined ? null : (
        <p className="notice" data-tone="warn" data-banner="token-expiry">
          {expiry.label}
        </p>
      )}

      {data === undefined ? (
        <p className="empty">Reading the listener…</p>
      ) : (
        <>
          <p data-fact="listener-state" data-state={data.state}>
            {listenerLine(data)}
          </p>
          <p className="settings__layer">
            {`${String(data.activeTokenCount)} active token${
              data.activeTokenCount === 1 ? '' : 's'
            }${data.clientUrl === null ? '' : ` · ${data.clientUrl}`}`}
          </p>

          <div className="assignment__actions">
            <button
              type="button"
              className="button"
              data-control="mint-token"
              disabled={mint.disabled || busy}
              title={mint.reason}
              onClick={() => {
                void call('/remote/tokens', { label: 'This device' }).then((value) => {
                  if (value !== undefined) setMinted(value as MintedToken);
                });
              }}
            >
              Create device token
            </button>
            <button
              type="button"
              className="button"
              data-control="enable-remote"
              disabled={(data.enabled ? false : enable.disabled) || busy}
              title={data.enabled ? undefined : enable.reason}
              onClick={() => void call('/remote/enabled', { enabled: !data.enabled }, 'PUT')}
            >
              {data.enabled ? 'Disable remote access' : 'Enable remote access'}
            </button>
            <button
              type="button"
              className="button"
              data-control="restart-listener"
              disabled={restart.disabled || busy}
              title={restart.reason}
              onClick={() => void call('/remote/restart', {})}
            >
              Restart listener
            </button>
          </div>

          {/* The reasons, visible rather than only in a tooltip (§13.4). */}
          {[
            ['mint-token', mint.reason],
            ['enable-remote', data.enabled ? undefined : enable.reason],
            ['restart-listener', restart.reason],
          ].map(([control, reason]) =>
            reason === undefined ? null : (
              <p key={control} className="settings__layer" data-reason={control}>
                {reason}
              </p>
            ),
          )}
        </>
      )}

      {minted === undefined ? null : (
        <MintedTokenPanel token={minted} onDismiss={() => setMinted(undefined)} />
      )}

      <h4>Device tokens</h4>
      {tokens.data === undefined || tokens.data.tokens.length === 0 ? (
        <p className="empty">No device tokens yet.</p>
      ) : (
        <ul className="settings__list">
          {tokens.data.tokens.map((token) => (
            <li key={token.id} className="settings__row" data-token-id={token.id}>
              <span>
                {`${token.label} · ${token.prefix}… · last used ${token.lastUsedAt ?? 'never'}${
                  token.lastUsedPeer === null ? '' : ` from ${token.lastUsedPeer}`
                }`}
              </span>
              <span className="settings__layer" data-token-expiry={token.expiresAt ?? ''}>
                {token.revokedAt === null
                  ? token.expiresAt === null
                    ? 'never expires'
                    : `expires ${token.expiresAt}`
                  : 'revoked'}
              </span>
              {/* Revocation works everywhere — the tablet-on-a-train case. */}
              {token.revokedAt === null ? (
                <button
                  type="button"
                  className="button"
                  disabled={busy}
                  onClick={() =>
                    void call(`/remote/tokens/${encodeURIComponent(token.id)}`, undefined, 'DELETE')
                  }
                >
                  Revoke
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <h4>Per-agent remote starts</h4>
      {grants.data === undefined || grants.data.agents.length === 0 ? (
        <p className="empty">No agent may be started remotely yet.</p>
      ) : (
        <ul className="settings__list">
          {grants.data.agents.map((grant) => (
            <li key={grant.agentId} className="settings__row" data-grant-for={grant.agentId}>
              <span>{grant.agentName ?? grant.agentId}</span>
              {/* §13.2: expiry is **always** shown. */}
              <span className="settings__layer" data-grant-expires={grant.expiresAt}>
                {`${grantExpiryLabel(grant, now)} · granted ${grant.grantedVia}`}
              </span>
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() =>
                  void call(
                    `/remote/agents/${encodeURIComponent(grant.agentId)}/access`,
                    { enabled: false },
                    'PUT',
                  )
                }
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * The plaintext, once (§13.2).
 *
 * > "shows the plaintext **once**, as copyable text and as a **QR rendered
 * > client-side** … with a clear 'this is the only time you will see it'."
 *
 * The token is held in this component's props and nowhere else: it is never put
 * in the query cache, never in `localStorage` on the desktop, and dismissing
 * the panel is what makes "once" true.
 */
export function MintedTokenPanel({
  token,
  onDismiss,
}: {
  readonly token: MintedToken;
  readonly onDismiss: () => void;
}): ReactElement {
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  const code = token.qrUrl === null ? undefined : encodeQr(token.qrUrl);

  return (
    <div className="panel" data-minted-token="true" role="group" aria-labelledby="minted-heading">
      <h4 id="minted-heading" ref={headingRef} tabIndex={-1}>
        This is the only time you will see this token
      </h4>
      <p className="token-plaintext" data-plaintext="true">
        {token.token}
      </p>
      {code === undefined ? (
        <p className="empty">
          Nothing is bound yet, so there is no address to put in a QR. Copy the token instead.
        </p>
      ) : (
        <>
          <svg
            className="qr"
            viewBox={`0 0 ${String(code.size)} ${String(code.size)}`}
            role="img"
            aria-label="Pairing QR code"
            data-qr-version={code.version}
          >
            <rect width={code.size} height={code.size} fill="#ffffff" />
            <path d={qrPath(code)} fill="#000000" />
          </svg>
          <p className="settings__layer">Scan this from the phone’s browser, on the tailnet.</p>
        </>
      )}
      <button type="button" className="button" onClick={onDismiss}>
        I have saved it
      </button>
    </div>
  );
}
