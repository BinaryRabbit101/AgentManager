/**
 * Settings, and remote parity (IMPLEMENTATION §10's remaining criteria).
 *
 * - the token dialog: plaintext once, a QR generated with no network request,
 *   and the plaintext never reappearing — including in `localStorage`;
 * - the four denied controls "visible and **disabled with their reasons**, and
 *   never a raw 403";
 * - per-agent grants with `expiresAt`, live on `remote.agent.access.*`;
 * - the work edition: no Remote section, one honest sentence, and
 *   `orchestrator.notify` disabled with the layer that set it;
 * - health warnings displayed persistently rather than as a dismissible toast.
 */

import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { BOOT_FACTS, json, mount, type Responder } from '../../test/harness';
import { App } from '../App';
import { TOKEN_STORAGE_KEY } from '../api/client';
import type { BootFacts } from '../app/AppContext';

const STATUS = {
  state: 'listening',
  enabled: true,
  boundAddress: { address: '100.64.0.7', port: 7478 },
  port: 7478,
  magicDnsName: 'workstation.example-tailnet.ts.net',
  tailscaleState: 'Running',
  lastError: null,
  recentBindFailures: 0,
  detectionSource: 'cli',
  mode: 'tailscale',
  clientUrl: 'http://workstation.example-tailnet.ts.net:7478',
  activeTokenCount: 1,
  deniedRemotely: [
    {
      method: 'POST',
      path: '/api/remote/tokens',
      source: 'declared',
      reason: 'Device tokens are created at the machine itself (remote §3.2).',
      conditional: false,
    },
    {
      method: 'POST',
      path: '/api/remote/restart',
      source: 'declared',
      reason: 'Restarting the listener would cut this very connection.',
      conditional: false,
    },
    {
      method: 'PUT',
      path: '/api/remote/enabled',
      source: 'backstop',
      reason: 'Remote access switches off from anywhere, but back on only at the machine.',
      conditional: true,
    },
  ],
  backstopPatterns: [{ methods: ['POST'], pattern: '/api/service/shutdown' }],
};

const MINTED = {
  id: 'tok_new',
  label: 'This device',
  device: null,
  token: 'oat01-THE-ONLY-TIME-YOU-SEE-THIS-abcdefghijklmnop',
  prefix: 'oat01-',
  createdAt: '2026-08-17T12:00:00.000Z',
  expiresAt: '2026-11-15T12:00:00.000Z',
  qrUrl:
    'http://workstation.example-tailnet.ts.net:7478/#t=oat01-THE-ONLY-TIME-YOU-SEE-THIS-abcdefghijklmnop',
};

const GRANTS = {
  agents: [
    {
      agentId: 'ada',
      agentName: 'Ada',
      enabled: true,
      grantedAt: '2026-08-17T09:00:00.000Z',
      expiresAt: new Date(Date.now() + 3 * 86_400_000 + 3_600_000).toISOString(),
      grantedVia: 'local',
      tokenId: 'tok_1',
    },
  ],
};

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

function serving(options: { calls?: Call[]; enabled?: boolean } = {}): Responder {
  return (url, init) => {
    const path = url.split('?')[0] ?? url;
    const method = init.method ?? 'GET';
    if (method !== 'GET') {
      options.calls?.push({
        url: path,
        method,
        body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      });
      if (path === '/api/remote/tokens') return json(MINTED, 201);
      return json({ ok: true });
    }
    if (path === '/api/remote/status') {
      return json({ ...STATUS, enabled: options.enabled ?? true });
    }
    if (path === '/api/remote/tokens') {
      return json({
        tokens: [
          {
            id: 'tok_1',
            label: 'Pixel',
            device: null,
            prefix: 'abc123',
            createdAt: '2026-05-01T00:00:00.000Z',
            lastUsedAt: '2026-08-17T11:00:00.000Z',
            lastUsedPeer: '100.64.0.9 (pixel-9)',
            expiresAt: null,
            revokedAt: null,
            expired: false,
          },
        ],
      });
    }
    if (path === '/api/remote/agents') return json(GRANTS);
    if (path === '/api/roster/agents') return json({ agents: [], diagnostics: [] });
    if (path === '/api/projects') return json({ projects: [] });
    if (path === '/api/logs') return json({ records: [], count: 0, source: 'ring', level: 'info' });
    return json({ error: 'not_found', message: `No fixture for ${path}.` }, 404);
  };
}

