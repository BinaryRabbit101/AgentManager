/**
 * **Remote M10 — the edition and boundary suite. This is the merge gate.**
 *
 * remote IMPLEMENTATION §10: *"The gate. A dedicated suite proving the work edition
 * **cannot** listen and that the home edition cannot listen anywhere but Tailscale.
 * Runs in CI on every change; required for any change to binding, listeners, config
 * validation, or module wiring."*
 *
 * Everything here goes through `boot()` — the real composition root, the real config
 * loader, the real module graph, the real bind-time assertion, real sockets — because
 * every criterion in §10 is a property of a *booted process* rather than of a
 * function. The static half of the milestone lives in `boundaryStatic.test.ts`; the
 * process-level half, driven against the built bundle with an out-of-process socket
 * enumeration, lives in `boundaryProcess.test.ts`.
 *
 * ## What this suite references rather than repeats
 *
 * §10 overlaps four existing proof surfaces on purpose, and the instruction it
 * carries is *"extends foundation's M11 suite rather than duplicating it"*. The same
 * discipline is applied to remote's own earlier milestones — where a fact is already
 * pinned, this file states where, and then pins the thing the earlier test could not
 * reach:
 *
 * | Already pinned | Where | What M10 adds |
 * |---|---|---|
 * | `assertBindable` refuses wildcard / loopback / LAN / IPv6 literals | `listener.test.ts` (unit) | The same five addresses driven through **`boot()`**, so the refusal is a property of the composed core and not of one function |
 * | The work edition never imports the module file | `main.test.ts`, `module.test.ts` (load counter) | The counter *plus* zero non-loopback sockets *plus* the **live route table** carrying no `/api/remote/*` |
 * | §6.3's assertion, every branch | `lifecycle/bind.test.ts` (pure) | The two claims produced independently by a real boot, and a deliberate desynchronisation that must kill it |
 * | A forced non-loopback bind is fatal | `lifecycle/process.test.ts` (`http.bind=0.0.0.0`, spawned bundle) | A **real extra socket opened by a harness module**, which is the case a config key cannot express |
 * | Proxy mode proves its declared address | `proxy.test.ts`, `module.test.ts` | Proxy mode as extra rows in the *boot matrix*, so D5's amendment is inside the gate rather than beside it |
 *
 * ## The load-counter ordering constraint
 *
 * ES modules are evaluated once per worker. The work-edition boots must therefore
 * come **first in this file**: a home-edition boot anywhere above them would put
 * `remote/index.js` in the module cache and leave a later work-edition boot unable to
 * evaluate it again — making a count of zero prove nothing at all. Every describe
 * block below is ordered for that reason, and nothing in this file imports
 * `./index.js` other than as a type.
 */
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:net';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  BIND_INVARIANT_EXIT_CODE,
  BindInvariantError,
  observeListeners,
  type ListenerObservation,
  type ObservedListener,
} from '../../lifecycle/bind.js';
import { boot, type BootOptions, type BootedService } from '../../main.js';
import { moduleLoadCount, resetModuleLoadCount } from '../loadProbe.js';
import type { Module } from '../types.js';
import { makeTempDir, repoRoot, type TempDir } from '../__tests__/helpers.js';

import { createRemoteHarness, type RemoteHarness } from './__tests__/harness.js';
// Type-only imports throughout: evaluating `./index.js` here would run its load
// probe and destroy the count the work-edition criteria assert on.
import type { RemoteStatus, RemoteTimers } from './listener.js';
import type { RemoteInternals } from './options.js';
import type { Detection, TailscaleDetector } from './tailscale.js';

/** Restated rather than imported, for the reason above. */
const REMOTE_SERVICE = 'remote';
const REMOTE_MODULE_ID = 'remote';

/** Timers that never fire, so only explicit calls move the state machine. */
const neverFires: RemoteTimers = { after: () => () => {} };

/** A machine with no Tailscale at all: no CLI to spawn, no adapter to find. */
const noTailscale: BootOptions['remote'] = {
  detect: { locateCli: () => undefined, networkInterfaces: () => ({}) },
};

