/**
 * AgentManager core entry point — the composition root of DESIGN §6.2.
 *
 * ```ts
 * const modules = [storage, secrets, http, roster, projects, runner];
 * if (config.modules.orchestrator.enabled) modules.push(orchestrator);
 * if (config.edition === 'home' && config.modules.remote.enabled) {
 *   const remote = await import('./modules/remote/index.js');            // dynamic
 *   modules.push(remote.createRemoteModule({ accessLogger }, options.remote));
 * }
 * ```
 *
 * This file is the only place that knows how the subsystems fit together:
 * config (M2) → logging (M3) → storage (M4/M5) → secrets (M6) → the module
 * runtime (M7) → the HTTP surface (M8). Everything below it takes plain options
 * and imports none of its siblings, which is what lets each be built and tested
 * on its own.
 *
 * The split between {@link boot} and {@link serve} is the split between a
 * service and a process. `boot` assembles a running service and hands it back;
 * it is what a test, an install script or an embedding host calls. `serve` adds
 * everything that is true only of *the* core process (M9, §4.2): the exclusive
 * single-instance lock on `run/core.lock`, the `run/core.port` publication that
 * Electron discovers the port through, SIGINT/SIGTERM, and the
 * `service.shutdownGraceSeconds` budget. The one lifecycle concern `boot` keeps
 * is §6.3's bind-time invariant, because a service with a socket bound where the
 * edition forbids it must not exist even for a test.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { argv, exit } from 'node:process';

import type { Logger } from 'pino';

import {
  COMMAND_FLAGS,
  VALUED_COMMAND_FLAGS,
  commandHelp,
  createCliContext,
  defaultIo,
  isCommandName,
  runCommand,
  type CliContext,
  type RunIo,
} from './cli/index.js';
import { ConfigError, loadConfig, type AppConfig, type ConfigSourceMap } from './config/index.js';
import {
  BindInvariantError,
  LOCK_FILENAME,
  PORT_FILENAME,
  REMOTE_SERVICE,
  acquireInstanceLock,
  alreadyRunningMessage,
  assertBindInvariant,
  createShutdownController,
  installShutdownSignals,
  observeListeners,
  probeCore,
  readPortFile,
  removePortFile,
  writePortFile,
  type BindInvariantReport,
  type InstanceLock,
  type ListenerObservation,
  type RemoteService,
  type ShutdownController,
} from './lifecycle/index.js';
import {
  createHttpModule,
  HTTP_SERVICE,
  type HttpModuleOptions,
  type HttpService,
} from './http/index.js';
import { createLogging, type Logging } from './logging/index.js';
import { createOrchestratorModule } from './modules/orchestrator/index.js';
import { createProjectsModule } from './modules/projects/index.js';
import { createRosterModule } from './modules/roster/index.js';
// Type-only, and from `options.ts` rather than from the module's `index.ts`:
// `import type` is erased, and the file it points at contains no load probe, no
// listener and nothing that runs, so the work edition's "never imported" guarantee
// holds even against a bundler that resolved the edge (foundation §6.2).
import type { RemoteModuleOptions } from './modules/remote/options.js';
import { createRunnerModule, type RunnerModuleOptions } from './modules/runner/index.js';
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
  /**
   * Positional words: the verb and its arguments (`['secrets', 'set', '<key>']`).
   *
   * Empty means "start the service", which is what `agentmanager` with no
   * arguments has always meant and what the scheduled task of §4.3 invokes.
   */
  readonly command: readonly string[];
  /** Recognised command flags, `--stdin` / `--json` / `--wait[=<s>]` (§4.4). */
  readonly flags: ReadonlyMap<string, string | true>;
  /** Arguments nothing recognises. */
  readonly unknown: readonly string[];
}

/**
 * Splits the argument list (excluding `node` and the script path) into the CLI's
 * own flags, the configuration loader's, the command words, and the rest.
 *
 * The loader is not re-implemented here: `--set key=value`, `--edition` and
 * `--data-root` are recognised only well enough to know how many tokens they
 * consume, and are handed on verbatim so exactly one parser decides what they
 * mean.
 *
 * Positional words are collected rather than rejected, because M10 gives the
 * binary verbs (`migrate`, `health`, `secrets set`) as well as a service mode.
 * Whether the first word *names* a verb is {@link run}'s question, not this
 * one's — a parser that also validated would have to know the command table.
 */
