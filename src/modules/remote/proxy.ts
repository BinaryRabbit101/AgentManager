/**
 * Proxy-mode address proving — architecture **D5 as amended 2026-08-17**, and the
 * amendment banner at the top of remote DESIGN.md.
 *
 * > "Tailscale only ever lives on the household's proxy host (the mini-pc), never
 * > on the core's machine. The remote listener therefore supports two bind modes
 * > […] **`proxy`** — bind a single configured LAN address and accept TCP
 * > connections **only from the declared proxy peer's IP** (the mini-pc, whose
 * > nginx + `tailscale serve` provide tailnet-only exposure and TLS). In proxy
 * > mode the tailnet-membership gate moves to the proxy host; the listener's
 * > peer-IP allowlist plus the bearer token are the core's own controls."
 *
 * ## What this file proves, and what it deliberately does not
 *
 * It is the exact counterpart of `tailscale.ts`: it answers **one** question —
 * *is the declared `remote.proxy.bind` an address this machine really holds on a
 * usable interface right now?* — and it never binds anything. `listener.ts` may
 * only bind what a prover returned, which is why proxy mode reuses the same
 * `Detection` result type and the same two-independent-detections discipline
 * rather than growing a second, shorter path to `listen()`.
 *
 * Three refusals, and each is a case that would otherwise be silent:
 *
 * 1. **The address is not on any interface.** A machine whose DHCP lease moved,
 *    or a `config.json` copied from another host, would otherwise fail with a raw
 *    `EADDRNOTAVAIL` five times and reach `down` with no explanation. Worse, if
 *    the address later reappeared **on a different network**, an unproven bind
 *    would be a socket on an interface the owner never named.
 * 2. **The address is loopback or a wildcard.** The schema already refuses both,
 *    so reaching them here means a subverted config path or a test harness — the
 *    same reason `assertBindable` exists in tailscale mode.
 * 3. **The address is on an `internal` interface.** Node marks loopback and
 *    host-only adapters internal; a "LAN" address on one of those is not the LAN.
 *
 * What it does **not** prove is tailnet membership, and that is the amendment's
 * whole point: in this mode that gate is the proxy host's (`tailscale serve` in
 * front of nginx). This file's contribution to the boundary is that the socket
 * exists on one named interface; the peer allowlist in `middleware.ts` and the
 * bearer token in `tokens.ts` are the core's own two controls.
 *
 * ## Everything is injected
 *
 * `networkInterfaces` is a dep, exactly as it is for the Tailscale detector, so
 * the acceptance tests drive a fake LAN address that is present, absent, internal
 * or duplicated instead of depending on whatever adapters CI happens to have.
 */
import { networkInterfaces as osNetworkInterfaces, type NetworkInterfaceInfo } from 'node:os';

import { silentLog, type LogFn } from '../../storage/index.js';

import type { AddressCandidate, Detection } from './tailscale.js';

/**
 * What `remote.status.tailscaleState` reports in proxy mode.
 *
 * Named rather than left `null`, because `null` already means "the CLI did not
 * answer" in tailscale mode and a status field that means two different things
 * is a status field nobody can act on.
 */
export const PROXY_BACKEND_STATE = 'not applicable (proxy mode)';

export interface ProxyProverDeps {
  /** `remote.proxy.bind` — the one address this mode may ever bind. */
  readonly bind: string;
  /** Defaults to `os.networkInterfaces()`. */
  readonly networkInterfaces?: () => NodeJS.Dict<NetworkInterfaceInfo[]>;
  readonly log?: LogFn;
}

/**
 * The prover interface `listener.ts` consumes.
 *
 * Structurally identical to `TailscaleDetector`, which is the point: the state
 * machine, the two independent detections, the fail-closed poll and the
 * `assertBindable` gate are one code path for both modes, so proxy mode cannot
 * accidentally be the more trusting of the two.
 */
export interface AddressProver {
  detect(): Promise<Detection>;
  /** §9.3's audit enrichment. Always `null` here: there is no tailnet peer map. */
  peerName(address: string): string | null;
  peerCount(): number;
}

/** True for `0.0.0.0` and the other spellings of "every interface". */
function isWildcard(value: string): boolean {
  return value === '0.0.0.0' || value === '::' || value === '*';
}

/** True for a loopback literal. */
function isLoopback(value: string): boolean {
  return value === '::1' || value === 'localhost' || value.startsWith('127.');
}

