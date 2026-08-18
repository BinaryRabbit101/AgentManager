/**
 * The shared fixture for M4–M6: a **real** mounted listener with remote's **real**
 * middleware chain in front of it.
 *
 * ## Why a real socket, bound to loopback
 *
 * Every criterion in IMPLEMENTATION §4–§6 is about what a client receives — a
 * status code, a header, a byte-identical body, an `access.log` line — so asserting
 * on a middleware's return value would be testing the wrong thing. These tests
 * therefore drive real HTTP requests against
 * `mountRoutes(..., { bind: '127.0.0.1', port: 0 })`, which is foundation's own
 * mount seam, the same one the module hands the listener.
 *
 * The client is `node:http` rather than `fetch`, for one specific reason: `Host` is
 * a forbidden header in undici, so `fetch` silently drops any override — and a
 * §9.2 #8 test that could only ever send the correct `Host` would pass just as
 * happily against a listener with no `Host` check at all.
 *
 * Binding loopback here is not a hole in D5. The tailscale-only rule is enforced by
 * `listener.ts`'s validated production path — `assertBindable` plus two independent
 * detections — and M3 pinned it with the five refusal cases. This fixture never goes
 * near that path: it mounts the route table directly, exactly as a test of a
 * *policy* should.
 *
 * The one consequence to be honest about: loopback is **not** inside
 * `100.64.0.0/10`, so remote's own peer guard (§9.2 #6) refuses it. That is the
 * guard working. So `allowPeer` is injected here, and the *default* predicate gets
 * its own named test in `auth.test.ts` — driven over this same loopback socket,
 * where the production predicate correctly refuses every request.
 *
 * ## Nothing here reads a real clock
 *
 * {@link RemoteHarness.now} is a mutable millisecond counter behind a `Clock`, so
 * token expiry, the lockout window, the `last_used_at` throttle and the browse
 * bucket are all moved by assignment rather than by waiting.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pino, type Logger } from 'pino';

import { mountRoutes, type HttpListener } from '../../../http/server.js';
import type { Middleware } from '../../../http/types.js';
import { openStorage } from '../../../storage/index.js';
import type { Clock, RemoteTokensRepository, Store } from '../../../storage/index.js';
import type { RegisteredRoute, RouteDefinition } from '../../types.js';
import { repoRoot } from '../../__tests__/helpers.js';

import {
  createRemoteMiddleware,
  type AuthBlockDetail,
  type AuthFailureDetail,
  type BrowseDetail,
  type PeerPolicy,
  type RefusalDetail,
  type RemoteAuditSink,
} from '../middleware.js';
import { isApiPath } from '../policy.js';
import { createAuthLimiter, createRouteBucket } from '../rateLimit.js';
import { createRemoteTokenService, type RemoteTokenService } from '../tokens.js';

/** A tailnet-shaped address, for the `Host` allowlist cases. */
export const TAILNET_ADDRESS = '100.64.0.7';
export const MAGIC_DNS = 'workstation.example-tailnet.ts.net';

/** `remote.auth.*` defaults, restated so a test can read the arithmetic. */
export const MAX_FAILURES = 10;
export const FAIL_WINDOW_MS = 300_000;
export const BLOCK_MS = 900_000;
export const BROWSE_LIMIT = 60;

/** Every audit call the chain made, in order, as data. */
export interface AuditTrail {
  readonly failures: AuthFailureDetail[];
  readonly blocks: AuthBlockDetail[];
  readonly browses: BrowseDetail[];
  readonly refusals: RefusalDetail[];
}

export interface RemoteHarness {
  readonly base: string;
  readonly store: Store;
  readonly tokensRepository: RemoteTokensRepository;
  readonly tokens: RemoteTokenService;
  readonly audit: AuditTrail;
  readonly listener: HttpListener;
  readonly middleware: readonly Middleware[];
  /** Milliseconds since the epoch. Assign to move every deadline in the module. */
  now: number;
  /** Mints a token and returns its plaintext (§4.2's display-once, in a test). */
  mint(label?: string, options?: { ttlDays?: number | null }): { id: string; token: string };
  /** One request, with full control of `Host` and the `Authorization` header. */
  call(
    path: string,
    options?: {
      method?: string;
      token?: string;
      body?: unknown;
      host?: string;
      headers?: Record<string, string>;
    },
  ): Promise<CallAnswer>;
  close(): Promise<void>;
}

