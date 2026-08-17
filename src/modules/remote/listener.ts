/**
 * The remote listener's lifecycle — remote DESIGN §2.3, IMPLEMENTATION §3.
 *
 * ```
 *              detect ok                bind ok
 *   waiting ─────────────────► binding ─────────────► listening
 *      ▲                          │                       │
 *      │  backoff retry           │ bind error            │ address gone / adapter down
 *      └──────────────────────────┴───────────────────────┘
 *                                         │  5 rapid failures
 *                                         ▼
 *                                       down (explicit restart required)
 * ```
 *
 * ## The four properties this file exists to guarantee
 *
 * 1. **Only a proven address is ever bound.** `detector.detect()` produces the
 *    address; {@link assertBindable} re-checks the *literal* immediately before
 *    `listen()`; and the whole detection is re-run once more between the decision
 *    and the bind, so a candidate that stopped being valid in the intervening
 *    milliseconds is never bound. That is DESIGN §9.1 #2's "two independent checks
 *    on the same fact, deliberately" — remote's own re-validation, plus
 *    foundation's post-start assertion reading {@link RemoteListener.boundAddress}.
 * 2. **`waiting` means no socket exists.** Not a socket bound to something
 *    harmless — none. Everything in this file that leaves `listening` closes the
 *    server first and only then changes state.
 * 3. **Fail closed on change.** An address that disappears or changes closes the
 *    socket *immediately and unconditionally*: "an adapter that went away must
 *    never leave a socket that a re-appearing interface with a different owner
 *    could inherit" (§2.3).
 * 4. **Retrying forever is not resilience.** Five bind failures in ten minutes
 *    reaches `down` and stops, because "endless retry against a permanently
 *    occupied port is log spam pretending to be resilience" (§2.3).
 *
 * ## One state machine, both of D5's bind modes
 *
 * D5 as amended (2026-08-17) has two modes, and this file runs **one** traversal
 * for both: the prover is injected ({@link AddressProver} — `tailscale.ts` in
 * tailscale mode, `proxy.ts` in proxy mode) and produces the same `Detection`, so
 * proxy mode inherits the two independent proofs, the fail-closed poll and the
 * `down` ceiling rather than getting a shorter route to `listen()`. The only two
 * facts {@link RemoteListenerDeps.mode} changes are which address literals
 * {@link assertBindable} accepts, and the `source` string on the published claim.
 *
 * ## Nothing here is time-dependent
 *
 * Timers and jitter are injected ({@link RemoteTimers}, `random`), and every
 * clock reading goes through `ctx.clock`, so the backoff, the poll and the
 * five-failures-in-ten-minutes window are all driven deterministically by tests
 * rather than waited out. The real timers are `unref`ed: a module in `waiting`
 * must not be the reason a process stays alive.
 */
import type { Logger } from 'pino';

import type { BoundAddress } from '../../lifecycle/bind.js';
import type { Middleware } from '../../http/types.js';
import type { Clock } from '../../storage/index.js';

import { REMOTE_BIND_LITERAL, REMOTE_BIND_PROXY, type RemoteBindMode } from './config.js';
import type { HttpListener, ListenerOptions } from './ports.js';
import type { AddressProver } from './proxy.js';
import { CGNAT_RANGE, isCgnatIPv4, type Detection, type DetectionSource } from './tailscale.js';

/** §2.3's states, plus `stopped` for a module that has been shut down. */
export type RemoteListenerState = 'waiting' | 'binding' | 'listening' | 'down' | 'stopped';

/** §2.3: "Retry backoff — 2 s, doubling to `remote.detect.retryMaxMs`, with jitter." */
export const INITIAL_BACKOFF_MS = 2_000;
/** §2.3: "5 bind failures within 10 minutes". */
export const BIND_FAILURE_LIMIT = 5;
export const BIND_FAILURE_WINDOW_MS = 600_000;

/**
 * Injectable timers, so the state machine is testable without waiting.
 *
 * `fn` may return a promise — the fake in `listener.test.ts` awaits it, which is
 * what lets a test drive a whole retry or poll tick deterministically instead of
 * sleeping and hoping.
 */
export interface RemoteTimers {
  /** Runs `fn` after `ms`. The returned function cancels it. */
  after(ms: number, fn: () => void | Promise<void>): () => void;
}

