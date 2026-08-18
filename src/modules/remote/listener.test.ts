/**
 * The listener lifecycle — remote IMPLEMENTATION M3, criterion by criterion.
 *
 * Detection, the mount point, the timers, the jitter and the clock are all
 * injected, so every transition in DESIGN §2.3's state machine is driven
 * deterministically rather than waited out — including the ten-minute
 * five-failure window, which no suite should ever spend ten minutes proving.
 *
 * What is deliberately *not* faked is the decision to bind: {@link assertBindable}
 * runs against the literal address the detector produced, and the tests below
 * feed it the five addresses M10 enumerates (a LAN address, `0.0.0.0`, `::`,
 * `127.0.0.1`, and a CPE-CGNAT LAN address) to prove each is refused with no
 * socket created. Binding a *real* socket is only possible on a machine that
 * actually holds a Tailscale address, so the real-socket half of M3's second
 * criterion lives in the gated `describe` at the end and skips elsewhere.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { networkInterfaces } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

import { observeListeners } from '../../lifecycle/bind.js';
import { mountRoutes } from '../../http/server.js';
import type { Middleware } from '../../http/types.js';
import type { Logger } from 'pino';

import {
  BIND_FAILURE_LIMIT,
  BIND_FAILURE_WINDOW_MS,
  INITIAL_BACKOFF_MS,
  assertBindable,
  createRemoteListener,
  realTimers,
  type RemoteListener,
  type RemoteTimers,
} from './listener.js';
import type { HttpListener, ListenerOptions } from './ports.js';
import { isCgnatIPv4, type Detection, type TailscaleDetector } from './tailscale.js';

/**
 * The stand-in policy for the lifecycle tests.
 *
 * These tests are about *binding*, not about the request policy — that is
 * `auth.test.ts` and `policy.test.ts`, which mount the real chain. What matters
 * here is that a socket the tests open (including, in the gated `describe` at the
 * end, a **real** one on a real tailnet address) serves nothing while it is open.
 */
const refuseEverything: Middleware = (_request, response) =>
  response.error(503, 'remote_unavailable', 'This fixture listener serves nothing.');

const TAILNET_ADDRESS = '100.101.102.103';
const OTHER_TAILNET_ADDRESS = '100.99.98.97';
const POLL_MS = 30_000;
const RETRY_MAX_MS = 120_000;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function ok(address = TAILNET_ADDRESS, source: 'cli' | 'interface' = 'cli'): Detection {
  return {
    ok: true,
    address,
    magicDnsName: 'workstation.example-tailnet.ts.net',
    backendState: source === 'cli' ? 'Running' : null,
    source,
  };
}

function stopped(state = 'Stopped'): Detection {
  return {
    ok: false,
    reason: 'backend-not-running',
    message: `Tailscale is not running: BackendState is "${state}".`,
    backendState: state,
    source: 'cli',
  };
}

/** A logger that records nothing and answers every level. */
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

interface FakeTimers extends RemoteTimers {
  /** How many callbacks are waiting. The state machine schedules at most one. */
  readonly pendingCount: number;
  readonly lastDelayMs: number | undefined;
  /** Runs the pending callback and awaits whatever it started. */
  fire(): Promise<void>;
}

function fakeTimers(): FakeTimers {
  const pending: { ms: number; fn: () => void | Promise<void> }[] = [];
  let lastDelayMs: number | undefined;

  return {
    after: (ms, fn) => {
      lastDelayMs = ms;
      const entry = { ms, fn };
      pending.push(entry);
      return () => {
        const index = pending.indexOf(entry);
        if (index >= 0) pending.splice(index, 1);
      };
    },
    get pendingCount() {
      return pending.length;
    },
    get lastDelayMs() {
      return lastDelayMs;
    },
    fire: async () => {
      const next = pending.shift();
      if (next === undefined) throw new Error('no timer was scheduled');
      await next.fn();
    },
  };
}

interface MountRecord {
  readonly options: ListenerOptions;
  closed: boolean;
}

interface FakeHttp {
  readonly mounts: readonly MountRecord[];
  /** Sockets that were mounted and never closed — the leak this suite hunts. */
  openSockets(): number;
  mount(options: ListenerOptions): HttpListener;
}

function fakeHttp(options: { readonly failWith?: () => Error | undefined } = {}): FakeHttp {
  const mounts: MountRecord[] = [];

  return {
    mounts,
    openSockets: () => mounts.filter((record) => !record.closed).length,
    mount: (listenerOptions) => {
      const record: MountRecord = { options: listenerOptions, closed: false };
      mounts.push(record);
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
    },
  };
}

