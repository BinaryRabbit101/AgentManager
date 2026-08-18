/**
 * The `remote` module — architecture D5/D6, remote IMPLEMENTATION M1–M8.
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
 * | Built (M1–M8) | Not yet |
 * |---|---|
 * | The module under foundation's contract: `dependsOn: ['storage', 'http']`, **`critical: false`** | The end-to-end phone path (M9) |
 * | §11's config sub-schema, with `bind` as a keyword (`config.ts`) | The edition/boundary suite (M10) |
 * | `migrations/remote/0001_last_used_peer.sql` | |
 * | §2.1/§2.2 Tailscale detection, injectable end to end (`tailscale.ts`) | |
 * | **D5's amended proxy mode**: the declared LAN address, proven (`proxy.ts`) | |
 * | §2.3's listener state machine, one path for both modes (`listener.ts`) | |
 * | `ctx.provide('remote', { boundAddress })` — foundation §6.3's claim | |
 * | §4's token store and bearer authentication (`tokens.ts`) | |
 * | §4.6's lockout and §3.3's route bucket (`rateLimit.ts`) | |
 * | §3.1/§3.2's route policy and deny list (`policy.ts`, `middleware.ts`) | |
 * | §3.4's single-use stream tickets (`tickets.ts`) and §4.5's connection map (`streams.ts`) | |
 * | §6's per-agent grants (`grants.ts`) and the launch gate (`gate.ts`) | |
 *
 * M3 mounted the route table behind a hard deny, because a socket existed and no
 * credential mechanism did. M4–M6 replaced that placeholder with the real chain —
 * peer guard, `Host` allowlist, then §3.1's rules — and M7/M8 filled in rules 3½
 * (a ticket where a browser cannot send a header) and 4 (the grant gate). Nothing
 * that binds a socket changed to make any of it happen, which is why the
 * placeholder was a `Middleware` in the first place.
 *
 * ## Two bind modes, one code path
 *
 * D5 as amended (2026-08-17) has `remote.bind` choose between `"tailscale"` and
 * `"proxy"`. That choice is made **once**, here, and reaches three places: which
 * prover the listener uses, which peer policy the guard enforces, and what `source`
 * the published claim carries. Everything else — the state machine, the two
 * independent proofs, `assertBindable`, bearer auth, the deny list, tickets,
 * grants, the audit trail — is one implementation serving both modes, because a
 * second one would be a second thing to keep correct.
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
import type { LogFn } from '../../storage/index.js';
import { noteModuleLoaded } from '../loadProbe.js';
import type { HealthReport, Module, ModuleContext, ModuleHandle } from '../types.js';

import { REMOTE_BIND_PROXY } from './config.js';
import { createGrantStore, type GrantStore } from './grants.js';
import { createRemoteListener, realTimers, type RemoteListener } from './listener.js';
import {
  createRemoteMiddleware,
  proxyPeerPolicy,
  TAILNET_PEER_POLICY,
  type PeerPolicy,
  type RemoteAuditSink,
} from './middleware.js';
import { HTTP_PORT_NAME, hasMount, type HttpPort } from './ports.js';
import { createProxyProver, type AddressProver } from './proxy.js';
import { createAuthLimiter, createRouteBucket } from './rateLimit.js';
import { allowedHosts, createRemoteRoutes, type RemoteClientHints } from './routes.js';
import { createGrantRoutes, createStreamRoutes } from './streamRoutes.js';
import { createStreamRegistry, type StreamRegistry } from './streams.js';
import { createTailscaleDetector, type TailscaleDetector } from './tailscale.js';
import { createTicketStore, type TicketStore } from './tickets.js';
import { createTokenRoutes, REMOTE_ENABLED_SETTING } from './tokenRoutes.js';
import { createRemoteTokenService, type RemoteTokenService } from './tokens.js';
import type { RemoteModuleDeps, RemoteModuleOptions } from './options.js';

export {
  REMOTE_BIND_LITERAL,
  REMOTE_BIND_MESSAGE,
  REMOTE_BIND_MODES,
  REMOTE_BIND_PROXY,
  REMOTE_CONFIG_DEFAULTS,
  REMOTE_PROXY_REQUIRED_MESSAGE,
  REMOTE_PROXY_UNEXPECTED_MESSAGE,
  REMOTE_PUBLIC_URL_MESSAGE,
  remoteConfigSchema,
  remoteProxySchema,
} from './config.js';
export type { RemoteBindMode, RemoteConfig, RemoteProxyConfig } from './config.js';
export { parsePublicUrl, publicHostname, publicOrigin } from './config.js';
export type { RemoteInternals, RemoteModuleDeps, RemoteModuleOptions } from './options.js';
export type { RemoteListener, RemoteListenerState, RemoteStatus } from './listener.js';
export { assertBindable } from './listener.js';
export type { Detection, TailscaleDetector } from './tailscale.js';
export {
  PROXY_BACKEND_STATE,
  createProxyProver,
  validateProxyBind,
  type AddressProver,
} from './proxy.js';
export {
  BACKSTOP_DENY_PATTERNS,
  ROUTE_DENIED_CODE,
  STREAM_TICKET_PATHS,
  decideRoutePolicy,
  effectiveDenyList,
  isStreamTicketRequest,
} from './policy.js';
export { PEER_NOT_ALLOWED_CODE, PEER_REFUSED_CODE, proxyPeerPolicy } from './middleware.js';
export { UNAUTHORIZED_CODE, UNAUTHORIZED_MESSAGE } from './tokens.js';
export type { RemoteTokenService, TokenView } from './tokens.js';
export { REMOTE_ENABLED_SETTING } from './tokenRoutes.js';
export { TICKET_BYTES, createTicketStore, type TicketStore } from './tickets.js';
export { createStreamRegistry, type StreamRegistry } from './streams.js';
export {
  AGENT_ACCESS_PREFIX,
  GRANT_EXPIRED_EVENT,
  GRANT_GRANTED_EVENT,
  GRANT_REVOKED_EVENT,
  createGrantStore,
  type GrantStore,
  type GrantView,
} from './grants.js';
export {
  INITIATING_SURFACES,
  NON_INITIATING_WRITES,
  REMOTE_ACCESS_REQUIRED_CODE,
  RESTRAINING_SURFACES,
  agentsForRequest,
  classifyPath,
  type RouteTier,
} from './gate.js';

/** The module id, used by `dependsOn`, the registry and `migrations/remote/`. */
export const REMOTE_MODULE_ID = 'remote';