/** The real timers: `unref`ed, so a `waiting` module holds nothing open. */
export const realTimers: RemoteTimers = {
  after: (ms, fn) => {
    const handle = setTimeout(() => {
      // The scheduled work handles its own failures; this is the last resort, so
      // a rejected tick can never become an unhandled rejection in the service.
      void (async () => fn())().catch(() => undefined);
    }, ms);
    handle.unref?.();
    return () => clearTimeout(handle);
  },
};

export interface RemoteListenerDeps {
  /**
   * Proves the address, in whichever of D5's two modes this install uses.
   *
   * Typed as the mode-neutral {@link AddressProver} — `TailscaleDetector`
   * satisfies it structurally — so this file runs one state machine for both
   * modes rather than two, and proxy mode inherits the two independent
   * detections, the fail-closed poll and the `down` ceiling unchanged.
   */
  readonly detector: AddressProver;
  /**
   * `remote.bind`. The **only** thing this file branches on, and it branches on
   * exactly two facts: which address literals {@link assertBindable} will accept,
   * and what `source` the published claim carries.
   */
  readonly mode?: RemoteBindMode;
  /**
   * In proxy mode, `remote.proxy.bind` — the one address the owner declared.
   *
   * Compared against what the prover returned immediately before `listen()`, so
   * a prover that answered something else (a subverted config path, a harness, a
   * future refactor) is refused at the point of no return rather than trusted.
   */
  readonly expectedAddress?: string;
  /** Foundation's `HttpService.mount` — the same route table, a second socket. */
  readonly mount: (options: ListenerOptions) => HttpListener;
  readonly port: number;
  readonly pollMs: number;
  readonly retryMaxMs: number;
  /** Runs in front of every request on this listener. M3 hard-denies (§3.1, M4). */
  readonly middleware: readonly Middleware[];
  readonly logger: Logger;
  /** `access.log` — one line per request (foundation §5.1). */
  readonly accessLogger: Logger;
  readonly clock: Clock;
  /**
   * DESIGN §5's runtime kill switch, read from `settings` rather than config.
   * Consulted at every start, restart and poll, so turning it off closes the
   * socket without a core restart.
   */
  readonly enabled: () => boolean;
  readonly timers?: RemoteTimers;
  /** Backoff jitter. Injected so a retry schedule is assertable. */
  readonly random?: () => number;
}

/** What `/api/remote/status` and `health()` report (§5, §2.3). */
export interface RemoteStatus {
  readonly state: RemoteListenerState;
  readonly enabled: boolean;
  readonly boundAddress: BoundAddress | null;
  readonly port: number;
  readonly magicDnsName: string | null;
  /** `Running`, `Stopped`, …, or `unknown (interface-derived)` on the fallback. */
  readonly tailscaleState: string | null;
  readonly lastError: string | null;
  /** Bind failures still inside §2.3's ten-minute window. */
  readonly recentBindFailures: number;
  readonly detectionSource: DetectionSource | null;
  /** `remote.bind` — which of D5's two modes this listener is running. */
  readonly mode: RemoteBindMode;
}

export interface RemoteListener {
  /**
   * Runs one full detect-and-bind cycle and **awaits it**.
   *
   * Awaiting is a security requirement, not a convenience: foundation's
   * bind-time assertion (§6.3) runs immediately after every module's `start()`,
   * so a socket that appeared afterwards would never be checked against the
   * edition. Retries after a failure are asynchronous; the *first* attempt is not.
   */
  start(): Promise<void>;
  stop(): Promise<void>;
  /** `POST /api/remote/restart` (§5) — clears `down` and re-runs the cycle. */
  restart(): Promise<void>;
  /** The claim foundation §6.3 reads. `null` unless a socket is actually bound. */
  boundAddress(): BoundAddress | null;
  status(): RemoteStatus;
  /** Test seam: runs the address watcher's tick now instead of on its timer. */
  poll(): Promise<void>;
}

/** What {@link assertBindable} is checking against. */
export interface BindableOptions {
  /** Defaults to `tailscale` — the mode that existed before D5's amendment. */
  readonly mode?: RemoteBindMode;
  /** Proxy mode only: `remote.proxy.bind`, the address the owner declared. */
  readonly expected?: string;
}

