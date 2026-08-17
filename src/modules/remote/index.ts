/**
 * The `remote` module — architecture D5/D6, remote IMPLEMENTATION M1–M3.
 *
 * ```ts
 * if (config.edition === 'home' && config.modules.remote.enabled) {
 *   modules.push((await import('./modules/remote/index.js')).createRemoteModule(deps));
 * }
 * ```
 *
 * The import is **dynamic** so that in the work edition "its code is never
 * evaluated, its routes never registered, its sockets never created" (foundation
 * §6.2). {@link noteModuleLoaded} below runs at module evaluation and is what makes
 * that a measured fact rather than a claim — foundation's M11 boundary suite and
 * `main.test.ts` both read the counter. It stays exactly where the placeholder put
 * it.
 *
 * ## What this milestone group builds, and what it deliberately does not
 *
 * | Built (M1–M3) | Not yet |
 * |---|---|
 * | The module under foundation's contract: `dependsOn: ['storage', 'http']`, **`critical: false`** | Bearer tokens and authentication (M4) |
 * | §11's config sub-schema, with `bind` as a literal (`config.ts`) | Rate limiting and lockout (M5) |
 * | `migrations/remote/0001_last_used_peer.sql` | The four-rule route policy and the deny list (M6) |
 * | §2.1/§2.2 detection, injectable end to end (`tailscale.ts`) | Stream tickets, WS/SSE auth (M7) |
 * | §2.3's listener state machine (`listener.ts`) | Per-agent grants (M8) |
 * | `ctx.provide('remote', { boundAddress })` — foundation §6.3's claim | |
 *
 * Because the socket exists from M3 and authentication arrives in M4, this
 * milestone mounts the route table behind a **hard deny** (`middleware.ts`): every
 * request on the tailnet listener is refused. A milestone that opened an
 * unauthenticated tailnet listener "temporarily" would be the exact failure D5
 * exists to prevent, and the deny is a `Middleware` so M4 replaces it rather than
 * editing anything that binds.
 *
 * ## `critical: false`
 *
 * "A remote listener that fails to start must leave the local service running, so
 * the owner can reach the UI at `127.0.0.1` and fix it" — and §10.3: "a broken
 * remote listener must not take down a machine that is happily running agents
 * locally."
 *
 * ## No `edition` branch anywhere below this line
 *
 * D6 is satisfied by *not being loaded*, never by an `if (edition === …)`. This
 * file reads `ctx.config.remote` and `ctx.config.modules.remote`; it never reads
 * `ctx.config.edition`.
 */
import type { RemoteService } from '../../lifecycle/bind.js';
import { noteModuleLoaded } from '../loadProbe.js';
import type { HealthReport, Module, ModuleContext, ModuleHandle } from '../types.js';

import { createRemoteListener, realTimers, type RemoteListener } from './listener.js';
import { denyEveryRequest } from './middleware.js';
import { HTTP_PORT_NAME, hasMount, type HttpPort } from './ports.js';
import { createRemoteRoutes } from './routes.js';
import { createTailscaleDetector, type TailscaleDetector } from './tailscale.js';
import type { RemoteModuleDeps, RemoteModuleOptions } from './options.js';

export {
  REMOTE_BIND_LITERAL,
  REMOTE_BIND_MESSAGE,
  REMOTE_CONFIG_DEFAULTS,
  remoteConfigSchema,
} from './config.js';
export type { RemoteConfig } from './config.js';
export type { RemoteInternals, RemoteModuleDeps, RemoteModuleOptions } from './options.js';
export type { RemoteListener, RemoteListenerState, RemoteStatus } from './listener.js';
export type { Detection, TailscaleDetector } from './tailscale.js';

/** The module id, used by `dependsOn`, the registry and `migrations/remote/`. */
export const REMOTE_MODULE_ID = 'remote';

/**
 * The service name foundation's bind-time assertion reads (`lifecycle/bind.ts`'s
 * `REMOTE_SERVICE`). Declared as a literal rather than imported, so the value is
 * asserted equal in a test instead of being trivially the same by construction.
 */
export const REMOTE_SERVICE = 'remote';

/** DESIGN §5's runtime kill switch. A `settings` key, deliberately not config. */
export const REMOTE_ENABLED_SETTING = 'remote.enabled';

// Runs on evaluation of this file, and only then — the whole point of the gate.
noteModuleLoaded(REMOTE_MODULE_ID);

/**
 * The remote module.
 *
 * @param deps what only the composition root has (the `access.log` stream).
 * @param options injection seams: detection, timers, jitter, port, `onReady`.
 */
