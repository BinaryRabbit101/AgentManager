/**
 * Tailscale interface detection — remote DESIGN §2.1/§2.2, IMPLEMENTATION §2.
 *
 * This file answers one question: **which single address, if any, is this
 * machine's Tailscale address?** It never binds anything. That separation is the
 * point — the address is a *proven* fact produced here, and `listener.ts` may
 * only bind what this file returned.
 *
 * ## The validator is the security control (§2.1)
 *
 * A candidate is accepted only if **all** of these hold:
 *
 * 1. it is IPv4 and inside `100.64.0.0/10` — the CGNAT range Tailscale allocates
 *    node addresses from;
 * 2. it is on a non-internal interface whose adapter name matches
 *    `/tailscale/i`, **or** the Tailscale CLI reported it as
 *    `Self.TailscaleIPs[]`;
 * 3. exactly one candidate survives.
 *
 * Neither of the first two is sufficient alone, and the design says why: "some
 * ISP CPE hands out `100.64.0.0/10` addresses on the LAN, and binding one of
 * those would put the listener on the LAN while passing a naive range check" —
 * while "an adapter can be renamed". Rule 3 is the refusal to guess: "two
 * surviving candidates is a refusal, not a coin toss — a security boundary does
 * not guess."
 *
 * ## Everything is injected
 *
 * `runCli`, `locateCli` and `networkInterfaces` are all deps. The real
 * implementations spawn `tailscale status --json` (directly, never through a
 * shell) and read `os.networkInterfaces()`; every test in `tailscale.test.ts`
 * supplies fixtures instead, because CI has no tailnet and a detection test that
 * depended on the developer's machine would assert nothing. The one test that
 * does touch the real machine is gated on a Tailscale interface actually being
 * present.
 *
 * `locateCli` resolves the executable **from the filesystem** rather than by
 * asking the shell, which is what makes DESIGN's "zero subprocesses are spawned
 * on the interface-fallback path" true rather than approximately true.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { networkInterfaces as osNetworkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { delimiter, join } from 'node:path';

import type { Clock } from '../../storage/index.js';
import { silentLog, type LogFn } from '../../storage/index.js';

// ---------------------------------------------------------------------------
// Address ranges
// ---------------------------------------------------------------------------

/** The CGNAT range Tailscale allocates node addresses from (§2.1 rule 1). */
export const CGNAT_RANGE = '100.64.0.0/10';

/**
 * The tailnet IPv6 ULA prefix.
 *
 * Recorded so an IPv6-only tailnet is **refused loudly** rather than silently
 * mis-bound; v1 binds IPv4 only (§2.2, and §14's deferral).
 */
export const TAILNET_ULA_PREFIX = 'fd7a:115c:a1e0:';

/** §2.1 rule 2's adapter test. */
export const TAILSCALE_ADAPTER_PATTERN = /tailscale/i;

/** The default CLI location on Windows, tried before `PATH` (§2.2). */
export const TAILSCALE_DEFAULT_CLI = 'C:\\Program Files\\Tailscale\\tailscale.exe';

/** `BackendState` values that mean "an address exists and is live" (§2.2). */
export const RUNNING_BACKEND_STATE = 'Running';

/** True for an IPv4 literal inside {@link CGNAT_RANGE}. */
export function isCgnatIPv4(address: string): boolean {
  const octets = address.split('.');
  if (octets.length !== 4) return false;
  const numbers = octets.map((octet) => (/^\d{1,3}$/.test(octet) ? Number(octet) : Number.NaN));
  if (numbers.some((value) => Number.isNaN(value) || value > 255)) return false;
  // 100.64.0.0/10 — the first octet is 100 and the second is 64..127.
  return numbers[0] === 100 && (numbers[1] ?? -1) >= 64 && (numbers[1] ?? -1) <= 127;
}

/** True for an address inside the tailnet ULA prefix. */
export function isTailnetUla(address: string): boolean {
  return address.toLowerCase().startsWith(TAILNET_ULA_PREFIX);
}

