/**
 * Remote parity, as rules (DESIGN §13.4; IMPLEMENTATION §10).
 *
 * The behaviours these encode are the ones a screen test can only show one
 * instance of: that the denied set is *read* rather than hardcoded, that a
 * denial added server-side greys the right control with no code change, and
 * that every reason shown to the user is the server's own sentence.
 */

import { describe, expect, it } from 'vitest';

import type { RemoteStatus, RemoteTokenView } from '../api/types';

import {
  CAPACITY_RAISE_REASON,
  canRaiseCapacity,
  controlState,
  daysUntil,
  denialFor,
  grantExpiryLabel,
  isRemoteClient,
  listenerLine,
  tokenExpiryWarning,
} from './access';

const NOW = Date.parse('2026-08-17T12:00:00.000Z');

function aStatus(overrides: Partial<RemoteStatus> = {}): RemoteStatus {
  return {
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
    activeTokenCount: 2,
    deniedRemotely: [
      {
        method: 'POST',
        path: '/api/remote/tokens',
        source: 'declared',
        reason: 'Registered `remote: "deny"` by the "remote" module.',
        conditional: false,
      },
      {
        method: 'POST',
        path: '/api/remote/restart',
        source: 'declared',
        reason: 'Restarting the listener would cut the connection making the request.',
        conditional: false,
      },
      {
        method: 'PUT',
        path: '/api/remote/enabled',
        source: 'backstop',
        reason: 'Remote access can be switched off from anywhere, but only on at the machine.',
        conditional: true,
      },
    ],
    backstopPatterns: [
      { methods: ['POST'], pattern: '/api/service/shutdown' },
      { methods: ['POST', 'PUT', 'PATCH', 'DELETE'], pattern: '/api/secrets/**' },
    ],
    ...overrides,
  };
}

function aToken(overrides: Partial<RemoteTokenView> = {}): RemoteTokenView {
  return {
    id: 'tok_1',
    label: 'Pixel',
    device: null,
    prefix: 'abc123',
    createdAt: '2026-05-01T00:00:00.000Z',
    lastUsedAt: null,
    lastUsedPeer: null,
    expiresAt: null,
    revokedAt: null,
    expired: false,
    ...overrides,
  };
}

describe('what "remote" means to the client (§3.1)', () => {
  it('is exactly "a bearer is held" — there is no second signal', () => {
    expect(isRemoteClient({ token: null })).toBe(false);
    expect(isRemoteClient({ token: '' })).toBe(false);
    expect(isRemoteClient({ token: 'abc' })).toBe(true);
  });
});

describe('the denied set is read from the server, never hardcoded (§13.4)', () => {
  it('finds the declared denials by method and path', () => {
    expect(denialFor(aStatus(), { method: 'POST', path: '/api/remote/tokens' })?.source).toBe(
      'declared',
    );
    expect(denialFor(aStatus(), { method: 'GET', path: '/api/remote/tokens' })).toBeUndefined();
  });

  it('finds the backstop patterns, including the wildcard ones', () => {
    expect(denialFor(aStatus(), { method: 'POST', path: '/api/service/shutdown' })?.source).toBe(
      'backstop',
    );
    expect(
      denialFor(aStatus(), { method: 'DELETE', path: '/api/secrets/notify.ntfy' })?.source,
    ).toBe('backstop');
    expect(
      denialFor(aStatus(), { method: 'GET', path: '/api/secrets/notify.ntfy' }),
    ).toBeUndefined();
  });

  it('greys a *newly* denied control with no change here (§12.7)', () => {
    // A denial the server adds later is a row in the same list, so the control
    // that names that route becomes disabled by itself.
    const future = aStatus({
      deniedRemotely: [
        ...aStatus().deniedRemotely,
        {
          method: 'PUT',
          path: '/api/runner/capacity',
          source: 'declared',
          reason: 'A remote client may not change the cap at all any more.',
          conditional: false,
        },
      ],
    });
    const state = controlState(future, true, { method: 'PUT', path: '/api/runner/capacity' });
    expect(state.disabled).toBe(true);
    expect(state.reason).toBe('A remote client may not change the cap at all any more.');
  });

  it('disables nothing locally, because the deny list is a property of the transport', () => {
    expect(controlState(aStatus(), false, { method: 'POST', path: '/api/remote/tokens' })).toEqual({
      disabled: false,
      reason: undefined,
    });
  });

  it('carries the server’s own sentence, so the user never meets a raw 403', () => {
    const state = controlState(aStatus(), true, { method: 'POST', path: '/api/remote/restart' });
    expect(state.disabled).toBe(true);
    expect(state.reason).toContain('cut the connection');
  });
});

