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
 * | Built (M1–M6) | Not yet |
 * |---|---|
 * | The module under foundation's contract: `dependsOn: ['storage', 'http']`, **`critical: false`** | Stream tickets, WS/SSE auth (M7) |
 * | §11's config sub-schema, with `bind` as a literal (`config.ts`) | Per-agent grants and the launch gate (M8) |
 * | `migrations/remote/0001_last_used_peer.sql` | The end-to-end phone path (M9) |
 * | §2.1/§2.2 detection, injectable end to end (`tailscale.ts`) | The edition/boundary suite (M10) |
 * | §2.3's listener state machine (`listener.ts`) | |
 * | `ctx.provide('remote', { boundAddress })` — foundation §6.3's claim | |
 * | §4's token store and bearer authentication (`tokens.ts`) | |
 * | §4.6's lockout and §3.3's route bucket (`rateLimit.ts`) | |
 * | §3.1/§3.2's route policy and deny list (`policy.ts`, `middleware.ts`) | |
 *
 * M3 mounted the route table behind a hard deny, because a socket existed and no
 * credential mechanism did. M4–M6 replace that placeholder with the real chain —
 * peer guard, `Host` allowlist, then §3.1's rules — and nothing that binds a socket
 * changed to make it happen, which is why the placeholder was a `Middleware` in the
 * first place.
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
import { realpathSync } from 'node:fs';

import type { RemoteService } from '../../lifecycle/bind.js';
import { noteModuleLoaded } from '../loadProbe.js';
import type { HealthReport, Module, ModuleContext, ModuleHandle } from '../types.js';

import { createRemoteListener, realTimers, type RemoteListener } from './listener.js';
import { createRemoteMiddleware, type RemoteAuditSink } from './middleware.js';
import { HTTP_PORT_NAME, hasMount, type HttpPort } from './ports.js';
import { createAuthLimiter, createRouteBucket } from './rateLimit.js';
import { createRemoteRoutes } from './routes.js';
import { createTailscaleDetector, type TailscaleDetector } from './tailscale.js';
import { createTokenRoutes, REMOTE_ENABLED_SETTING } from './tokenRoutes.js';
import { createRemoteTokenService, type RemoteTokenService } from './tokens.js';
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
export {
  BACKSTOP_DENY_PATTERNS,
  ROUTE_DENIED_CODE,
  decideRoutePolicy,
  effectiveDenyList,
} from './policy.js';
export { UNAUTHORIZED_CODE, UNAUTHORIZED_MESSAGE } from './tokens.js';
export type { RemoteTokenService, TokenView } from './tokens.js';
export { REMOTE_ENABLED_SETTING } from './tokenRoutes.js';

/** The module id, used by `dependsOn`, the registry and `migrations/remote/`. */
export const REMOTE_MODULE_ID = 'remote';

/**
 * The service name foundation's bind-time assertion reads (`lifecycle/bind.ts`'s
 * `REMOTE_SERVICE`). Declared as a literal rather than imported, so the value is
 * asserted equal in a test instead of being trivially the same by construction.
 */