export function parseArgs(args: readonly string[]): ParsedArgs {
  let version = false;
  let help = false;
  const config: string[] = [];
  const command: string[] = [];
  const flags = new Map<string, string | true>();
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

    if (COMMAND_FLAGS.has(flag)) {
      if (eq !== -1) {
        flags.set(flag, arg.slice(eq + 1));
      } else if (VALUED_COMMAND_FLAGS.has(flag)) {
        const next = args[i + 1];
        if (next !== undefined && !next.startsWith('-')) {
          flags.set(flag, next);
          i += 1;
        } else {
          flags.set(flag, true);
        }
      } else {
        flags.set(flag, true);
      }
      continue;
    }

    if (!arg.startsWith('-')) {
      command.push(arg);
      continue;
    }

    unknown.push(arg);
  }

  return { version, help, config, command, flags, unknown };
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
    `  ${PROGRAM_NAME} [options]              Start the core service`,
    `  ${PROGRAM_NAME} <command> [options]`,
    '',
    ...commandHelp(),
    '',
    'Options:',
    '  -v, --version            Print the version and exit',
    '  -h, --help               Print this help and exit',
    '  --edition <home|work>    Override the configured edition for this run',
    '  --data-root <path>       Override the data root for this run',
    '  --set <key=value>        Override any configuration key for this run',
    '',
    'With no command the core service starts.',
  ].join('\n');
}

/** Re-exported so callers of `run`/`boot` need not know where the seam lives. */
export type { RunIo } from './cli/index.js';

/**
 * Handles the CLI-only invocations and returns the process exit code, or `null`
 * when the caller should proceed — to a command, or to the service.
 *
 * Pure with respect to the process: everything observable goes through
 * {@link RunIo}, and nothing here touches the data root — `--version` must
 * answer on a machine with no install at all. Command *execution* is
 * deliberately not here, because every verb is asynchronous and touches disk;
 * this only decides that a verb was named and that its name is real.
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

  const verb = parsed.command[0];
  if (verb !== undefined && !isCommandName(verb)) {
    io.err(`${PROGRAM_NAME}: unknown command "${verb}".`);
    io.err(helpText());
    return 2;
  }

  // A command flag with no command would silently do nothing, which is worse
  // than saying so: `agentmanager --stdin` is a mistyped `secrets set`.
  if (verb === undefined && parsed.flags.size > 0) {
    io.err(
      `${PROGRAM_NAME}: ${[...parsed.flags.keys()].join(' ')} applies to a command, but none was given.`,
    );
    io.err(helpText());
    return 2;
  }

  return null;
}

export interface MainOptions {
  readonly io?: RunIo;
  /** Injected wholesale by the CLI tests; process-shaped defaults otherwise. */
  readonly cli?: Partial<CliContext>;
  readonly boot?: BootOptions;
}

/**
 * The process entry point's whole decision, as a function.
 *
 * Three outcomes, in the order they are checked: a flag that answers on its own
 * (`--version`), a verb (M10's `migrate`/`health`/`secrets`), or the service.
 * Only the last one does not return — {@link serve} keeps the event loop alive
 * — which is why this resolves `null` for it and an exit code for the others.
 */