describe('the capacity rule runner leaves to the client (§12, runner §15.3 #17)', () => {
  it('lets a local client raise and a remote one only lower, with the reason', () => {
    expect(canRaiseCapacity(false)).toBe(true);
    expect(canRaiseCapacity(true)).toBe(false);
    expect(CAPACITY_RAISE_REASON).toContain('lower the cap but not raise it');
  });
});

describe('token expiry (remote §4.4, §3.2 step 4)', () => {
  it('raises the banner at fourteen days and not before', () => {
    const inFifteen = new Date(NOW + 15 * 86_400_000).toISOString();
    const inTen = new Date(NOW + 10 * 86_400_000).toISOString();
    expect(tokenExpiryWarning([aToken({ expiresAt: inFifteen })], NOW)).toBeUndefined();
    expect(tokenExpiryWarning([aToken({ expiresAt: inTen })], NOW)?.days).toBe(10);
    expect(tokenExpiryWarning([aToken({ expiresAt: inTen })], NOW)?.label).toContain('10 days');
  });

  it('ignores revoked and already-expired rows, and takes the soonest live one', () => {
    const soon = new Date(NOW + 2 * 86_400_000).toISOString();
    const later = new Date(NOW + 9 * 86_400_000).toISOString();
    const warning = tokenExpiryWarning(
      [
        aToken({ id: 'a', label: 'Old', expiresAt: soon, revokedAt: '2026-08-01T00:00:00.000Z' }),
        aToken({ id: 'b', label: 'Tablet', expiresAt: later }),
      ],
      NOW,
    );
    expect(warning?.label).toContain('Tablet');
  });

  it('says so plainly once it has expired', () => {
    const past = new Date(NOW - 86_400_000).toISOString();
    expect(tokenExpiryWarning([aToken({ expiresAt: past })], NOW)?.label).toContain('has expired');
  });

  it('never warns about a token that does not expire', () => {
    expect(tokenExpiryWarning([aToken({ expiresAt: null })], NOW)).toBeUndefined();
    expect(daysUntil(null, NOW)).toBeUndefined();
  });
});

describe('grant expiry is always shown (§13.2)', () => {
  it('reads in days, in hours on the last day, and says expired after', () => {
    expect(grantExpiryLabel({ expiresAt: new Date(NOW + 3 * 86_400_000).toISOString() }, NOW)).toBe(
      'expires in 3 days',
    );
    expect(grantExpiryLabel({ expiresAt: new Date(NOW + 5 * 3_600_000).toISOString() }, NOW)).toBe(
      'expires in 5h',
    );
    expect(grantExpiryLabel({ expiresAt: new Date(NOW - 1).toISOString() }, NOW)).toBe('expired');
  });
});

describe('the listener line (§13.2)', () => {
  it('renders Tailscale’s own state string in the waiting case', () => {
    expect(listenerLine(aStatus({ state: 'waiting', tailscaleState: 'NeedsLogin' }))).toBe(
      'Remote access unavailable — Tailscale is NeedsLogin.',
    );
  });

  it('names the address and the MagicDNS name when it is up', () => {
    expect(listenerLine(aStatus())).toContain('100.64.0.7:7478');
    expect(listenerLine(aStatus())).toContain('workstation.example-tailnet.ts.net');
  });

  it('carries the last error when it is down', () => {
    expect(listenerLine(aStatus({ state: 'down', lastError: 'EADDRINUSE' }))).toContain(
      'EADDRINUSE',
    );
  });
});
