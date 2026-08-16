/**
 * The module runner of DESIGN §6.2.
 *
 * "Modules are topologically sorted by `dependsOn`, started in order with a
 * per-module start timeout (10 s), and stopped in reverse. A non-critical
 * module that fails to start is logged, marked unhealthy in `/api/health`, and
 * the service continues — a broken orchestrator should not prevent you from
 * reading logs and fixing it. `storage` and `secrets` are critical."
 *
 * ## Phases
 *
 * `init` → `boot-tasks` → `listener-bind` (= module `start()`) → `ready`.
 *
 * The middle step is §4.2's guarantee, made structural rather than
 * conventional: **boot tasks run after storage is up and before any listener
 * binds**, because a module binds its socket in `start()` and every boot task
 * has already run by then. M9's bind-time invariant (§6.3) hooks the far side
 * of `ready`. Phases are reported through {@link ModuleRuntimeOptions.onPhase}
 * and recorded on {@link ModuleRuntime.phases}, so the ordering is a thing a
 * test can assert on rather than a thing a reviewer has to trace.
 */
import type { Logger } from 'pino';

import type { SecretResolver } from '../secrets/index.js';
import type { Store } from '../storage/index.js';
import type { AppConfig } from '../config/index.js';

import { createEventBus } from './bus.js';
import { CriticalModuleFailureError, ModuleTimeoutError, describeError } from './errors.js';
import { topologicalOrder } from './graph.js';
import { ServiceRegistry } from './registry.js';
import { RouteTable } from './routes.js';
import type {
  BootTask,
  Clock,
  EventBus,
  HealthAggregate,
  HealthCheck,
  HealthCondition,
  HealthReport,
  HealthStatus,
  LifecyclePhase,
  Module,
  ModuleContext,
  ModuleHandle,
  ModuleHealth,
  PhaseMark,
  PhaseObserver,
  RouteRegistration,
} from './types.js';

/** §6.2: "a per-module start timeout (10 s)". */
export const DEFAULT_START_TIMEOUT_MS = 10_000;

/**
 * The stop budget per module. §4.2 gives the *process* `shutdownGraceSeconds`
 * (default 20) and says "a module that hangs in `stop()` does not prevent
 * process exit"; the per-module ceiling here is what makes that true one module
 * at a time. M9 owns the overall budget.
 */
export const DEFAULT_STOP_TIMEOUT_MS = 10_000;

export interface ModuleRuntimeOptions {
  readonly modules: readonly Module[];
  readonly config: AppConfig;
  readonly store: Store;
  /** The read-only face (§3.2); the composition root keeps the writable store. */
  readonly secrets: SecretResolver;
  /** Builds each module's pre-tagged child logger — `logging.child` (§5.1). */
  readonly logger: (component: string) => Logger;
  readonly clock?: Clock;
  /** Injected so the composition root can wire persistence and error logging. */
  readonly bus?: EventBus;
  readonly startTimeoutMs?: number;
  readonly stopTimeoutMs?: number;
  readonly onPhase?: PhaseObserver;
}

interface ModuleState {
  readonly module: Module;
  handle?: ModuleHandle;
  status: HealthStatus;
  error?: string;
  started: boolean;
  readonly checks: { name: string; check: HealthCheck }[];
}

interface RegisteredBootTask {
  readonly moduleId: string;
  readonly name: string;
  readonly task: BootTask;
}

const STATUS_SEVERITY: Readonly<Record<HealthStatus, number>> = Object.freeze({
  ok: 0,
  degraded: 1,
  'not-started': 2,
  failed: 3,
});

/** The worst of a set of statuses, collapsed to what `/api/health` reports. */
function worst(statuses: readonly HealthStatus[]): HealthStatus {
  let result: HealthStatus = 'ok';
  for (const status of statuses) {
    if (STATUS_SEVERITY[status] > STATUS_SEVERITY[result]) result = status;
  }
  // The service is answering, so it is not "failed" as a whole: a failed module
  // that did not end the process was non-critical by definition (§6.2), and the
  // right word for the service around it is degraded.
  return result === 'ok' ? 'ok' : 'degraded';
}

/**
 * Runs `operation`, rejecting with {@link ModuleTimeoutError} after `ms`.
 *
 * The timer is `unref`'d so a module that never settles cannot, by itself, keep
 * the process alive past the point the runner has given up on it.
 */