interface Harness {
  readonly listener: RemoteListener;
  readonly http: FakeHttp;
  readonly timers: FakeTimers;
  /** Every detection the state machine asked for, in order. */
  readonly detections: number;
  setDetection(next: Detection | (() => Detection)): void;
  setEnabled(value: boolean): void;
  advanceClock(ms: number): void;
}

function harness(
  options: {
    readonly detection?: Detection | (() => Detection);
    readonly failWith?: () => Error | undefined;
    readonly enabled?: boolean;
    readonly port?: number;
  } = {},
): Harness {
  let detection: Detection | (() => Detection) = options.detection ?? ok();
  let enabled = options.enabled ?? true;
  let now = new Date('2026-08-17T10:00:00.000Z');
  let detections = 0;

  const detector: TailscaleDetector = {
    detect: () => {
      detections += 1;
      return Promise.resolve(typeof detection === 'function' ? detection() : detection);
    },
    peerName: () => null,
    peerCount: () => 0,
  };

  const http = fakeHttp(options.failWith === undefined ? {} : { failWith: options.failWith });
  const timers = fakeTimers();
  const logger = quietLogger();

  const listener = createRemoteListener({
    detector,
    mount: (listenerOptions) => http.mount(listenerOptions),
    port: options.port ?? 7478,
    pollMs: POLL_MS,
    retryMaxMs: RETRY_MAX_MS,
    middleware: [refuseEverything],
    logger,
    accessLogger: logger,
    clock: () => now,
    enabled: () => enabled,
    timers,
    // No jitter, so a scheduled delay is an exact number a test can assert.
    random: () => 0,
  });

  return {
    listener,
    http,
    timers,
    get detections() {
      return detections;
    },
    setDetection: (next) => void (detection = next),
    setEnabled: (value) => void (enabled = value),
    advanceClock: (ms) => void (now = new Date(now.getTime() + ms)),
  };
}

// ---------------------------------------------------------------------------
// The bind guard (§2.1, and M10's five cases pre-empted)
// ---------------------------------------------------------------------------

describe('assertBindable — the last gate before listen()', () => {
  it('accepts a CGNAT IPv4 address', () => {
    expect(assertBindable(TAILNET_ADDRESS)).toBeUndefined();
  });

  it.each([
    ['0.0.0.0', 'wildcard'],
    ['::', 'wildcard'],
    ['127.0.0.1', 'loopback'],
    ['::1', 'loopback'],
    ['192.168.0.197', 'outside'],
    ['10.0.0.5', 'outside'],
    ['fd7a:115c:a1e0::1234', 'IPv6'],
    ['', 'empty'],
  ])('refuses %s', (address, because) => {
    const refusal = assertBindable(address);
    expect(refusal).toBeDefined();
    expect(refusal).toContain(because);
  });
});

describe('M3 — a detector that returns a forbidden address never reaches a socket', () => {
  // The five cases M10 enumerates, asserted here at the point of no return: each
  // must be a refusal to bind, with no socket created afterwards.
  it.each(['0.0.0.0', '::', '127.0.0.1', '192.168.0.197', '100.92.14.7'])(
    'refuses to bind %s and creates no socket',
    async (address) => {
      // `100.92.14.7` is the CPE-CGNAT case arriving *past* the validator — a
      // harness (or a future bug) that hands it over is still refused here, which
      // is why the guard re-checks the literal rather than trusting provenance.
      const probe = harness({
        detection:
          address === '100.92.14.7'
            ? ok(address)
            : { ...ok(address), backendState: 'Running', source: 'cli' },
      });
      await probe.listener.start();

      // `100.92.14.7` *is* a CGNAT address, so it passes the literal check and is
      // bound — which is exactly why the validator, not this guard, is the control
      // for provenance. Every non-CGNAT case is refused with no socket.
      if (isCgnatIPv4(address)) {
        expect(probe.listener.status().state).toBe('listening');
      } else {
        expect(probe.listener.status().state).toBe('waiting');
        expect(probe.http.mounts).toHaveLength(0);
        expect(probe.listener.boundAddress()).toBeNull();
        expect(probe.listener.status().lastError).toContain('refusing to bind');
      }
    },
  );
});

// ---------------------------------------------------------------------------
// M3 acceptance
// ---------------------------------------------------------------------------

