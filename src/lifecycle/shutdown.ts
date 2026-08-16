/**
 * Graceful shutdown and its budget — DESIGN §4.2.
 *
 * > "**Graceful shutdown** on SIGINT/SIGTERM/`POST /api/service/shutdown`: stop
 * > accepting new sessions and HTTP connections → ask the runner to interrupt
 * > in-flight sessions and persist resume state → stop modules in reverse
 * > dependency order with a per-module timeout → WAL checkpoint and close the
 * > DB → release lock and delete `run/core.port`. Budget:
 * > `service.shutdownGraceSeconds` (default 20), after which the process exits
 * > anyway."
 *
 * The middle of that sequence is the module runtime's: `ModuleRuntime.stop`
 * walks the reverse topological order, each module under its own timeout. Every
 * step the design names is a module's own `stop()` in that walk — "stop
 * accepting HTTP connections" is the `http` module closing its listener,
 * "interrupt in-flight sessions and persist resume state" will be the runner's,
 * and the WAL checkpoint is `storage`, which is last in reverse precisely so the
 * database outlives everything that might still want to write to it. There is no
 * second, hand-ordered sequence here, because a hand-ordered one drifts from
 * `dependsOn` the moment a module is added.
 *
 * What this file owns is the two ends:
 *
 * - **The budget.** One deadline for the whole process, not per module. The
 *   per-module ceiling stops *one* hung module from stranding the rest; only a
 *   process-level deadline can make "a module that hangs in `stop()` does not
 *   prevent process exit" true when several hang, or when the hang is somewhere
 *   the module runtime does not reach.
 * - **The last rites.** Deleting `run/core.port` and releasing the lock happen
 *   on **both** paths — the graceful one and the deadline one — because a core
 *   that exits leaving a port file behind sends the next Electron launch to a
 *   dead socket, and that is just as true when it exits late.
 *
 * The deadline timer is `unref`'d: it is a ceiling, never a reason for the
 * process to stay alive.
 */
export type ShutdownPath = 'graceful' | 'forced' | 'failed';

export interface ShutdownOutcome {
  /** `SIGINT`, `SIGTERM`, or the reason `POST /api/service/shutdown` carried. */
  readonly reason: string;
  readonly path: ShutdownPath;
  readonly durationMs: number;
  readonly exitCode: number;
  /** Present when the teardown itself threw. */
  readonly error?: string;
}

export interface ShutdownControllerOptions {
  /** `service.shutdownGraceSeconds` × 1000 (§2.3). */
  readonly graceMs: number;
  /** The teardown: modules in reverse order, WAL checkpoint, log flush. */
  readonly stop: () => Promise<void>;
  /**
   * Synchronous last rites, run exactly once on every path: delete
   * `run/core.port`, release the lock, and — on the forced path only — whatever
   * the teardown did not get to.
   */
  readonly finalize: (outcome: ShutdownOutcome) => void;
  readonly exit: (code: number) => void;
  readonly onEvent?: (outcome: ShutdownOutcome) => void;
  /** Injectable so a test is not bound to a 20 s wall clock. */
  readonly now?: () => number;
  readonly failureExitCode?: number;
}

export interface ShutdownController {
  /** Idempotent: the first reason wins and later requests are ignored. */
  request(reason: string): void;
  readonly requested: boolean;
  /** Resolves with how it went, after {@link ShutdownControllerOptions.exit}. */
  readonly settled: Promise<ShutdownOutcome>;
}

/** `EX_SOFTWARE`; matches the module system's failure code. */
const DEFAULT_FAILURE_EXIT_CODE = 70;

export function createShutdownController(options: ShutdownControllerOptions): ShutdownController {
  const now = options.now ?? ((): number => Date.now());
  const failureExitCode = options.failureExitCode ?? DEFAULT_FAILURE_EXIT_CODE;

  let requested = false;
  let finished = false;
  let startedAt = 0;
  let settle: (outcome: ShutdownOutcome) => void = () => {};
  const settled = new Promise<ShutdownOutcome>((resolve) => {
    settle = resolve;
  });

  const finish = (reason: string, path: ShutdownPath, error?: string): void => {
    if (finished) return;
    finished = true;
    const outcome: ShutdownOutcome = {
      reason,
      path,
      durationMs: now() - startedAt,
      // A shutdown the owner asked for is a success even when it overran: the
      // scheduled task of §4.3 restarts on failure, and "you asked me to stop"
      // must not look like a crash.
      exitCode: path === 'failed' ? failureExitCode : 0,
      ...(error === undefined ? {} : { error }),
    };
    options.finalize(outcome);
    options.onEvent?.(outcome);
    settle(outcome);
    options.exit(outcome.exitCode);
  };

  const request = (reason: string): void => {
    if (requested) return;
    requested = true;
    startedAt = now();

    const deadline = setTimeout(() => {
      finish(reason, 'forced');
    }, options.graceMs);
    deadline.unref?.();

    void (async () => {
      try {
        await options.stop();
        clearTimeout(deadline);
        finish(reason, 'graceful');
      } catch (error) {
        clearTimeout(deadline);
        finish(reason, 'failed', error instanceof Error ? error.message : String(error));
      }
    })();
  };

  return {
    request,
    get requested() {
      return requested;
    },
    settled,
  };
}

/** The signals §4.2 puts on the same line as `POST /api/service/shutdown`. */
export const SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM'] as const;

export interface SignalTarget {
  once(signal: string, handler: (signal: string) => void): unknown;
}

/**
 * Routes SIGINT and SIGTERM into the controller.
 *
 * `once` per signal: a second Ctrl+C during a shutdown reaches the default
 * handler and kills the process, which is the right escape hatch for an owner
 * who has decided not to wait out the grace budget.
 *
 * On Windows SIGINT arrives from the console control handler; SIGTERM cannot be
 * delivered by another process at all, which is why `POST /api/service/shutdown`
 * (§6.4) — not a signal — is how Electron's "Stop background service" and the
 * uninstaller stop the core.
 */
export function installShutdownSignals(
  controller: ShutdownController,
  target: SignalTarget = process,
): void {
  for (const signal of SHUTDOWN_SIGNALS) {
    target.once(signal, () => void controller.request(signal));
  }
}
