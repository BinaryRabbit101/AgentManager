/**
 * Tailscale detection — remote IMPLEMENTATION M2, acceptance criterion by
 * criterion.
 *
 * Every case runs against **injected** fixtures: a `status --json` string, a
 * `NetworkInterfaceInfo` map, or a `CliOutcome`. Nothing here spawns Tailscale or
 * reads this machine's adapters, because a detection suite that did would assert
 * one thing on a developer's laptop and another in CI — and the property under
 * test is precisely that the validator refuses everything it has not proven.
 *
 * The one exception is the last `describe`, which is gated on a real Tailscale
 * interface actually being present and skips otherwise.
 */
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { describe, expect, it } from 'vitest';

import type { LogLevel } from '../../storage/index.js';

import {
  CGNAT_RANGE,
  CLI_TIMEOUT_MS,
  PEER_MAP_TTL_MS,
  createTailscaleDetector,
  isCgnatIPv4,
  locateTailscaleCli,
  parseTailscaleStatus,
  stripTrailingDot,
  validateCandidates,
  type CliOutcome,
  type Detection,
  type TailscaleRefusal,
} from './tailscale.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * `tailscale status --json`, trimmed to the shape a real Windows 11 + Tailscale
 * host emits for the four fields §2.2 reads.
 *
 * The trailing dot on `DNSName` and the `100.x` addressing are the real thing;
 * the tailnet name is fictional.
 */
const STATUS_RUNNING = JSON.stringify({
  Version: '1.78.1',
  BackendState: 'Running',
  TUN: true,
  Self: {
    ID: 'nnnnnnnnnnnn',
    HostName: 'workstation',
    DNSName: 'workstation.example-tailnet.ts.net.',
    OS: 'windows',
    TailscaleIPs: ['100.101.102.103', 'fd7a:115c:a1e0::1234'],
    Online: true,
  },
  Peer: {
    'nodekey:aaaa': {
      HostName: 'pixel-9',
      DNSName: 'pixel-9.example-tailnet.ts.net.',
      TailscaleIPs: ['100.88.77.66', 'fd7a:115c:a1e0::4321'],
    },
    'nodekey:bbbb': {
      HostName: 'minipc',
      TailscaleIPs: ['100.70.60.50'],
    },
  },
  MagicDNSSuffix: 'example-tailnet.ts.net',
});

function statusWithBackendState(state: string): string {
  const parsed = JSON.parse(STATUS_RUNNING) as Record<string, unknown>;
  parsed['BackendState'] = state;
  return JSON.stringify(parsed);
}

function iface(
  overrides: Partial<NetworkInterfaceInfo> & { readonly address: string },
): NetworkInterfaceInfo {
  return {
    address: overrides.address,
    netmask: overrides.netmask ?? '255.255.255.255',
    family: overrides.family ?? 'IPv4',
    mac: overrides.mac ?? '00:00:00:00:00:00',
    internal: overrides.internal ?? false,
    cidr: overrides.cidr ?? null,
  } as NetworkInterfaceInfo;
}

/** A machine whose only tailnet-looking address is on a genuine Tailscale adapter. */
const TAILSCALE_ADAPTER_ONLY: NodeJS.Dict<NetworkInterfaceInfo[]> = {
  Ethernet: [iface({ address: '192.168.0.197' })],
  'Loopback Pseudo-Interface 1': [iface({ address: '127.0.0.1', internal: true })],
  Tailscale: [iface({ address: '100.101.102.103' })],
};

interface LogLine {
  readonly level: LogLevel;
  readonly message: string;
  readonly data?: Record<string, unknown>;
}

interface Harness {
  readonly logs: LogLine[];
  /** How many times the CLI was actually run. */
  spawns(): number;
  detect(): Promise<Detection>;
  peerName(address: string): string | null;
}

