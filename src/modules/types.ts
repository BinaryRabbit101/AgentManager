/**
 * The module contracts of DESIGN §6.1 — the surface every element codes against.
 *
 * ```ts
 * interface Module {
 *   id: string;
 *   dependsOn: string[];
 *   critical?: boolean;
 *   init(ctx: ModuleContext): Promise<ModuleHandle>;
 * }
 *
 * interface ModuleHandle {
 *   start?(): Promise<void>;
 *   stop?(): Promise<void>;
 *   health?(): HealthReport;
 * }
 * ```
 *
 * "`ModuleContext` is the only thing a module may reach for" (§6.1). Two
 * consequences are visible in the types below and are deliberate:
 *
 * - the context carries a {@link SecretResolver}, never a `SecretStore` — only
 *   the composition root holds a handle that can `set` or `delete` (§3.2);
 * - there is no `db`, only {@link Store}. A feature module has no supported way
 *   to reach the SQLite handle (§1.3).
 *
 * Feature modules never import each other (§6.1): they talk through the event
 * bus (fire-and-forget) and through service interfaces on the registry
 * (request/response), which is what makes the remote module removable without a
 * compile error anywhere else.
 */
import type { Logger } from 'pino';

import type { AppConfig } from '../config/index.js';
import type { RouteHandler } from '../http/types.js';
import type { SecretResolver } from '../secrets/index.js';
import type { Clock, SettingsRepository, Store } from '../storage/index.js';

export type { Clock };

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

/**
 * `ok` — working. `degraded` — running with a caveat the UI should show (the
 * keyfile fallback of §3.1 is the canonical one). `failed` — the module is not
 * running; only a non-critical module can reach this state and leave the
 * service up (§6.2). `not-started` — never got as far as `start()`.
 */
export type HealthStatus = 'ok' | 'degraded' | 'failed' | 'not-started';

/**
 * A condition the health system surfaces to the UI, with a stable id so it can
 * be tracked across restarts.
 *
 * Structurally identical to (and assignable from) the secrets module's
 * `HealthCondition`, which DESIGN §3 defined first and called "the smallest
 * shape [M7] can lift verbatim". `error` is added because a health system with
 * only one severity cannot express the difference between "weaker than you
 * asked for" and "not working".
 */
export interface HealthCondition {
  readonly id: string;
  readonly level: 'warn' | 'error';
  readonly message: string;
}

/** What a module answers when asked how it is doing (§6.1). */
export interface HealthReport {
  readonly status: HealthStatus;
  /** One line for a human; the conditions carry the detail worth acting on. */
  readonly message?: string;
  readonly conditions?: readonly HealthCondition[];
  /** Free-form facts for `/api/health` (schema version, queue depth, …). */
  readonly detail?: Readonly<Record<string, unknown>>;
}

/** A check registered through {@link ModuleContext.registerHealthCheck}. */
export type HealthCheck = () => HealthReport | Promise<HealthReport>;

/** One module's line in the aggregate (§6.2: "reports degraded modules individually"). */
export interface ModuleHealth extends HealthReport {
  readonly id: string;
  readonly critical: boolean;
  readonly conditions: readonly HealthCondition[];
  /** Present when the module failed to init or start; already stringified. */
  readonly error?: string;
}

/** The queryable aggregate M8 serves as `/api/health`. */
export interface HealthAggregate {
  /** Worst of the parts: `ok` only when every module and check is `ok`. */
  readonly status: HealthStatus;
  readonly phase: LifecyclePhase;
  readonly modules: readonly ModuleHealth[];
  /** Every condition raised anywhere, flattened for a UI banner. */
  readonly conditions: readonly HealthCondition[];
}

// ---------------------------------------------------------------------------
// Routes (§6.4 — M7 records, M8 mounts)
// ---------------------------------------------------------------------------

/**
 * Per-route remote policy (§6.4), **defaulting to `allow`**.
 *
 * "A module that adds a route which must never be reachable from the tailnet
 * declares `remote: 'deny'` at the point of registration — next to the code
 * that makes it dangerous." Foundation only records the flag and exposes it on
 * the route table; enforcement is remote's.
 */