// ---------------------------------------------------------------------------
// The result type
// ---------------------------------------------------------------------------

/** Which of §2.2's two paths produced the answer. */
export type DetectionSource = 'cli' | 'interface';

/** A proven address. Only this shape may reach `server.listen()`. */
export interface TailscaleAddress {
  readonly ok: true;
  readonly address: string;
  /** `Self.DNSName` with the trailing dot stripped; `null` on the fallback path. */
  readonly magicDnsName: string | null;
  /** `null` on the fallback path — interface enumeration cannot produce it. */
  readonly backendState: string | null;
  readonly source: DetectionSource;
}

/**
 * Why no address was accepted. Distinct reasons, because they mean different
 * things to the user and the acceptance list names several individually.
 */
export type RefusalReason =
  /** The CLI answered, but `BackendState` is not `Running` (§2.2). */
  | 'backend-not-running'
  /** Nothing that could even be a candidate was found. */
  | 'no-candidate'
  /** A `/tailscale/i` adapter, but its address is outside the CGNAT range. */
  | 'not-in-cgnat-range'
  /** A CGNAT address on an adapter nothing vouches for — the CPE-CGNAT case. */
  | 'unverified-adapter'
  /** Two candidates survived validation. Never a coin toss (§2.1 rule 3). */
  | 'ambiguous-interface'
  /** A tailnet address exists, but only as IPv6. Out of scope for v1 (§2.2). */
  | 'ipv6-only';

export interface TailscaleRefusal {
  readonly ok: false;
  readonly reason: RefusalReason;
  /** One line for `/api/health` and the local UI (§2.3). */
  readonly message: string;
  /** The `BackendState` string when the CLI answered, else `null`. */
  readonly backendState: string | null;
  /** Which path reached the refusal; `none` when neither produced candidates. */
  readonly source: DetectionSource | 'none';
}

export type Detection = TailscaleAddress | TailscaleRefusal;

// ---------------------------------------------------------------------------
// Candidates and the validator
// ---------------------------------------------------------------------------

/** One address, with the provenance §2.1 rule 2 needs in order to trust it. */
export interface AddressCandidate {
  readonly address: string;
  readonly family: 'IPv4' | 'IPv6';
  readonly internal: boolean;
  /** The adapter name, when the candidate came from interface enumeration. */
  readonly adapter: string | null;
  /** True when `tailscale status --json` listed it in `Self.TailscaleIPs[]`. */
  readonly cliReported: boolean;
}

function vouchedFor(candidate: AddressCandidate): boolean {
  return (
    candidate.cliReported ||
    (candidate.adapter !== null && TAILSCALE_ADAPTER_PATTERN.test(candidate.adapter))
  );
}

function describe(candidate: AddressCandidate): string {
  return candidate.adapter === null
    ? candidate.address
    : `${candidate.address} (adapter "${candidate.adapter}")`;
}

/**
 * §2.1's three rules, applied to a candidate list.
 *
 * Pure, and deliberately the only place any of the three rules is expressed —
 * both detection paths funnel through it, so the CLI path cannot accidentally be
 * more trusting than the fallback.
 */
