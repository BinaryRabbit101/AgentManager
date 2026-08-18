/**
 * Remote's configuration sub-schema — remote IMPLEMENTATION M1.
 *
 * The load path is the real one: `loadConfig` over the shipped `config/` layers,
 * because the acceptance criterion is about what a `config.json` edit can and
 * cannot do, and asserting against the bare zod object would prove it for a schema
 * nobody loads.
 */
import { describe, expect, it } from 'vitest';

import { ConfigError, createFoundationRegistry, loadConfig } from '../../config/index.js';
import { repoRoot } from '../__tests__/helpers.js';

import {
  REMOTE_BIND_LITERAL,
  REMOTE_BIND_MESSAGE,
  REMOTE_CONFIG_DEFAULTS,
  REMOTE_PUBLIC_URL_MESSAGE,
  parsePublicUrl,
  publicHostname,
  publicOrigin,
  remoteConfigSchema,
} from './config.js';

function load(argv: readonly string[] = []): ReturnType<typeof loadConfig> {
  return loadConfig({ argv: [...argv], env: {}, installRoot: repoRoot });
}

function issues(argv: readonly string[]): string {
  try {
    load(argv);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as ConfigError).report();
  }
  throw new Error('the configuration was expected to be rejected');
}

describe('M1 — remote.bind is a literal, not an address (§11, architecture D5)', () => {
  it('rejects an IP literal with a message naming D5', () => {
    const report = issues(['--set', 'remote.bind=100.101.102.103']);

    expect(report).toContain('remote.bind');
    // The whole reason the key is a literal: a config-editable bind address would
    // be a hole through the decision.
    expect(report).toContain('D5');
    expect(report).toContain('never LAN or public');
    expect(report).toContain(REMOTE_BIND_MESSAGE);
  });

  it.each(['0.0.0.0', '127.0.0.1', '192.168.0.197', '::', 'localhost', 'Tailscale'])(
    'rejects %s as well — there is no accepted address form at all',
    (value) => {
      expect(issues(['--set', `remote.bind=${value}`])).toContain('remote.bind');
    },
  );

  it('accepts the literal "tailscale"', () => {
    const loaded = load(['--set', `remote.bind=${REMOTE_BIND_LITERAL}`]);
    expect(loaded.config.remote.bind).toBe('tailscale');
  });

  it('is what the shipped layers already say, in both editions', () => {
    expect(load().config.remote.bind).toBe('tailscale');
    expect(load(['--edition', 'home']).config.remote.bind).toBe('tailscale');
  });
});

describe('M1 — the namespace is remote-owned and complete (§11)', () => {
  it('is registered with remote as its owner', () => {
    const registry = createFoundationRegistry();
    expect(registry.contributions.find((entry) => entry.namespace === 'remote')?.owner).toBe(
      'remote',
    );
  });

  it('carries DESIGN §11 key for key, with foundation §2.3’s three keys unchanged', () => {
    const { remote } = load().config;
    expect(remote).toEqual({
      // Foundation §2.3's three, with the meanings and defaults they already had.
      bind: 'tailscale',
      port: 7478,
      hostnameHint: null,
      // §4.2: null means "the phone reaches this socket directly".
      publicUrl: null,
      // D5's 2026-08-17 amendment: proxy mode's own block, `null` in the shipped
      // default because the shipped mode is `"tailscale"` (`proxy.test.ts` owns the
      // cross-key rule).
      proxy: null,
      // Remote's namespace extension.
      detect: { cli: null, pollMs: 30_000, retryMaxMs: 120_000 },
      token: { ttlDays: 90, maxActive: 10 },
      auth: { maxFailures: 10, failWindowMs: 300_000, blockMs: 900_000 },
      stream: { ticketTtlSec: 30, heartbeatMs: 30_000 },
      agentAccess: { ttlHours: 72 },
      browseRateLimitPerMin: 60,
    });
    expect(remote).toEqual(REMOTE_CONFIG_DEFAULTS);
  });

  it('does not carry remote.enabled — that is a settings value, not config (§5)', () => {
    // A runtime toggle the UI owns must survive a config-file rewrite, so it lives
    // in `settings`. Shipping it here as well would give it two homes that disagree.
    expect(REMOTE_CONFIG_DEFAULTS).not.toHaveProperty('enabled');
    expect(remoteConfigSchema.safeParse({ ...REMOTE_CONFIG_DEFAULTS, enabled: true }).success).toBe(
      false,
    );
  });

  it('rejects an unknown key inside the namespace rather than ignoring it', () => {
    expect(issues(['--set', 'remote.detect.pollMs=notanumber'])).toContain('remote.detect.pollMs');
    expect(remoteConfigSchema.safeParse({ ...REMOTE_CONFIG_DEFAULTS, nope: 1 }).success).toBe(
      false,
    );
  });

  it('allows a never-expiring token TTL, since §4.4 does', () => {
    expect(
      remoteConfigSchema.safeParse({
        ...REMOTE_CONFIG_DEFAULTS,
        token: { ttlDays: null, maxActive: 10 },
      }).success,
    ).toBe(true);
  });

  it('still refuses the work edition with the remote module enabled', () => {
    // Re-asserted from remote's side, because remote is what the invariant protects
    // against (M10 pins it too).
    expect(issues(['--set', 'modules.remote.enabled=true'])).toContain('modules.remote.enabled');
  });
});