/**
 * The **real** machine, minus the Tailscale CLI.
 *
 * Used by the two criteria that need a socket to actually exist: proxy mode proves
 * its declared address against `os.networkInterfaces()`, so the address it is given
 * has to be one this host really holds. No subprocess is spawned in proxy mode, so
 * suppressing the CLI probe costs nothing and keeps the test off whatever Tailscale
 * the developer's machine may have.
 */
const realInterfaces: BootOptions['remote'] = {
  detect: { locateCli: () => undefined, networkInterfaces },
};

/** A prover that always answers one address, whether or not it is allowed. */
function claiming(address: string): TailscaleDetector {
  const detection: Detection = {
    ok: true,
    address,
    magicDnsName: 'workstation.jackal-hippocampus.ts.net',
    backendState: 'Running',
    source: 'cli',
  };
  return {
    detect: () => Promise.resolve(detection),
    peerName: () => null,
    peerCount: () => 0,
  };
}

/** One fixture adapter holding one address, for the real detector's fallback path. */
function adapters(name: string, address: string): NodeJS.Dict<NetworkInterfaceInfo[]> {
  return {
    Loopback: [
      {
        address: '127.0.0.1',
        netmask: '255.0.0.0',
        family: 'IPv4',
        mac: '00:00:00:00:00:00',
        internal: true,
        cidr: '127.0.0.1/8',
      },
    ],
    [name]: [
      {
        address,
        netmask: '255.255.255.0',
        family: 'IPv4',
        mac: '00:11:22:33:44:55',
        internal: false,
        cidr: `${address}/24`,
      },
    ],
  };
}

let dataRootDir: TempDir;
let service: BootedService | undefined;
let exitCodes: number[];
let baselineNonLoopback: number;
const forcedSockets: Server[] = [];

/** The non-loopback sockets this *process* owns — §10's netstat-equivalent, in-process. */
function nonLoopbackListeners(): readonly ObservedListener[] {
  return observeListeners().listeners.filter(
    (entry) => !entry.address.startsWith('127.') && entry.address !== '::1',
  );
}

async function bootCore(options: BootOptions = {}): Promise<BootedService> {
  const booted = await boot({
    installRoot: repoRoot,
    dataRoot: dataRootDir.path,
    env: {},
    pretty: false,
    tightenAcl: false,
    acl: { run: () => {} },
    exit: (code) => void exitCodes.push(code),
    io: { out: () => {}, err: () => {} },
    ...options,
    http: { port: 0, heartbeatMs: 0, ...options.http },
    remote: { ...noTailscale, ...options.remote },
    argv: ['--set', 'secrets.provider=env', ...(options.argv ?? [])],
  });
  service = booted;
  return booted;
}

async function bootHome(options: BootOptions = {}): Promise<BootedService> {
  return bootCore({ ...options, argv: ['--edition', 'home', ...(options.argv ?? [])] });
}

async function bootFailure(options: BootOptions = {}): Promise<unknown> {
  return bootCore(options).then(
    (booted) => {
      service = booted;
      return new Error('the boot succeeded, but this configuration must be fatal');
    },
    (error: unknown) => error,
  );
}

function remoteStatus(booted: BootedService): RemoteStatus | undefined {
  return booted.runtime.registry.require<{ status: () => RemoteStatus }>(REMOTE_SERVICE)?.status();
}

async function get(booted: BootedService, path: string): Promise<{ status: number; text: string }> {
  const base = booted.url();
  if (base === undefined) throw new Error('the local listener did not bind');
  const answer = await fetch(`${base}${path}`);
  return { status: answer.status, text: await answer.text() };
}

/** A harness module that opens a real non-loopback socket during `start()`. */
function forcedListenerModule(address: string): Module {
  return {
    id: 'fixture-forced-listener',
    dependsOn: [],
    init: () => {
      const server = createServer();
      forcedSockets.push(server);
      return {
        start: () =>
          new Promise<void>((done, fail) => {
            server.once('error', fail);
            server.listen(0, address, () => done());
          }),
        stop: () => new Promise<void>((done) => void server.close(() => done())),
      };
    },
  };
}