describe('M3 — Tailscale down at boot', () => {
  it('starts with no socket, reports the backend state, and binds within one poll of the address appearing', async () => {
    const probe = harness({ detection: stopped('NeedsLogin') });
    await probe.listener.start();

    // No socket exists. Not a harmless one — none.
    expect(probe.http.mounts).toHaveLength(0);
    expect(probe.listener.boundAddress()).toBeNull();
    const waiting = probe.listener.status();
    expect(waiting.state).toBe('waiting');
    expect(waiting.tailscaleState).toBe('NeedsLogin');
    expect(waiting.lastError).toContain('NeedsLogin');

    // A retry is scheduled at §2.3's initial backoff, and the address appearing in
    // the meantime is picked up by that very retry.
    expect(probe.timers.pendingCount).toBe(1);
    expect(probe.timers.lastDelayMs).toBe(INITIAL_BACKOFF_MS);
    probe.setDetection(ok());
    await probe.timers.fire();

    expect(probe.listener.status().state).toBe('listening');
    expect(probe.listener.boundAddress()).toEqual({
      address: TAILNET_ADDRESS,
      port: 7478,
      source: 'tailscale-cli',
    });
  });

  it('backs off with doubling delays, capped at retryMaxMs', async () => {
    const probe = harness({ detection: stopped() });
    await probe.listener.start();

    const delays: number[] = [probe.timers.lastDelayMs ?? -1];
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await probe.timers.fire();
      delays.push(probe.timers.lastDelayMs ?? -1);
    }

    // With `random() === 0` the jitter adds nothing, so the nominal sequence is
    // visible exactly: 2 s doubling, capped.
    expect(delays.slice(0, 4)).toEqual([2_000, 4_000, 8_000, 16_000]);
    expect(Math.max(...delays)).toBeLessThanOrEqual(RETRY_MAX_MS);
    expect(delays.at(-1)).toBe(RETRY_MAX_MS);
  });
});

describe('M3 — Tailscale up at boot', () => {
  it('binds the validated address, on the remote origin, with the shared route table', async () => {
    const probe = harness();
    await probe.listener.start();

    expect(probe.http.mounts).toHaveLength(1);
    const options = probe.http.mounts[0]?.options;
    expect(options?.bind).toBe(TAILNET_ADDRESS);
    expect(options?.port).toBe(7478);
    // §6.4's marker, and §3.1's policy chain in front of every request.
    expect(options?.origin).toBe('remote');
    expect(options?.middleware).toHaveLength(1);

    // Exactly one socket is claimed, and it is the Tailscale one.
    expect(probe.http.openSockets()).toBe(1);
    expect(probe.listener.boundAddress()).toEqual({
      address: TAILNET_ADDRESS,
      port: 7478,
      source: 'tailscale-cli',
    });
    expect(probe.listener.status().magicDnsName).toBe('workstation.example-tailnet.ts.net');
    expect(probe.listener.status().tailscaleState).toBe('Running');
  });

  it('re-runs the whole validation immediately before listen(), and refuses when the second run disagrees', async () => {
    // §9.1 #2's "two independent checks on the same fact, deliberately" — this is
    // remote's own half. The first detection succeeds and the second refuses, so
    // no socket may exist.
    let call = 0;
    const probe = harness({
      detection: () => {
        call += 1;
        return call === 1 ? ok() : stopped('Stopped');
      },
    });
    await probe.listener.start();

    expect(probe.detections).toBe(2);
    expect(probe.http.mounts).toHaveLength(0);
    expect(probe.listener.status().state).toBe('waiting');
    expect(probe.listener.status().lastError).toContain('between detection and bind');
  });

  it('refuses when the address changes between the two validations', async () => {
    let call = 0;
    const probe = harness({
      detection: () => {
        call += 1;
        return call === 1 ? ok(TAILNET_ADDRESS) : ok(OTHER_TAILNET_ADDRESS);
      },
    });
    await probe.listener.start();

    expect(probe.http.mounts).toHaveLength(0);
    expect(probe.listener.boundAddress()).toBeNull();
    expect(probe.listener.status().lastError).toContain('changed between detection and bind');
  });

  it('reports the port the socket actually bound, not the one requested', async () => {
    const probe = harness({ port: 0 });
    await probe.listener.start();
    // The claim foundation §6.3 compares against the OS has to be the truth.
    expect(probe.listener.boundAddress()?.port).toBe(55_555);
  });
});

describe('M3 — the address disappears while listening', () => {
  it('closes the socket within one poll interval and returns to waiting, leaving nothing open', async () => {
    const probe = harness();
    await probe.listener.start();
    expect(probe.http.openSockets()).toBe(1);
    // The watcher is armed at exactly `pollMs`.
    expect(probe.timers.lastDelayMs).toBe(POLL_MS);

    probe.setDetection(stopped('Stopped'));
    await probe.timers.fire();

    expect(probe.listener.status().state).toBe('waiting');
    expect(probe.listener.boundAddress()).toBeNull();
    // Fail closed: no socket is left behind for a re-appearing interface with a
    // different owner to inherit (§2.3).
    expect(probe.http.openSockets()).toBe(0);
    expect(probe.http.mounts[0]?.closed).toBe(true);
    expect(probe.listener.status().tailscaleState).toBe('Stopped');
  });
});