function harness(
  options: {
    readonly cli?: CliOutcome | 'absent';
    readonly interfaces?: NodeJS.Dict<NetworkInterfaceInfo[]>;
    readonly cliPath?: string | null;
    readonly now?: () => Date;
    readonly onRun?: (executable: string, timeoutMs: number) => void;
  } = {},
): Harness {
  const logs: LogLine[] = [];
  let spawns = 0;
  const cli = options.cli ?? 'absent';

  const detector = createTailscaleDetector({
    cliPath: options.cliPath ?? null,
    locateCli: () => (cli === 'absent' ? undefined : 'C:\\fixture\\tailscale.exe'),
    runCli: (executable, timeoutMs) => {
      spawns += 1;
      options.onRun?.(executable, timeoutMs);
      return Promise.resolve(cli === 'absent' ? { kind: 'missing' } : cli);
    },
    networkInterfaces: () => options.interfaces ?? {},
    ...(options.now === undefined ? {} : { clock: options.now }),
    log: (level, message, data) => {
      logs.push({ level, message, ...(data === undefined ? {} : { data }) });
    },
  });

  return {
    logs,
    spawns: () => spawns,
    detect: () => detector.detect(),
    peerName: (address) => detector.peerName(address),
  };
}

function refusal(detection: Detection): TailscaleRefusal {
  expect(detection.ok).toBe(false);
  return detection as TailscaleRefusal;
}

// ---------------------------------------------------------------------------
// The validator (§2.1)
// ---------------------------------------------------------------------------

describe('the CGNAT range check (§2.1 rule 1)', () => {
  it('accepts the whole of 100.64.0.0/10 and nothing outside it', () => {
    for (const inside of ['100.64.0.0', '100.101.102.103', '100.127.255.255', '100.70.60.50']) {
      expect(isCgnatIPv4(inside), inside).toBe(true);
    }
    for (const outside of [
      '100.63.255.255',
      '100.128.0.0',
      '99.64.0.1',
      '101.64.0.1',
      '192.168.0.197',
      '10.0.0.1',
      '0.0.0.0',
      '127.0.0.1',
      '100.64.0.256',
      'fd7a:115c:a1e0::1234',
      'not-an-address',
    ]) {
      expect(isCgnatIPv4(outside), outside).toBe(false);
    }
  });
});

describe('the §2.1 validator', () => {
  it('accepts exactly one CGNAT address on a /tailscale/i adapter', () => {
    const detection = validateCandidates(
      [
        {
          address: '100.101.102.103',
          family: 'IPv4',
          internal: false,
          adapter: 'Tailscale',
          cliReported: false,
        },
        {
          address: '192.168.0.197',
          family: 'IPv4',
          internal: false,
          adapter: 'Ethernet',
          cliReported: false,
        },
      ],
      { source: 'interface', backendState: null },
    );
    expect(detection).toMatchObject({ ok: true, address: '100.101.102.103', source: 'interface' });
  });

  it('ignores internal (loopback) adapters entirely', () => {
    const detection = validateCandidates(
      [
        {
          address: '100.64.0.1',
          family: 'IPv4',
          internal: true,
          adapter: 'Tailscale Loopback',
          cliReported: false,
        },
      ],
      { source: 'interface', backendState: null },
    );
    expect(refusal(detection).reason).toBe('no-candidate');
  });
});

// ---------------------------------------------------------------------------
// M2 acceptance, criterion by criterion
// ---------------------------------------------------------------------------