describe('remote.publicUrl — the front door the core cannot discover (§4.2, §11)', () => {
  it('accepts a bare origin with an explicit port', () => {
    const loaded = load(['--set', 'remote.publicUrl=https://minipc.example-tailnet.ts.net:455']);

    expect(loaded.config.remote.publicUrl).toBe('https://minipc.example-tailnet.ts.net:455');
  });

  it('defaults to null, so tailscale mode keeps building the URL it always built', () => {
    expect(load().config.remote.publicUrl).toBeNull();
    expect(REMOTE_CONFIG_DEFAULTS.publicUrl).toBeNull();
  });

  it.each([
    ['a path', 'https://minipc.example-tailnet.ts.net:455/agentmanager'],
    ['a query', 'https://minipc.example-tailnet.ts.net:455?x=1'],
    ['a fragment — where the token goes', 'https://minipc.example-tailnet.ts.net:455/#t=abc'],
    ['credentials', 'https://user:pw@minipc.example-tailnet.ts.net:455'],
    ['a bare host with no scheme', 'minipc.example-tailnet.ts.net:455'],
    ['a scheme this is not', 'ws://minipc.example-tailnet.ts.net:455'],
  ])('refuses %s', (_label, value) => {
    const report = issues(['--set', `remote.publicUrl=${value}`]);

    expect(report).toContain('remote.publicUrl');
    expect(report).toContain(REMOTE_PUBLIC_URL_MESSAGE);
  });

  it('parses into the origin the QR uses and the hostname the allowlist wants', () => {
    expect(parsePublicUrl('https://minipc.example-tailnet.ts.net:455')).toEqual({
      origin: 'https://minipc.example-tailnet.ts.net:455',
      hostname: 'minipc.example-tailnet.ts.net',
    });
    // A trailing slash is the same origin, and the default port is spelled one way.
    expect(publicOrigin('https://minipc.example-tailnet.ts.net/')).toBe(
      'https://minipc.example-tailnet.ts.net',
    );
    expect(publicOrigin('https://minipc.example-tailnet.ts.net:443')).toBe(
      'https://minipc.example-tailnet.ts.net',
    );
    expect(publicHostname(null)).toBeNull();
  });

  it('is orthogonal to the bind mode: a tailscale-mode install may declare one too', () => {
    const loaded = load([
      '--set',
      `remote.bind=${REMOTE_BIND_LITERAL}`,
      '--set',
      'remote.publicUrl=https://workstation.example-tailnet.ts.net',
    ]);

    expect(loaded.config.remote.publicUrl).toBe('https://workstation.example-tailnet.ts.net');
  });
});
