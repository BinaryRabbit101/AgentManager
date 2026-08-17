/**
 * **D5's proxy bind mode**, as amended 2026-08-17 — the schema, the prover, the
 * listener, the peer allowlist, and the invariants that must be identical in both
 * modes.
 *
 * Every address here is a fixture. The machine's real interfaces are never
 * consulted and no LAN socket is ever bound: `networkInterfaces` is injected, and
 * the mount point is the same fake `HttpListener` `listener.test.ts` uses, for the
 * reason that file states — "binding a *real* socket is only possible on a machine
 * that actually holds" the address, and a security test that depended on the
 * developer's LAN would assert nothing on anyone else's.
 *
 * The one thing that is emphatically *not* faked is the decision to bind: the real
 * `validateProxyBind`, the real `assertBindable` and the real listener state
 * machine run on every case below.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { NetworkInterfaceInfo } from 'node:os';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Logger } from 'pino';
import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from '../../config/index.js';
import type { Middleware } from '../../http/types.js';
import { repoRoot } from '../__tests__/helpers.js';

import { createRemoteHarness, type RemoteHarness } from './__tests__/harness.js';
import {
  REMOTE_BIND_MESSAGE,
  REMOTE_BIND_MODES,
  REMOTE_BIND_PROXY,
  REMOTE_PROXY_REQUIRED_MESSAGE,
  REMOTE_PROXY_UNEXPECTED_MESSAGE,
  remoteConfigSchema,
  REMOTE_CONFIG_DEFAULTS,
} from './config.js';
import { assertBindable, createRemoteListener, type RemoteListener } from './listener.js';
import { PEER_NOT_ALLOWED_CODE, proxyPeerPolicy } from './middleware.js';
import type { HttpListener, ListenerOptions } from './ports.js';
import { PROXY_BACKEND_STATE, createProxyProver, validateProxyBind } from './proxy.js';

const LAN_ADDRESS = '192.168.0.42';
const OTHER_LAN_ADDRESS = '192.168.0.77';
const PROXY_PEER = '192.168.0.9';

const PROXY_CONFIG = { bind: LAN_ADDRESS, allowedPeers: [PROXY_PEER] };

// ---------------------------------------------------------------------------
// Interface fixtures
// ---------------------------------------------------------------------------

function iface(
  address: string,
  options: { internal?: boolean; family?: 'IPv4' | 'IPv6' } = {},
): NetworkInterfaceInfo {
  return {
    address,
    netmask: '255.255.255.0',
    family: options.family ?? 'IPv4',
    mac: '00:11:22:33:44:55',
    internal: options.internal ?? false,
    cidr: `${address}/24`,
  } as NetworkInterfaceInfo;
}

/** A machine holding loopback plus whatever the case wants. */
function interfaces(
  entries: Record<string, NetworkInterfaceInfo[]>,
): () => NodeJS.Dict<NetworkInterfaceInfo[]> {
  return () => ({
    'Loopback Pseudo-Interface 1': [iface('127.0.0.1', { internal: true })],
    ...entries,
  });
}

const withLan = interfaces({ Ethernet: [iface(LAN_ADDRESS)] });
const withoutLan = interfaces({ Ethernet: [iface(OTHER_LAN_ADDRESS)] });

// ---------------------------------------------------------------------------
// (A1) The schema
// ---------------------------------------------------------------------------

function load(argv: readonly string[]): ReturnType<typeof loadConfig> {
  return loadConfig({ argv: [...argv], env: {}, installRoot: repoRoot });
}

function refusal(argv: readonly string[]): string {
  try {
    load(argv);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as ConfigError).report();
  }
  throw new Error('the configuration was expected to be rejected');
}

const asProxy = (proxy: unknown = PROXY_CONFIG): string[] => [
  '--set',
  'remote.bind=proxy',
  '--set',
  `remote.proxy=${JSON.stringify(proxy)}`,
];