export interface RemoteHarnessOptions {
  /** Extra routes to mount alongside the fixtures below. */
  readonly routes?: readonly RouteDefinition[];
  /** Overrides the peer predicate. Omit to accept loopback; pass to test the guard. */
  readonly allowPeer?: (address: string) => boolean;
  /**
   * The whole peer policy — predicate, code and message.
   *
   * Passed by `proxy.test.ts` so D5's amended peer allowlist is exercised as the
   * production object rather than as a lambda that happens to agree with it.
   */
  readonly peerPolicy?: PeerPolicy;
  /** Overrides the `Host` allowlist. */
  readonly allowedHosts?: () => readonly string[];
  readonly maxFailures?: number;
  readonly failWindowMs?: number;
  readonly blockMs?: number;
  readonly browseLimit?: number;
  readonly maxActive?: number;
  readonly ttlDays?: number | null;
  readonly peerName?: (address: string) => string | null;
  readonly resolvePath?: (path: string) => string;
  readonly startAt?: number;
}

function quiet(): Logger {
  return pino({ level: 'silent' });
}

export interface CallAnswer {
  readonly status: number;
  readonly text: string;
  readonly json: unknown;
  readonly headers: Headers;
}

/** One request over loopback, with full control of the `Host` header. */
function request(
  port: number,
  path: string,
  options: {
    readonly method: string;
    readonly host: string;
    readonly token?: string;
    readonly body?: unknown;
    readonly headers?: Record<string, string>;
  },
): Promise<CallAnswer> {
  const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
  const headers: Record<string, string> = {
    host: options.host,
    ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
    ...(payload === undefined
      ? {}
      : {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(payload)),
        }),
    ...options.headers,
  };

  return new Promise<CallAnswer>((resolve, reject) => {
    const pending = httpRequest(
      { hostname: '127.0.0.1', port, path, method: options.method, headers },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => void chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed: unknown;
          try {
            parsed = text.length === 0 ? undefined : JSON.parse(text);
          } catch {
            parsed = undefined;
          }
          const collected = new Headers();
          for (const [key, value] of Object.entries(response.headers)) {
            if (typeof value === 'string') collected.set(key, value);
            else if (Array.isArray(value)) collected.set(key, value.join(', '));
          }
          resolve({ status: response.statusCode ?? 0, text, json: parsed, headers: collected });
        });
      },
    );
    pending.on('error', reject);
    if (payload !== undefined) pending.write(payload);
    pending.end();
  });
}

function fixtureRoutes(): readonly RouteDefinition[] {
  return [
    { method: 'GET', path: '/api/health', handler: (_q, r) => r.json({ status: 'ok' }) },
    {
      method: 'GET',
      path: '/api/fs/browse',
      description: 'Stands in for projects’ browse route (§3.3).',
      handler: (request, response) =>
        response.json({ path: request.query.get('path'), entries: [] }),
    },
    {
      method: 'POST',
      path: '/api/service/shutdown',
      remote: 'deny',
      handler: (_q, r) => r.json({ stopping: true }),
    },
    {
      method: 'POST',
      path: '/api/remote/tokens',
      remote: 'deny',
      handler: (_q, r) => r.json({ minted: true }),
    },
    {
      method: 'DELETE',
      path: '/api/remote/tokens/:id',
      handler: (request, response) => response.json({ revoked: request.params['id'] }),
    },
    {
      method: 'POST',
      path: '/api/remote/restart',
      remote: 'deny',
      handler: (_q, r) => r.json({ restarted: true }),
    },
    {
      method: 'PUT',
      path: '/api/remote/enabled',
      handler: (request, response) => response.json({ body: request.body }),
    },
    {
      method: 'POST',
      path: '/api/secrets/notify.ntfy.topicUrl',
      handler: (_q, r) => r.json({ written: true }),
    },
    // The SPA route foundation registers on both listeners, including its history
    // fallback (§6.4, remote §3.1 rule 1) — and including foundation's rule that
    // "`/api/**` never falls through to the fallback; an unknown API path stays a
    // JSON 404", without which this fixture would answer 200 to everything and
    // quietly invalidate the 401/403/404 assertions.
    {
      method: 'GET',
      path: '/*',
      remote: 'allow',
      handler: (request, response) =>
        isApiPath(request.path)
          ? response.error(404, 'not_found', `No route matches ${request.path}.`)
          : response.text(`shell:${request.path}`),
    },
  ];
}

function toRegistered(routes: readonly RouteDefinition[]): readonly RegisteredRoute[] {
  return routes.map((route) => ({
    moduleId: 'fixture',
    method: route.method,
    path: route.path,
    handler: route.handler,
    remote: route.remote ?? 'allow',
    ...(route.description === undefined ? {} : { description: route.description }),
  }));
}

