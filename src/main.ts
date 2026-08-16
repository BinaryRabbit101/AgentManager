/**
 * AgentManager core entry point — the composition root of DESIGN §6.2.
 *
 * ```ts
 * const modules = [storage, secrets, http, roster, projects, runner];
 * if (config.modules.orchestrator.enabled) modules.push(orchestrator);
 * if (config.edition === 'home' && config.modules.remote.enabled) {
 *   modules.push((await import('./modules/remote')).default);   // dynamic import
 * }
 * ```
 *
 * This file is the only place that knows how the subsystems fit together:
 * config (M2) → logging (M3) → storage (M4/M5) → secrets (M6) → the module
 * runtime (M7). Everything below it takes plain options and imports none of its
 * siblings, which is what lets each be built and tested on its own.
 *
 * The HTTP surface (M8) and the Windows process lifecycle — single-instance
 * lock, `run/core.port`, graceful shutdown budget, the bind-time invariant of
 * §6.3 — are M9. Until M8's listener exists, {@link serve} holds the process
 * open itself and shuts down on SIGINT/SIGTERM.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { argv, exit, stderr, stdout } from 'node:process';

import type { Logger } from 'pino';

import { ConfigError, loadConfig, type AppConfig, type ConfigSourceMap } from './config/index.js';
import { createLogging, type Logging } from './logging/index.js';
import {
  createSecretStore,
  warnOnAnthropicApiKeyOverride,
  type HealthCondition as SecretsHealthCondition,
  type SecretResolver,
  type SecretStoreHandle,
  type TightenOptions,
} from './secrets/index.js';
import {
  dataRootPaths,
  defaultMigrationsDir,
  openStorage,
  type Clock,
  type DataRootPaths,
  type LogFn,
  type Storage,
} from './storage/index.js';
import {
  createEventBus,
  createSecretsModule,
  createStorageModule,
  moduleMigrationsFor,
  topologicalOrder,
  ModuleRuntime,
  MODULE_FAILURE_EXIT_CODE,
  describeError,
  type HealthAggregate,
  type Module,
  type PhaseObserver,
} from './modules/index.js';

const requireFromHere = createRequire(import.meta.url);

/** Reported when package.json cannot be located next to the running bundle. */
export const UNKNOWN_VERSION = '0.0.0-unknown';

export const PROGRAM_NAME = 'agentmanager';

/** Flags the configuration loader owns (DESIGN §2.1, layer 5). */
const CONFIG_FLAGS = new Set(['--set', '--edition', '--data-root']);

export interface ParsedArgs {
  readonly version: boolean;
  readonly help: boolean;
  /** Configuration flags, passed through to the loader untouched. */
  readonly config: readonly string[];
  /** Arguments nothing recognises. */
  readonly unknown: readonly string[];
}

/**
 * Splits the argument list (excluding `node` and the script path) into the CLI's
 * own flags, the configuration loader's, and the rest.
 *
 * The loader is not re-implemented here: `--set key=value`, `--edition` and
 * `--data-root` are recognised only well enough to know how many tokens they
 * consume, and are handed on verbatim so exactly one parser decides what they
 * mean.
 */
export function parseArgs(args: readonly string[]): ParsedArgs {
  let version = false;
  let help = false;
  const config: string[] = [];
  const unknown: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) continue;

    if (arg === '--version' || arg === '-v') {
      version = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }

    const eq = arg.indexOf('=');
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    if (CONFIG_FLAGS.has(flag)) {
      config.push(arg);
      // `--flag value` carries its value in the next token; `--flag=value` does not.
      const next = args[i + 1];
      if (eq === -1 && next !== undefined && !next.startsWith('--')) {
        config.push(next);
        i += 1;
      }
      continue;
    }

    unknown.push(arg);
  }

  return { version, help, config, unknown };
}

/** The version string from package.json, or {@link UNKNOWN_VERSION}. */
export function readVersion(): string {
  try {
    const pkg = requireFromHere('../package.json') as { version?: unknown };
    return typeof pkg.version === 'string' && pkg.version.length > 0
      ? pkg.version
      : UNKNOWN_VERSION;
  } catch {
    return UNKNOWN_VERSION;
  }
}

export function helpText(): string {
  return [
    `${PROGRAM_NAME} ${readVersion()}`,
    '',
    'Usage:',
    `  ${PROGRAM_NAME} [options]`,
    '',
    'Options:',
    '  -v, --version            Print the version and exit',
    '  -h, --help               Print this help and exit',
    '  --edition <home|work>    Override the configured edition for this run',
    '  --data-root <path>       Override the data root for this run',
    '  --set <key=value>        Override any configuration key for this run',
    '',
    'With no options the core service starts.',
  ].join('\n');
}