describe('M2 — the CLI path (§2.2 primary)', () => {
  it('extracts the address, the MagicDNS name with its trailing dot stripped, and BackendState', async () => {
    const probe = harness({ cli: { kind: 'ok', stdout: STATUS_RUNNING } });
    const detection = await probe.detect();

    expect(detection).toEqual({
      ok: true,
      address: '100.101.102.103',
      magicDnsName: 'workstation.example-tailnet.ts.net',
      backendState: 'Running',
      source: 'cli',
    });
    // The fixture's DNSName really does end in a dot; nothing else strips it.
    expect(JSON.parse(STATUS_RUNNING)).toMatchObject({
      Self: { DNSName: 'workstation.example-tailnet.ts.net.' },
    });
    expect(stripTrailingDot('a.b.ts.net.')).toBe('a.b.ts.net');
    // The CLI is asked once per detection, with §2.2's 5 s budget.
    expect(probe.spawns()).toBe(1);
  });

  it('spawns the CLI with the 5 s budget §2.2 specifies', async () => {
    const seen: number[] = [];
    const probe = harness({
      cli: { kind: 'ok', stdout: STATUS_RUNNING },
      onRun: (_executable, timeoutMs) => void seen.push(timeoutMs),
    });
    await probe.detect();
    expect(seen).toEqual([CLI_TIMEOUT_MS]);
  });

  it.each(['Stopped', 'NeedsLogin', 'NoState', 'Starting'])(
    'refuses a BackendState of %s, carrying the string and no address',
    async (state) => {
      const probe = harness({
        cli: { kind: 'ok', stdout: statusWithBackendState(state) },
        // A perfectly good adapter is present: the refusal must come from the
        // backend state, not from a shortage of candidates.
        interfaces: TAILSCALE_ADAPTER_ONLY,
      });
      const detection = await probe.detect();

      const refused = refusal(detection);
      expect(refused.reason).toBe('backend-not-running');
      expect(refused.backendState).toBe(state);
      expect(refused.message).toContain(state);
      expect(refused.source).toBe('cli');
      expect(detection).not.toHaveProperty('address');
    },
  );

  it('builds the 60 s-TTL peer map for §9.3 audit enrichment, and never as an auth input', async () => {
    let now = new Date('2026-08-17T10:00:00.000Z');
    const probe = harness({
      cli: { kind: 'ok', stdout: STATUS_RUNNING },
      now: () => now,
    });
    await probe.detect();

    expect(probe.peerName('100.88.77.66')).toBe('pixel-9');
    expect(probe.peerName('100.70.60.50')).toBe('minipc');
    expect(probe.peerName('100.1.1.1')).toBeNull();

    // Past the TTL the map answers `null` rather than a stale name — and a `null`
    // is never a refusal, because nothing authenticates on this.
    now = new Date(now.getTime() + PEER_MAP_TTL_MS + 1);
    expect(probe.peerName('100.88.77.66')).toBeNull();
  });
});

describe('M2 — the validator refuses what it cannot prove (§2.1)', () => {
  it('refuses a LAN adapter holding a 100.64.0.0/10 address — the CPE-CGNAT case', async () => {
    // This is the test that proves the range check alone is insufficient: some ISP
    // equipment hands out CGNAT addresses on the LAN, and binding one would put
    // the listener on the LAN while passing a naive check.
    const probe = harness({
      interfaces: {
        Ethernet: [iface({ address: '100.92.14.7' })],
        'Loopback Pseudo-Interface 1': [iface({ address: '127.0.0.1', internal: true })],
      },
    });
    const refused = refusal(await probe.detect());

    expect(refused.reason).toBe('unverified-adapter');
    expect(refused.message).toContain('100.92.14.7');
    expect(refused.message).toContain(CGNAT_RANGE);
    expect(refused.message).toContain('Ethernet');
  });

  it('refuses a /tailscale/i adapter holding a non-CGNAT address', async () => {
    const probe = harness({
      interfaces: { 'Tailscale Tunnel': [iface({ address: '10.44.0.5' })] },
    });
    const refused = refusal(await probe.detect());

    expect(refused.reason).toBe('not-in-cgnat-range');
    expect(refused.message).toContain('10.44.0.5');
    expect(refused.message).toContain(CGNAT_RANGE);
  });

  it('refuses two valid candidates as ambiguous rather than choosing one', async () => {
    const probe = harness({
      interfaces: {
        Tailscale: [iface({ address: '100.101.102.103' })],
        'Tailscale (2)': [iface({ address: '100.99.98.97' })],
      },
    });
    const refused = refusal(await probe.detect());

    expect(refused.reason).toBe('ambiguous-interface');
    expect(refused.message).toContain('100.101.102.103');
    expect(refused.message).toContain('100.99.98.97');
    expect(refused.message).toContain('does not guess');
  });

  it('refuses an IPv6-only tailnet with a distinct reason rather than binding', async () => {
    const probe = harness({
      interfaces: {
        Tailscale: [
          iface({ address: 'fd7a:115c:a1e0::1234', family: 'IPv6' }),
          iface({ address: 'fe80::d640:97c7:7d8b:af90', family: 'IPv6' }),
        ],
      },
    });
    const refused = refusal(await probe.detect());

    expect(refused.reason).toBe('ipv6-only');
    expect(refused.message).toContain('IPv4 only');
  });

  it('refuses a machine with no Tailscale adapter at all', async () => {
    const probe = harness({ interfaces: { Ethernet: [iface({ address: '192.168.0.197' })] } });
    const refused = refusal(await probe.detect());
    expect(refused.reason).toBe('no-candidate');
  });
});

