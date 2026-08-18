/**
 * Pairing and remote parity against a **real** core (IMPLEMENTATION §10).
 *
 * What this file exists to catch is one class of bug and nothing else: the
 * frontend guessing a field name. Every parity rule in the app is applied to a
 * payload — the deny list, the minted token, the grant's `expiresAt`, the
 * module list feature detection reads — and a jsdom test proves only that the
 * rule works on the payload *this repository wrote down*. So these boot
 * `src/main.ts` in the **home edition**, with the remote module loaded and its
 * routes registered, and run the app's own functions over what the server
 * actually returns.
 *
 * **What is deliberately not here**: driving the remote *listener*. It binds a
 * Tailscale address and its peer guard refuses loopback by design (remote §9.2
 * #6) — correctly, and the seam that lets remote's own tests override that
 * predicate is not on the module's public options. Reaching it from here would
 * mean widening another element's construction surface to suit a test in this
 * one. The bearer path is covered instead by `web/src/api/client.test.ts` (the
 * five typed outcomes), `web/src/app/shell.test.tsx` (a 401 renders the pairing
 * screen) and `remote`'s own middleware suite — and the end-to-end phone pass
 * is on the manual checklist, where a real tailnet and a real camera belong.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { claimTokenFromHash, type PairingWindow } from '../src/api/pairing';
import type { Health, MintedToken, RemoteStatus, RemoteTokenListView } from '../src/api/types';
import { controlState, listenerLine, tokenExpiryWarning } from '../src/remote/access';
import { encodeQr } from '../src/remote/qr';

import { bootCore, type BootedCore } from './core';

/** A machine with no Tailscale at all — no socket is opened by these tests. */
const NO_TAILSCALE = { detect: { locateCli: () => undefined, networkInterfaces: () => ({}) } };

let core: BootedCore;

beforeEach(async () => {
  core = await bootCore({ argv: ['--edition', 'home'], remote: NO_TAILSCALE });
});

afterEach(async () => {
  await core.shutdown();
});

describe('feature detection reads the module list the server sends (§3.5)', () => {
  it('finds `remote` in the home edition, by the field name the UI uses', async () => {
    const health = await core.client.request<Health>('/health');
    expect(health.kind).toBe('ok');
    if (health.kind !== 'ok') return;
    // `id`, not `name` — the whole edition rule hangs off this one field, and a
    // guess here would silently hide the remote UI in production.
    const ids = health.value.modules.map((module) => module.id);
    expect(ids).toContain('remote');
    expect(ids).toContain('orchestrator');
    expect(ids.every((id) => typeof id === 'string' && id !== '')).toBe(true);
  });
});

describe('the deny list the settings screen greys controls from (§13.4)', () => {
  it('is the real one, and it names exactly the controls §13.4 enumerates', async () => {
    const status = await core.client.request<RemoteStatus>('/remote/status');
    expect(status.kind).toBe('ok');
    if (status.kind !== 'ok') return;

    // The same function the settings screen calls, over the server's payload.
    for (const control of [
      { method: 'POST', path: '/api/remote/tokens' },
      { method: 'POST', path: '/api/remote/restart' },
      { method: 'PUT', path: '/api/remote/enabled' },
      { method: 'POST', path: '/api/service/shutdown' },
    ]) {
      const state = controlState(status.value, true, control);
      expect(state.disabled, control.path).toBe(true);
      // The user reads remote's own sentence, before the request rather than
      // after a 403 (§13.4: "never produce a raw 403 to the user").
      expect(state.reason ?? '', control.path).not.toBe('');
    }

    // …and nothing is disabled at the desk, on the same payload.
    expect(
      controlState(status.value, false, { method: 'POST', path: '/api/remote/tokens' }).disabled,
    ).toBe(false);
    // Revoking is allowed from the phone — the tablet-on-a-train case (§13.2).
    expect(
      controlState(status.value, true, { method: 'DELETE', path: '/api/remote/tokens/tok_1' })
        .disabled,
    ).toBe(false);
  });

  it('renders the listener line from the real status, including the waiting case', async () => {
    const status = await core.client.request<RemoteStatus>('/remote/status');
    if (status.kind !== 'ok') return;
    // No Tailscale on this machine, so the listener is waiting and §13.2 says
    // the sentence carries Tailscale's own state string.
    expect(status.value.state).toBe('waiting');
    expect(listenerLine(status.value)).toContain('Remote access unavailable');
  });
});

