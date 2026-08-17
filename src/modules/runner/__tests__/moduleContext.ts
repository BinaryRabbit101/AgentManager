/**
 * A {@link ModuleContext} over **real** storage and a **real** registry, for the
 * tests that need to prove the module's own wiring rather than the launch
 * chain's logic.
 *
 * Foundation's own module tests build the runtime; this is the smaller thing —
 * one module, initialised by hand, with services put on the registry in the
 * order a test chooses. That order is the point: it is how "orchestrator was not
 * there, then it was" becomes a two-line test.
 */
import type { Logger } from 'pino';

import { testConfig } from '../../__tests__/helpers.js';
import type { AppConfig } from '../../../config/index.js';
import type { SecretResolver } from '../../../secrets/index.js';
import type { Storage } from '../../../storage/index.js';
import { createEventBus } from '../../bus.js';
import type {
  BootTask,
  EventBus,
  HealthCheck,
  ModuleContext,
  RouteRegistration,
} from '../../types.js';

export interface TestModuleContext extends ModuleContext {
  /** Services published by the module under test. */
  readonly provided: Map<string, unknown>;
  /** Puts a service on the registry, as another module's `init` would. */
  register(name: string, api: unknown): void;
  readonly bootTasks: BootTask[];
  readonly routes: RouteRegistration[];
  readonly logs: { level: string; message: string; detail: unknown }[];
}

export interface TestModuleContextOptions {
  readonly storage: Storage;
  readonly moduleId: string;
  readonly config?: AppConfig;
  readonly secrets?: SecretResolver;
  readonly now?: () => Date;
}

export function createTestModuleContext(options: TestModuleContextOptions): TestModuleContext {
  const registry = new Map<string, unknown>();
  const provided = new Map<string, unknown>();
  const bootTasks: BootTask[] = [];
  const routes: RouteRegistration[] = [];
  const logs: { level: string; message: string; detail: unknown }[] = [];

  const record =
    (level: string) =>
    (first: unknown, second?: unknown): void => {
      logs.push({
        level,
        message: typeof first === 'string' ? first : typeof second === 'string' ? second : '',
        detail: typeof first === 'object' ? first : {},
      });
    };
  const logger = {
    level: 'debug',
    trace: record('trace'),
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    fatal: record('fatal'),
    silent: () => {},
    child: () => logger,
  } as unknown as Logger;

  const bus: EventBus = createEventBus({ clock: options.now ?? ((): Date => new Date()) });

  return {
    moduleId: options.moduleId,
    config: options.config ?? testConfig(),
    store: options.storage.store,
    settings: options.storage.store.settings,
    logger,
    secrets: options.secrets ?? { get: () => Promise.resolve(undefined) },
    bus,
    clock: options.now ?? ((): Date => new Date()),

    registerRoutes: (registration) => void routes.push(registration),
    registerBootTask: (task) => void bootTasks.push(task),
    registerHealthCheck: (_check: HealthCheck) => {},
    provide: (name, api) => {
      provided.set(name, api);
      registry.set(name, api);
    },
    require: <T>(name: string): T | undefined => registry.get(name) as T | undefined,

    provided,
    register: (name, api) => void registry.set(name, api),
    bootTasks,
    routes,
    logs,
  };
}