/**
 * The last gate before `listen()`.
 *
 * Every address reaching this function has already been proven — by
 * `validateCandidates` in tailscale mode, by `validateProxyBind` in proxy mode —
 * so in a correct build it always succeeds. It exists for the build that is not
 * correct: a prover — or a future refactor, or a test harness — that hands back
 * `0.0.0.0`, `::`, `127.0.0.1`, or an address other than the one the owner
 * declared, must be refused *here*, at the point of no return, rather than
 * trusted because something upstream promised.
 *
 * The three refusals that hold in **both** modes (wildcard, loopback, IPv6) are
 * the ones that are about exposure rather than about which network the address
 * belongs to. What differs is the fourth:
 *
 * - **tailscale** — the address must be inside `100.64.0.0/10`, so a LAN address
 *   can never be bound.
 * - **proxy** — the address must be exactly `remote.proxy.bind`. A LAN address is
 *   the point of this mode, so the range check is replaced by an *identity* check
 *   against the declared one: the owner named one interface, and this is the
 *   second independent confirmation that it is the interface being bound.
 *
 * @returns the reason to refuse, or `undefined` when the address may be bound.
 */
export function assertBindable(address: string, options: BindableOptions = {}): string | undefined {
  const mode = options.mode ?? REMOTE_BIND_LITERAL;
  const value = address.trim().toLowerCase();
  if (value.length === 0) return 'the detected address is empty';
  if (value === '0.0.0.0' || value === '::' || value === '*') {
    return `"${address}" is a wildcard address and would expose every interface this machine has`;
  }
  if (value === 'localhost' || value.startsWith('127.') || value === '::1') {
    return `"${address}" is a loopback address; the remote listener exists to be reachable from another device`;
  }
  if (value.includes(':')) {
    return `"${address}" is IPv6; v1 binds IPv4 only (remote DESIGN §2.2)`;
  }

  if (mode === REMOTE_BIND_PROXY) {
    const expected = options.expected?.trim().toLowerCase();
    if (expected === undefined || expected.length === 0) {
      return (
        'proxy mode has no declared remote.proxy.bind to compare against, so nothing can be ' +
        'confirmed as the interface the owner named'
      );
    }
    if (value !== expected) {
      return (
        `"${address}" is not the address remote.proxy.bind declares ("${options.expected ?? ''}"), ` +
        'and proxy mode binds only the one interface the owner named'
      );
    }
    return undefined;
  }

  if (!isCgnatIPv4(value)) {
    return `"${address}" is outside ${CGNAT_RANGE}, so it is not a Tailscale node address`;
  }
  return undefined;
}