describe('minting a device token, and pairing from its QR (§13.2, §3.2)', () => {
  it('returns a plaintext and a pairing URL, and never the plaintext again', async () => {
    const minted = await core.client.request<MintedToken>('/remote/tokens', {
      method: 'POST',
      body: { label: 'Pixel' },
    });
    expect(minted.kind).toBe('ok');
    if (minted.kind !== 'ok') return;
    expect(minted.value.token.length).toBeGreaterThan(20);
    expect(minted.value.prefix).not.toBe('');

    // The list route carries the prefix and never the secret — which is what
    // makes "shown exactly once" true on the server side as well as in the UI.
    const list = await core.client.request<RemoteTokenListView>('/remote/tokens');
    if (list.kind !== 'ok') return;
    expect(JSON.stringify(list.value)).not.toContain(minted.value.token);
    expect(list.value.tokens.map((token) => token.id)).toContain(minted.value.id);
    // Every row carries the expiry the banner is computed from.
    expect(list.value.tokens[0]).toHaveProperty('expiresAt');
    expect(tokenExpiryWarning(list.value.tokens, Date.now())).toBeUndefined();
  });

  it('encodes the server’s own qrUrl, and the fragment pairs the client', async () => {
    // Nothing is bound (no Tailscale), so `qrUrl` is null and the dialog falls
    // back to the copyable text — which is the honest behaviour, and is why the
    // pairing URL is rebuilt here the way a bound listener would return it.
    const minted = await core.client.request<MintedToken>('/remote/tokens', {
      method: 'POST',
      body: { label: 'Pixel' },
    });
    if (minted.kind !== 'ok') return;
    expect(minted.value.qrUrl).toBeNull();

    const pairingUrl = `http://workstation.example-tailnet.ts.net:7478/#t=${minted.value.token}`;
    // The QR encoder takes a real token of a real length without complaint.
    const code = encodeQr(pairingUrl);
    expect(code.version).toBeLessThanOrEqual(10);

    const url = new URL(pairingUrl);
    let stored: string | null = null;
    const replaced: string[] = [];
    const windowRef: PairingWindow = {
      location: { hash: url.hash, pathname: '/', search: '' } as Location,
      history: {
        replaceState: (_state: unknown, _title: string, next?: string | URL | null) => {
          replaced.push(String(next));
        },
      } as History,
    };
    expect(
      claimTokenFromHash(
        {
          setToken: (value) => {
            stored = value;
          },
        },
        windowRef,
      ),
    ).toBe(minted.value.token);
    expect(stored).toBe(minted.value.token);
    expect(replaced).toEqual(['/']);
  });

  it('revokes from the list, idempotently', async () => {
    const minted = await core.client.request<MintedToken>('/remote/tokens', {
      method: 'POST',
      body: { label: 'Tablet' },
    });
    if (minted.kind !== 'ok') return;

    const first = await core.client.request<{ revoked: boolean }>(
      `/remote/tokens/${minted.value.id}`,
      { method: 'DELETE' },
    );
    const second = await core.client.request<{ revoked: boolean }>(
      `/remote/tokens/${minted.value.id}`,
      { method: 'DELETE' },
    );
    expect(first.kind).toBe('ok');
    expect(second.kind).toBe('ok');
    if (first.kind !== 'ok' || second.kind !== 'ok') return;
    expect(first.value.revoked).toBe(true);
    // Pressing it twice produces a state, not an error.
    expect(second.value.revoked).toBe(false);
  });
});

describe('per-agent grants carry an expiry (§13.2, remote §12.4)', () => {
  it('returns `expiresAt` on every granted row, which is what the card shows', async () => {
    const agent = await core.client.request<{ definition: { id: string } }>('/roster/agents', {
      method: 'POST',
      body: {
        name: 'Ada',
        specialty: 'feature-implementation',
        capabilities: { roles: ['implementer'] },
        personaText: '# Ada\n',
      },
    });
    if (agent.kind !== 'ok') throw new Error('agent refused');

    const granted = await core.client.request<{ grant: { expiresAt: string } }>(
      `/remote/agents/${agent.value.definition.id}/access`,
      { method: 'PUT', body: { enabled: true } },
    );
    expect(granted.kind).toBe('ok');
    if (granted.kind !== 'ok') return;
    expect(Date.parse(granted.value.grant.expiresAt)).toBeGreaterThan(Date.now());

    const list = await core.client.request<{
      agents: { agentId: string; expiresAt: string; grantedVia: string }[];
    }>('/remote/agents');
    if (list.kind !== 'ok') return;
    const row = list.value.agents.find((one) => one.agentId === agent.value.definition.id);
    expect(row).toBeDefined();
    // The two fields the board badge and the settings row both render.
    expect(row?.expiresAt).toBeTruthy();
    expect(row?.grantedVia).toBe('local');
  });
});