export const REMOTE_SERVICE = 'remote';

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

      // §4: the credential store. It receives foundation's repository and the
      // clock, and nothing else — no `SecretResolver`, because R5 pins that remote
      // never calls `.reveal()`: there is no stored secret to read.
      const tokens: RemoteTokenService = createRemoteTokenService({
        tokens: ctx.store.remoteTokens,
        clock: ctx.clock,
        defaultTtlDays: config.token.ttlDays,
        maxActive: config.token.maxActive,
      });

      // §4.6's per-peer sliding window, and §3.3's per-token browse bucket. Both
      // in memory, both keyed by the caller's clock reading.
      const limiter = createAuthLimiter({
        maxFailures: config.auth.maxFailures,
        failWindowMs: config.auth.failWindowMs,
        blockMs: config.auth.blockMs,
      });
      const browseBucket = createRouteBucket({
        limit: config.browseRateLimitPerMin,
        windowMs: 60_000,
      });

      // Where the middleware's audit output lands: `access.log` for the line and
      // the event bus for the persisted record the UI reads. §4.6 is precise about
      // the volume — one event and one `warn` per *window*, not per failure — and
      // that shaping lives in the middleware, so this sink is only a destination.
      const audit: RemoteAuditSink = {
        authFailed: (detail) => {
          deps.accessLogger.warn(
            { ...detail, origin: 'remote', outcome: 'auth_failed' },
            'a remote sign-in failed',
          );
          ctx.bus.emit({
            type: 'remote.auth.failed',
            persist: true,
            payload: { peer: detail.peer ?? null, failures: detail.failures, at: detail.at },
          });
        },
        authBlocked: (detail) => {
          deps.accessLogger.warn(
            { ...detail, origin: 'remote', outcome: 'auth_blocked' },
            'a remote peer is locked out after repeated failed sign-ins',
          );
          // A distinct type from `remote.auth.failed` so §4.6's "one event per
          // window" stays literally one, while a lockout — the thing a user needs
          // to be told about — is still a persisted, surfaceable fact.
          ctx.bus.emit({
            type: 'remote.auth.blocked',
            persist: true,
            payload: {
              peer: detail.peer ?? null,
              failures: detail.failures,
              until: detail.until,
              retryAfterSeconds: detail.retryAfterSeconds,
            },
          });
        },
        browsed: (detail) => {
          // §3.3: "this is the one route where the audit trail is the control".
          deps.accessLogger.info(
            { ...detail, origin: 'remote', outcome: 'fs_browse' },
            'a remote client listed a folder',
          );
        },
        refused: (detail) => {
          deps.accessLogger.warn(
            { ...detail, origin: 'remote', outcome: 'refused' },
            `refused a request on the remote listener: ${detail.reason}`,
          );
        },
      };

      const listener: RemoteListener = createRemoteListener({
        detector,
        mount: (listenerOptions) => http.mount(listenerOptions),
        port,
        pollMs: config.detect.pollMs,
        retryMaxMs: config.detect.retryMaxMs,
        // §3.1 and §9.2, in order: peer guard, `Host` allowlist, then the four-rule
        // policy. This is what replaced M3's hard deny, and the listener did not
        // change to accommodate it.
        middleware: createRemoteMiddleware({
          tokens,
          limiter,
          browseBucket,
          clock: ctx.clock,
          audit,
          // §9.3: best-effort enrichment from the cached peer map. Never consulted
          // for a decision — only written to a log line and an audit column.
          peerName: (address) => detector.peerName(address),
          // §9.2 #8's allowlist. Read per request, because the MagicDNS name and
          // the bound address both change when the tailnet re-keys (§2.3).
          allowedHosts: () => {
            const status = listener.status();
            return [status.boundAddress?.address, status.magicDnsName, config.hostnameHint].filter(
              (entry): entry is string => typeof entry === 'string' && entry.length > 0,
            );
          },
          // §3.3's audit line wants the *resolved* path, and the OS is the only
          // thing that can resolve a junction. Audit only: a failure here is
          // swallowed and the requested path is logged instead.
          resolvePath: (target) => realpathSync.native(target),
        }),
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
        createRemoteRoutes({
          listener,
          logger: ctx.logger,
          hostnameHint: config.hostnameHint,
          tokens,
          // The live table, read per request: a route registered by a module that
          // starts after remote must still appear in the effective deny list.
          routes: () => http.routes(),
        }),
      );
      ctx.registerRoutes(
        createTokenRoutes({
          tokens,
          listener,
          settings: ctx.settings,
          hostnameHint: config.hostnameHint,
          logger: ctx.logger,
          // Deferred by one turn of the event loop, deliberately: switching the
          // kill switch off closes the socket the response is travelling on, so the
          // response has to be written first (§5).
          onEnabledChanged: () => {
            setImmediate(() => {
              void listener.restart().catch((error: unknown) => {
                ctx.logger.error(
                  { err: error },
                  'the remote listener failed to react to the remote.enabled setting',
                );
              });
            });
          },
        }),
      );

      options.onReady?.({ detector, listener, tokens });

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