export function validateCandidates(
  candidates: readonly AddressCandidate[],
  context: { readonly source: DetectionSource; readonly backendState: string | null },
): Detection {
  const external = candidates.filter((candidate) => !candidate.internal);
  const accepted: AddressCandidate[] = [];
  const seen = new Set<string>();
  for (const candidate of external) {
    if (candidate.family !== 'IPv4') continue;
    if (!isCgnatIPv4(candidate.address)) continue;
    if (!vouchedFor(candidate)) continue;
    if (seen.has(candidate.address)) continue;
    seen.add(candidate.address);
    accepted.push(candidate);
  }

  const refusal = (reason: RefusalReason, message: string): TailscaleRefusal => ({
    ok: false,
    reason,
    message,
    backendState: context.backendState,
    source: candidates.length === 0 ? 'none' : context.source,
  });

  if (accepted.length > 1) {
    return refusal(
      'ambiguous-interface',
      `Ambiguous Tailscale interface: ${String(accepted.length)} addresses passed validation ` +
        `(${accepted.map(describe).join(', ')}). Refusing to bind rather than choosing one — a ` +
        'security boundary does not guess which interface leaves this machine (remote DESIGN §2.1).',
    );
  }

  if (accepted.length === 1) {
    const chosen = accepted[0] as AddressCandidate;
    return {
      ok: true,
      address: chosen.address,
      magicDnsName: null,
      backendState: context.backendState,
      source: context.source,
    };
  }

  // Nothing was accepted. Report the *most specific* thing that was wrong, so
  // the user is told which of the three rules their setup failed.
  const ulaOnly = external.some((candidate) => isTailnetUla(candidate.address));
  if (ulaOnly) {
    return refusal(
      'ipv6-only',
      'This tailnet offers only an IPv6 address (the tailnet ULA prefix ' +
        `${TAILNET_ULA_PREFIX.slice(0, -1)}::/48). v1 binds IPv4 only, so the listener is ` +
        'refusing to bind rather than binding something unexpected (remote DESIGN §2.2).',
    );
  }

  const tailscaleAdapterOutOfRange = external.find(
    (candidate) => vouchedFor(candidate) && !isCgnatIPv4(candidate.address),
  );
  if (tailscaleAdapterOutOfRange !== undefined) {
    return refusal(
      'not-in-cgnat-range',
      `${describe(tailscaleAdapterOutOfRange)} is vouched for as a Tailscale address but is ` +
        `outside ${CGNAT_RANGE}, the range Tailscale allocates node addresses from. Refusing to ` +
        'bind it (remote DESIGN §2.1 rule 1).',
    );
  }

  const unvouchedCgnat = external.find(
    (candidate) =>
      candidate.family === 'IPv4' && isCgnatIPv4(candidate.address) && !vouchedFor(candidate),
  );
  if (unvouchedCgnat !== undefined) {
    return refusal(
      'unverified-adapter',
      `${describe(unvouchedCgnat)} is inside ${CGNAT_RANGE}, but nothing vouches for it as a ` +
        'Tailscale address: the adapter name does not match /tailscale/i and the Tailscale CLI ' +
        'did not report it. Some ISP equipment hands out addresses from this range on the LAN, ' +
        'and binding one would put the listener on the LAN. Refusing (remote DESIGN §2.1 rule 2).',
    );
  }

  return refusal(
    'no-candidate',
    'No Tailscale address was found on this machine: no adapter matching /tailscale/i holds an ' +
      `address inside ${CGNAT_RANGE}, and the Tailscale CLI reported none. Remote access is ` +
      'unavailable until Tailscale is running (remote DESIGN §2.3).',
  );
}

// ---------------------------------------------------------------------------
// The CLI path (§2.2, primary)
// ---------------------------------------------------------------------------

/** How `tailscale status --json` ended. */
export type CliOutcome =
  | { readonly kind: 'ok'; readonly stdout: string }
  /** No executable was found; nothing was spawned. */
  | { readonly kind: 'missing' }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'failed'; readonly message: string };

/** The four fields §2.2 reads, and nothing else. */
export interface TailscaleStatus {
  readonly backendState: string | null;
  readonly addresses: readonly string[];
  readonly magicDnsName: string | null;
  readonly peers: ReadonlyMap<string, string>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asStringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

/** MagicDNS names arrive fully qualified with a trailing dot (§2.2). */
export function stripTrailingDot(name: string): string {
  return name.endsWith('.') ? name.slice(0, -1) : name;
}

/**
 * Parses `tailscale status --json` down to the four fields §2.2 names.
 *
 * Returns `undefined` for unparseable output, which the caller treats exactly
 * like a missing CLI: fall back to interface enumeration (§2.2).
 */
export function parseTailscaleStatus(stdout: string): TailscaleStatus | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  const root = asRecord(parsed);
  if (root === undefined) return undefined;