export async function main(
  args: readonly string[],
  options: MainOptions = {},
): Promise<number | null> {
  const io = options.io ?? defaultIo;

  const code = run(args, io);
  if (code !== null) return code;

  const parsed = parseArgs(args);
  if (parsed.command.length > 0) {
    return runCommand(
      {
        words: parsed.command,
        flags: parsed.flags,
        config: parsed.config,
        ctx: createCliContext({ io, ...options.cli }),
      },
      readVersion(),
    );
  }

  await serve(args, options.boot ?? {});
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
  /**
   * Listener overrides for the `http` module (M8).
   *
   * `port: 0` asks the OS for an ephemeral port, which is how tests bind
   * without competing for 7477 — the config schema requires a real port number,
   * and rightly so, so the escape hatch is here rather than in configuration.
   */
  readonly http?: {
    readonly bind?: string;
    readonly port?: number;
    readonly webRoot?: string;
    readonly heartbeatMs?: number;
  };
  /**
   * Handles `POST /api/service/shutdown`. Defaults to the service's own
   * {@link BootedService.shutdown}; {@link serve} replaces it with the full
   * lifecycle (grace budget, `run/core.port` removal, lock release).
   */
  readonly onShutdownRequest?: (reason: string) => void;
  /**
   * Overrides §6.3's listener enumeration.
   *
   * The real one walks the process's own libuv handles, which is what makes the
   * assertion a second, independent claim rather than a module's own word (see
   * `lifecycle/bind.ts`). Tests inject a set so a fatal case can be proven
   * without binding a socket to a real interface.
   */
  readonly listeners?: () => ListenerObservation;
  readonly startTimeoutMs?: number;
  readonly stopTimeoutMs?: number;
  /** Called before a fatal boot error is rethrown. Defaults to `process.exit`. */
  readonly exit?: (code: number) => void;
  /** Where the fatal report goes when there is no logger yet. */
  readonly io?: RunIo;
  /**
   * Passed through to `createRunnerModule` — the SDK `query` seam and the
   * internals hook. Tests and demo scripts inject a scripted query here to
   * drive full session lifecycles through the real composition root without a
   * token or a subprocess.
   */
  readonly runner?: RunnerModuleOptions;
  /**
   * Passed through to `createRemoteModule` — Tailscale detection, the listener's
   * timers and jitter, and a port override.
   *
   * Every remote test injects detection here rather than depending on whether the
   * machine running the suite happens to be on a tailnet; `port: 0` is the same
   * ephemeral-port escape hatch {@link BootOptions.http} provides, for the same
   * reason (the schema requires a real port number, and rightly so).
   */
  readonly remote?: RemoteModuleOptions;
}