/** Every address this machine currently holds, as candidates. */
export function enumerateLocalAddresses(
  interfaces: () => NodeJS.Dict<NetworkInterfaceInfo[]>,
): readonly AddressCandidate[] {
  const candidates: AddressCandidate[] = [];
  for (const [adapter, addresses] of Object.entries(interfaces())) {
    for (const info of addresses ?? []) {
      candidates.push({
        address: info.address,
        family: info.family === 'IPv4' ? 'IPv4' : 'IPv6',
        internal: info.internal,
        adapter,
        cliReported: false,
      });
    }
  }
  return candidates;
}

/**
 * Proves a declared proxy-mode bind address against the machine's interfaces.
 *
 * Pure, and the only place any of the three rules above is expressed, so a
 * caller cannot reach a bind by a route that skips one.
 */
export function validateProxyBind(
  declared: string,
  candidates: readonly AddressCandidate[],
): Detection {
  const value = declared.trim().toLowerCase();

  if (value.length === 0) {
    return {
      ok: false,
      reason: 'proxy-address-invalid',
      message:
        'remote.proxy.bind is empty, so proxy mode has no address to bind. Set it to the LAN ' +
        'address of this machine that the proxy host connects to (architecture D5, amended ' +
        '2026-08-17).',
      backendState: PROXY_BACKEND_STATE,
      source: 'proxy',
    };
  }

  if (isWildcard(value)) {
    return {
      ok: false,
      reason: 'proxy-address-invalid',
      message:
        `remote.proxy.bind is "${declared}", a wildcard that would expose every interface this ` +
        'machine has. Proxy mode binds exactly one named LAN interface (architecture D5).',
      backendState: PROXY_BACKEND_STATE,
      source: 'proxy',
    };
  }

  if (isLoopback(value)) {
    return {
      ok: false,
      reason: 'proxy-address-invalid',
      message:
        `remote.proxy.bind is "${declared}", a loopback address the proxy host can never reach. ` +
        'Proxy mode binds a LAN address (architecture D5, amended 2026-08-17).',
      backendState: PROXY_BACKEND_STATE,
      source: 'proxy',
    };
  }

  if (value.includes(':')) {
    return {
      ok: false,
      reason: 'proxy-address-invalid',
      message:
        `remote.proxy.bind is "${declared}", which is IPv6. v1 binds IPv4 only (remote DESIGN ` +
        '§2.2 — the same deferral as the tailnet ULA).',
      backendState: PROXY_BACKEND_STATE,
      source: 'proxy',
    };
  }

  const held = candidates.filter(
    (candidate) => candidate.family === 'IPv4' && candidate.address.toLowerCase() === value,
  );
  const usable = held.filter((candidate) => !candidate.internal);

  if (usable.length === 0) {
    return {
      ok: false,
      reason: held.length === 0 ? 'proxy-address-absent' : 'proxy-address-internal',
      message:
        held.length === 0
          ? `remote.proxy.bind is "${declared}", but no interface on this machine holds that ` +
            'address right now. Refusing to bind an address this host does not own: an address ' +
            'that later reappears on a different network would be a socket on an interface ' +
            'nobody named (architecture D5, amended 2026-08-17).'
          : `remote.proxy.bind is "${declared}", but the only interface holding it ` +
            `(${held.map((candidate) => `"${candidate.adapter ?? '?'}"`).join(', ')}) is an ` +
            'internal one, which is not the LAN. Refusing to bind it (architecture D5).',
      backendState: PROXY_BACKEND_STATE,
      source: 'proxy',
    };
  }

  return {
    ok: true,
    address: usable[0]?.address ?? declared,
    // Only the Tailscale CLI can produce a MagicDNS name; in proxy mode the
    // tailnet name belongs to the proxy host, and `remote.hostnameHint` is how
    // the owner tells the client about it (§9.2 #8's allowlist reads it).
    magicDnsName: null,
    backendState: PROXY_BACKEND_STATE,
    source: 'proxy',
  };
}

/**
 * The proxy-mode prover.
 *
 * `detect()` re-enumerates the machine's interfaces on **every** call, which is
 * what makes `listener.ts`'s two independent detections meaningful here: the
 * second one runs immediately before `listen()` and can disagree with the first.
 */
export function createProxyProver(deps: ProxyProverDeps): AddressProver {
  const interfaces = deps.networkInterfaces ?? osNetworkInterfaces;
  const log = deps.log ?? silentLog;

  return {
    detect: (): Promise<Detection> => {
      const detection = validateProxyBind(deps.bind, enumerateLocalAddresses(interfaces));
      if (!detection.ok) {
        log('warn', detection.message, { source: 'proxy', reason: detection.reason });
      }
      return Promise.resolve(detection);
    },

    // §9.3's enrichment is a Tailscale peer map, and there is none here. `null`
    // is the same answer a stale map gives, and it is never an authorisation
    // input in either mode.
    peerName: () => null,
    peerCount: () => 0,
  };
}