/** This machine's own LAN IPv4, when it has one. Used by the real-socket criteria. */
function localLanAddress(): string | undefined {
  for (const infos of Object.values(networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family === 'IPv4' && !info.internal) return info.address;
    }
  }
  return undefined;
}

const lanAddress = localLanAddress();

beforeEach(() => {
  dataRootDir = makeTempDir('agentmanager-boundary-');
  service = undefined;
  exitCodes = [];
  baselineNonLoopback = nonLoopbackListeners().length;
});

afterEach(async () => {
  await service?.shutdown().catch(() => undefined);
  service = undefined;
  for (const socket of forcedSockets.splice(0)) {
    await new Promise<void>((done) => void socket.close(() => done()));
  }
  dataRootDir.cleanup();
});

// ---------------------------------------------------------------------------
// Criterion 1 — the work edition boots with zero non-loopback listeners
// ---------------------------------------------------------------------------

describe('M10 — the work edition cannot listen (architecture D6)', () => {
  // **Must stay the first boot in this file.** See the file header.
  it('boots with zero non-loopback listeners, never imports the module file, and has no remote routes on the live table', async () => {
    resetModuleLoadCount(REMOTE_MODULE_ID);
    const booted = await bootCore();

    expect(booted.config.edition).toBe('work');
    expect(booted.config.modules.remote.enabled).toBe(false);

    // (a) The module file is never evaluated — the load counter, not a consequence.
    expect(moduleLoadCount(REMOTE_MODULE_ID)).toBe(0);
    expect(booted.runtime.order).not.toContain(REMOTE_MODULE_ID);
    expect((await booted.health()).modules.map((module) => module.id)).not.toContain(
      REMOTE_MODULE_ID,
    );
    expect(booted.runtime.registry.require(REMOTE_SERVICE)).toBeUndefined();

    // (b) Zero non-loopback listeners, from the process's own handles — which is
    // what §6.3's assertion compared against, and it is reported here as data.
    expect(booted.bind.listeners.length).toBeGreaterThan(0);
    expect(booted.bind.nonLoopback).toEqual([]);
    expect(booted.bind.remote).toBeNull();
    expect(nonLoopbackListeners()).toHaveLength(baselineNonLoopback);
    expect(booted.url()).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it('has /api/remote/* on neither the live route table nor the local listener', async () => {
    const booted = await bootCore();

    // "asserted against the live route table, not a source-code list" — the table
    // the `http` module actually mounted, read after every module's `init`.
    const paths = booted.runtime.routes.routes.map((route) => route.path);
    expect(paths.length).toBeGreaterThan(5);
    expect(paths.filter((path) => path.startsWith('/api/remote'))).toEqual([]);

    // And a client sees a JSON 404 rather than the SPA fallback, on every one of
    // remote's DESIGN §5 routes.
    for (const path of [
      '/api/remote/status',
      '/api/remote/tokens',
      '/api/remote/agents',
      '/api/remote/stream-ticket',
    ]) {
      const answer = await get(booted, path);
      expect(answer.status, path).toBe(404);
      expect(answer.text, path).toContain('not_found');
    }
  });
});

// ---------------------------------------------------------------------------
// Criterion 4 — home + modules.remote.enabled:false is the work edition
// ---------------------------------------------------------------------------

describe('M10 — the home edition with remote disabled is the work edition, listener for listener', () => {
  it('produces an identical listener set, an identical route table and an identical null claim', async () => {
    // Both editions in one test, so the comparison is between two observations
    // rather than between one observation and a remembered expectation. Still no
    // home-edition boot that *loads* remote, so the counter above stays honest.
    const work = await bootCore();
    const workReport = {
      nonLoopback: work.bind.nonLoopback,
      remote: work.bind.remote,
      loopbackAddresses: [...new Set(work.bind.loopback.map((entry) => entry.address))].sort(),
      remoteRoutes: work.runtime.routes.routes.filter((route) =>
        route.path.startsWith('/api/remote'),
      ).length,
    };
    await work.shutdown();
    service = undefined;

    resetModuleLoadCount(REMOTE_MODULE_ID);
    const home = await bootHome({ argv: ['--set', 'modules.remote.enabled=false'] });

    expect(home.config.edition).toBe('home');
    expect(home.config.modules.remote.enabled).toBe(false);
    expect(moduleLoadCount(REMOTE_MODULE_ID)).toBe(0);
    expect(home.runtime.order).not.toContain(REMOTE_MODULE_ID);

    expect({
      nonLoopback: home.bind.nonLoopback,
      remote: home.bind.remote,
      loopbackAddresses: [...new Set(home.bind.loopback.map((entry) => entry.address))].sort(),
      remoteRoutes: home.runtime.routes.routes.filter((route) =>
        route.path.startsWith('/api/remote'),
      ).length,
    }).toEqual(workReport);
    expect(home.bind.nonLoopback).toEqual([]);
    expect(nonLoopbackListeners()).toHaveLength(baselineNonLoopback);
  });
});

// ---------------------------------------------------------------------------
// Criterion 2 — work edition + modules.remote.enabled:true fails validation
// ---------------------------------------------------------------------------

describe('M10 — work edition + modules.remote.enabled:true in config.json never starts', () => {
  /** Writes layer 3, `<dataRoot>/config/config.json` (foundation §1.2, §2.2). */
  function writeConfigJson(value: unknown): void {
    mkdirSync(join(dataRootDir.path, 'config'), { recursive: true });
    writeFileSync(
      join(dataRootDir.path, 'config', 'config.json'),
      JSON.stringify(value, null, 2),
      'utf8',
    );
  }

  it('fails config validation with a message naming the combination, and binds nothing', async () => {
    // Deliberately through a real `config.json` rather than `--set`: this is the
    // file an owner edits, and it is the layer the refusal has to hold at.
    // `main.test.ts` covers the `--set` spelling; M10 re-asserts it from remote's
    // side because remote is what the rule protects against.
    writeConfigJson({ edition: 'work', modules: { remote: { enabled: true } } });

    const failure = await bootFailure();

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('invalid');
    expect(exitCodes).toEqual([78]);
    // Nothing started, so nothing is listening and nothing is claimed.
    expect(service).toBeUndefined();
    expect(nonLoopbackListeners()).toHaveLength(baselineNonLoopback);
  });

  it('accepts the same file with edition home, so the refusal is about the combination', async () => {
    // The control. Without it, a schema that rejected `modules.remote.enabled: true`
    // outright would pass the test above and quietly break the home edition.
    writeConfigJson({ edition: 'home', modules: { remote: { enabled: true } } });

    const booted = await bootCore({ remote: { ...noTailscale, timers: neverFires } });

    expect(booted.config.edition).toBe('home');
    expect(booted.config.modules.remote.enabled).toBe(true);
    expect(booted.runtime.order).toContain(REMOTE_MODULE_ID);
    // Loaded, and still bound to nothing: no tailnet on this machine.
    expect(booted.bind.nonLoopback).toEqual([]);
    expect(remoteStatus(booted)?.state).toBe('waiting');
  });
});

// ---------------------------------------------------------------------------
// Criterion 3 — a forced non-loopback listener is fatal
// ---------------------------------------------------------------------------

describe('M10 — a forced non-loopback listener exits the process fatally (§6.3)', () => {
  it('kills the work edition, naming the offending address, when a harness binds one directly', async () => {
    // `lifecycle/process.test.ts` proves the spawned bundle dies for
    // `http.bind=0.0.0.0`. This is the case a config key cannot express: a *second*
    // socket, opened by a module that never told anyone, enumerated from the
    // process's real libuv handles rather than from anybody's claim.
    const failure = await bootFailure({ additionalModules: [forcedListenerModule('0.0.0.0')] });

    expect(failure).toBeInstanceOf(BindInvariantError);
    const error = failure as BindInvariantError;
    expect(error.exitCode).toBe(BIND_INVARIANT_EXIT_CODE);
    expect(error.edition).toBe('work');
    expect(error.message).toContain('work edition');
    expect(error.message).toContain('0.0.0.0');
    expect(error.offending.map((entry) => entry.address)).toContain('0.0.0.0');
    expect(exitCodes).toEqual([BIND_INVARIANT_EXIT_CODE]);
  });

  it.skipIf(lanAddress === undefined)(
    'kills the work edition for a real LAN address too, not only for the wildcard',
    async () => {
      const failure = await bootFailure({
        additionalModules: [forcedListenerModule(lanAddress as string)],
      });

      expect(failure).toBeInstanceOf(BindInvariantError);
      expect((failure as Error).message).toContain(lanAddress as string);
      expect(exitCodes).toEqual([BIND_INVARIANT_EXIT_CODE]);
    },
  );

  it('kills the home edition too, because no remote module claimed the socket', async () => {
    // D5's other half: in the home edition a non-loopback socket is allowed only
    // when remote *published* it. A harness socket is claimed by nobody, so the
    // edition makes no difference.
    const failure = await bootFailure({
      argv: ['--edition', 'home'],
      remote: { ...noTailscale, timers: neverFires },
      additionalModules: [forcedListenerModule('0.0.0.0')],
    });

    expect(failure).toBeInstanceOf(BindInvariantError);
    expect((failure as Error).message).toContain('not claimed by the remote module');
    expect(exitCodes).toEqual([BIND_INVARIANT_EXIT_CODE]);
  });
});

// ---------------------------------------------------------------------------
// Criterion 5 — the home edition never binds a non-Tailscale address
// ---------------------------------------------------------------------------

/**
 * §10's five cases, plus D5's amended proxy mode, driven through `boot()`.
 *
 * Each row forces the address the prover answers and asserts the same three facts:
 * the module is `waiting`, it claims nothing, and **no socket exists afterwards**.
 * `listener.test.ts` asserts the same refusals against `assertBindable` directly;
 * these run through the composed core, which is the thing a refactor breaks.
 */
/** `--set` arguments putting the listener in D5's amended proxy mode. */
function proxyArgs(bind: string, allowedPeers: readonly string[] = ['192.168.253.9']): string[] {
  return [
    '--set',
    'remote.bind=proxy',
    '--set',
    `remote.proxy=${JSON.stringify({ bind, allowedPeers })}`,
  ];
}

/** A LAN address no machine in this household holds, so a bind would fail. */
const UNHELD_LAN = '192.168.253.253';

const REFUSALS: readonly {
  readonly label: string;
  readonly remote: NonNullable<BootOptions['remote']>;
  readonly argv?: readonly string[];
  readonly reason: RegExp;
}[] = [
  {
    label: 'a LAN address',
    remote: { detector: claiming('192.168.0.197') },
    reason: /outside 100\.64\.0\.0\/10/u,
  },
  {
    label: 'the IPv4 wildcard 0.0.0.0',
    remote: { detector: claiming('0.0.0.0') },
    reason: /wildcard/u,
  },
  {
    label: 'the IPv6 wildcard ::',
    remote: { detector: claiming('::') },
    reason: /wildcard/u,
  },
  {
    label: 'loopback 127.0.0.1',
    remote: { detector: claiming('127.0.0.1') },
    reason: /loopback/u,
  },
  {
    label: 'a CPE-CGNAT address on a LAN adapter (the case a range check alone passes)',
    // Not a forced prover: this one goes through the **real** detector, because the
    // control that catches it is §2.1's provenance rule (adapter name or CLI), not
    // `assertBindable`'s range check — `100.92.14.7` would pass that.
    remote: {
      detect: {
        locateCli: () => undefined,
        networkInterfaces: () => adapters('Ethernet', '100.92.14.7'),
      },
    },
    reason: /tailscale|adapter|candidate/iu,
  },
  {
    label: 'an IPv6 tailnet ULA address (v1 binds IPv4 only)',
    remote: { detector: claiming('fd7a:115c:a1e0::1234') },
    reason: /IPv6/u,
  },
  {
    label: 'proxy mode where the prover answers something other than remote.proxy.bind',
    remote: { detector: claiming('192.168.0.250') },
    argv: proxyArgs(UNHELD_LAN),
    reason: /not the address remote\.proxy\.bind declares/u,
  },
  {
    label: 'proxy mode where the machine does not hold the declared address',
    remote: {
      detect: {
        locateCli: () => undefined,
        networkInterfaces: () => adapters('Ethernet', '192.168.0.197'),
      },
    },
    argv: proxyArgs(UNHELD_LAN),
    reason: /interface|hold/iu,
  },
  {
    label: 'proxy mode where the prover answers the wildcard',
    remote: { detector: claiming('0.0.0.0') },
    argv: proxyArgs(UNHELD_LAN),
    reason: /wildcard/u,
  },
];

describe('M10 — the home edition binds nothing but a proven address (architecture D5)', () => {
  it.each(REFUSALS)('refuses $label and leaves no socket', async ({ remote, argv, reason }) => {
    const booted = await bootHome({
      remote: { ...remote, timers: neverFires, port: 0 },
      ...(argv === undefined ? {} : { argv: [...argv] }),
    });

    const status = remoteStatus(booted);
    expect(status?.state).toBe('waiting');
    expect(status?.boundAddress).toBeNull();
    expect(status?.lastError ?? '').toMatch(reason);

    // "each asserting no socket exists afterwards" — from the process's handles,
    // and from the report §6.3's assertion produced out of them.
    expect(booted.bind.nonLoopback).toEqual([]);
    expect(booted.bind.remote).toBeNull();
    expect(nonLoopbackListeners()).toHaveLength(baselineNonLoopback);

    // And the core is perfectly healthy apart from remote being degraded — the
    // `critical: false` half of the same boundary.
    const health = await booted.health();
    expect(health.modules.find((module) => module.id === REMOTE_MODULE_ID)?.status).toBe(
      'degraded',
    );
    expect(health.modules.find((module) => module.id === 'http')?.status).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// Criterion 7 — the bind-assertion cross-check
// ---------------------------------------------------------------------------

describe('M10 — foundation’s assertion and remote’s boundAddress() must agree', () => {
  it('is fatal when a non-loopback socket exists and remote claims nothing', async () => {
    // The desynchronisation that needs no real socket: the harness reports a
    // listener the module never published. §6.3 has to refuse it, because a socket
    // nobody owns is exactly the leak the assertion exists to catch.
    const foreign: ObservedListener = { address: '192.0.2.55', port: 7999, family: 'IPv4' };
    const observe = (): ListenerObservation => ({
      listeners: [{ address: '127.0.0.1', port: 7477, family: 'IPv4' }, foreign],
      source: 'handles',
    });

    const failure = await bootFailure({
      argv: ['--edition', 'home'],
      remote: { ...noTailscale, timers: neverFires },
      listeners: observe,
    });

    expect(failure).toBeInstanceOf(BindInvariantError);
    expect((failure as Error).message).toContain('192.0.2.55:7999');
    expect((failure as Error).message).toContain('No module published a bound address');
    expect(exitCodes).toEqual([BIND_INVARIANT_EXIT_CODE]);
  });

  it.skipIf(lanAddress === undefined)(
    'agrees with remote’s published claim when a real socket is bound (proxy mode)',
    async () => {
      // The positive half, with a **real** socket on a real interface: proxy mode is
      // the D5 shape that can be exercised on a machine with no tailnet, so this is
      // where the two independently produced claims are compared for real.
      const booted = await bootHome({
        argv: [
          '--set',
          'remote.bind=proxy',
          '--set',
          `remote.proxy=${JSON.stringify({
            bind: lanAddress,
            // A peer nobody is: the socket exists for the assertion, not for traffic.
            allowedPeers: ['192.0.2.9'],
          })}`,
        ],
        remote: { ...realInterfaces, timers: neverFires, port: 0 },
      });

      const claim = remoteStatus(booted)?.boundAddress;
      expect(claim?.address).toBe(lanAddress);
      expect(claim?.source).toBe('proxy');

      // The report §6.3 produced: enumerated from handles, one non-loopback socket,
      // and it is the one remote published.
      expect(booted.bind.listeners.length).toBeGreaterThan(0);
      expect(booted.bind.remote).toEqual(claim);
      expect(booted.bind.nonLoopback).toEqual([
        { address: claim?.address, port: claim?.port, family: 'IPv4' },
      ]);
      expect(booted.bind.warnings).toEqual([]);
      expect(nonLoopbackListeners()).toHaveLength(baselineNonLoopback + 1);
    },
  );

  it.skipIf(lanAddress === undefined)(
    'fails the boot when the two claims are deliberately desynchronised',
    async () => {
      // Remote really binds, and the harness reports a *different* address. The
      // assertion must compare the two rather than trust either.
      const failure = await bootFailure({
        argv: [
          '--edition',
          'home',
          '--set',
          'remote.bind=proxy',
          '--set',
          `remote.proxy=${JSON.stringify({ bind: lanAddress, allowedPeers: ['192.0.2.9'] })}`,
        ],
        remote: { ...realInterfaces, timers: neverFires, port: 0 },
        listeners: () => ({
          listeners: [
            { address: '127.0.0.1', port: 7477, family: 'IPv4' },
            // Same interface, a port remote never claimed.
            { address: lanAddress as string, port: 7999, family: 'IPv4' },
          ],
          source: 'handles',
        }),
      });

      expect(failure).toBeInstanceOf(BindInvariantError);
      const message = (failure as Error).message;
      expect(message).toContain(`${lanAddress ?? ''}:7999`);
      // The fatal report names remote's actual claim, so the mismatch is diagnosable.
      expect(message).toContain('Remote claims');
      expect(message).toContain('source "proxy"');
      expect(exitCodes).toEqual([BIND_INVARIANT_EXIT_CODE]);
    },
  );
});

// ---------------------------------------------------------------------------
// Criterion 8 — no token material in any response
// ---------------------------------------------------------------------------

/** The three shapes §10 names, as a scan over one response body. */
function expectNoTokenMaterial(where: string, text: string, token: string): void {
  const digest = createHash('sha256').update(token).digest('hex');
  expect(text, `${where}: plaintext token`).not.toContain(token);
  expect(text, `${where}: token hash`).not.toContain(digest);
  expect(text.toLowerCase(), `${where}: base64 token hash`).not.toContain(
    createHash('sha256').update(token).digest('base64').toLowerCase(),
  );
  expect(text, `${where}: an OAuth-shaped secret`).not.toMatch(/sk-ant-/u);
}

describe('M10 — no response carries token material', () => {
  it('keeps a live token out of /api/config/effective, /api/health and remote’s own routes', async () => {
    let internals: RemoteInternals | undefined;
    const booted = await bootHome({
      remote: {
        ...noTailscale,
        timers: neverFires,
        onReady: (ready) => void (internals = ready),
      },
    });

    // Minted against the **real** service the middleware verifies against, so the
    // value scanned for is the one a device would actually hold.
    const token = internals?.tokens.mint({ label: 'Pixel 9' });
    expect(token?.token).toBeDefined();
    const plaintext = token?.token ?? '';
    expect(plaintext.length).toBeGreaterThan(20);

    for (const path of [
      '/api/config/effective',
      '/api/health',
      '/healthz',
      '/api/remote/status',
      '/api/remote/tokens',
      '/api/remote/agents',
    ]) {
      const answer = await get(booted, path);
      expect(answer.status, path).toBeLessThan(500);
      expectNoTokenMaterial(path, answer.text, plaintext);
    }

    // The list view *does* show the six-character display prefix (§4.3) — that is
    // the deliberate exception, and it is asserted rather than assumed, so a change
    // to it is a decision instead of a surprise.
    const list = await get(booted, '/api/remote/tokens');
    expect(list.text).toContain(plaintext.slice(0, 6));
  });
});

describe('M10 — no error body over the remote listener carries token material', () => {
  let harness: RemoteHarness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it('scans every refusal the chain can produce — 401, 403, 404, 421 and 429', async () => {
    // The real middleware chain over a real socket (`__tests__/harness.ts`), which is
    // where every one of these bodies is actually written.
    harness = await createRemoteHarness({ maxFailures: 3 });
    const live = harness.mint('Pixel 9');
    const expired = harness.mint('old tablet', { ttlDays: 1 });
    const revoked = harness.mint('lost phone');
    harness.tokens.revoke(revoked.id);

    const cases: readonly { label: string; answer: Awaited<ReturnType<RemoteHarness['call']>> }[] =
      [
        { label: '401 no credential', answer: await harness.call('/api/health') },
        {
          label: '401 unknown token',
          answer: await harness.call('/api/health', { token: 'not-a-real-token' }),
        },
        {
          label: '401 malformed token',
          answer: await harness.call('/api/health', { headers: { authorization: 'Bearer' } }),
        },
        {
          label: '401 revoked token',
          answer: await harness.call('/api/health', { token: revoked.token }),
        },
        {
          label: '403 route denied remotely',
          answer: await harness.call('/api/service/shutdown', {
            method: 'POST',
            token: live.token,
          }),
        },
        {
          label: '404 unknown api path',
          answer: await harness.call('/api/nope', { token: live.token }),
        },
        {
          label: '421 misdirected host',
          answer: await harness.call('/api/health', { token: live.token, host: 'evil.example' }),
        },
      ];

    for (const { label, answer } of cases) {
      expect(answer.status, label).toBeGreaterThanOrEqual(400);
      for (const token of [live.token, expired.token, revoked.token]) {
        expectNoTokenMaterial(label, answer.text, token);
      }
      expectNoTokenMaterial(`${label} (headers)`, JSON.stringify([...answer.headers]), live.token);
    }

    // The expired case needs the clock moved, and the lockout needs the failures
    // to have accumulated — both after the table above, so neither disturbs it.
    harness.now += 2 * 24 * 60 * 60 * 1000;
    const stale = await harness.call('/api/health', { token: expired.token });
    expect(stale.status).toBe(401);
    expectNoTokenMaterial('401 expired token', stale.text, expired.token);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await harness.call('/api/health', { token: 'wrong' });
    }
    const blocked = await harness.call('/api/health', { token: live.token });
    expect(blocked.status).toBe(429);
    expectNoTokenMaterial('429 lockout', blocked.text, live.token);
    expect(blocked.headers.get('retry-after')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Criterion 9 — the gate is documented as the gate
// ---------------------------------------------------------------------------

describe('M10 — the suite is documented as the merge gate for D5/D6 changes', () => {
  it('is named in the README and reachable as its own npm script', () => {
    // §10's last criterion: "The suite is documented in the repo README as the merge
    // gate for D5/D6-touching changes." Asserted rather than trusted, because a
    // documented gate that nobody can run is not a gate.
    const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8');
    expect(readme).toMatch(/merge gate/iu);
    expect(readme).toContain('test:boundary');
    expect(readme).toMatch(/D5/u);
    expect(readme).toMatch(/D6/u);

    const scripts = (
      JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
        scripts: Record<string, string>;
      }
    ).scripts;
    expect(scripts['test:boundary']).toBeDefined();
    // `npm run ci` must still run it, so the gate cannot be forgotten by running
    // the normal command.
    expect(scripts['ci']).toContain('test');
  });
});