describe('M2 — the interface fallback (§2.2)', () => {
  it('falls back when the CLI is missing, warns, and reports source "interface"', async () => {
    const probe = harness({ cli: 'absent', interfaces: TAILSCALE_ADAPTER_ONLY });
    const detection = await probe.detect();

    expect(detection).toMatchObject({
      ok: true,
      address: '100.101.102.103',
      source: 'interface',
      // Interface enumeration cannot produce either of these.
      magicDnsName: null,
      backendState: null,
    });
    const warned = probe.logs.filter((line) => line.level === 'warn');
    expect(warned).toHaveLength(1);
    expect(warned[0]?.data).toMatchObject({
      source: 'interface',
      tailscaleState: 'unknown (interface-derived)',
    });
  });

  it('falls back when the CLI hangs past its 5 s timeout, warns, and still binds', async () => {
    const probe = harness({ cli: { kind: 'timeout' }, interfaces: TAILSCALE_ADAPTER_ONLY });
    const detection = await probe.detect();

    expect(detection).toMatchObject({ ok: true, address: '100.101.102.103', source: 'interface' });
    const warned = probe.logs.filter((line) => line.level === 'warn');
    expect(warned).toHaveLength(1);
    expect(warned[0]?.message).toContain('5000 ms');
  });

  it('falls back when the CLI returns malformed JSON, warns, and still binds', async () => {
    const probe = harness({
      cli: { kind: 'ok', stdout: '{"BackendState": "Runn' },
      interfaces: TAILSCALE_ADAPTER_ONLY,
    });
    const detection = await probe.detect();

    expect(detection).toMatchObject({ ok: true, address: '100.101.102.103', source: 'interface' });
    expect(probe.logs.filter((line) => line.level === 'warn')[0]?.message).toContain(
      'unparseable JSON',
    );
    expect(parseTailscaleStatus('{"BackendState": "Runn')).toBeUndefined();
  });

  it('spawns zero subprocesses on the interface-fallback path', async () => {
    // The whole point of resolving the executable from the filesystem rather than
    // asking a shell: a machine without Tailscale must pay nothing for detection,
    // and it runs on every poll.
    const probe = harness({ cli: 'absent', interfaces: TAILSCALE_ADAPTER_ONLY });
    await probe.detect();
    await probe.detect();
    expect(probe.spawns()).toBe(0);
  });

  it('locates no executable, and spawns nothing, when the configured path does not exist', () => {
    expect(locateTailscaleCli('C:\\nowhere\\tailscale.exe', {})).toBeUndefined();
    // An empty PATH cannot yield a hit either, and nothing was executed to find out.
    expect(locateTailscaleCli(null, { PATH: '' })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The real machine, when it has a tailnet
// ---------------------------------------------------------------------------

/** The one thing this suite reads off the real machine: is there an adapter at all? */
function realTailscaleAddress(): string | undefined {
  for (const [adapter, addresses] of Object.entries(networkInterfaces())) {
    if (!/tailscale/i.test(adapter)) continue;
    for (const info of addresses ?? []) {
      if (info.family === 'IPv4' && !info.internal && isCgnatIPv4(info.address))
        return info.address;
    }
  }
  return undefined;
}

const realAddress = realTailscaleAddress();

describe.skipIf(realAddress === undefined)(
  'the real interface path, when Tailscale is present',
  () => {
    it('detects this machine’s actual Tailscale address through the real enumeration', async () => {
      // Skipped on every machine and CI runner without a Tailscale adapter, which
      // is why every other test in this file is injected. Nothing is bound here.
      const detector = createTailscaleDetector({ locateCli: () => undefined });
      const detection = await detector.detect();

      expect(detection).toMatchObject({ ok: true, address: realAddress, source: 'interface' });
    });
  },
);
