/**
 * The bind-time invariant of DESIGN §6.3, milestone M9.
 *
 * Every branch of the assertion is exercised here against constructed listener
 * sets; `lifecycle.test.ts` proves it fires through a real boot, and
 * `process.test.ts` proves the process actually exits on it.
 */
import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import {
  assertBindInvariant,
  BindInvariantError,
  BIND_INVARIANT_EXIT_CODE,
  isLoopback,
  normaliseAddress,
  observeListeners,
  type BoundAddress,
  type ObservedListener,
} from './bind.js';

const loopback: ObservedListener = { address: '127.0.0.1', port: 7477, family: 'IPv4' };
const tailnet: ObservedListener = { address: '100.101.102.103', port: 7478, family: 'IPv4' };
const wildcard: ObservedListener = { address: '0.0.0.0', port: 7477, family: 'IPv4' };

const remoteClaim: BoundAddress = {
  address: '100.101.102.103',
  port: 7478,
  source: 'tailscale',
};

describe('isLoopback', () => {
  it.each(['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1', 'localhost'])(
    'accepts %s',
    (address) => {
      expect(isLoopback(address)).toBe(true);
    },
  );

  it.each(['0.0.0.0', '::', '100.101.102.103', '192.168.1.10', 'fe80::1'])(
    'refuses %s',
    (address) => {
      expect(isLoopback(address)).toBe(false);
    },
  );

  it('refuses the wildcards specifically, because they expose every interface', () => {
    // The one that would otherwise slip through: `0.0.0.0` is not an address a
    // packet comes from, it is "all of them", including the LAN D5 rules out.
    expect(isLoopback('0.0.0.0')).toBe(false);
    expect(isLoopback('::')).toBe(false);
  });
});

describe('normaliseAddress', () => {
  it('strips an IPv6 zone id', () => {
    expect(normaliseAddress('fe80::1%eth0')).toBe('fe80::1');
  });

  it('unwraps an IPv4-mapped IPv6 address, so the two spellings compare equal', () => {
    expect(normaliseAddress('::ffff:100.101.102.103')).toBe('100.101.102.103');
  });
});

describe('assertBindInvariant, work edition', () => {
  it('accepts a process whose every listener is loopback', () => {
    const report = assertBindInvariant({ edition: 'work', listeners: [loopback] });
    expect(report.nonLoopback).toEqual([]);
    expect(report.loopback).toEqual([loopback]);
  });

  it('is fatal for any non-loopback listener', () => {
    expect(() => assertBindInvariant({ edition: 'work', listeners: [loopback, tailnet] })).toThrow(
      BindInvariantError,
    );
  });

  it('is fatal for a wildcard bind, which is the realistic mistake', () => {
    const failure = attempt({ edition: 'work', listeners: [wildcard] });
    expect(failure?.message).toContain('0.0.0.0:7477');
    expect(failure?.message).toContain('work edition');
    expect(failure?.exitCode).toBe(BIND_INVARIANT_EXIT_CODE);
    expect(failure?.offending).toEqual([wildcard]);
  });

  it('is fatal even when a remote claim would have covered it', () => {
    // The work edition has no remote module at all; a claim reaching this far
    // would mean the edition gate had already been crossed.
    expect(() =>
      assertBindInvariant({ edition: 'work', listeners: [tailnet], remote: remoteClaim }),
    ).toThrow(BindInvariantError);
  });
});

describe('assertBindInvariant, home edition', () => {
  it('accepts a non-loopback listener that matches remote’s published claim', () => {
    const report = assertBindInvariant({
      edition: 'home',
      listeners: [loopback, tailnet],
      remote: remoteClaim,
    });
    expect(report.nonLoopback).toEqual([tailnet]);
    expect(report.warnings).toEqual([]);
  });

  it('accepts the IPv4-mapped spelling of the same address', () => {
    expect(() =>
      assertBindInvariant({
        edition: 'home',
        listeners: [{ ...tailnet, address: '::ffff:100.101.102.103', family: 'IPv6' }],
        remote: remoteClaim,
      }),
    ).not.toThrow();
  });

  it('is fatal when no module claims the listener', () => {
    const failure = attempt({ edition: 'home', listeners: [loopback, tailnet], remote: null });
    expect(failure?.message).toContain('100.101.102.103:7478');
    expect(failure?.message).toContain('not claimed by the remote module');
    expect(failure?.message).toContain('boundAddress()');
  });

  it('is fatal when remote claims a different port on the same address', () => {
    const failure = attempt({
      edition: 'home',
      listeners: [tailnet],
      remote: { ...remoteClaim, port: 9999 },
    });
    expect(failure?.message).toContain('Remote claims 100.101.102.103:9999');
  });

  it('is fatal when remote claims a different address on the same port', () => {
    const failure = attempt({
      edition: 'home',
      listeners: [tailnet],
      remote: { ...remoteClaim, address: '10.0.0.5' },
    });
    expect(failure?.message).toContain('source "tailscale"');
  });

  it('behaves exactly like the work edition when remote binds nothing', () => {
    // §6.3 read through the placeholder module: no service on the registry
    // means no claim, so home-with-remote-disabled is as closed as work.
    expect(() => assertBindInvariant({ edition: 'home', listeners: [loopback] })).not.toThrow();
    expect(() => assertBindInvariant({ edition: 'home', listeners: [wildcard] })).toThrow(
      BindInvariantError,
    );
  });

  it('warns, but does not fail, when remote claims a socket that is not bound', () => {
    const report = assertBindInvariant({
      edition: 'home',
      listeners: [loopback],
      remote: remoteClaim,
    });
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]).toContain('no listening socket');
  });
});

describe('observeListeners', () => {
  const servers: Server[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      await new Promise<void>((done) => void server.close(() => done()));
    }
  });

  it('reports a socket this process actually owns, without being told about it', async () => {
    const server = createServer();
    servers.push(server);
    await new Promise<void>((done) => void server.listen(0, '127.0.0.1', () => done()));
    const port = (server.address() as { port: number }).port;

    const observation = observeListeners();
    expect(observation.source).toBe('handles');
    expect(observation.listeners).toContainEqual(
      expect.objectContaining({ address: '127.0.0.1', port }),
    );
  });

  it('drops the socket from the observation once it closes', async () => {
    const server = createServer();
    servers.push(server);
    await new Promise<void>((done) => void server.listen(0, '127.0.0.1', () => done()));
    const port = (server.address() as { port: number }).port;
    await new Promise<void>((done) => void servers.pop()?.close(() => done()));

    expect(observeListeners().listeners.map((listener) => listener.port)).not.toContain(port);
  });

  it('falls back to the caller’s list, and says so, when handles cannot be read', () => {
    const handles = (process as unknown as Record<string, unknown>)['_getActiveHandles'];
    try {
      delete (process as unknown as Record<string, unknown>)['_getActiveHandles'];
      const observation = observeListeners([loopback]);
      expect(observation.source).toBe('fallback');
      expect(observation.listeners).toEqual([loopback]);
    } finally {
      (process as unknown as Record<string, unknown>)['_getActiveHandles'] = handles;
    }
  });
});

/** Runs the assertion and hands back the error it threw, for message checks. */
function attempt(input: Parameters<typeof assertBindInvariant>[0]): BindInvariantError | undefined {
  try {
    assertBindInvariant(input);
    return undefined;
  } catch (error) {
    expect(error).toBeInstanceOf(BindInvariantError);
    return error as BindInvariantError;
  }
}