export type RemotePolicy = 'allow' | 'deny';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS' | 'ALL';

/**
 * The handler contract, defined by M8 and re-exported here.
 *
 * M7 owned the route *table*, not the HTTP framework, and left this opaque
 * because "the request/response contract arrives with the server in M8, and
 * inventing one here would mean two definitions to reconcile". M8 defined it in
 * `src/http/types.ts`, next to the server that calls it, and this is the one
 * definition:
 *
 * ```ts
 * (req: RequestContext, res: ResponseTools) => HttpResult | void | Promise<…>
 * ```
 *
 * The import is type-only in both directions, so `src/modules` and `src/http`
 * still have no runtime dependency on each other.
 */
export type { RouteHandler };

/** What a module hands to {@link ModuleContext.registerRoutes}. */
export interface RouteDefinition {
  readonly method: HttpMethod;
  /** Framework-agnostic path pattern, e.g. `/api/sessions/:id/stream`. */
  readonly path: string;
  readonly handler: RouteHandler;
  /** §6.4 metadata; omitted means `allow`. */
  readonly remote?: RemotePolicy;
  /** Shown in diagnostics and in the route inventory test of M11. */
  readonly description?: string;
}

/** A "router": anything carrying a list of routes, so M8's framework object fits. */
export interface RouteProvider {
  readonly routes: readonly RouteDefinition[];
}

export type RouteRegistration = RouteDefinition | readonly RouteDefinition[] | RouteProvider;

/** A route as the table holds it: attributed to a module, policy resolved. */
export interface RegisteredRoute {
  readonly moduleId: string;
  readonly method: HttpMethod;
  readonly path: string;
  readonly handler: RouteHandler;
  /** Resolved — never `undefined`, so no consumer re-implements the default. */
  readonly remote: RemotePolicy;
  readonly description?: string;
}

// ---------------------------------------------------------------------------
// Events (§6.5)
// ---------------------------------------------------------------------------

/** The correlation ids of §1.4's `events` columns. */
export interface EventIds {
  readonly sessionId?: string;
  readonly assignmentId?: string;
  readonly projectId?: string;
  readonly agentId?: string;
}

/** What a module passes to {@link EventBus.emit}; the bus stamps the rest. */
export interface EmitEvent<P = unknown> {
  readonly type: string;
  readonly ids?: EventIds;
  readonly payload?: P;
  /** `true` writes a row to `events` in the same tick it is emitted (§6.5). */
  readonly persist?: boolean;
  /** ISO-8601 UTC. Defaults to the injected clock; set it only when replaying. */
  readonly ts?: string;
}

/** An event as subscribers see it: `{type, ts, ids, payload, persist?}` (§6.5). */
export interface AppEvent<P = unknown> {
  readonly type: string;
  readonly ts: string;
  readonly ids: EventIds;
  readonly payload?: P;
  readonly persist: boolean;
  /** The `events.id` watermark — present only when the row was written. */
  readonly id?: string;
}

export type EventListener<P = unknown> = (event: AppEvent<P>) => void;

/** Cancels a subscription. Safe to call twice. */
export type Unsubscribe = () => void;

/**
 * The in-process typed emitter of §6.5.
 *
 * Subscriptions are filterable by exact type or `prefix.*` pattern — the same
 * matcher `/api/events?types=` uses, "applied identically to the live fan-out
 * and to the `since=` replay, so a reconnect returns the same subset it was
 * streaming".
 */