  const backendState = typeof root['BackendState'] === 'string' ? root['BackendState'] : null;
  const self = asRecord(root['Self']);
  const dnsName = self === undefined ? undefined : self['DNSName'];
  const magicDnsName =
    typeof dnsName === 'string' && dnsName.length > 0 ? stripTrailingDot(dnsName) : null;

  const peers = new Map<string, string>();
  const peerTable = asRecord(root['Peer']);
  for (const entry of Object.values(peerTable ?? {})) {
    const peer = asRecord(entry);
    if (peer === undefined) continue;
    const hostName = peer['HostName'];
    if (typeof hostName !== 'string' || hostName.length === 0) continue;
    for (const address of asStringArray(peer['TailscaleIPs'])) peers.set(address, hostName);
  }

  return {
    backendState,
    addresses: self === undefined ? [] : asStringArray(self['TailscaleIPs']),
    magicDnsName,
    peers,
  };
}

/**
 * §2.2's search order: `remote.detect.cli`, then the default install path, then
 * `PATH`.
 *
 * The `PATH` walk is `existsSync` over the entries rather than `where.exe`,
 * because a subprocess spent looking for a subprocess would break the
 * fallback path's "zero subprocesses" guarantee.
 */
export function locateTailscaleCli(
  configured: string | null,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (configured !== null && configured.length > 0) {
    return existsSync(configured) ? configured : undefined;
  }
  if (existsSync(TAILSCALE_DEFAULT_CLI)) return TAILSCALE_DEFAULT_CLI;

  const names = process.platform === 'win32' ? ['tailscale.exe'] : ['tailscale'];
  for (const entry of (env['PATH'] ?? '').split(delimiter)) {
    if (entry.length === 0) continue;
    for (const name of names) {
      const candidate = join(entry, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * Spawns `tailscale status --json` directly — `shell: false`, argv array, no
 * string interpolation — and kills it at `timeoutMs`.
 */
export function runTailscaleCli(executable: string, timeoutMs: number): Promise<CliOutcome> {
  return new Promise<CliOutcome>((resolve) => {
    let settled = false;
    const finish = (outcome: CliOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };

    const child = spawn(executable, ['status', '--json'], {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      child.kill();
      finish({ kind: 'timeout' });
    }, timeoutMs);
    timer.unref?.();

    let stdout = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => void (stdout += chunk));
    child.on('error', (error: Error) => finish({ kind: 'failed', message: error.message }));
    child.on('close', (code) =>
      finish(
        code === 0
          ? { kind: 'ok', stdout }
          : { kind: 'failed', message: `exited with code ${String(code)}` },
      ),
    );
  });
}

// ---------------------------------------------------------------------------
// The detector
// ---------------------------------------------------------------------------

export interface TailscaleDetectorDeps {
  /** `remote.detect.cli`. */
  readonly cliPath?: string | null;
  /** Resolves the executable. Defaults to {@link locateTailscaleCli}. */
  readonly locateCli?: (configured: string | null) => string | undefined;
  /** Runs it. Defaults to {@link runTailscaleCli}. */
  readonly runCli?: (executable: string, timeoutMs: number) => Promise<CliOutcome>;
  /** Defaults to `os.networkInterfaces()`. */
  readonly networkInterfaces?: () => NodeJS.Dict<NetworkInterfaceInfo[]>;
  /** §2.2's 5 s CLI budget. */
  readonly timeoutMs?: number;
  /** §9.3's peer-map TTL. */
  readonly peerTtlMs?: number;
  readonly clock?: Clock;
  readonly log?: LogFn;
}

export interface TailscaleDetector {
  /** Runs §2.2's CLI-primary, interface-fallback detection. */
  detect(): Promise<Detection>;
  /**
   * §9.3's audit enrichment: the tailnet node name for a peer address, from the
   * cached CLI peer map. **Never** an authentication or authorization input —
   * a stale or absent map answers `null` and the request proceeds.
   */
  peerName(address: string): string | null;
  /** Diagnostics: how many peers the cache currently holds. */
  peerCount(): number;
}

/** §2.2's 5 s budget, and §9.3's 60 s peer-map TTL. */
export const CLI_TIMEOUT_MS = 5_000;
export const PEER_MAP_TTL_MS = 60_000;

export function createTailscaleDetector(deps: TailscaleDetectorDeps = {}): TailscaleDetector {
  const cliPath = deps.cliPath ?? null;
  const locate = deps.locateCli ?? ((configured: string | null) => locateTailscaleCli(configured));
  const run = deps.runCli ?? runTailscaleCli;
  const interfaces = deps.networkInterfaces ?? osNetworkInterfaces;
  const timeoutMs = deps.timeoutMs ?? CLI_TIMEOUT_MS;
  const peerTtlMs = deps.peerTtlMs ?? PEER_MAP_TTL_MS;
  const clock = deps.clock ?? ((): Date => new Date());
  const log = deps.log ?? silentLog;

  let peers: ReadonlyMap<string, string> = new Map();
  let peersAt = 0;

  /** §2.2's fallback. Never spawns anything. */
  const fromInterfaces = (): Detection => {
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
    return validateCandidates(candidates, { source: 'interface', backendState: null });
  };

  /**
   * Falls back with a `warn`, because §2.2 is explicit that this path "works, but
   * it is the degraded path" — and a degraded security-relevant path that logs at
   * `info` is a degraded path nobody notices.
   */
  const fallback = (why: string): Detection => {
    const detection = fromInterfaces();
    log('warn', `Tailscale CLI unavailable (${why}); using interface enumeration instead`, {
      source: 'interface',
      why,
      ...(detection.ok
        ? { address: detection.address, tailscaleState: 'unknown (interface-derived)' }
        : { reason: detection.reason }),
    });
    return detection;
  };

  return {
    detect: async (): Promise<Detection> => {
      const executable = locate(cliPath);
      if (executable === undefined) return fallback('no executable found');

      const outcome = await run(executable, timeoutMs);
      if (outcome.kind === 'missing') return fallback('no executable found');
      if (outcome.kind === 'timeout') return fallback(`no answer within ${String(timeoutMs)} ms`);
      if (outcome.kind === 'failed') return fallback(outcome.message);

      const status = parseTailscaleStatus(outcome.stdout);
      if (status === undefined) return fallback('unparseable JSON output');

      peers = status.peers;
      peersAt = clock().getTime();

      if (status.backendState !== RUNNING_BACKEND_STATE) {
        const state = status.backendState ?? 'unknown';
        return {
          ok: false,
          reason: 'backend-not-running',
          message:
            `Tailscale is not running: BackendState is "${state}". Remote access is unavailable ` +
            'until it reports "Running" (remote DESIGN §2.2).',
          backendState: status.backendState,
          source: 'cli',
        };
      }

      const detection = validateCandidates(
        status.addresses.map((address) => ({
          address,
          family: address.includes(':') ? ('IPv6' as const) : ('IPv4' as const),
          internal: false,
          adapter: null,
          cliReported: true,
        })),
        { source: 'cli', backendState: status.backendState },
      );

      // The MagicDNS name is the one thing only this path can produce, and the
      // browser client needs it (§2.2).
      return detection.ok ? { ...detection, magicDnsName: status.magicDnsName } : detection;
    },

    peerName: (address) => {
      if (clock().getTime() - peersAt > peerTtlMs) return null;
      return peers.get(address) ?? null;
    },

    peerCount: () => (clock().getTime() - peersAt > peerTtlMs ? 0 : peers.size),
  };
}