/**
 * Foundation's real schema in a throwaway data root, **plus remote's own module
 * migration** — so `remote_tokens.last_used_peer` exists exactly as it does in the
 * home edition, which is the only edition this module runs in (§4.1, §6.2).
 */
function openTestStorage(clock: Clock): { store: Store; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'agentmanager-remote-auth-'));
  const storage = openStorage({
    dataRoot: dir,
    migrationsDir: join(repoRoot, 'migrations'),
    moduleMigrations: [{ moduleId: 'remote', dir: join(repoRoot, 'migrations', 'remote') }],
    tightenAcl: false,
    acl: { run: () => {} },
    log: () => {},
    clock,
  });
  return {
    store: storage.store,
    cleanup: () => {
      storage.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    },
  };
}

export async function createRemoteHarness(
  options: RemoteHarnessOptions = {},
): Promise<RemoteHarness> {
  const state = { now: options.startAt ?? Date.parse('2026-08-17T12:00:00.000Z') };
  const clock: Clock = () => new Date(state.now);
  const storage = openTestStorage(clock);

  const tokens = createRemoteTokenService({
    tokens: storage.store.remoteTokens,
    clock,
    defaultTtlDays: options.ttlDays === undefined ? 90 : options.ttlDays,
    maxActive: options.maxActive ?? 10,
  });

  const audit: AuditTrail = { failures: [], blocks: [], browses: [], refusals: [] };
  const sink: RemoteAuditSink = {
    authFailed: (detail) => void audit.failures.push(detail),
    authBlocked: (detail) => void audit.blocks.push(detail),
    browsed: (detail) => void audit.browses.push(detail),
    refused: (detail) => void audit.refusals.push(detail),
  };

  const middleware = createRemoteMiddleware({
    tokens,
    limiter: createAuthLimiter({
      maxFailures: options.maxFailures ?? MAX_FAILURES,
      failWindowMs: options.failWindowMs ?? FAIL_WINDOW_MS,
      blockMs: options.blockMs ?? BLOCK_MS,
    }),
    browseBucket: createRouteBucket({
      limit: options.browseLimit ?? BROWSE_LIMIT,
      windowMs: 60_000,
    }),
    clock,
    audit: sink,
    // Loopback, because that is where the socket is (see this file's header). A
    // test that wants a production predicate passes `peerPolicy` (proxy mode) or
    // omits both (tailscale mode's CGNAT check).
    ...(options.peerPolicy === undefined ? {} : { peerPolicy: options.peerPolicy }),
    ...(options.peerPolicy !== undefined && options.allowPeer === undefined
      ? {}
      : {
          allowPeer:
            options.allowPeer ?? ((address) => address === '127.0.0.1' || address === '::1'),
        }),
    allowedHosts: options.allowedHosts ?? (() => ['127.0.0.1', TAILNET_ADDRESS, MAGIC_DNS]),
    ...(options.peerName === undefined ? {} : { peerName: options.peerName }),
    ...(options.resolvePath === undefined ? {} : { resolvePath: options.resolvePath }),
  });

  const logger = quiet();
  const listener = mountRoutes(toRegistered([...(options.routes ?? []), ...fixtureRoutes()]), {
    bind: '127.0.0.1',
    port: 0,
    origin: 'remote',
    name: 'remote-policy-fixture',
    logger,
    accessLogger: logger,
    middleware,
  });
  const address = await listener.listen();
  const base = `http://127.0.0.1:${String(address.port)}`;

  return {
    base,
    store: storage.store,
    tokensRepository: storage.store.remoteTokens,
    tokens,
    audit,
    listener,
    middleware,
    get now() {
      return state.now;
    },
    set now(value: number) {
      state.now = value;
    },

    mint: (label = 'Pixel 9', mintOptions = {}) => {
      const minted = tokens.mint({ label, ...mintOptions });
      return { id: minted.view.id, token: minted.token };
    },

    call: (path, callOptions = {}) =>
      // `node:http` rather than `fetch`, for one reason that matters: `Host` is a
      // forbidden header in undici, so `fetch` silently drops any override and the
      // §9.2 #8 allowlist could never be exercised — a test that always sent the
      // right Host would "pass" against a listener with no Host check at all.
      request(address.port, path, {
        method: callOptions.method ?? 'GET',
        host: callOptions.host ?? '127.0.0.1',
        ...(callOptions.token === undefined ? {} : { token: callOptions.token }),
        ...(callOptions.body === undefined ? {} : { body: callOptions.body }),
        ...(callOptions.headers === undefined ? {} : { headers: callOptions.headers }),
      }),

    close: async () => {
      await listener.close();
      storage.cleanup();
    },
  };
}