/** A running service. M8 hangs the HTTP server off this; M9 the process lifecycle. */
export interface BootedService {
  readonly config: AppConfig;
  readonly sources: ConfigSourceMap;
  readonly paths: DataRootPaths;
  /** Where the shipped, read-only configuration layers were read from (§1.2). */
  readonly installRoot: string;
  /** The local listener's base URL (`http://127.0.0.1:7477`), once started. */
  url(): string | undefined;
  readonly logging: Logging;
  readonly storage: Storage;
  /** The full store — only the composition root holds one (§3.2). */
  readonly secrets: SecretStoreHandle;
  readonly runtime: ModuleRuntime;
  /** What §6.3's post-start assertion saw. Always satisfied — it throws otherwise. */
  readonly bind: BindInvariantReport;
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
  readonly http: HttpModuleOptions;
  readonly runner?: RunnerModuleOptions | undefined;
  readonly remote?: RemoteModuleOptions | undefined;
  /** `access.log`'s stream, which remote's second listener writes to as well. */
  readonly accessLogger: Logger;
  readonly additional: readonly Module[];
  readonly log: Logger;
}): Promise<readonly Module[]> {
  const { config } = options;
  const modules: Module[] = [
    createStorageModule(options.storage),
    createSecretsModule({ get: options.secrets, conditions: options.secretConditions }),
    createHttpModule(options.http),
    createRosterModule(options.storage),
    createProjectsModule(options.storage),
    createRunnerModule(options.storage, options.runner),
  ];

  // §6.2's gate, and the one this module is *designed* to be absent behind:
  // runner's §11.3 already says what a missing `orchestrator` means for it
  // (degraded questions, no launch path) and roster drops its
  // `mcp__agentmanager__*` rules with a diagnostic. Unlike `remote` this is a
  // static import — the module ships in both editions and the flag is an
  // operator's switch, not an edition invariant.
  if (config.modules.orchestrator.enabled) modules.push(createOrchestratorModule(options.storage));

  if (config.edition === 'home' && config.modules.remote.enabled) {
    const loaded = (await import('./modules/remote/index.js')) as {
      createRemoteModule: (
        deps: { readonly accessLogger: Logger },
        options?: RemoteModuleOptions,
      ) => Module;
    };
    // `access.log` is not on `ModuleContext` (modules get `ctx.logger`, which is
    // `core.log`), and remote is the second listener on the same route table, so
    // its request lines belong on the same stream with the same redaction chain.
    modules.push(loaded.createRemoteModule({ accessLogger: options.accessLogger }, options.remote));
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
  let service: BootedService | undefined;
  let shutdownRequested = false;

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

    // `POST /api/service/shutdown` (§4.2). Guarded against re-entry, and
    // deferred to the caller when one is supplied — M9's lifecycle takes it
    // over, which is why the route calls a function rather than `process.exit`.
    const requestShutdown = (reason: string): void => {
      if (shutdownRequested) return;
      shutdownRequested = true;
      if (options.onShutdownRequest !== undefined) {
        options.onShutdownRequest(reason);
        return;
      }
      log.info({ reason }, 'graceful shutdown starting');
      void requireResource(service, 'service')
        .shutdown()
        .catch((failure: unknown) => {
          log.error({ err: failure }, `shutdown failed: ${describeError(failure)}`);
        });
    };

    const modules = await buildModuleList({
      config,
      storage: () => requireResource(storage, 'storage'),
      secrets: () => requireResource(secretStore, 'secrets'),
      secretConditions: () => secretConditions,
      http: {
        version: readVersion(),
        // Read at `start()`, by which point every module's `init` has run and
        // the table is complete (§6.4).
        routes: () => requireResource(runtime, 'runtime').routes.routes,
        sources: loaded.sources,
        origins: {
          installRoot: loaded.paths.installRoot,
          dataRoot: loaded.paths.dataRoot,
          configFile: loaded.paths.configFile,
          editionFile: loaded.paths.editionFile,
        },
        logging: requireResource(logging, 'logging'),
        logsDir: paths.logs,
        health: () => requireResource(runtime, 'runtime').health(),
        phase: () => requireResource(runtime, 'runtime').phase,
        requestShutdown,
        installRoot: loaded.paths.installRoot,
        startedAt: clock(),
        ...(options.http?.bind === undefined ? {} : { bind: options.http.bind }),
        ...(options.http?.port === undefined ? {} : { port: options.http.port }),
        ...(options.http?.webRoot === undefined ? {} : { webRoot: options.http.webRoot }),
        ...(options.http?.heartbeatMs === undefined
          ? {}
          : { heartbeatMs: options.http.heartbeatMs }),
      },
      runner: options.runner,
      remote: options.remote,
      accessLogger: logging.accessLogger,
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

    // --- The bind-time invariant (§6.3), after every module has started and
    // before the service is handed to anyone. A violation throws, and the catch
    // below unwinds and exits — "a boundary that actually holds" (§8).
    const bind = assertBindTimeInvariant({
      edition: config.edition,
      runtime,
      log,
      ...(options.listeners === undefined ? {} : { observe: options.listeners }),
    });

    service = {
      config,
      sources: loaded.sources,
      paths,
      installRoot: loaded.paths.installRoot,
      bind,
      url: () =>
        requireResource(runtime, 'runtime').registry.require<HttpService>(HTTP_SERVICE)?.url(),
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
    const code =
      error instanceof ConfigError || error instanceof BindInvariantError
        ? error.exitCode
        : MODULE_FAILURE_EXIT_CODE;
    const report = error instanceof ConfigError ? error.report() : describeError(error);

    if (logging === undefined) {
      io.err(`${PROGRAM_NAME}: ${report}`);
    } else {
      logging.child('core').fatal({ err: error }, `refusing to start: ${report}`);
      // §6.3 is a security boundary, and the core normally runs with no console
      // at all (§4.3's scheduled task). When it *does* have one — an owner
      // debugging a bind — the reason must be on it, not only in a file.
      if (error instanceof BindInvariantError) io.err(`${PROGRAM_NAME}: ${report}`);
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

/**
 * §6.3's assertion, wired to the running process.
 *
 * The two claims it compares come from deliberately different places: the
 * listener set from the process's own handles, and the remote address from
 * `ctx.require('remote').boundAddress()` — the module's published claim, never
 * re-derived here. A remote module that is absent (work edition), a placeholder
 * (no service on the registry), or present but bound to nothing all yield the
 * same `null`, which is exactly why a home edition with remote disabled behaves
 * like the work edition.
 *
 * @throws BindInvariantError — fatal, per §6.3.
 */
function assertBindTimeInvariant(input: {
  readonly edition: AppConfig['edition'];
  readonly runtime: ModuleRuntime;
  readonly log: Logger;
  readonly observe?: () => ListenerObservation;
}): BindInvariantReport {
  const { runtime, log } = input;

  // The `http` module's own address, used only when the handle list cannot be
  // read: something is better than nothing, and the report says which it was.
  const local = runtime.registry.require<HttpService>(HTTP_SERVICE)?.address();
  const fallback =
    local === undefined ? [] : [{ address: local.address, port: local.port, family: local.family }];

  const observation = input.observe?.() ?? observeListeners(fallback);
  if (observation.source === 'fallback') {
    log.warn(
      { listeners: observation.listeners.length },
      "could not enumerate this process's listening sockets; the bind-time invariant of §6.3 " +
        'was checked against the listeners foundation knows about, which is weaker',
    );
  }

  const remote = runtime.registry.require<RemoteService>(REMOTE_SERVICE)?.boundAddress() ?? null;
  const report = assertBindInvariant({
    edition: input.edition,
    listeners: observation.listeners,
    remote,
  });

  for (const warning of report.warnings) log.warn({ remote }, warning);
  log.info(
    {
      edition: report.edition,
      source: observation.source,
      loopback: report.loopback.map((listener) => `${listener.address}:${String(listener.port)}`),
      nonLoopback: report.nonLoopback.map(
        (listener) => `${listener.address}:${String(listener.port)}`,
      ),
      remote,
    },
    'bind-time invariant satisfied',
  );
  return report;
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
 * Loads configuration for the sole purpose of locating `run/`, tolerating
 * failure.
 *
 * A broken configuration is *not* reported here: {@link boot} below hits the
 * same failure and owns the per-key report (§2.1, "fatal at boot with a per-key
 * error report"). Duplicating that formatting is how the two copies drift, so
 * this returns `undefined` and lets the single owner speak. The consequence is
 * benign — a core that cannot read its own configuration takes no lock, and it
 * is about to exit non-zero anyway.
 */
function tryLoadConfig(
  args: readonly string[],
  options: BootOptions,
): ReturnType<typeof loadConfig> | undefined {
  try {
    return loadConfig({
      argv: args,
      env: options.env ?? process.env,
      ...(options.installRoot === undefined ? {} : { installRoot: options.installRoot }),
      ...(options.dataRoot === undefined ? {} : { dataRootOverride: options.dataRoot }),
    });
  } catch {
    return undefined;
  }
}

/**
 * §4.2's stale-file rule: "A stale file whose `/healthz` does not answer is
 * ignored and overwritten."
 *
 * Reaching this point means the single-instance lock is held by *this* process,
 * so any `run/core.port` on disk was left by a core that died without deleting
 * it — a hard kill, a power cut. The probe still runs, because the answer
 * changes what the owner needs to be told: silence is the ordinary stale case,
 * while an answer means some unrelated program now holds that port and the file
 * would have sent Electron to it.
 */
async function reconcileStalePortFile(path: string, log: Logger): Promise<void> {
  const stale = readPortFile(path);
  if (stale === undefined) return;

  const answered = await probeCore(stale.port);
  log.warn(
    { file: path, port: stale.port, pid: stale.pid, startedAt: stale.startedAt },
    answered === undefined
      ? `ignoring a stale ${PORT_FILENAME} from a previous core: nothing answers /healthz on port ` +
          `${String(stale.port)}. It will be overwritten.`
      : `overwriting ${PORT_FILENAME}: something answers /healthz on port ${String(stale.port)}, ` +
          'but this process holds the single-instance lock, so it is not an agentmanager core.',
  );
}

/**
 * Runs the core as a process: the whole of DESIGN §4.2.
 *
 * 1. **Single instance.** `run/core.lock` is opened with an exclusive handle
 *    before anything else — in particular before storage, so a second instance
 *    never touches the database. Losing the race is not an error: it prints the
 *    running port from `run/core.port` and exits 0.
 * 2. **Boot**, which ends with §6.3's bind-time assertion.
 * 3. **Discovery.** Any stale `run/core.port` is reported and overwritten with
 *    `{port, pid, startedAt, edition}` for the port actually bound.
 * 4. **Shutdown.** SIGINT, SIGTERM and `POST /api/service/shutdown` all reach
 *    one controller with one budget; the port file and the lock go on every
 *    path out.
 *
 * Nothing artificial holds the event loop open: the `http` module's listener
 * does it, which is the correct reason for a service process to stay up.
 */
export async function serve(args: readonly string[], options: BootOptions = {}): Promise<void> {
  const io = options.io ?? defaultIo;
  const clock = options.clock ?? ((): Date => new Date());
  const exitWith =
    options.exit ??
    ((code: number): void => {
      exit(code);
    });

  // --- 1. Single instance (§4.2), before storage exists.
  const preflight = tryLoadConfig(args, options);
  let lock: InstanceLock | undefined;
  let portFile: string | undefined;

  if (preflight !== undefined) {
    // `run/` is "recreated on boot if missing" (§1.2), and the lock creates it:
    // the very first thing this process does needs it to exist, which is well
    // before the storage bootstrap that repairs the rest of the tree.
    const run = dataRootPaths(preflight.paths.dataRoot).run;
    const lockFile = join(run, LOCK_FILENAME);
    portFile = join(run, PORT_FILENAME);

    const attempt = acquireInstanceLock({ path: lockFile, now: clock });
    if (!attempt.acquired) {
      // Deliberately before any logger exists: a second instance writes nothing
      // and reads nothing but `run/`. It is a query, not a start-up.
      io.out(alreadyRunningMessage(readPortFile(portFile), lockFile));
      exitWith(0);
      return;
    }
    lock = attempt.lock;
  }

  // `POST /api/service/shutdown` and a signal take the same path, as §4.2 puts
  // them on the same line. The listener binds during `startAll`, so a shutdown
  // can be requested before `boot` has returned the service to stop; the reason
  // is held and acted on the moment there is something to act with.
  const state: { controller?: ShutdownController; pending?: string } = {};
  const requestShutdown = (reason: string): void => {
    if (state.controller === undefined) {
      state.pending ??= reason;
      return;
    }
    state.controller.request(reason);
  };

  // --- 2. Boot.
  let service: BootedService;
  try {
    service = await boot({ argv: args, onShutdownRequest: requestShutdown, ...options });
  } catch (error) {
    // Boot has already reported and exited; releasing matters only for an
    // injected `exit` that returns, and for leaving `run/` tidy.
    lock?.release();
    throw error;
  }

  const log = service.logging.child('core');

  // --- 3. Discovery (§4.2): publish after binding, never before.
  if (portFile !== undefined) {
    await reconcileStalePortFile(portFile, log);
    const address = service.runtime.registry.require<HttpService>(HTTP_SERVICE)?.address();
    if (address === undefined) {
      log.warn(
        { file: portFile },
        `no listener is bound, so ${PORT_FILENAME} was not published; clients cannot discover this core`,
      );
    } else {
      const record = {
        port: address.port,
        pid: process.pid,
        startedAt: clock().toISOString(),
        edition: service.config.edition,
      };
      writePortFile(portFile, record);
      log.info({ file: portFile, ...record }, `published ${PORT_FILENAME}`);
    }
  }

  // --- 4. Shutdown, with §4.2's budget.
  const controller = createShutdownController({
    graceMs: service.config.service.shutdownGraceSeconds * 1000,
    stop: async () => {
      log.info({ graceSeconds: service.config.service.shutdownGraceSeconds }, 'shutdown requested');
      await service.shutdown();
    },
    finalize: (outcome) => {
      // On the graceful path storage's own `stop()` has already checkpointed
      // the WAL and closed the handle (it is last in reverse order). On any
      // other path it has not, and this synchronous call is the last moment
      // there is to leave a self-contained database behind.
      if (outcome.path !== 'graceful') {
        try {
          service.storage.close();
        } catch {
          // The WAL is recovered on next open; exiting matters more.
        }
      }
      if (portFile !== undefined) removePortFile(portFile);
      lock?.release();
    },
    exit: exitWith,
    onEvent: (outcome) => {
      // The graceful path has already logged its own end and closed the log
      // streams; only the paths that went wrong still have something to say.
      if (outcome.path === 'graceful') return;
      log.warn(
        { reason: outcome.reason, path: outcome.path, durationMs: outcome.durationMs },
        outcome.path === 'forced'
          ? `shutdown exceeded the ${String(service.config.service.shutdownGraceSeconds)} s grace ` +
              'budget; exiting anyway with the port file removed and the lock released'
          : `shutdown failed: ${outcome.error ?? 'unknown error'}`,
      );
    },
    failureExitCode: MODULE_FAILURE_EXIT_CODE,
  });
  state.controller = controller;
  installShutdownSignals(controller);
  if (state.pending !== undefined) controller.request(state.pending);

  const url = service.url();
  if (url !== undefined) log.info({ url }, `agentmanager core at ${url}`);
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
  void main(args)
    .then((code) => {
      // `null` means the service is running and owns the event loop from here.
      if (code !== null) exit(code);
    })
    // `boot` has already reported and exited on failure; the rejection it
    // rethrows is for programmatic callers, and a verb's failure has already
    // been reported by `runCommand`.
    .catch(() => exit(MODULE_FAILURE_EXIT_CODE));
}