/**
 * §6.3's "hourly sweep whose only job is emitting the events that keep the UI
 * honest".
 *
 * Not configurable, deliberately: read-time expiry is what enforces the deadline
 * (`grants.isLive`), so this interval only affects how quickly the board card
 * updates itself, and a knob on it would imply it affected the boundary.
 */
export const GRANT_SWEEP_MS = 3_600_000;

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
      const mode = config.bind;
      // §4.2's two declarations, read once: they name the origin the QR points at
      // and the hosts the listener answers to, and those two must be built from
      // the same pair or a phone gets a URL the guard then refuses.
      const clientHints: RemoteClientHints = {
        publicUrl: config.publicUrl,
        hostnameHint: config.hostnameHint,
      };
      const log: LogFn = (level, message, data) => {
        ctx.logger[level](data ?? {}, message);
      };

      // D5's two modes, chosen once, here. The listener, the peer guard and the
      // published claim all read this one decision; nothing below branches on the
      // *edition*, which is D6's separate mechanism (see this file's header).
      const proxy = mode === REMOTE_BIND_PROXY ? config.proxy : null;
      if (mode === REMOTE_BIND_PROXY && proxy === null) {
        // Unreachable through the loader — the schema refuses the combination —
        // so this is a diagnostic for a subverted config path, not a fallback.
        throw new Error(
          'remote.bind is "proxy" but remote.proxy is absent, so there is no address to bind and ' +
            'no peer allowlist to enforce (architecture D5, amended 2026-08-17).',
        );
      }

      const detector: AddressProver =
        options.detector ??
        (proxy !== null
          ? createProxyProver({
              bind: proxy.bind,
              log,
              ...(options.detect?.networkInterfaces === undefined
                ? {}
                : { networkInterfaces: options.detect.networkInterfaces }),
            })
          : createTailscaleDetector({
              cliPath: config.detect.cli,
              clock: ctx.clock,
              log,
              ...options.detect,
            }));

      // §9.2 #6 in tailscale mode; D5's amended peer allowlist in proxy mode. Built
      // from configuration rather than from a request, so no header can move it.
      const peerPolicy: PeerPolicy =
        proxy === null ? TAILNET_PEER_POLICY : proxyPeerPolicy(proxy.allowedPeers);

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
      //
      // **A property of §4.6 that proxy mode narrows, recorded rather than papered
      // over.** The window is keyed on the raw TCP peer, and in proxy mode every
      // request arrives from the same peer — the proxy host — so §4.6's "a
      // *different* peer is unaffected" no longer separates devices: ten bad
      // credentials from anyone behind the proxy lock the whole household out for
      // `blockMs`. The behaviour is deliberately left alone (keying the window on
      // an `X-Forwarded-For` the proxy wrote would hand the key to whoever the
      // allowlist excludes, which is strictly worse), and it is bounded by the same
      // trust boundary as before: reaching the socket at all still means passing
      // the proxy host's tailnet gate. Raised for the owner as a note on the
      // amendment rather than fixed here, because the fix is a design choice.
      const limiter = createAuthLimiter({
        maxFailures: config.auth.maxFailures,
        failWindowMs: config.auth.failWindowMs,
        blockMs: config.auth.blockMs,
      });
      const browseBucket = createRouteBucket({
        limit: config.browseRateLimitPerMin,
        windowMs: 60_000,
      });

      // §3.4's ticket store and §4.5's connection map. Both in memory, neither
      // persisted: a ticket is worth 30 seconds, and a connection cannot outlive
      // the process that holds its socket.
      const tickets: TicketStore = createTicketStore({
        ttlSec: config.stream.ticketTtlSec,
        ...(options.ticketBytes === undefined ? {} : { randomBytes: options.ticketBytes }),
      });
      const streams: StreamRegistry = createStreamRegistry();

      // §6.1's per-agent grants: one `settings` row each, so grant and revoke are
      // independent writes (R2).
      const grants: GrantStore = createGrantStore({
        settings: ctx.settings,
        agents: ctx.store.agents,
        clock: ctx.clock,
        bus: ctx.bus,
        logger: ctx.logger,
        ttlHours: config.agentAccess.ttlHours,
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

      /** §5's runtime kill switch, read at every decision point (never cached). */
      const remoteEnabled = (): boolean =>
        ctx.settings.get<boolean>(REMOTE_ENABLED_SETTING) !== false;

      const listener: RemoteListener = createRemoteListener({
        detector,
        mode,
        // Proxy mode only: the declared address, so `assertBindable` can confirm
        // at the point of no return that the socket is going on the interface the
        // owner named (§9.1 #2's "two independent checks on the same fact").
        ...(proxy === null ? {} : { expectedAddress: proxy.bind }),
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
          // D5's peer boundary for whichever mode this is, decided from config
          // above. It runs first in the chain, before auth and before the rate
          // limiter's accounting.
          peerPolicy,
          // §9.3: best-effort enrichment from the cached peer map. Never consulted
          // for a decision — only written to a log line and an audit column.
          peerName: (address) => detector.peerName(address),
          // §9.2 #8's allowlist. Read per request, because the MagicDNS name and
          // the bound address both change when the tailnet re-keys (§2.3). In proxy
          // mode there is no MagicDNS name here — the tailnet name belongs to the
          // proxy host — so `remote.hostnameHint` and `remote.publicUrl` are how
          // the owner declares it; a proxy that preserves `Host` sends the name
          // the phone dialled, which is `publicUrl`'s.
          allowedHosts: () => allowedHosts(listener.status(), clientHints),
          // §3.3's audit line wants the *resolved* path, and the OS is the only
          // thing that can resolve a junction. Audit only: a failure here is
          // swallowed and the requested path is logged instead.
          resolvePath: (target) => realpathSync.native(target),
          // §3.4 and §4.5: ticket redemption on the stream paths, and registration
          // of the stream the handler is about to open.
          tickets,
          streams,
          // §3.1 rule 4 — the per-agent grant gate (§6.2).
          gate: {
            grants,
            stores: {
              sessions: ctx.store.sessions,
              assignments: ctx.store.assignments,
              agents: ctx.store.agents,
            },
            enabled: remoteEnabled,
          },
        }),
        logger: ctx.logger,
        accessLogger: deps.accessLogger,
        clock: ctx.clock,
        enabled: remoteEnabled,
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

      // §6.3's "Agent archived, deleted, or purged — on roster's `roster.changed`
      // bus event → Immediate". Reconciled against the *live* index rather than
      // against the event payload: `roster.changed` says the roster moved, and the
      // authoritative answer to "does this agent still exist and is it live?" is
      // the `agents` table roster just rewrote.
      const unsubscribeRoster = ctx.bus.subscribe(['roster.changed'], () => {
        const at = ctx.clock().getTime();
        for (const view of grants.list(at)) {
          const agent = ctx.store.agents.get(view.agentId);
          if (agent !== undefined && agent.archivedAt === null) continue;
          grants.revoke(view.agentId, 'agent_gone');
        }
      });

      ctx.registerRoutes(
        createRemoteRoutes({
          listener,
          logger: ctx.logger,
          clientHints,
          tokens,
          // The live table, read per request: a route registered by a module that
          // starts after remote must still appear in the effective deny list.
          routes: () => http.routes(),
        }),
      );
      ctx.registerRoutes(
        createStreamRoutes({ tickets, streams, clock: ctx.clock, logger: ctx.logger }),
      );
      ctx.registerRoutes(createGrantRoutes({ grants, clock: ctx.clock, logger: ctx.logger }));
      ctx.registerRoutes(
        createTokenRoutes({
          tokens,
          listener,
          settings: ctx.settings,
          clientHints,
          logger: ctx.logger,
          // §4.5's two consequences of a revoke: the token's live streams close,
          // and losing the *last* token clears every grant.
          streams,
          grants,
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

      // §6.3's boot sweep. A `boot-task` rather than something inside `start()`:
      // foundation runs boot tasks after storage is up and **before any listener
      // binds** (§4.2), so a grant that lapsed while the machine was off is gone —
      // and its `.expired` event emitted — before the first remote request can
      // arrive.
      ctx.registerBootTask(() => {
        const expired = grants.sweep(ctx.clock().getTime());
        if (expired.length > 0) {
          ctx.logger.info({ agents: expired.length }, 'boot sweep expired per-agent grants');
        }
      }, 'remote-grant-boot-sweep');

      /**
       * The two periodic jobs, on one interval each.
       *
       * The heartbeat carries §3.4's keep-alive and reaps half-open connections;
       * the sweep is §6.3's hourly job whose "only job is emitting the events that
       * keep the UI honest" — read-time expiry (in `grants.isLive`) is what
       * actually keeps a lapsed grant from being honoured.
       */
      const timers = options.timers ?? realTimers;
      let cancelHeartbeat: (() => void) | undefined;
      let cancelSweep: (() => void) | undefined;
      const scheduleHeartbeat = (): void => {
        cancelHeartbeat = timers.after(config.stream.heartbeatMs, () => {
          tickets.sweep(ctx.clock().getTime());
          streams.beat();
          scheduleHeartbeat();
        });
      };
      const scheduleSweep = (): void => {
        cancelSweep = timers.after(GRANT_SWEEP_MS, () => {
          grants.sweep(ctx.clock().getTime());
          scheduleSweep();
        });
      };

      options.onReady?.({
        detector,
        listener,
        tokens,
        tickets,
        streams,
        grants,
        heartbeat: () => {
          tickets.sweep(ctx.clock().getTime());
          return streams.beat();
        },
        sweepGrants: () => grants.sweep(ctx.clock().getTime()),
      });

      ctx.logger.info(
        { bind: config.bind, mode, port, pollMs: config.detect.pollMs },
        mode === REMOTE_BIND_PROXY
          ? 'remote module initialised; the declared proxy-facing LAN address is proven and the ' +
              'peer allowlist enforced at start()'
          : 'remote module initialised; the Tailscale interface is detected and validated at start()',
      );

      return {
        // Awaited, so foundation's post-start bind assertion never runs before the
        // socket this module might open (§6.3 and `listener.ts`'s note).
        start: async () => {
          await listener.start();
          // Cancelled first, so a second `start()` cannot leave two chains of
          // timers running against one registry.
          cancelHeartbeat?.();
          cancelSweep?.();
          scheduleHeartbeat();
          scheduleSweep();
        },
        stop: async () => {
          cancelHeartbeat?.();
          cancelSweep?.();
          unsubscribeRoster();
          // Every live stream ends with the module, so nothing is left holding a
          // socket the listener is about to close.
          streams.closeAll();
          await listener.stop();
        },

        health: (): HealthReport => {
          const status = listener.status();
          const detail = {
            state: status.state,
            enabled: status.enabled,
            mode: status.mode,
            bound: status.boundAddress !== null,
            port: status.port,
            address: status.boundAddress?.address ?? null,
            magicDnsName: status.magicDnsName,
            tailscaleState: status.tailscaleState,
            detectionSource: status.detectionSource,
            recentBindFailures: status.recentBindFailures,
            liveStreams: streams.count(),
            liveTickets: tickets.size(),
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
          // `/api/health` reports `remote: degraded` with the reason string. The
          // sentence is mode-aware, because "Tailscale is <state>" would be a
          // misleading thing to show an owner whose Tailscale lives on the mini-pc.
          return {
            status: 'degraded',
            message:
              status.lastError ??
              (mode === REMOTE_BIND_PROXY
                ? 'Remote access is unavailable: the declared proxy-facing LAN address is not bound.'
                : 'Remote access is unavailable: no validated Tailscale address is bound.'),
            conditions: [
              {
                id: 'remote.unavailable',
                level: 'warn',
                message: (mode === REMOTE_BIND_PROXY
                  ? `Remote access unavailable — the declared LAN address is not bound. ${
                      status.lastError ?? ''
                    }`
                  : `Remote access unavailable — Tailscale is ${
                      status.tailscaleState ?? 'not detected'
                    }. ${status.lastError ?? ''}`
                ).trim(),
              },
            ],
            detail,
          };
        },
      };
    },
  };
}