/** The home edition with the remote module loaded — the only edition it runs in. */
const HOME: BootFacts = {
  config: BOOT_FACTS.config,
  health: {
    ...BOOT_FACTS.health,
    modules: [...BOOT_FACTS.health.modules, { id: 'remote', status: 'ok' as const }],
  },
};

function mountSettings(
  options: { respond?: Responder; boot?: BootFacts; token?: string } = {},
): ReturnType<typeof mount> {
  return mount(<App />, {
    respond: options.respond ?? serving(),
    boot: options.boot ?? HOME,
    route: '/settings',
    ...(options.token === undefined ? {} : { token: options.token }),
  });
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('creating a device token (§13.2, IMPLEMENTATION §10)', () => {
  it('shows the plaintext exactly once, with a client-side QR and no network for it', async () => {
    const mounted = mountSettings();
    await screen.findByRole('heading', { name: 'Remote access' });

    const user = userEvent.setup();
    const before = mounted.calls.length;
    await user.click(await screen.findByRole('button', { name: 'Create device token' }));

    const panel = await waitFor(() => {
      const found = document.querySelector('[data-minted-token="true"]');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(within(panel).getByText(MINTED.token)).toBeInTheDocument();
    expect(panel.textContent).toContain('only time you will see this token');

    // The QR is inline SVG, drawn from the returned `qrUrl`.
    const qr = within(panel).getByRole('img', { name: 'Pairing QR code' });
    expect(qr.tagName.toLowerCase()).toBe('svg');
    expect(qr.querySelector('path')?.getAttribute('d')).toMatch(/^M\d+ \d+h1v1h-1z/u);

    // Generating it issued no request: the only calls since the click are the
    // mint itself and the refetches it invalidated.
    const since = mounted.calls.slice(before);
    expect(since.filter((call) => !call.startsWith('/api/remote/'))).toEqual([]);
    expect(since.some((call) => call.includes('qr'))).toBe(false);
  });

  it('never shows the plaintext again, and never puts it in localStorage', async () => {
    mountSettings();
    await screen.findByRole('heading', { name: 'Remote access' });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Create device token' }));
    await screen.findByText(MINTED.token);

    await user.click(screen.getByRole('button', { name: 'I have saved it' }));
    await waitFor(() => expect(screen.queryByText(MINTED.token)).toBeNull());

    // The list shows the prefix and never the secret.
    expect(document.body.textContent).not.toContain(MINTED.token);
    expect(screen.getByText(/abc123…/u)).toBeInTheDocument();
    // Nothing about it reached storage on the desktop — the desktop holds no
    // bearer at all (§3.1), and the minted one belongs to a phone.
    expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
    expect(JSON.stringify(window.localStorage)).not.toContain(MINTED.token);
  });
});

describe('over the tailnet, denied controls are shown disabled with their reasons (§13.4)', () => {
  it('greys create token, enable remote access, restart listener and stop service', async () => {
    mountSettings({ respond: serving({ enabled: false }), token: 'a-device-token' });
    await screen.findByRole('heading', { name: 'Remote access' });

    for (const [name, reason] of [
      ['Create device token', 'created at the machine itself'],
      ['Enable remote access', 'back on only at the machine'],
      ['Restart listener', 'cut this very connection'],
      ['Stop background service', 'do it at the machine itself'],
    ] as const) {
      const button = await screen.findByRole('button', { name });
      // Visible **and** disabled — never hidden, and never a raw 403 (§13.5).
      expect(button).toBeVisible();
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute('title', expect.stringContaining(reason));
    }

    // And the reasons are on the page, not only in tooltips.
    const reasons = [...document.querySelectorAll('[data-reason]')].map(
      (node) => node.textContent ?? '',
    );
    expect(reasons.join(' ')).toContain('created at the machine itself');
    expect(reasons.join(' ')).toContain('cut this very connection');
  });

  it('leaves everything enabled locally, and lets revocation work from anywhere', async () => {
    const calls: Call[] = [];
    mountSettings({ respond: serving({ calls }), token: 'a-device-token' });
    await screen.findByRole('heading', { name: 'Remote access' });

    const user = userEvent.setup();
    // "Revocation is available everywhere, including from the phone."
    const row = await waitFor(() => {
      const found = document.querySelector('[data-token-id="tok_1"]');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    await user.click(within(row).getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.method).toBe('DELETE');
    expect(calls[0]?.url).toBe('/api/remote/tokens/tok_1');
  });

  it('enables all four at the desk', async () => {
    mountSettings({ respond: serving({ enabled: false }) });
    await screen.findByRole('heading', { name: 'Remote access' });
    for (const name of [
      'Create device token',
      'Enable remote access',
      'Restart listener',
      'Stop background service',
    ]) {
      expect(await screen.findByRole('button', { name })).toBeEnabled();
    }
  });
});

describe('per-agent grants (§13.2, remote §12.4)', () => {
  it('shows the expiry on the settings screen and updates live', async () => {
    const mounted = mountSettings();
    const row = await waitFor(() => {
      const found = document.querySelector('[data-grant-for="ada"]');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(row.textContent).toContain('expires in 3 days');
    expect(row.querySelector('[data-grant-expires]')).not.toBeNull();

    // §3.4 invalidates on the grant events, so the row is not stale after one.
    mounted.stream.emit({
      type: 'remote.agent.access.revoked',
      id: 'evt_2',
      ids: { agentId: 'ada' },
    });
    await waitFor(() =>
      expect(
        mounted.calls.filter((call) => call.startsWith('/api/remote/agents')).length,
      ).toBeGreaterThan(1),
    );
  });
});

describe('the work edition (§13.5, §18-4)', () => {
  const WORK: BootFacts = {
    config: {
      ...BOOT_FACTS.config,
      edition: 'work',
      config: { orchestrator: { notify: { enabled: false } } },
      sources: {
        'orchestrator.notify.enabled': { layer: 'machine', origin: 'C:\\ProgramData\\config.json' },
      },
    },
    // The remote module is not loaded at all — its routes do not exist.
    health: { ...BOOT_FACTS.health, edition: 'work' },
  };

  it('has no Remote section, and one honest sentence under Health & about', async () => {
    mountSettings({ boot: WORK });
    await screen.findByRole('heading', { name: 'Settings' });

    expect(screen.queryByRole('heading', { name: 'Remote access' })).toBeNull();
    expect(document.querySelector('[data-section="remote"]')).toBeNull();
    expect(
      screen.getByText('Remote access is not available in the work edition.'),
    ).toBeInTheDocument();
    // And no disabled remote controls anywhere: an absent capability is hidden,
    // not greyed (that is the *transport* rule, not the edition rule).
    expect(screen.queryByRole('button', { name: 'Create device token' })).toBeNull();
  });

  it('never asks the remote module anything — feature detection, not a 404 probe (§3.5)', async () => {
    const mounted = mountSettings({ boot: WORK });
    await screen.findByRole('heading', { name: 'Settings' });
    await waitFor(() => expect(screen.getByText(/work edition/u)).toBeInTheDocument());
    expect(mounted.calls.filter((call) => call.startsWith('/api/remote'))).toEqual([]);
  });

  it('renders orchestrator.notify disabled with the layer that set it', async () => {
    mountSettings({ boot: WORK });
    const toggle = await screen.findByRole('checkbox', {
      name: /Send an ntfy push when a question stays open/u,
    });
    expect(toggle).toBeDisabled();
    expect(toggle).not.toBeChecked();
    expect(document.querySelector('[data-layer="machine"]')?.textContent).toContain(
      'Disabled by the machine layer',
    );
  });
});

describe('health warnings are persistent, not a toast (IMPLEMENTATION §10)', () => {
  it('renders every condition on the page, with no way to dismiss it', async () => {
    const degraded: BootFacts = {
      config: HOME.config,
      health: {
        ...HOME.health,
        status: 'degraded',
        conditions: [
          {
            id: 'secrets.degradedToKeyfile',
            level: 'warn',
            message: 'Secrets fell back to the keyfile provider.',
          },
          {
            id: 'secrets.anthropicApiKeyOverridesSubscription',
            level: 'warn',
            message: 'ANTHROPIC_API_KEY is set while auth.mode is "subscription".',
          },
        ],
      },
    };
    mountSettings({ boot: degraded });
    await screen.findByRole('heading', { name: 'Health & about' });

    for (const id of [
      'secrets.degradedToKeyfile',
      'secrets.anthropicApiKeyOverridesSubscription',
    ]) {
      const notice = document.querySelector(`[data-condition-id="${id}"]`);
      expect(notice).not.toBeNull();
      expect(within(notice as HTMLElement).queryByRole('button')).toBeNull();
    }
    // Not in the toast region, which is where a dismissible message would be.
    expect(
      within(screen.getByRole('status', { name: 'Notifications' })).queryByText(
        /ANTHROPIC_API_KEY/u,
      ),
    ).toBeNull();
  });
});