describe('D5 amendment — remote.bind is a keyword, and "proxy" is the second one', () => {
  it('accepts both keywords and nothing else', () => {
    expect([...REMOTE_BIND_MODES]).toEqual(['tailscale', 'proxy']);
    expect(load(['--set', 'remote.bind=tailscale']).config.remote.bind).toBe('tailscale');
    expect(load(asProxy()).config.remote.bind).toBe('proxy');
  });

  it('still rejects every IP literal in remote.bind itself', () => {
    // M1–M3's rule stands: the mode is a keyword, the address lives under
    // remote.proxy.*. A config-editable bind address would be the hole D5 closes.
    for (const value of ['100.101.102.103', '192.168.0.42', '0.0.0.0', '127.0.0.1', '::']) {
      const report = refusal(['--set', `remote.bind=${value}`]);
      expect(report, value).toContain('remote.bind');
      expect(report, value).toContain('D5');
      expect(report, value).toContain('never LAN or public');
      expect(report, value).toContain(REMOTE_BIND_MESSAGE);
    }
  });

  it('requires remote.proxy when the mode is proxy', () => {
    const report = refusal(['--set', 'remote.bind=proxy']);
    expect(report).toContain('remote.proxy');
    expect(report).toContain(REMOTE_PROXY_REQUIRED_MESSAGE);
  });

  it('rejects remote.proxy when the mode is tailscale', () => {
    // Refused rather than ignored: a security-relevant block its author believes
    // is in force, and is not, is worse than a validation error.
    const report = refusal(['--set', `remote.proxy=${JSON.stringify(PROXY_CONFIG)}`]);
    expect(report).toContain('remote.proxy');
    expect(report).toContain(REMOTE_PROXY_UNEXPECTED_MESSAGE);
  });

  it('rejects a wildcard, a loopback, a non-IPv4 and a hostname as remote.proxy.bind', () => {
    for (const bind of ['0.0.0.0', '127.0.0.1', 'localhost', '::1', 'minipc.local', '192.168.0']) {
      const report = refusal(asProxy({ bind, allowedPeers: [PROXY_PEER] }));
      expect(report, bind).toContain('remote.proxy.bind');
    }
  });

  it('rejects an empty allowlist and a non-IPv4 peer', () => {
    expect(refusal(asProxy({ bind: LAN_ADDRESS, allowedPeers: [] }))).toContain(
      'remote.proxy.allowedPeers',
    );
    expect(refusal(asProxy({ bind: LAN_ADDRESS, allowedPeers: ['minipc'] }))).toContain(
      'remote.proxy.allowedPeers',
    );
  });

  it('rejects an unknown key inside remote.proxy rather than ignoring it', () => {
    expect(
      refusal(asProxy({ bind: LAN_ADDRESS, allowedPeers: [PROXY_PEER], trustForwardedFor: true })),
    ).toContain('remote.proxy');
  });

  it('ships proxy: null as the default, in both editions', () => {
    expect(REMOTE_CONFIG_DEFAULTS.proxy).toBeNull();
    expect(load([]).config.remote.proxy).toBeNull();
    expect(load(['--edition', 'home']).config.remote.proxy).toBeNull();
    expect(load(['--edition', 'home']).config.remote.bind).toBe('tailscale');
  });

  it('keeps the work edition’s refusal of the remote module, proxy config or not', () => {
    // D6 is untouched by the amendment: the work edition never starts a listener
    // of *any* mode.
    const report = refusal([...asProxy(), '--set', 'modules.remote.enabled=true']);
    expect(report).toContain('modules.remote.enabled');
    // And a work-edition config that merely *describes* proxy mode is still a work
    // edition with the module switched off.
    const work = load(asProxy());
    expect(work.config.edition).toBe('work');
    expect(work.config.modules.remote.enabled).toBe(false);
  });

  it('accepts several declared peers, because a household may have two proxies', () => {
    const parsed = remoteConfigSchema.safeParse({
      ...REMOTE_CONFIG_DEFAULTS,
      bind: REMOTE_BIND_PROXY,
      proxy: { bind: LAN_ADDRESS, allowedPeers: [PROXY_PEER, '192.168.0.10'] },
    });
    expect(parsed.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (A2) The prover
// ---------------------------------------------------------------------------

describe('D5 amendment — validateProxyBind proves the declared address (proxy.ts)', () => {
  it('accepts a declared address the machine really holds on an external interface', () => {
    const detection = validateProxyBind(LAN_ADDRESS, [
      {
        address: LAN_ADDRESS,
        family: 'IPv4',
        internal: false,
        adapter: 'Ethernet',
        cliReported: false,
      },
    ]);
    expect(detection).toEqual({
      ok: true,
      address: LAN_ADDRESS,
      magicDnsName: null,
      backendState: PROXY_BACKEND_STATE,
      source: 'proxy',
    });
  });

  it('refuses a declared address no interface holds', () => {
    const detection = validateProxyBind(LAN_ADDRESS, [
      {
        address: OTHER_LAN_ADDRESS,
        family: 'IPv4',
        internal: false,
        adapter: 'Wi-Fi',
        cliReported: false,
      },
    ]);
    expect(detection.ok).toBe(false);
    if (detection.ok) throw new Error('unreachable');
    expect(detection.reason).toBe('proxy-address-absent');
    expect(detection.message).toContain('different network');
  });

  it('refuses a declared address that only exists on an internal adapter', () => {
    const detection = validateProxyBind(LAN_ADDRESS, [
      {
        address: LAN_ADDRESS,
        family: 'IPv4',
        internal: true,
        adapter: 'vEthernet',
        cliReported: false,
      },
    ]);
    expect(detection.ok).toBe(false);
    if (detection.ok) throw new Error('unreachable');
    expect(detection.reason).toBe('proxy-address-internal');
  });

  it.each(['0.0.0.0', '::', '127.0.0.1', '::1', 'localhost', '', 'fd7a:115c:a1e0::1'])(
    'refuses %s as a declared address even when something claims to hold it',
    (declared) => {
      const detection = validateProxyBind(declared, [
        {
          address: declared,
          family: 'IPv4',
          internal: false,
          adapter: 'Ethernet',
          cliReported: false,
        },
      ]);
      expect(detection.ok).toBe(false);
      if (detection.ok) throw new Error('unreachable');
      expect(detection.reason).toBe('proxy-address-invalid');
    },
  );

  it('re-enumerates the interfaces on every detect(), so the second check can disagree', async () => {
    let present = true;
    const prover = createProxyProver({
      bind: LAN_ADDRESS,
      networkInterfaces: () => (present ? withLan() : withoutLan()),
    });

    expect((await prover.detect()).ok).toBe(true);
    present = false;
    expect((await prover.detect()).ok).toBe(false);
  });

  it('never claims a tailnet peer name — §9.3 has no map in this mode', () => {
    const prover = createProxyProver({ bind: LAN_ADDRESS, networkInterfaces: withLan });
    expect(prover.peerName(PROXY_PEER)).toBeNull();
    expect(prover.peerCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// (A3) assertBindable in proxy mode
// ---------------------------------------------------------------------------

describe('D5 amendment — assertBindable is mode-aware and still refuses exposure', () => {
  it('accepts the declared LAN address only when it matches remote.proxy.bind', () => {
    expect(assertBindable(LAN_ADDRESS, { mode: 'proxy', expected: LAN_ADDRESS })).toBeUndefined();
    const refused = assertBindable(OTHER_LAN_ADDRESS, { mode: 'proxy', expected: LAN_ADDRESS });
    expect(refused).toContain('remote.proxy.bind declares');
  });

  it.each([
    ['0.0.0.0', 'wildcard'],
    ['::', 'wildcard'],
    ['127.0.0.1', 'loopback'],
    ['::1', 'loopback'],
    ['', 'empty'],
  ])('refuses %s in proxy mode too — exposure rules hold in both modes', (address, because) => {
    const refused = assertBindable(address, { mode: 'proxy', expected: address });
    expect(refused).toBeDefined();
    expect(refused).toContain(because);
  });

  it('refuses proxy mode with nothing declared to compare against', () => {
    expect(assertBindable(LAN_ADDRESS, { mode: 'proxy' })).toContain(
      'no declared remote.proxy.bind',
    );
  });

  it('still refuses a LAN address in tailscale mode, which is the original rule', () => {
    expect(assertBindable(LAN_ADDRESS)).toContain('100.64.0.0/10');
    expect(assertBindable(LAN_ADDRESS, { mode: 'tailscale', expected: LAN_ADDRESS })).toContain(
      '100.64.0.0/10',
    );
  });
});

// ---------------------------------------------------------------------------
// (A4) The listener in proxy mode
// ---------------------------------------------------------------------------

interface ProxyHarness {
  readonly listener: RemoteListener;
  readonly mounts: readonly ListenerOptions[];
  openSockets(): number;
  setPresent(value: boolean): void;
  readonly detections: number;
}

const refuseEverything: Middleware = (_request, response) =>
  response.error(503, 'remote_unavailable', 'This fixture listener serves nothing.');

function quietLogger(): Logger {
  const noop = (): void => {};
  const logger = {
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    child: () => logger,
  };
  return logger as unknown as Logger;
}

function proxyHarness(
  options: { present?: boolean; failWith?: () => Error | undefined } = {},
): ProxyHarness {
  let present = options.present ?? true;
  let detections = 0;
  const mounts: ListenerOptions[] = [];
  const records: { closed: boolean }[] = [];

  const prover = createProxyProver({
    bind: LAN_ADDRESS,
    networkInterfaces: () => {
      detections += 1;
      return present ? withLan() : withoutLan();
    },
  });

  const mount = (listenerOptions: ListenerOptions): HttpListener => {
    mounts.push(listenerOptions);
    const record = { closed: false };
    records.push(record);
    const info: AddressInfo = {
      address: listenerOptions.bind,
      port: listenerOptions.port === 0 ? 55_555 : listenerOptions.port,
      family: 'IPv4',
    };
    let bound = false;
    return {
      server: createServer(),
      routes: [],
      get address() {
        return bound ? info : undefined;
      },
      get url() {
        return bound ? `http://${info.address}:${String(info.port)}` : undefined;
      },
      streamCount: 0,
      listen: () => {
        const failure = options.failWith?.();
        if (failure !== undefined) {
          record.closed = true;
          return Promise.reject(failure);
        }
        bound = true;
        return Promise.resolve(info);
      },
      close: () => {
        bound = false;
        record.closed = true;
        return Promise.resolve();
      },
    };
  };

  const logger = quietLogger();
  const listener = createRemoteListener({
    detector: prover,
    mode: REMOTE_BIND_PROXY,
    expectedAddress: LAN_ADDRESS,
    mount,
    port: 7478,
    pollMs: 30_000,
    retryMaxMs: 120_000,
    middleware: [refuseEverything],
    logger,
    accessLogger: logger,
    clock: () => new Date('2026-08-17T10:00:00.000Z'),
    enabled: () => true,
    timers: { after: () => () => {} },
    random: () => 0,
  });

  return {
    listener,
    mounts,
    openSockets: () => records.filter((record) => !record.closed).length,
    setPresent: (value) => void (present = value),
    get detections() {
      return detections;
    },
  };
}

describe('D5 amendment — the listener in proxy mode', () => {
  it('skips Tailscale detection entirely and binds the declared LAN address', async () => {
    const harness = proxyHarness();
    await harness.listener.start();

    const status = harness.listener.status();
    expect(status.state).toBe('listening');
    expect(status.mode).toBe('proxy');
    // No tailnet fact is claimed, and none was looked for: the CLI is never
    // located and no `100.64.0.0/10` address is involved anywhere.
    expect(status.magicDnsName).toBeNull();
    expect(status.tailscaleState).toBe(PROXY_BACKEND_STATE);
    expect(status.detectionSource).toBe('proxy');
    expect(harness.mounts.map((options) => options.bind)).toEqual([LAN_ADDRESS]);
    expect(harness.mounts[0]?.origin).toBe('remote');
    await harness.listener.stop();
  });

  it('publishes the same boundAddress claim shape, with source "proxy" (§6.3, §9.1 #2)', async () => {
    const harness = proxyHarness();
    await harness.listener.start();

    // Foundation's assertion compares this against the sockets the OS reports; the
    // contract is identical in both modes, and only `source` differs.
    expect(harness.listener.boundAddress()).toEqual({
      address: LAN_ADDRESS,
      port: 7478,
      source: 'proxy',
    });
    await harness.listener.stop();
    expect(harness.listener.boundAddress()).toBeNull();
  });

  it('proves the address twice — once to decide, once immediately before listen()', async () => {
    const harness = proxyHarness();
    await harness.listener.start();
    // Two full enumerations per cycle, the same discipline tailscale mode uses.
    expect(harness.detections).toBe(2);
    await harness.listener.stop();
  });

  it('never binds when the declared address vanishes between the two proofs', async () => {
    let calls = 0;
    const mounts: ListenerOptions[] = [];
    const logger = quietLogger();
    const listener = createRemoteListener({
      detector: createProxyProver({
        bind: LAN_ADDRESS,
        networkInterfaces: () => {
          calls += 1;
          // Present for the decision, gone for the confirmation.
          return calls === 1 ? withLan() : withoutLan();
        },
      }),
      mode: REMOTE_BIND_PROXY,
      expectedAddress: LAN_ADDRESS,
      mount: (options) => {
        mounts.push(options);
        throw new Error('the listener must never have reached mount()');
      },
      port: 7478,
      pollMs: 30_000,
      retryMaxMs: 120_000,
      middleware: [refuseEverything],
      logger,
      accessLogger: logger,
      clock: () => new Date('2026-08-17T10:00:00.000Z'),
      enabled: () => true,
      timers: { after: () => () => {} },
      random: () => 0,
    });

    await listener.start();
    expect(mounts).toEqual([]);
    expect(listener.status().state).toBe('waiting');
    expect(listener.boundAddress()).toBeNull();
    expect(listener.status().lastError).toContain('stopped validating between detection and bind');
  });

  it('stays in waiting, with no socket, when the machine does not hold the declared address', async () => {
    const harness = proxyHarness({ present: false });
    await harness.listener.start();

    expect(harness.listener.status().state).toBe('waiting');
    expect(harness.listener.boundAddress()).toBeNull();
    expect(harness.openSockets()).toBe(0);
    expect(harness.mounts).toEqual([]);
    expect(harness.listener.status().lastError).toContain('no interface on this machine holds');
  });

  it('closes the socket unconditionally when the declared address disappears while listening', async () => {
    const harness = proxyHarness();
    await harness.listener.start();
    expect(harness.openSockets()).toBe(1);

    harness.setPresent(false);
    await harness.listener.poll();

    // Fail closed, exactly as §2.3 requires of tailscale mode.
    expect(harness.openSockets()).toBe(0);
    expect(harness.listener.status().state).toBe('waiting');
    expect(harness.listener.boundAddress()).toBeNull();
  });

  it('refuses a prover that answers an address other than the declared one', async () => {
    const mounts: ListenerOptions[] = [];
    const logger = quietLogger();
    const listener = createRemoteListener({
      // A subverted prover: it validates fine and returns the *wrong* address.
      detector: {
        detect: () =>
          Promise.resolve({
            ok: true as const,
            address: OTHER_LAN_ADDRESS,
            magicDnsName: null,
            backendState: PROXY_BACKEND_STATE,
            source: 'proxy' as const,
          }),
        peerName: () => null,
        peerCount: () => 0,
      },
      mode: REMOTE_BIND_PROXY,
      expectedAddress: LAN_ADDRESS,
      mount: (options) => {
        mounts.push(options);
        throw new Error('the listener must never have reached mount()');
      },
      port: 7478,
      pollMs: 30_000,
      retryMaxMs: 120_000,
      middleware: [refuseEverything],
      logger,
      accessLogger: logger,
      clock: () => new Date('2026-08-17T10:00:00.000Z'),
      enabled: () => true,
      timers: { after: () => () => {} },
      random: () => 0,
    });

    await listener.start();
    expect(mounts).toEqual([]);
    expect(listener.status().lastError).toContain('remote.proxy.bind declares');
    expect(listener.boundAddress()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (A5) The peer allowlist, over a real socket
// ---------------------------------------------------------------------------

async function peerHarness(allowed: readonly string[]): Promise<RemoteHarness> {
  // The **production** policy object, not a lambda that agrees with it.
  return createRemoteHarness({ peerPolicy: proxyPeerPolicy(allowed) });
}

describe('D5 amendment — the peer-IP allowlist (proxy mode)', () => {
  it('serves an allowlisted peer, which then still has to authenticate', async () => {
    const harness = await peerHarness(['127.0.0.1']);
    try {
      // The peer check passed, so the bearer check is what decides.
      expect((await harness.call('/api/health')).status).toBe(401);
      const { token } = harness.mint();
      expect((await harness.call('/api/health', { token })).status).toBe(200);
      expect(harness.audit.refusals.filter((r) => r.code === PEER_NOT_ALLOWED_CODE)).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it('refuses a non-allowlisted peer with a detail-free 403 and one warn-level line', async () => {
    const harness = await peerHarness([PROXY_PEER]);
    try {
      const answer = await harness.call('/api/health');

      expect(answer.status).toBe(403);
      const body = answer.json as { error: string; message: string };
      expect(body.error).toBe(PEER_NOT_ALLOWED_CODE);
      // No detail: the response names no allowlist entry, no count, no address.
      expect(body.message).not.toContain(PROXY_PEER);
      expect(body.message).not.toContain('127.0.0.1');
      // One audit line, at warn (the sink's `refused` channel is the warn one).
      expect(harness.audit.refusals).toHaveLength(1);
      expect(harness.audit.refusals[0]?.code).toBe(PEER_NOT_ALLOWED_CODE);
      expect(harness.audit.refusals[0]?.status).toBe(403);
    } finally {
      await harness.close();
    }
  });

  it('refuses a non-allowlisted peer holding a perfectly valid token — the check is first', async () => {
    const harness = await peerHarness([PROXY_PEER]);
    try {
      const { token } = harness.mint();
      const answer = await harness.call('/api/health', { token });
      expect(answer.status).toBe(403);
      expect((answer.json as { error: string }).error).toBe(PEER_NOT_ALLOWED_CODE);
    } finally {
      await harness.close();
    }
  });

  it('never lets a refused peer touch the rate limiter’s failure accounting', async () => {
    const harness = await peerHarness([PROXY_PEER]);
    try {
      // Twenty bad credentials from a peer that may not talk to us: twice the
      // lockout budget, and not one failure recorded — so a refused peer cannot
      // spend the window that protects a legitimate one.
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const answer = await harness.call('/api/health', { token: `wrong-${String(attempt)}` });
        expect(answer.status).toBe(403);
      }
      expect(harness.audit.failures).toEqual([]);
      expect(harness.audit.blocks).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it('refuses a denied route to a refused peer as a peer refusal, before the deny list', async () => {
    const harness = await peerHarness([PROXY_PEER]);
    try {
      const answer = await harness.call('/api/service/shutdown', { method: 'POST', body: {} });
      expect(answer.status).toBe(403);
      // The peer guard runs before *any* routing, so it decides even here.
      expect((answer.json as { error: string }).error).toBe(PEER_NOT_ALLOWED_CODE);
    } finally {
      await harness.close();
    }
  });

  it('refuses even the static shell to a peer that is not declared', async () => {
    const harness = await peerHarness([PROXY_PEER]);
    try {
      const answer = await harness.call('/');
      expect(answer.status).toBe(403);
      expect(answer.text).not.toContain('shell:');
    } finally {
      await harness.close();
    }
  });

  it('never reads X-Forwarded-For as identity', async () => {
    const harness = await peerHarness([PROXY_PEER]);
    try {
      for (const header of ['x-forwarded-for', 'forwarded', 'x-real-ip', 'x-client-ip']) {
        const answer = await harness.call('/api/health', { headers: { [header]: PROXY_PEER } });
        expect(answer.status, header).toBe(403);
        expect((answer.json as { error: string }).error, header).toBe(PEER_NOT_ALLOWED_CODE);
      }
    } finally {
      await harness.close();
    }
  });

  it('normalises an IPv4-mapped IPv6 peer, so a dual-stack socket is not an outage', () => {
    const policy = proxyPeerPolicy(['::ffff:192.168.0.9']);
    // Both spellings of the same peer compare equal, in both directions.
    expect(policy.allow(PROXY_PEER)).toBe(true);
    expect(proxyPeerPolicy([PROXY_PEER]).allow(PROXY_PEER)).toBe(true);
    expect(proxyPeerPolicy([PROXY_PEER]).allow('192.168.0.10')).toBe(false);
  });

  it('describes the refusal for the log without putting the allowlist in the response', () => {
    const policy = proxyPeerPolicy([PROXY_PEER, '192.168.0.10']);
    expect(policy.describe('10.0.0.1')).toContain('2 peer(s)');
    expect(policy.message).not.toContain('192.168.0');
  });
});

// ---------------------------------------------------------------------------
// (A6) Static assertions over remote's own source
// ---------------------------------------------------------------------------

describe('D5 amendment — remote reads no forwarding header anywhere', () => {
  const sources = [
    'index.ts',
    'listener.ts',
    'proxy.ts',
    'tailscale.ts',
    'routes.ts',
    'streamRoutes.ts',
    'tokenRoutes.ts',
    'middleware.ts',
    'policy.ts',
    'gate.ts',
    'grants.ts',
    'rateLimit.ts',
    'streams.ts',
    'tickets.ts',
    'tokens.ts',
    'ports.ts',
    'config.ts',
    'options.ts',
  ];

  it('contains no read of x-forwarded-for, forwarded, or any proxy identity header', () => {
    for (const file of sources) {
      const text = readFileSync(join(import.meta.dirname, file), 'utf8');
      // Comments are allowed to *say* the header is never read — that is the
      // documentation of the decision — so the check is against the code only.
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      for (const header of ['x-forwarded-for', 'x-real-ip', 'x-client-ip', 'forwarded']) {
        expect(code.toLowerCase(), `${file} reads ${header}`).not.toContain(`'${header}'`);
        expect(code.toLowerCase(), `${file} reads ${header}`).not.toContain(`"${header}"`);
      }
    }
  });

  it('reads no edition anywhere, in either mode — D6 is satisfied by not being loaded', () => {
    for (const file of sources) {
      const text = readFileSync(join(import.meta.dirname, file), 'utf8');
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(code, file).not.toMatch(/config\.edition|edition ===/);
    }
  });

  it('creates no server of its own and passes no address to listen()', () => {
    for (const file of sources) {
      const text = readFileSync(join(import.meta.dirname, file), 'utf8');
      expect(text, file).not.toMatch(/createServer/);
      expect(text, file).not.toMatch(/\.listen\(\s*[^)\s]/);
    }
  });
});