async function withTimeout<T>(
  operation: () => Promise<T> | T,
  ms: number,
  moduleId: string,
  phase: 'init' | 'start' | 'stop',
): Promise<T> {
  if (ms <= 0) return await operation();

  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      (async () => await operation())(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new ModuleTimeoutError(moduleId, phase, ms));
        }, ms);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export class ModuleRuntime {
  readonly #options: ModuleRuntimeOptions;
  readonly #states: ModuleState[];
  readonly #bootTasks: RegisteredBootTask[] = [];
  readonly #phases: PhaseMark[] = [];
  readonly #log: Logger;
  readonly #clock: Clock;
  #phase: LifecyclePhase = 'modules-init';

  /** Foundation's one route table (§6.4). M8 mounts it. */
  readonly routes = new RouteTable();
  /** The service registry of §6.1. */
  readonly registry = new ServiceRegistry();
  readonly bus: EventBus;

  /**
   * @throws ModuleGraphError if the graph has a cycle, a duplicate id or a
   *   dangling dependency — before any module is touched.
   */
  constructor(options: ModuleRuntimeOptions) {
    this.#options = options;
    this.#clock = options.clock ?? ((): Date => new Date());
    this.#log = options.logger('modules');
    this.bus = options.bus ?? createEventBus({ clock: this.#clock });
    this.#states = topologicalOrder(options.modules).map((module) => ({
      module,
      status: 'not-started',
      started: false,
      checks: [],
    }));
  }

  /** Module ids in start order. Stopping is exactly this reversed. */
  get order(): readonly string[] {
    return this.#states.map((state) => state.module.id);
  }

  get phase(): LifecyclePhase {
    return this.#phase;
  }

  /** Every phase reached, in order, with the instant it was reached. */
  get phases(): readonly PhaseMark[] {
    return [...this.#phases];
  }

  /** Boot tasks in registration order (module topological order). */
  get bootTaskNames(): readonly string[] {
    return this.#bootTasks.map((task) => `${task.moduleId}:${task.name}`);
  }

  /**
   * `init` → `boot-tasks` → `listener-bind` → `ready`, in one call.
   *
   * @throws CriticalModuleFailureError after stopping whatever had started.
   */
  async startAll(): Promise<void> {
    await this.initialize();
    await this.runBootTasks();
    await this.startModules();
  }

  /** Calls `init` on every module in topological order. */
  async initialize(): Promise<void> {
    this.#enter('modules-init', { modules: this.order });

    for (const state of this.#states) {
      const { module } = state;
      const context = this.#contextFor(state);
      try {
        state.handle = await withTimeout(
          () => module.init(context),
          this.#options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS,
          module.id,
          'init',
        );
        this.#log.debug({ module: module.id }, 'module initialised');
      } catch (error) {
        await this.#fail(state, 'init', error);
      }
    }
  }

  /**
   * §4.2: "modules register boot tasks that run after storage is up and before
   * the listener binds. Foundation guarantees the hook and the ordering."
   *
   * A failing boot task is logged and marks its module degraded; it does not
   * end the process even for a critical module, because by this point storage
   * and secrets are up and the reconciliation a boot task performs (the
   * runner's `running` → `orphaned` sweep) is corrective, not structural.
   */
  async runBootTasks(): Promise<void> {
    this.#enter('boot-tasks', { count: this.#bootTasks.length });

    for (const entry of this.#bootTasks) {
      try {
        await entry.task();
        this.#log.debug({ module: entry.moduleId, task: entry.name }, 'boot task complete');
      } catch (error) {
        const message = describeError(error);
        this.#log.error(
          { module: entry.moduleId, task: entry.name, err: error },
          `boot task failed: ${message}`,
        );
        const state = this.#states.find((candidate) => candidate.module.id === entry.moduleId);
        if (state !== undefined && state.status !== 'failed') {
          state.status = 'degraded';
          state.error = `boot task "${entry.name}" failed: ${message}`;
        }
      }
    }
  }

  /**
   * Starts every initialised module in order, with the per-module timeout.
   *
   * This is the `listener-bind` phase: a module that binds a socket binds it
   * here, which is what makes "boot tasks before any listener" true.
   */
  async startModules(): Promise<void> {
    this.#enter('listener-bind');

    for (const state of this.#states) {
      if (state.handle === undefined) continue;
      try {
        await withTimeout(
          () => state.handle?.start?.(),
          this.#options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS,
          state.module.id,
          'start',
        );
        state.started = true;
        // Only an upgrade from "not yet": a module already marked degraded by a
        // failed boot task must not have that erased by starting successfully.
        if (state.status === 'not-started') state.status = 'ok';
        this.#log.info({ module: state.module.id }, 'module started');
      } catch (error) {
        await this.#fail(state, 'start', error);
      }
    }

    this.#enter('ready', {
      started: this.#states.filter((s) => s.started).map((s) => s.module.id),
    });
  }

  /**
   * Stops every started module in **reverse** order (§6.2), each with its own
   * timeout so one hanging `stop()` cannot strand the rest (§4.2).
   */
  async stop(): Promise<void> {
    if (this.#phase === 'stopped' || this.#phase === 'stopping') return;
    this.#enter('stopping');

    for (const state of [...this.#states].reverse()) {
      if (state.handle === undefined) continue;
      // A module that failed to start may still have allocated something in
      // init, so `stop` is offered to anything that has a handle.
      try {
        await withTimeout(
          () => state.handle?.stop?.(),
          this.#options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS,
          state.module.id,
          'stop',
        );
        this.#log.debug({ module: state.module.id }, 'module stopped');
      } catch (error) {
        this.#log.error(
          { module: state.module.id, err: error },
          `module stop failed: ${describeError(error)}`,
        );
      }
      state.started = false;
      if (state.status === 'ok') state.status = 'not-started';
    }

    this.#enter('stopped');
  }

  /**
   * The aggregate M8 serves as `/api/health` (§6.2: "reports degraded modules
   * individually").
   *
   * Asynchronous because a registered check may be — `ModuleHandle.health()`
   * itself stays synchronous, as §6.1 declares it.
   */
  async health(): Promise<HealthAggregate> {
    const modules: ModuleHealth[] = [];

    for (const state of this.#states) {
      const reports: HealthReport[] = [];

      const own = this.#safeHealth(state);
      if (own !== undefined) reports.push(own);

      for (const { name, check } of state.checks) {
        try {
          reports.push(await check());
        } catch (error) {
          reports.push({
            status: 'failed',
            message: `health check "${name}" threw: ${describeError(error)}`,
          });
        }
      }

      const conditions = reports.flatMap((report) => report.conditions ?? []);
      const detail: Record<string, unknown> = {};
      for (const report of reports) Object.assign(detail, report.detail ?? {});
      const message = reports.find((report) => report.message !== undefined)?.message;
      const status = worstModuleStatus(state, reports);

      modules.push({
        id: state.module.id,
        critical: state.module.critical === true,
        status,
        conditions,
        ...(message === undefined ? {} : { message }),
        ...(state.error === undefined ? {} : { error: state.error }),
        ...(Object.keys(detail).length === 0 ? {} : { detail }),
      });
    }

    const conditions: HealthCondition[] = modules.flatMap((module) => [...module.conditions]);
    return {
      status: worst(modules.map((module) => module.status)),
      phase: this.#phase,
      modules,
      conditions,
    };
  }

  // -------------------------------------------------------------------------

  #safeHealth(state: ModuleState): HealthReport | undefined {
    if (state.handle?.health === undefined) return undefined;
    try {
      return state.handle.health();
    } catch (error) {
      return { status: 'failed', message: `health() threw: ${describeError(error)}` };
    }
  }

  #enter(phase: LifecyclePhase, detail?: Record<string, unknown>): void {
    this.#phase = phase;
    this.#phases.push({ phase, at: this.#clock().toISOString() });
    this.#log.debug({ phase, ...detail }, `lifecycle phase: ${phase}`);
    this.#options.onPhase?.(phase, detail);
  }

  /**
   * §6.2's two outcomes: a critical module ends the process (the composition
   * root turns this throw into a non-zero exit), a non-critical one is logged,
   * marked unhealthy, and skipped for the rest of the boot.
   */
  async #fail(state: ModuleState, phase: 'init' | 'start', error: unknown): Promise<void> {
    state.status = 'failed';
    state.error = describeError(error);
    state.started = false;

    if (state.module.critical === true) {
      this.#log.fatal(
        { module: state.module.id, phase, err: error },
        `critical module "${state.module.id}" failed to ${phase}: ${state.error}`,
      );
      // Unwind what is already up before the process goes away: the DB handle
      // and the WAL belong to a module that has a `stop()`.
      await this.stop();
      throw new CriticalModuleFailureError(state.module.id, phase, error);
    }

    this.#log.error(
      { module: state.module.id, phase, err: error },
      `module "${state.module.id}" failed to ${phase}; the service continues without it: ${state.error}`,
    );
    // Dropping the handle keeps a half-initialised module out of `start` and
    // out of `stop` — it never reported itself ready for either.
    delete state.handle;
  }

  #contextFor(state: ModuleState): ModuleContext {
    const moduleId = state.module.id;
    const named = (given: string | undefined, fn: { name: string }): string =>
      given ?? (fn.name === '' ? 'anonymous' : fn.name);

    // Arrow properties rather than methods, so each closure carries the module
    // id it was built for: a module cannot register anything under another
    // module's name, because there is no argument through which it could.
    return {
      moduleId,
      config: this.#options.config,
      store: this.#options.store,
      settings: this.#options.store.settings,
      logger: this.#options.logger(moduleId),
      secrets: this.#options.secrets,
      bus: this.bus,
      clock: this.#clock,

      registerRoutes: (registration: RouteRegistration): void => {
        this.routes.add(moduleId, registration);
      },
      registerBootTask: (task: BootTask, name?: string): void => {
        this.#bootTasks.push({ moduleId, name: named(name, task), task });
      },
      registerHealthCheck: (check: HealthCheck, name?: string): void => {
        state.checks.push({ name: named(name, check), check });
      },
      provide: (name: string, api: unknown): void => {
        this.registry.provide(moduleId, name, api);
      },
      require: <T>(name: string): T | undefined => this.registry.require<T>(name),
    };
  }
}

/** A module's status: its own report, unless the runner already knows better. */
function worstModuleStatus(state: ModuleState, reports: readonly HealthReport[]): HealthStatus {
  if (state.status === 'failed') return 'failed';
  let result: HealthStatus = state.status;
  for (const report of reports) {
    if (STATUS_SEVERITY[report.status] > STATUS_SEVERITY[result]) result = report.status;
  }
  return result;
}
