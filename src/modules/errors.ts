/**
 * Failures the module system raises, each with the exit code the composition
 * root turns it into.
 *
 * The rule of DESIGN §6.2: a **critical** module that cannot init or start ends
 * the process; a non-critical one is logged, marked unhealthy, and skipped —
 * "a broken orchestrator should not prevent you from reading logs and fixing
 * it". Only the first case is an error type; the second is a health status.
 */

/** `EX_SOFTWARE` from sysexits.h — the service could not bring itself up. */
export const MODULE_FAILURE_EXIT_CODE = 70;

export class ModuleError extends Error {
  override readonly name: string = 'ModuleError';
  readonly exitCode: number = MODULE_FAILURE_EXIT_CODE;
}

/**
 * The dependency graph itself is wrong: a cycle, a duplicate id, or a
 * `dependsOn` naming a module that is not in the list.
 *
 * Fails fast, before anything is initialised — §6.2's topological sort has no
 * answer to give, and a service that starts half a graph is worse than one that
 * refuses.
 */
export class ModuleGraphError extends ModuleError {
  override readonly name = 'ModuleGraphError';
  /** The cycle as ids in order, first id repeated at the end. Only for cycles. */
  readonly cycle?: readonly string[];

  constructor(message: string, cycle?: readonly string[]) {
    super(message);
    if (cycle !== undefined) this.cycle = cycle;
  }
}

/** A module exceeded the per-module `start()` / `stop()` budget (§6.2: 10 s). */
export class ModuleTimeoutError extends ModuleError {
  override readonly name = 'ModuleTimeoutError';
  readonly moduleId: string;
  readonly phase: 'init' | 'start' | 'stop';
  readonly timeoutMs: number;

  constructor(moduleId: string, phase: 'init' | 'start' | 'stop', timeoutMs: number) {
    super(`Module "${moduleId}" did not finish ${phase}() within ${String(timeoutMs)} ms.`);
    this.moduleId = moduleId;
    this.phase = phase;
    this.timeoutMs = timeoutMs;
  }
}

/** A `critical` module failed. The composition root exits non-zero on this. */
export class CriticalModuleFailureError extends ModuleError {
  override readonly name = 'CriticalModuleFailureError';
  readonly moduleId: string;
  readonly phase: 'init' | 'start';

  constructor(moduleId: string, phase: 'init' | 'start', cause: unknown) {
    super(
      `Critical module "${moduleId}" failed to ${phase}: ${describeError(cause)}. ` +
        'Critical modules are the ones the service cannot run without (DESIGN §6.2), ' +
        'so the process is exiting rather than continuing degraded.',
      { cause },
    );
    this.moduleId = moduleId;
    this.phase = phase;
  }
}

/** Two modules claimed the same service name, or the same method+path route. */
export class ModuleConflictError extends ModuleError {
  override readonly name = 'ModuleConflictError';
}

/** An `Error`'s message, or the stringified value, never a stack. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return String(error);
  } catch {
    return '[unstringifiable error]';
  }
}