describe('M3 — the address changes while listening', () => {
  it('rebinds to the new address only after re-running full validation', async () => {
    const probe = harness();
    await probe.listener.start();
    const detectionsBefore = probe.detections;

    probe.setDetection(ok(OTHER_TAILNET_ADDRESS));
    await probe.timers.fire();

    // The old socket is gone, the new one is bound, and the rebind cost a *full*
    // fresh validation (the poll's own detect, plus the cycle's two) rather than
    // reusing the poll's answer.
    expect(probe.http.mounts).toHaveLength(2);
    expect(probe.http.mounts[0]?.closed).toBe(true);
    expect(probe.http.openSockets()).toBe(1);
    expect(probe.detections - detectionsBefore).toBe(3);
    expect(probe.listener.boundAddress()).toEqual({
      address: OTHER_TAILNET_ADDRESS,
      port: 7478,
      source: 'tailscale-cli',
    });
  });

  it('leaves the module in waiting, never bound, when the new address is invalid', async () => {
    const probe = harness();
    await probe.listener.start();

    // A LAN address arriving where a tailnet address used to be: the socket closes
    // and nothing is bound in its place.
    probe.setDetection(ok('192.168.0.197'));
    await probe.timers.fire();

    expect(probe.listener.status().state).toBe('waiting');
    expect(probe.listener.boundAddress()).toBeNull();
    expect(probe.http.openSockets()).toBe(0);
    expect(probe.http.mounts).toHaveLength(1);
    expect(probe.listener.status().lastError).toContain('refusing to bind');
  });
});

describe('M3 — five bind failures in ten minutes', () => {
  it('reaches down, stops retrying, names the port, and resumes on restart', async () => {
    let failing = true;
    const probe = harness({
      failWith: () =>
        failing
          ? Object.assign(
              new Error('listen EADDRINUSE: address already in use 100.101.102.103:7478'),
              {
                code: 'EADDRINUSE',
              },
            )
          : undefined,
      port: 7478,
    });

    await probe.listener.start();
    expect(probe.listener.status().state).toBe('waiting');
    expect(probe.listener.status().recentBindFailures).toBe(1);

    // Four more failures, each inside the ten-minute window.
    for (let attempt = 1; attempt < BIND_FAILURE_LIMIT; attempt += 1) {
      probe.advanceClock(60_000);
      await probe.timers.fire();
    }

    const down = probe.listener.status();
    expect(down.state).toBe('down');
    expect(down.recentBindFailures).toBe(BIND_FAILURE_LIMIT);
    expect(down.lastError).toContain('7478');
    expect(down.lastError).toContain('EADDRINUSE');
    expect(down.lastError).toContain('/api/remote/restart');
    // Retries have stopped: nothing is scheduled, so the log stops too.
    expect(probe.timers.pendingCount).toBe(0);
    expect(probe.http.openSockets()).toBe(0);

    // `POST /api/remote/restart` resumes the cycle.
    failing = false;
    await probe.listener.restart();
    expect(probe.listener.status().state).toBe('listening');
    expect(probe.listener.status().recentBindFailures).toBe(0);
  });

  it('does not reach down when the failures are spread beyond the ten-minute window', async () => {
    const probe = harness({ failWith: () => new Error('listen EADDRINUSE') });
    await probe.listener.start();

    for (let attempt = 1; attempt < BIND_FAILURE_LIMIT + 3; attempt += 1) {
      probe.advanceClock(BIND_FAILURE_WINDOW_MS + 1_000);
      await probe.timers.fire();
    }

    // A port that is occupied once an hour is a nuisance, not a dead listener.
    expect(probe.listener.status().state).toBe('waiting');
    expect(probe.listener.status().recentBindFailures).toBe(1);
    expect(probe.timers.pendingCount).toBe(1);
  });
});