export interface RunIo {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

const defaultIo: RunIo = {
  out: (line) => void stdout.write(`${line}\n`),
  err: (line) => void stderr.write(`${line}\n`),
};

/**
 * Handles the CLI-only invocations and returns the process exit code, or `null`
 * when the caller should start the service.
 *
 * Pure with respect to the process: everything observable goes through
 * {@link RunIo}, and nothing here touches the data root — `--version` must
 * answer on a machine with no install at all.
 */
export function run(args: readonly string[], io: RunIo = defaultIo): number | null {
  const parsed = parseArgs(args);

  if (parsed.version) {
    io.out(readVersion());
    return 0;
  }

  if (parsed.help) {
    io.out(helpText());
    return 0;
  }

  if (parsed.unknown.length > 0) {
    io.err(`${PROGRAM_NAME}: unrecognised argument(s): ${parsed.unknown.join(' ')}`);
    io.err(helpText());
    return 2;
  }

  return null;
}

// ---------------------------------------------------------------------------
// The composition root
// ---------------------------------------------------------------------------

export interface BootOptions {
  /** Arguments after `node main.js`; defaults to `process.argv.slice(2)`. */
  readonly argv?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  /** Overrides install-root discovery. Tests point this at a fixture directory. */
  readonly installRoot?: string;
  /** Programmatic stand-in for `--data-root`; an actual flag wins over it. */
  readonly dataRoot?: string;
  /** Root holding `NNNN_*.sql` and `<moduleId>/`. Defaults to the packaged `migrations/`. */
  readonly migrationsDir?: string;
  /**
   * Modules appended to the foundation list before sorting.
   *
   * The seam M8–M11 use to boot a service with a fixture module, and the one
   * this milestone's tests use to prove critical vs. degradable failure through
   * the real boot path.
   */
  readonly additionalModules?: readonly Module[];
  /** Injectable, so tests are not time-dependent (§6.1). */
  readonly clock?: Clock;
  /** Adds the human-readable stderr stream. Defaults to "stderr is a TTY" (§5.1). */
  readonly pretty?: boolean;
  readonly writePretty?: (chunk: string) => void;
  /** Passed to the data-root bootstrap; `false` skips `icacls` on a temp root. */
  readonly tightenAcl?: boolean;
  /** ACL injection for the secrets directory, so tests mutate no real ACLs. */
  readonly acl?: TightenOptions;
  readonly onPhase?: PhaseObserver;
  readonly startTimeoutMs?: number;
  readonly stopTimeoutMs?: number;
  /** Called before a fatal boot error is rethrown. Defaults to `process.exit`. */
  readonly exit?: (code: number) => void;
  /** Where the fatal report goes when there is no logger yet. */
  readonly io?: RunIo;
}

/** A running service. M8 hangs the HTTP server off this; M9 the process lifecycle. */
export interface BootedService {
  readonly config: AppConfig;
  readonly sources: ConfigSourceMap;
  readonly paths: DataRootPaths;
  readonly logging: Logging;
  readonly storage: Storage;
  /** The full store — only the composition root holds one (§3.2). */
  readonly secrets: SecretStoreHandle;
  readonly runtime: ModuleRuntime;
  /** The aggregate M8 serves as `/api/health` (§6.2). */
  health(): Promise<HealthAggregate>;
  /** Stops modules in reverse order, closes the database, flushes the logs. */
  shutdown(): Promise<void>;
}

/** Adapts a pino logger to the plain sink storage and secrets accept. */
function toLogFn(logger: Logger): LogFn {
  return (level, msg, data) => {
    logger[level](data ?? {}, msg);
  };
}

/**
 * Builds §6.2's module list.
 *
 * Foundation's own modules come first and are `critical`; `http`, `roster`,
 * `projects`, `runner` and `orchestrator` join as their elements land. The
 * remote module is reached through a **dynamic import** behind the edition
 * gate, so in the work edition its file is never evaluated.
 */
async function buildModuleList(options: {
  readonly config: AppConfig;
  readonly storage: () => Storage;
  readonly secrets: () => SecretStoreHandle;
  readonly secretConditions: () => readonly SecretsHealthCondition[];
  readonly additional: readonly Module[];
  readonly log: Logger;
}): Promise<readonly Module[]> {
  const { config } = options;
  const modules: Module[] = [
    createStorageModule(options.storage),
    createSecretsModule({ get: options.secrets, conditions: options.secretConditions }),
  ];

  if (config.edition === 'home' && config.modules.remote.enabled) {
    const loaded = (await import('./modules/remote/index.js')) as { default: Module };
    modules.push(loaded.default);
    options.log.info('remote module loaded (edition "home", modules.remote.enabled)');
  } else {
    options.log.debug(
      { edition: config.edition, enabled: config.modules.remote.enabled },
      'remote module not loaded; its file is never imported in this configuration',
    );
  }

  modules.push(...options.additional);
  return modules;
}

/**
 * Brings the whole service up: config, logging, storage, secrets, modules.
 *
 * On a fatal failure — invalid configuration, a corrupt database, a `critical`
 * module that will not start (§6.2) — it reports the problem, tears down
 * whatever it had already built, calls {@link BootOptions.exit} with a non-zero
 * code, and rethrows. Exiting *and* throwing is deliberate: the default `exit`
 * never returns, while an injected one (tests, an embedding host) does, and a
 * caller that carries on must not be handed a half-built service.
 */
export async function boot(options: BootOptions = {}): Promise<BootedService> {
  const env = options.env ?? process.env;
  const io = options.io ?? defaultIo;
  const clock = options.clock ?? ((): Date => new Date());
  const migrationsRoot = options.migrationsDir ?? defaultMigrationsDir();
  const exitWith =
    options.exit ??
    ((code: number): void => {
      exit(code);
    });

  const phase: PhaseObserver = (name, detail) => {
    options.onPhase?.(name, detail);
  };

  let logging: Logging | undefined;
  let storage: Storage | undefined;
  let runtime: ModuleRuntime | undefined;

  try {
    // --- Configuration (M2). Resolves before anything else exists, because
    // everything else is configured by it.
    const loaded = loadConfig({
      argv: options.argv ?? [],
      env,
      ...(options.installRoot === undefined ? {} : { installRoot: options.installRoot }),
      ...(options.dataRoot === undefined ? {} : { dataRootOverride: options.dataRoot }),
    });
    const { config } = loaded;
    phase('config-loaded', { edition: config.edition, dataRoot: loaded.paths.dataRoot });

    const rootOptions = {
      dataRoot: loaded.paths.dataRoot,
      ...(config.library.root === null ? {} : { libraryRoot: config.library.root }),
      ...(config.projects.worktreesRoot === null
        ? {}
        : { worktreesRoot: config.projects.worktreesRoot }),
    };
    const paths = dataRootPaths(rootOptions.dataRoot, rootOptions);

    // --- Logging (M3). Created before storage so the migration runner's own
    // messages land in `core.log` like everything else.
    logging = createLogging({
      logsDir: paths.logs,
      level: config.logging.level,
      maxFileMB: config.logging.maxFileMB,
      maxFiles: config.logging.maxFiles,
      retentionDays: config.logging.retentionDays,
      now: clock,
      ...(options.pretty === undefined ? {} : { pretty: options.pretty }),
      ...(options.writePretty === undefined ? {} : { writePretty: options.writePretty }),
    });
    const log = logging.child('core');
    phase('logging-ready', { logs: paths.logs });

    log.info(
      {
        version: readVersion(),
        edition: config.edition,
        dataRoot: paths.dataRoot,
        configFile: loaded.paths.configFile,
      },
      'starting agentmanager core',
    );
    for (const warning of loaded.warnings) {
      log.warn({ code: warning.code, key: warning.key }, warning.message);
    }

    // --- The module graph, built before storage opens: its topological order
    // is what decides the order element-owned migrations are applied in (§1.3).
    let secretStore: SecretStoreHandle | undefined = undefined;
    let secretConditions: readonly SecretsHealthCondition[] = [];

    const modules = await buildModuleList({
      config,
      storage: () => requireResource(storage, 'storage'),
      secrets: () => requireResource(secretStore, 'secrets'),
      secretConditions: () => secretConditions,
      additional: options.additionalModules ?? [],
      log,
    });
    const order = topologicalOrder(modules);

    // --- Storage (M4/M5).
    storage = openStorage({
      ...rootOptions,
      migrationsDir: migrationsRoot,
      moduleMigrations: moduleMigrationsFor(order, migrationsRoot),
      retention: {
        eventDays: config.retention.eventDays,
        eventMaxRows: config.retention.eventMaxRows,
      },
      log: toLogFn(logging.child('storage')),
      clock,
      ...(options.tightenAcl === undefined ? {} : { tightenAcl: options.tightenAcl }),
    });
    phase('storage-ready', { schemaVersion: storage.schemaVersion });

    // --- Secrets (M6). The composition root keeps the only writable handle;
    // modules receive the read-only face (§3.2).
    const secretsLog = toLogFn(logging.child('secrets'));
    secretStore = await createSecretStore({
      secretsDir: paths.secrets,
      provider: config.secrets.provider,
      env,
      log: secretsLog,
      now: clock,
      ...(options.acl === undefined ? {} : { acl: options.acl }),
    });
    const anthropic = warnOnAnthropicApiKeyOverride(secretsLog, {
      env,
      authMode: config.auth.mode,
    });
    secretConditions = anthropic === undefined ? [] : [anthropic];
    phase('secrets-ready', { provider: secretStore.provider });

    const resolver: SecretResolver = {
      get: (key) => requireResource(secretStore, 'secrets').get(key),
    };

    // --- The event bus (§6.5): persisted events land in `events`, and neither
    // a failing subscriber nor a failing write takes the emitter down.
    const busLog = logging.child('events');
    const bus = createEventBus({
      clock,
      events: storage.store.events,
      onListenerError: (error, event) => {
        busLog.error(
          { type: event.type, err: error },
          `event subscriber threw: ${describeError(error)}`,
        );
      },
      onPersistError: (error, event) => {
        busLog.error(
          { type: event.type, err: error },
          `event could not be persisted: ${describeError(error)}`,
        );
      },
    });

    runtime = new ModuleRuntime({
      modules: order,
      config,
      store: storage.store,
      secrets: resolver,
      logger: (component) => requireResource(logging, 'logging').child(component),
      clock,
      bus,
      onPhase: phase,
      ...(options.startTimeoutMs === undefined ? {} : { startTimeoutMs: options.startTimeoutMs }),
      ...(options.stopTimeoutMs === undefined ? {} : { stopTimeoutMs: options.stopTimeoutMs }),
    });

    await runtime.startAll();

    const service: BootedService = {
      config,
      sources: loaded.sources,
      paths,
      logging,
      storage,
      secrets: secretStore,
      runtime,
      health: () => requireResource(runtime, 'runtime').health(),
      shutdown: async () => {
        // Modules stop in reverse order, which puts storage's WAL checkpoint
        // and close last (§4.2); the log streams outlive them so a shutdown
        // failure is still recorded.
        await requireResource(runtime, 'runtime').stop();
        log.info('agentmanager core stopped');
        await requireResource(logging, 'logging').flushAndClose();
      },
    };

    log.info({ modules: runtime.order }, 'agentmanager core ready');
    return service;
  } catch (error) {
    const code = error instanceof ConfigError ? error.exitCode : MODULE_FAILURE_EXIT_CODE;
    const report = error instanceof ConfigError ? error.report() : describeError(error);

    if (logging === undefined) {
      io.err(`${PROGRAM_NAME}: ${report}`);
    } else {
      logging.child('core').fatal({ err: error }, `refusing to start: ${report}`);
    }

    // Unwind in the same order `shutdown()` would, tolerating everything: this
    // path runs *because* something is already wrong.
    await safely(() => runtime?.stop());
    // `close()` is idempotent, so this covers both the case where the storage
    // module never got as far as owning the handle and the case where it did.
    storage?.close();
    await safely(() => logging?.flushAndClose());

    exitWith(code);
    throw error;
  }
}

/** Reads a resource the boot sequence has already built, or fails loudly. */
function requireResource<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw new Error(
      `Internal error: "${name}" was used before the composition root built it. ` +
        'This means the boot order in main.ts changed without its dependents.',
    );
  }
  return value;
}

