/**
 * The client URL and the `Host` allowlist — remote DESIGN §4.2 and §9.2 #8.
 *
 * Both are built from the same pair of declarations, and the case that motivates
 * the pair is proxy mode: the phone's front door is a scheme and a port this
 * process never learns, so a URL assembled from the socket it happens to hold is
 * a QR code that leads to a closed port. That was a real failure — a phone
 * scanned `http://minipc.<tailnet>:7478` while the reachable door was
 * `https://minipc.<tailnet>:455` — so it is tested from both ends here.
 */
import { describe, expect, it } from 'vitest';

import type { RemoteStatus } from './listener.js';
import { allowedHosts, clientUrl, type RemoteClientHints } from './routes.js';

const FRONT_DOOR = 'https://minipc.example-tailnet.ts.net:455';

function status(overrides: Partial<RemoteStatus> = {}): RemoteStatus {
  return {
    state: 'listening',
    enabled: true,
    boundAddress: { address: '192.168.0.197', port: 7478, source: 'proxy' },
    port: 7478,
    magicDnsName: null,
    tailscaleState: 'not applicable (proxy mode)',
    lastError: null,
    recentBindFailures: 0,
    detectionSource: 'proxy',
    mode: 'proxy',
    ...overrides,
  };
}

const NO_HINTS: RemoteClientHints = { publicUrl: null, hostnameHint: null };

describe('clientUrl — the origin a phone opens (§4.2)', () => {
  it('uses the MagicDNS name and this socket’s port when the phone reaches it directly', () => {
    const tailscale = status({
      boundAddress: { address: '100.101.102.103', port: 7478, source: 'cli' },
      magicDnsName: 'workstation.example-tailnet.ts.net',
      mode: 'tailscale',
      detectionSource: 'cli',
    });

    expect(clientUrl(tailscale, NO_HINTS)).toBe('http://workstation.example-tailnet.ts.net:7478');
  });

  it('falls back to the hostnameHint, then to the bound address', () => {
    expect(clientUrl(status(), { publicUrl: null, hostnameHint: 'minipc' })).toBe(
      'http://minipc:7478',
    );
    expect(clientUrl(status(), NO_HINTS)).toBe('http://192.168.0.197:7478');
  });

  it('returns the declared front door whole — scheme and port included', () => {
    // The bug this key exists for: hostnameHint alone swaps the *name* and keeps
    // this process’s scheme and port, which in proxy mode are both wrong.
    const hints: RemoteClientHints = {
      publicUrl: FRONT_DOOR,
      hostnameHint: 'minipc.example-tailnet.ts.net',
    };

    expect(clientUrl(status(), hints)).toBe(FRONT_DOOR);
    expect(
      clientUrl(status(), { publicUrl: null, hostnameHint: 'minipc.example-tailnet.ts.net' }),
    ).toBe('http://minipc.example-tailnet.ts.net:7478');
  });

  it('outranks a MagicDNS name too — a fronted tailscale-mode install is still fronted', () => {
    const detected = status({ magicDnsName: 'workstation.example-tailnet.ts.net' });

    expect(clientUrl(detected, { publicUrl: FRONT_DOOR, hostnameHint: null })).toBe(FRONT_DOOR);
  });

  it('is null while nothing is bound, front door or not', () => {
    // The proxy is up, but everything behind it is this listener.
    const idle = status({ state: 'waiting', boundAddress: null });

    expect(clientUrl(idle, { publicUrl: FRONT_DOOR, hostnameHint: 'minipc' })).toBeNull();
    expect(clientUrl(idle, NO_HINTS)).toBeNull();
  });

  it('ignores a publicUrl the schema would have refused rather than emitting a broken URL', () => {
    // Unreachable through the loader, which refuses it (`config.test.ts`); this is
    // the belt to that braces, because the value is what a QR encodes.
    expect(clientUrl(status(), { publicUrl: 'minipc:455', hostnameHint: 'minipc' })).toBe(
      'http://minipc:7478',
    );
  });
});

describe('allowedHosts — every name this listener answers to (§9.2 #8)', () => {
  it('carries the bound address, the MagicDNS name and both declarations', () => {
    const detected = status({ magicDnsName: 'workstation.example-tailnet.ts.net' });

    expect(allowedHosts(detected, { publicUrl: FRONT_DOOR, hostnameHint: 'minipc' })).toEqual([
      '192.168.0.197',
      'workstation.example-tailnet.ts.net',
      'minipc',
      // The port is dropped here: the guard compares host parts (§9.2 #8).
      'minipc.example-tailnet.ts.net',
    ]);
  });

  it('admits the front door’s host, so a proxy that preserves Host is not answered with 421', () => {
    expect(allowedHosts(status(), { publicUrl: FRONT_DOOR, hostnameHint: null })).toContain(
      'minipc.example-tailnet.ts.net',
    );
  });

  it('drops what is absent rather than emitting an empty entry', () => {
    expect(allowedHosts(status({ boundAddress: null }), NO_HINTS)).toEqual([]);
  });
});