export interface EventBus {
  /** Persists (when flagged) and then fans out. Returns the stamped event. */
  emit<P>(event: EmitEvent<P>): AppEvent<P>;
  /** Everything. */
  subscribe(listener: EventListener): Unsubscribe;
  /** Only the matching types; `undefined` means everything. */
  subscribe(types: readonly string[] | undefined, listener: EventListener): Unsubscribe;
  /** Live subscriber count, for diagnostics and tests. */
  subscriberCount(): number;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Boot-order markers (§4.2: "modules register boot tasks that run after storage
 * is up and before the listener binds. Foundation guarantees the hook and the
 * ordering").
 *
 * The guarantee is expressed as an ordered phase sequence rather than as a
 * comment, so a test can assert on it and M8/M9 can hook a named point instead
 * of a line number:
 *
 * `config-loaded → logging-ready → storage-ready → secrets-ready →
 *  modules-init → boot-tasks → listener-bind → ready → stopping → stopped`
 *
 * `listener-bind` is the module `start()` phase: a module that binds a socket
 * binds it in `start()`, so every boot task has already run by the time any
 * listener exists.
 */
export const LIFECYCLE_PHASES = [
  'config-loaded',
  'logging-ready',
  'storage-ready',
  'secrets-ready',
  'modules-init',
  'boot-tasks',
  'listener-bind',
  'ready',
  'stopping',
  'stopped',
] as const;

export type LifecyclePhase = (typeof LIFECYCLE_PHASES)[number];

export interface PhaseMark {
  readonly phase: LifecyclePhase;
  readonly at: string;
}

/** Observes phase transitions. The runtime logs them; tests record them. */
export type PhaseObserver = (phase: LifecyclePhase, detail?: Record<string, unknown>) => void;

/**
 * A task registered during `init` and run in the `boot-tasks` phase — after
 * storage is up, before any listener binds (§4.2). The runner uses it to move
 * `running` sessions from a previous life to `orphaned`.
 */
export type BootTask = () => void | Promise<void>;

// ---------------------------------------------------------------------------
// The module contract
// ---------------------------------------------------------------------------

/** The only thing a module may reach for (§6.1). */
export interface ModuleContext {
  /** The id of the module this context belongs to. */
  readonly moduleId: string;
  /** Frozen and immutable for the process lifetime (§2.4). */
  readonly config: AppConfig;
  /** The repositories of §1.4. There is no raw handle here, by design (§1.3). */
  readonly store: Store;
  /** `store.settings`, named on the context because §6.1 names it. */
  readonly settings: SettingsRepository;
  /** A child logger pre-tagged with `component: <module id>` (§5.1). */
  readonly logger: Logger;
  /** The read-only face of §3.2 — no module can `set` or `delete` a secret. */
  readonly secrets: SecretResolver;
  readonly bus: EventBus;
  /** Injectable, so tests are not time-dependent (§6.1). */
  readonly clock: Clock;

  /**
   * Records routes on foundation's one route table (§6.4). Accepts a single
   * route, an array, or any object with a `routes` array. M8 mounts the table;
   * M7 only records it.
   */
  registerRoutes(registration: RouteRegistration): void;
  /** Runs in the `boot-tasks` phase (§4.2). */
  registerBootTask(task: BootTask, name?: string): void;
  /** Contributes to `/api/health` alongside {@link ModuleHandle.health}. */
  registerHealthCheck(check: HealthCheck, name?: string): void;

  /** Publishes a service interface under `name`. Claiming a name twice throws. */
  provide<T>(name: string, api: T): void;
  /**
   * The service published under `name`, or `undefined`.
   *
   * `undefined` rather than a throw is the whole edition-gating mechanism
   * (§6.2): "any code that would want to ask 'are we home edition?' instead
   * asks whether a capability is present (`ctx.require('remote')` returns
   * undefined)".
   */
  require<T>(name: string): T | undefined;
}

export interface ModuleHandle {
  start?(): Promise<void> | void;
  stop?(): Promise<void> | void;
  health?(): HealthReport;
}

export interface Module {
  /** `storage` | `roster` | `runner` | `remote` | … Unique across the list. */
  readonly id: string;
  /** Ids this module must be started after. Every id must be present. */
  readonly dependsOn: readonly string[];
  /** Failure to init or start kills the process (§6.2: storage, secrets). */
  readonly critical?: boolean;
  init(ctx: ModuleContext): Promise<ModuleHandle> | ModuleHandle;
}