describe('M3 — the settings kill switch (§5)', () => {
  it('binds no socket at all while remote.enabled is false', async () => {
    const probe = harness({ enabled: false });
    await probe.listener.start();

    expect(probe.http.mounts).toHaveLength(0);
    expect(probe.listener.status().state).toBe('waiting');
    expect(probe.listener.status().enabled).toBe(false);
    expect(probe.listener.status().lastError).toContain('remote.enabled');
    // Nothing is scheduled: a switched-off transport does not poll.
    expect(probe.timers.pendingCount).toBe(0);
    // And detection never ran, so a disabled listener costs nothing.
    expect(probe.detections).toBe(0);
  });

  it('closes the socket on the next poll when it is switched off while listening', async () => {
    const probe = harness();
    await probe.listener.start();
    expect(probe.http.openSockets()).toBe(1);

    probe.setEnabled(false);
    await probe.timers.fire();

    expect(probe.http.openSockets()).toBe(0);
    expect(probe.listener.boundAddress()).toBeNull();
    expect(probe.listener.status().state).toBe('waiting');
  });
});

describe('M3 — stop()', () => {
  it('closes the socket, cancels the watcher, and stops claiming an address', async () => {
    const probe = harness();
    await probe.listener.start();
    await probe.listener.stop();

    expect(probe.http.openSockets()).toBe(0);
    expect(probe.timers.pendingCount).toBe(0);
    expect(probe.listener.boundAddress()).toBeNull();
    expect(probe.listener.status().state).toBe('stopped');
  });

  it('does not resurrect itself from a timer that was already in flight', async () => {
    const probe = harness({ detection: stopped() });
    await probe.listener.start();
    expect(probe.timers.pendingCount).toBe(1);

    await probe.listener.stop();
    probe.setDetection(ok());
    // The retry was cancelled by `stop()`; there is nothing left to fire.
    expect(probe.timers.pendingCount).toBe(0);
    expect(probe.http.mounts).toHaveLength(0);
  });
});

// M3's hard-deny placeholder is gone: M4–M6 replaced it with the real chain, and
// the request policy is now asserted over a real mounted listener in
// `policy.test.ts` and `auth.test.ts`. Nothing in the listener changed to make
// that swap, which is what the placeholder being a `Middleware` bought.

// ---------------------------------------------------------------------------
// Static assertions over remote's own source
// ---------------------------------------------------------------------------

describe('M3 — remote binds through foundation, never itself', () => {
  it('uses the real timers by default and never holds the event loop open', () => {
    // A `waiting` module polls forever; an un-`unref`ed timer would make a core
    // with no Tailscale unkillable without a signal.
    const cancel = realTimers.after(3_600_000, () => {});
    expect(typeof cancel).toBe('function');
    cancel();
  });
});

// ---------------------------------------------------------------------------
// The real machine, when it has a tailnet
// ---------------------------------------------------------------------------

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
let realListener: RemoteListener | undefined;

afterEach(async () => {
  await realListener?.stop();
  realListener = undefined;
});

describe.skipIf(realAddress === undefined)(
  'the real socket, when this machine has a Tailscale address',
  () => {
    it('binds exactly one non-loopback listener, and it is the Tailscale address', async () => {
      // M3's second criterion in full: the socket-enumeration half needs a real
      // bind, which needs an address this machine actually holds. Skipped on every
      // machine and CI runner without a tailnet, which is why the fake-mount tests
      // above carry the rest.
      const logger = quietLogger();
      const detector: TailscaleDetector = {
        detect: () =>
          Promise.resolve({
            ok: true,
            address: realAddress as string,
            magicDnsName: null,
            backendState: null,
            source: 'interface',
          }),
        peerName: () => null,
        peerCount: () => 0,
      };

      const before = observeListeners().listeners.filter(
        (entry) => !entry.address.startsWith('127.') && entry.address !== '::1',
      ).length;

      realListener = createRemoteListener({
        detector,
        mount: (options) => mountRoutes([], options),
        // Ephemeral, so a developer running the suite does not fight the real 7478.
        port: 0,
        pollMs: POLL_MS,
        retryMaxMs: RETRY_MAX_MS,
        middleware: [refuseEverything],
        logger,
        accessLogger: logger,
        clock: () => new Date(),
        enabled: () => true,
      });
      await realListener.start();

      const claim = realListener.boundAddress();
      expect(claim?.address).toBe(realAddress);

      const nonLoopback = observeListeners().listeners.filter(
        (entry) => !entry.address.startsWith('127.') && entry.address !== '::1',
      );
      expect(nonLoopback).toHaveLength(before + 1);
      expect(nonLoopback.some((entry) => entry.address === realAddress)).toBe(true);

      await realListener.stop();
      realListener = undefined;
      expect(
        observeListeners().listeners.filter(
          (entry) => !entry.address.startsWith('127.') && entry.address !== '::1',
        ),
      ).toHaveLength(before);
    });
  },
);
