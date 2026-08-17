/**
 * Discover or start the core (ui DESIGN §1.5 #1, foundation §4.1 / §4.2).
 *
 * Foundation is unambiguous and this file is written to be read beside it:
 *
 * > "on launch, read `run/core.port`, probe `GET /healthz`. If nothing is
 * > listening, spawn the core **detached** (`detached: true`, stdio ignored) and
 * > poll for readiness; if it is listening, just connect. Closing the Electron
 * > window (or quitting from the tray) never stops the core."
 *
 * So the procedure is exactly two steps in that order, and **the shell never
 * owns what it spawned**: the child is detached and `unref`'d, no handle to it is
 * kept, and no code path anywhere in `electron/` stops it. The only way to stop
 * the core from here is the explicit "Stop background service" tray item, which
 * asks the *core* to shut itself down (§1.5 #3).
 *
 * Every side effect is injected — the port-file read, the `/healthz` probe, the
 * spawn, the clock. That is not test scaffolding for its own sake: Electron
 * cannot be booted in this repository, so a seam is the difference between this
 * logic being covered and being hoped at.
 *
 * The two steps are foundation's own `readPortFile` / `probeCore` (`src/lifecycle/
 * portFile.ts`), which document themselves as "*the* discovery procedure, not
 * private helpers". `main.ts` passes those in, so there is one implementation of
 * "is a core listening" in the repository rather than two that will disagree.
 */

/** `{port, pid, startedAt, edition}` — foundation §4.2's record. */
export interface PortRecord {
  readonly port: number;
  readonly pid: number;
  readonly startedAt: string;
  readonly edition: string;
}

/** What `/healthz` answered, when it answered. */
export interface CoreProbe {
  readonly status: string;
  readonly version?: string | undefined;
  readonly edition?: string | undefined;
}

export interface DiscoveryDeps {
  /** `<dataRoot>\run\core.port`, parsed; `undefined` for missing or malformed. */
  readPortFile(): PortRecord | undefined;
  /** `GET http://127.0.0.1:<port>/healthz`; `undefined` when nothing usable answered. */
  probe(port: number): Promise<CoreProbe | undefined>;
  /**
   * Starts the core detached and returns nothing.
   *
   * Returning nothing is the contract, not an omission: a handle would invite a
   * `kill()` somewhere later, and foundation §4.1 says the shell never owns the
   * core.
   */
  spawnCore(): void;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** Named in the failure screen so the user has somewhere to look (§1.5 #1). */
  readonly logPath: string;
}

export interface DiscoveryOptions {
  /** How long to wait for a spawned core to answer `/healthz`. */
  readonly readinessTimeoutMs?: number;
  readonly pollIntervalMs?: number;
}

/** Long enough for a cold start with a WAL checkpoint, short enough to notice. */
export const DEFAULT_READINESS_TIMEOUT_MS = 30_000;
export const DEFAULT_POLL_INTERVAL_MS = 250;

export type DiscoveryResult =
  /** A core was already listening. Nothing was spawned. */
  | { readonly kind: 'connected'; readonly url: string; readonly probe: CoreProbe }
  /** Nothing answered, so one was started; it is now listening. */
  | { readonly kind: 'started'; readonly url: string; readonly probe: CoreProbe }
  /**
   * Nothing answered and nothing came up in time.
   *
   * `message` is what the failure screen shows, and it names the log path,
   * because "AgentManager could not start" with no next step is the least useful
   * sentence a launcher can print.
   */
  | { readonly kind: 'failed'; readonly message: string; readonly logPath: string };

export function coreUrl(port: number): string {
  // Loopback, always — §1.5 #2: "never `file://`", and never a LAN address
  // either. The tailnet client reaches the *remote* listener; this is the local
  // one, and foundation §6.4 pins that it has no authentication precisely
  // because it is loopback-only.
  return `http://127.0.0.1:${String(port)}`;
}

/**
 * Foundation §4.2's two steps, in order.
 *
 * A port file whose `/healthz` does not answer is *stale* and is ignored rather
 * than trusted — which is the whole reason the probe exists, and why "the file
 * is there" is never enough to skip the spawn.
 */
export async function discoverCore(
  deps: DiscoveryDeps,
  options: DiscoveryOptions = {},
): Promise<DiscoveryResult> {
  const existing = deps.readPortFile();
  if (existing !== undefined) {
    const answer = await deps.probe(existing.port);
    if (answer !== undefined) {
      return { kind: 'connected', url: coreUrl(existing.port), probe: answer };
    }
  }

  deps.spawnCore();
  return waitForCore(deps, options);
}

/**
 * Polls the port file **and** `/healthz` until one answers or the budget runs out.
 *
 * Re-reading the file each turn rather than reusing the stale record is the
 * point: a freshly spawned core binds an ephemeral port when the configured one
 * is taken, and republishes the file after binding. Polling the old port forever
 * would time out beside a perfectly healthy core.
 */
export async function waitForCore(
  deps: DiscoveryDeps,
  options: DiscoveryOptions = {},
): Promise<DiscoveryResult> {
  const timeout = options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
  const interval = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const deadline = deps.now() + timeout;

  for (;;) {
    const record = deps.readPortFile();
    if (record !== undefined) {
      const answer = await deps.probe(record.port);
      if (answer !== undefined) {
        return { kind: 'started', url: coreUrl(record.port), probe: answer };
      }
    }
    if (deps.now() >= deadline) {
      return {
        kind: 'failed',
        logPath: deps.logPath,
        message: startupFailureMessage(timeout, deps.logPath),
      };
    }
    await deps.sleep(interval);
  }
}

export function startupFailureMessage(timeoutMs: number, logPath: string): string {
  const seconds = Math.round(timeoutMs / 1000);
  return (
    `AgentManager's background service did not answer within ${String(seconds)} seconds. ` +
    `It may still be starting, or it may have failed on boot — the log is at ${logPath}.`
  );
}
