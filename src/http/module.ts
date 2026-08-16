/**
 * The `http` module — third in §6.2's list, and the owner of the one framework
 * instance.
 *
 * ```ts
 * const modules = [storage, secrets, http, roster, projects, runner];
 * ```
 *
 * It registers foundation's routes in `init` like any module would (there is no
 * privileged path for them), and binds the loopback listener in `start()` —
 * which is the `listener-bind` phase, so §4.2's "boot tasks run after storage is
 * up and before the listener binds" stays true by construction.
 *
 * It publishes {@link HttpService} on the registry. That is remote's seam: the
 * remote module calls `ctx.require('http')?.mount(...)` to put **the same route
 * table** on a second listener with its own bind address, `origin: 'remote'` and
 * bearer middleware, rather than building a second surface (§6.4).
 *
 * ## Why `critical`
 *
 * §6.2 names storage and secrets as critical and explains the rule behind it —
 * "a broken orchestrator should not prevent you from reading logs and fixing
 * it". A core with no listener is the case that rule is protecting: `/api/logs`,
 * `/api/health` and `POST /api/service/shutdown` are *the* means of reading logs
 * and fixing it, and without them the process is an invisible, unstoppable
 * background task. M9's single-instance lock is what turns the common cause —
 * the port already being held by a running core — into a clean exit 0 rather
 * than a crash loop.
 */
import type { AddressInfo } from 'node:net';

import type { ConfigSourceMap } from '../config/index.js';
import type { Logging } from '../logging/index.js';
import type {
  HealthAggregate,
  HealthReport,
  LifecyclePhase,
  Module,
  RegisteredRoute,
  RouteDefinition,
} from '../modules/types.js';

import type { ConfigOrigins, HttpDeps } from './deps.js';
import { createConfigRoutes } from './routes/config.js';
import { createEventRoutes } from './routes/events.js';
import { createHealthRoutes } from './routes/health.js';
import { createLogRoutes } from './routes/logs.js';
import { createServiceRoutes } from './routes/service.js';
import { createSpaRoutes, resolveWebRoot } from './routes/spa.js';
import { mountRoutes, type HttpListener, type ListenerOptions } from './server.js';
import type { RouteSource } from './types.js';

/** The module id, used by `dependsOn`, the registry and `migrations/http/`. */
export const HTTP_MODULE_ID = 'http';
/** The service name the http module publishes on the registry. */
export const HTTP_SERVICE = 'http';

/** What `ctx.require('http')` yields — remote's mount point (§6.4). */
export interface HttpService {
  /** Foundation's one route table, as it stands now. */
  routes(): readonly RegisteredRoute[];
  /**
   * Mounts the same table on another listener. Remote calls this with its
   * Tailscale bind, `origin: 'remote'`, its bearer middleware, and its own
   * filtered view of the routes (§6.4).
   */
  mount(options: ListenerOptions): HttpListener;
  /** The local listener's bound address, once `start()` has run. */
  address(): AddressInfo | undefined;
  url(): string | undefined;
}

export interface HttpModuleOptions {
  readonly version: string;
  /** Reads the runtime's route table; called at `start()`, once every module has registered. */
  readonly routes: () => RouteSource;
  readonly sources: ConfigSourceMap;
  readonly origins: ConfigOrigins;
  readonly logging: Logging;
  /** `<dataRoot>/state/logs`. */
  readonly logsDir: string;
  readonly health: () => Promise<HealthAggregate>;
  readonly phase: () => LifecyclePhase;
  readonly requestShutdown: (reason: string) => void;
  /** Overrides bundle discovery; otherwise `<install>/app/web` then `<install>/web`. */
  readonly webRoot?: string;
  readonly installRoot: string;
  /** Overrides `http.bind`. For tests and for M9's lifecycle work. */
  readonly bind?: string;
  /** Overrides `http.port`; `0` asks the OS for an ephemeral one (tests). */
  readonly port?: number;
  /** SSE keep-alive interval, injectable so a stream test is not timer-bound. */
  readonly heartbeatMs?: number;
  readonly startedAt?: Date;
}

export function createHttpModule(options: HttpModuleOptions): Module {
  return {
    id: HTTP_MODULE_ID,
    // Storage answers `/api/events` replay; the ordering also keeps the module
    // list in §6.2's stated order.
    dependsOn: ['storage'],
    critical: true,

    init(ctx) {
      const webRoot = resolveWebRoot(options.installRoot, options.webRoot);
      const deps: HttpDeps = {
        version: options.version,
        config: ctx.config,
        sources: options.sources,
        origins: options.origins,
        logging: options.logging,
        logsDir: options.logsDir,
        events: ctx.store.events,
        bus: ctx.bus,
        health: options.health,
        phase: options.phase,
        requestShutdown: options.requestShutdown,
        webRoot,
        startedAt: options.startedAt ?? ctx.clock(),
        clock: ctx.clock,
        logger: ctx.logger,
      };

      const routes: RouteDefinition[] = [
        ...createHealthRoutes(deps),
        ...createConfigRoutes(deps),
        ...createLogRoutes(deps),
        ...createEventRoutes(deps),
        ...createServiceRoutes(deps),
        // Last in the list for readability only: the router scores literal
        // segments above the catch-all, so registration order decides nothing.
        ...createSpaRoutes(deps),
      ];
      ctx.registerRoutes(routes);

      if (webRoot === undefined) {
        ctx.logger.warn(
          { installRoot: options.installRoot },
          'no web bundle found; the SPA route serves a placeholder page until one is installed',
        );
      }

      let listener: HttpListener | undefined;

      const service: HttpService = {
        routes: () => toRouteArray(options.routes()),
        mount: (listenerOptions) => mountRoutes(options.routes(), listenerOptions),
        address: () => listener?.address,
        url: () => listener?.url,
      };
      ctx.provide(HTTP_SERVICE, service);

      return {
        start: async () => {
          const bind = options.bind ?? ctx.config.http.bind;
          const port = options.port ?? ctx.config.http.port;
          listener = mountRoutes(options.routes(), {
            bind,
            port,
            origin: 'local',
            name: 'local',
            logger: ctx.logger,
            accessLogger: options.logging.accessLogger,
            ...(options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs }),
          });
          const address = await listener.listen();
          ctx.logger.info(
            { url: listener.url, routes: listener.routes.length },
            `local API listening on ${String(address.address)}:${String(address.port)}`,
          );
        },

        stop: async () => {
          await listener?.close();
          listener = undefined;
        },

        health: (): HealthReport => {
          const address = listener?.address;
          return {
            status: address === undefined ? 'not-started' : 'ok',
            ...(address === undefined
              ? { message: 'The local API listener is not bound.' }
              : { message: `Listening on ${listener?.url ?? ''}.` }),
            detail: {
              bound: address !== undefined,
              ...(address === undefined
                ? {}
                : { address: address.address, port: address.port, url: listener?.url }),
              routes: toRouteArray(options.routes()).length,
              webBundle: webRoot ?? null,
            },
          };
        },
      };
    },
  };
}

function toRouteArray(source: RouteSource): readonly RegisteredRoute[] {
  return Array.isArray(source)
    ? (source as readonly RegisteredRoute[])
    : (source as { routes: readonly RegisteredRoute[] }).routes;
}