export function createRemoteListener(deps: RemoteListenerDeps): RemoteListener {
  const timers = deps.timers ?? realTimers;
  const random = deps.random ?? Math.random;
  const mode = deps.mode ?? REMOTE_BIND_LITERAL;
  const bindableOptions: BindableOptions = {
    mode,
    ...(deps.expectedAddress === undefined ? {} : { expected: deps.expectedAddress }),
  };
  /** What the log lines and `lastError` call the address, per mode. */
  const addressNoun =
    mode === REMOTE_BIND_PROXY ? 'declared proxy-facing LAN address' : 'Tailscale address';

  let state: RemoteListenerState = 'waiting';
  let listener: HttpListener | undefined;
  let bound: BoundAddress | null = null;
  let magicDnsName: string | null = null;
  let tailscaleState: string | null = null;
  let detectionSource: DetectionSource | null = null;
  let lastError: string | null = null;
  let backoffMs = INITIAL_BACKOFF_MS;
  let bindFailures: number[] = [];
  let cancelTimer: (() => void) | undefined;
  let stopped = false;

  const clearTimer = (): void => {
    cancelTimer?.();
    cancelTimer = undefined;
  };

  const now = (): number => deps.clock().getTime();

  /** Closes the socket, if any, before any state change that leaves `listening`. */
  const closeSocket = async (why: string): Promise<void> => {
    const open = listener;
    listener = undefined;
    bound = null;
    if (open === undefined) return;
    try {
      await open.close();
      deps.logger.info({ why }, `remote listener socket closed: ${why}`);
    } catch (error) {
      // A close that fails leaves us with no handle either way; the state must
      // still say "no socket", because pretending otherwise is the leak.
      deps.logger.error({ err: error, why }, 'closing the remote listener socket failed');
    }
  };

  const toWaiting = (reason: string, detection?: Detection): void => {
    state = 'waiting';
    lastError = reason;
    if (detection !== undefined) {
      tailscaleState = detection.ok
        ? (detection.backendState ?? 'unknown (interface-derived)')
        : detection.backendState;
      detectionSource = detection.ok
        ? detection.source
        : detection.source === 'none'
          ? null
          : detection.source;
    }
  };

  const scheduleRetry = (): void => {
    if (stopped) return;
    clearTimer();
    const nominal = Math.min(backoffMs, deps.retryMaxMs);
    // Jitter adds up to 25 % on top of the nominal delay and never subtracts, so
    // §2.3's "2 s, doubling to retryMaxMs" is a floor rather than an average: a
    // retry that fired *sooner* than the backoff said would defeat the point of
    // backing off. `retryMaxMs` still caps the result.
    const delay = Math.min(deps.retryMaxMs, Math.round(nominal * (1 + random() * 0.25)));
    backoffMs = Math.min(backoffMs * 2, deps.retryMaxMs);
    deps.logger.debug({ delayMs: delay, state }, 'remote listener retry scheduled');
    cancelTimer = timers.after(delay, () => cycle());
  };

  const scheduleWatch = (): void => {
    if (stopped) return;
    clearTimer();
    cancelTimer = timers.after(deps.pollMs, () => poll());
  };

  const recordBindFailure = async (message: string): Promise<void> => {
    await closeSocket('bind failed');
    const at = now();
    bindFailures = [...bindFailures, at].filter((stamp) => at - stamp < BIND_FAILURE_WINDOW_MS);
    if (bindFailures.length >= BIND_FAILURE_LIMIT) {
      state = 'down';
      lastError =
        `The remote listener failed to bind ${String(bindFailures.length)} times within ` +
        `${String(BIND_FAILURE_WINDOW_MS / 60_000)} minutes on port ${String(deps.port)}: ` +
        `${message}. Retries have stopped; POST /api/remote/restart (locally) or restart the core ` +
        'once the port is free. Change remote.port if something else owns it permanently.';
      clearTimer();
      deps.logger.error({ port: deps.port, failures: bindFailures.length }, lastError);
      return;
    }
    toWaiting(`bind failed on port ${String(deps.port)}: ${message}`);
    deps.logger.warn({ port: deps.port, failures: bindFailures.length }, lastError ?? message);
    scheduleRetry();
  };

  /** One `waiting → binding → listening | waiting | down` traversal. */
  const cycle = async (): Promise<void> => {
    if (stopped) return;
    clearTimer();

    if (!deps.enabled()) {
      await closeSocket('remote access disabled');
      toWaiting(
        'Remote access is switched off (the settings key "remote.enabled" is false), so no ' +
          'listener is bound. Turn it back on from this machine (remote DESIGN §3.2, §5).',
      );
      deps.logger.info('remote access is disabled in settings; no socket will be bound');
      return;
    }

    state = 'binding';
    const first = await deps.detector.detect();
    if (!first.ok) {
      toWaiting(first.message, first);
      deps.logger.warn({ reason: first.reason, backendState: first.backendState }, first.message);
      scheduleRetry();
      return;
    }

    // §9.1 #2: "remote independently re-validates the same address through §2.1
    // immediately before `listen()`". A second full detection, not a cached one —
    // the whole value is that it can disagree with the first. Proxy mode inherits
    // this unchanged: `proxy.ts`'s `detect()` re-enumerates the machine's
    // interfaces on every call, so a declared LAN address that went away between
    // the decision and the bind is caught here rather than bound.
    const confirmed = await deps.detector.detect();
    if (!confirmed.ok) {
      toWaiting(
        `the ${addressNoun} stopped validating between detection and bind: ${confirmed.message}`,
        confirmed,
      );
      deps.logger.warn({ reason: confirmed.reason }, lastError ?? confirmed.message);
      scheduleRetry();
      return;
    }
    if (confirmed.address !== first.address) {
      toWaiting(
        `the ${addressNoun} changed between detection and bind (${first.address} → ` +
          `${confirmed.address}); refusing to bind either until one validates twice`,
        confirmed,
      );
      deps.logger.warn({ first: first.address, confirmed: confirmed.address }, lastError ?? '');
      scheduleRetry();
      return;
    }

    const refusal = assertBindable(confirmed.address, bindableOptions);
    if (refusal !== undefined) {
      toWaiting(
        `refusing to bind the detected address: ${refusal}. ${
          mode === REMOTE_BIND_PROXY
            ? 'Only the LAN interface remote.proxy.bind declares may be bound'
            : 'Only a validated Tailscale address may be bound'
        } (architecture D5, remote DESIGN §2.1).`,
        confirmed,
      );
      deps.logger.error({ address: confirmed.address, mode }, lastError ?? refusal);
      scheduleRetry();
      return;
    }

    tailscaleState = confirmed.backendState ?? 'unknown (interface-derived)';
    detectionSource = confirmed.source;
    magicDnsName = confirmed.magicDnsName;

    const mounted = deps.mount({
      bind: confirmed.address,
      port: deps.port,
      origin: 'remote',
      name: 'remote',
      logger: deps.logger,
      accessLogger: deps.accessLogger,
      middleware: deps.middleware,
    });
    listener = mounted;

    let address;
    try {
      address = await mounted.listen();
    } catch (error) {
      await recordBindFailure(error instanceof Error ? error.message : String(error));
      return;
    }

    // The bound port, not the requested one: a test may ask for an ephemeral
    // port, and the claim foundation compares against the OS must be the truth.
    // `source` names *how* the address was decided (foundation §6.3 carries it
    // into the fatal message), so proxy mode publishes the same claim shape with
    // `source: 'proxy'` — one claim contract, two modes.
    bound = {
      address: address.address,
      port: address.port,
      source: confirmed.source === 'proxy' ? 'proxy' : `tailscale-${confirmed.source}`,
    };
    state = 'listening';
    lastError = null;
    backoffMs = INITIAL_BACKOFF_MS;
    deps.logger.info(
      {
        address: bound.address,
        port: bound.port,
        source: bound.source,
        mode,
        magicDnsName,
        tailscaleState,
        routes: mounted.routes.length,
      },
      `remote listener bound on the ${
        mode === REMOTE_BIND_PROXY ? 'declared proxy-facing LAN interface' : 'Tailscale interface'
      } at ${bound.address}:${String(bound.port)}`,
    );
    scheduleWatch();
  };

  /** §2.3's address watcher. Fails closed on anything but "unchanged and valid". */
  const poll = async (): Promise<void> => {
    if (stopped || state !== 'listening') return;

    if (!deps.enabled()) {
      await cycle();
      return;
    }

    const detection = await deps.detector.detect();
    if (!detection.ok) {
      await closeSocket(`${addressNoun} is gone: ${detection.reason}`);
      toWaiting(detection.message, detection);
      deps.logger.warn(
        { reason: detection.reason, backendState: detection.backendState },
        `the remote listener's address is no longer valid, so its socket was closed: ${detection.message}`,
      );
      scheduleRetry();
      return;
    }

    const current = bound?.address;
    if (detection.address !== current) {
      // §2.3: close, re-validate the new candidate from scratch, rebind.
      await closeSocket(`${addressNoun} changed (${String(current)} → ${detection.address})`);
      toWaiting(`the ${addressNoun} changed to ${detection.address}; rebinding`);
      deps.logger.warn(
        { previous: current, next: detection.address },
        'the bound address changed; the socket was closed and the new address will be ' +
          're-validated from scratch before any rebind',
      );
      await cycle();
      return;
    }

    tailscaleState = detection.backendState ?? 'unknown (interface-derived)';
    magicDnsName = detection.magicDnsName;
    scheduleWatch();
  };

  return {
    start: async () => {
      stopped = false;
      await cycle();
    },

    stop: async () => {
      stopped = true;
      clearTimer();
      await closeSocket('module stopping');
      state = 'stopped';
    },

    restart: async () => {
      stopped = false;
      clearTimer();
      await closeSocket('restart requested');
      bindFailures = [];
      backoffMs = INITIAL_BACKOFF_MS;
      lastError = null;
      await cycle();
    },

    // Never a remembered value: `null` unless a socket is bound right now, which
    // is what makes foundation's comparison meaningful (§6.3).
    boundAddress: () => (state === 'listening' ? bound : null),

    status: () => ({
      state,
      enabled: deps.enabled(),
      boundAddress: state === 'listening' ? bound : null,
      port: deps.port,
      magicDnsName,
      tailscaleState,
      lastError,
      recentBindFailures: bindFailures.filter((stamp) => now() - stamp < BIND_FAILURE_WINDOW_MS)
        .length,
      detectionSource,
      mode,
    }),

    poll,
  };
}