export function createRemoteModule(
  deps: RemoteModuleDeps,
  options: RemoteModuleOptions = {},
): Module {
  return {
    id: REMOTE_MODULE_ID,
    // `storage` for `remote_tokens` and the `settings` kill switch; `http` for
    // §6.4's mount point. Both are `critical: true`, so both are present here.
    dependsOn: ['storage', HTTP_PORT_NAME],
    critical: false,

    init(ctx: ModuleContext): ModuleHandle {
      const config = ctx.config.remote;
      const port = options.port ?? config.port;

      const detector: TailscaleDetector =
        options.detector ??
        createTailscaleDetector({
          cliPath: config.detect.cli,
          clock: ctx.clock,
          log: (level, message, data) => {
            ctx.logger[level](data ?? {}, message);
          },
          ...options.detect,
        });

      const http = ctx.require<HttpPort>(HTTP_PORT_NAME);
      if (!hasMount(http)) {
        // Unreachable in a normal build — `http` is critical and in `dependsOn` —
        // so this is a diagnostic rather than a fallback. Failing loudly beats
        // reporting `waiting` forever with no explanation.
        throw new Error(
          'The remote module cannot bind a listener: the "http" service is not on the registry, ' +
            'so foundation’s route table has nothing to mount on (foundation DESIGN §6.4).',
        );
      }

      const listener: RemoteListener = createRemoteListener({
        detector,
        mount: (listenerOptions) => http.mount(listenerOptions),
        port,
        pollMs: config.detect.pollMs,
        retryMaxMs: config.detect.retryMaxMs,
        // M3's placeholder policy. M4 puts the real chain in front of it and M6
        // removes it; nothing that binds a socket changes when it does.
        middleware: [
          denyEveryRequest((request) => {
            ctx.logger.warn(
              { method: request.method, path: request.path, peer: request.remoteAddress },
              'refused a request on the remote listener: bearer authentication is not built yet (M4)',
            );
          }),
        ],
        logger: ctx.logger,
        accessLogger: deps.accessLogger,
        clock: ctx.clock,
        // Read at every decision point rather than captured once: the kill switch
        // is a runtime toggle, and a cached copy would ignore it until a restart.
        enabled: () => ctx.settings.get<boolean>(REMOTE_ENABLED_SETTING) !== false,
        timers: options.timers ?? realTimers,
        ...(options.random === undefined ? {} : { random: options.random }),
      });

      // Foundation §6.3's claim. Published in `init` so the assertion can read it
      // whatever happened in `start()` — including a `waiting` module, which
      // answers `null` and is therefore indistinguishable from no remote at all.
      const service: RemoteService & {
        status: RemoteListener['status'];
        peerName: TailscaleDetector['peerName'];
      } = {
        boundAddress: () => listener.boundAddress(),
        status: () => listener.status(),
        peerName: (address: string) => detector.peerName(address),
      };
      ctx.provide(REMOTE_SERVICE, service);

      ctx.registerRoutes(
        createRemoteRoutes({ listener, logger: ctx.logger, hostnameHint: config.hostnameHint }),
      );

      options.onReady?.({ detector, listener });

      ctx.logger.info(
        { bind: config.bind, port, pollMs: config.detect.pollMs },
        'remote module initialised; the Tailscale interface is detected and validated at start()',
      );

      return {
        // Awaited, so foundation's post-start bind assertion never runs before the
        // socket this module might open (§6.3 and `listener.ts`'s note).
        start: () => listener.start(),
        stop: () => listener.stop(),

        health: (): HealthReport => {
          const status = listener.status();
          const detail = {
            state: status.state,
            enabled: status.enabled,
            bound: status.boundAddress !== null,
            port: status.port,
            address: status.boundAddress?.address ?? null,
            magicDnsName: status.magicDnsName,
            tailscaleState: status.tailscaleState,
            detectionSource: status.detectionSource,
            recentBindFailures: status.recentBindFailures,
          };

          if (status.state === 'listening') {
            return {
              status: 'ok',
              message: `Remote access is listening on ${status.boundAddress?.address ?? ''}:${String(
                status.boundAddress?.port ?? port,
              )}.`,
              detail,
            };
          }

          if (status.state === 'down') {
            return {
              status: 'failed',
              message: status.lastError ?? 'The remote listener is down.',
              conditions: [
                {
                  id: 'remote.listener.down',
                  level: 'error',
                  message: status.lastError ?? 'The remote listener is down.',
                },
              ],
              detail,
            };
          }

          // §2.3: `waiting` is "started and healthy enough for the core to run";
          // `/api/health` reports `remote: degraded` with the reason string.
          return {
            status: 'degraded',
            message:
              status.lastError ??
              'Remote access is unavailable: no validated Tailscale address is bound.',
            conditions: [
              {
                id: 'remote.unavailable',
                level: 'warn',
                message: `Remote access unavailable — Tailscale is ${
                  status.tailscaleState ?? 'not detected'
                }. ${status.lastError ?? ''}`.trim(),
              },
            ],
            detail,
          };
        },
      };
    },
  };
}
