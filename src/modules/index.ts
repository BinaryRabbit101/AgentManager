/**
 * The module system (foundation DESIGN §6, milestone M7).
 *
 * This is the seam every other element is written against:
 * {@link Module} / {@link ModuleHandle} / {@link ModuleContext} (§6.1), the
 * service registry and typed event bus (§6.1, §6.5), the route table M8 mounts
 * (§6.4), and the runner that orders, starts, stops and health-checks the lot
 * (§6.2). The composition root that assembles it from real config, storage,
 * logging and secrets is `src/main.ts`.
 *
 * Nothing here imports a feature module. The one feature module foundation
 * knows the *path* of — `./remote/index.js` — is reached through a dynamic
 * import in the composition root and never through this file (§6.2).
 */
export type {
  AppEvent,
  BootTask,
  Clock,
  EmitEvent,
  EventBus,
  EventIds,
  EventListener,
  HealthAggregate,
  HealthCheck,
  HealthCondition,
  HealthReport,
  HealthStatus,
  HttpMethod,
  LifecyclePhase,
  Module,
  ModuleContext,
  ModuleHandle,
  ModuleHealth,
  PhaseMark,
  PhaseObserver,
  RegisteredRoute,
  RemotePolicy,
  RouteDefinition,
  RouteHandler,
  RouteProvider,
  RouteRegistration,
  Unsubscribe,
} from './types.js';
export { LIFECYCLE_PHASES } from './types.js';

export {
  createEventBus,
  createEventTypeFilter,
  matchesEventType,
  type EventBusOptions,
} from './bus.js';

export { ServiceRegistry, type ProvidedService } from './registry.js';
export { RouteTable, DEFAULT_REMOTE_POLICY } from './routes.js';

export { moduleMigrationsFor, topologicalOrder, type ModuleMigrationDir } from './graph.js';

export {
  ModuleRuntime,
  DEFAULT_START_TIMEOUT_MS,
  DEFAULT_STOP_TIMEOUT_MS,
  type ModuleRuntimeOptions,
} from './runtime.js';

export {
  createSecretsModule,
  createStorageModule,
  SECRETS_SERVICE,
  STORAGE_SERVICE,
  type SecretsModuleOptions,
  type SecretsService,
  type StorageService,
} from './foundation.js';

export {
  CriticalModuleFailureError,
  ModuleConflictError,
  ModuleError,
  ModuleGraphError,
  ModuleTimeoutError,
  MODULE_FAILURE_EXIT_CODE,
  describeError,
} from './errors.js';

export { moduleLoadCount, noteModuleLoaded, resetModuleLoadCount } from './loadProbe.js';