async function safely(operation: () => Promise<void> | void): Promise<void> {
  try {
    await operation();
  } catch {
    // Nothing useful left to do: this is the failure path's own cleanup.
  }
}

/**
 * Boots the service and keeps the process alive until SIGINT/SIGTERM.
 *
 * The keep-alive handle is a placeholder for M8's listener, which will hold the
 * event loop open by itself; M9 replaces the signal handling here with the real
 * lifecycle (single-instance lock, `run/core.port`, the
 * `service.shutdownGraceSeconds` budget).
 */
export async function serve(args: readonly string[], options: BootOptions = {}): Promise<void> {
  const service = await boot({ argv: args, ...options });

  const keepAlive = setInterval(() => {
    // Nothing: an empty ref'd timer is the smallest thing that holds the event
    // loop open while no listener is bound yet.
  }, 60_000);

  let stopping = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (stopping) return;
    stopping = true;
    clearInterval(keepAlive);
    service.logging.child('core').info({ signal }, 'shutdown signal received');
    void service.shutdown().then(
      () => exit(0),
      () => exit(MODULE_FAILURE_EXIT_CODE),
    );
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

/** True when this file is the process entry point rather than an import. */
function isEntryPoint(): boolean {
  const invoked = argv[1];
  if (invoked === undefined) return false;
  try {
    return realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  const args = argv.slice(2);
  const code = run(args);
  if (code !== null) {
    exit(code);
  } else {
    // `boot` has already reported and exited on failure; the rejection it
    // rethrows is for programmatic callers.
    void serve(args).catch(() => undefined);
  }
}
