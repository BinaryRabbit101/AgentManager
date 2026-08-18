/**
 * The fixture for M7 and M8: **a real second listener**, with remote's real
 * middleware chain, remote's real routes, real storage, a real event bus and the
 * real redacting `access.log` writer in front of it.
 *
 * ## Why it is a real socket and a real SSE client
 *
 * Every criterion in IMPLEMENTATION §7 is about what a *browser-shaped* client
 * gets: something that "connects to `/api/events` … using a ticket" with **no
 * custom headers**, receives an event "within 1 s", is closed "within 1 s" of a
 * revoke, and leaves no map entry behind when it drops. None of that can be
 * asserted against a middleware's return value, so these tests speak HTTP over a
 * loopback socket, and the SSE client below sets exactly the headers a browser
 * would: none. It cannot send `Authorization` even by accident, because the helper
 * has no parameter for it.
 *
 * Binding loopback here is not a hole in D5 — the same note the M4–M6 harness
 * carries applies unchanged: production binding is pinned by `listener.test.ts`
 * and `proxy.test.ts` through the validated `assertBindable` path, and this
 * fixture never goes near it. The peer predicate is injected for the same reason
 * (loopback is correctly refused by both of D5's production predicates).
 *
 * ## Why the fixture launch routes really write rows
 *
 * IMPLEMENTATION §8's first two criteria are "returns 409 … and **creates no
 * assignment and no session row**". A stub handler would satisfy that trivially
 * and prove nothing. The launch fixtures below therefore write to the real
 * `assignments` and `sessions` repositories, so "no row" is only true if the gate
 * refused *before* the handler ran — which is the property under test.
 *
 * ## Nothing here reads a real clock
 *
 * {@link StreamHarness.now} is a mutable millisecond counter behind a `Clock`, so
 * ticket TTLs, grant deadlines and the sliding window are moved by assignment.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pino, type Logger } from 'pino';

import { createLogging, type Logging } from '../../../logging/index.js';
import { mountRoutes, type HttpListener } from '../../../http/server.js';
import { openStorage } from '../../../storage/index.js';
import { newId, type Clock, type Store } from '../../../storage/index.js';
import { createEventBus } from '../../bus.js';
import type { AppEvent, EventBus, RegisteredRoute, RouteDefinition } from '../../types.js';
import { repoRoot } from '../../__tests__/helpers.js';

import { createGrantStore, type GrantStore } from '../grants.js';
import { createRemoteMiddleware, type RemoteAuditSink } from '../middleware.js';
import { isApiPath } from '../policy.js';
import { createAuthLimiter, createRouteBucket } from '../rateLimit.js';
import { createGrantRoutes, createStreamRoutes } from '../streamRoutes.js';
import { createStreamRegistry, type StreamRegistry } from '../streams.js';
import { createTicketStore, type TicketStore } from '../tickets.js';
import { createTokenRoutes } from '../tokenRoutes.js';
import { createRemoteTokenService, type RemoteTokenService } from '../tokens.js';

export const HARNESS_HOST = '127.0.0.1';

/** `remote.stream.*` defaults, restated so a test can read the arithmetic. */
export const TICKET_TTL_SEC = 30;
export const GRANT_TTL_HOURS = 72;

export interface CallAnswer {
  readonly status: number;
  readonly text: string;
  readonly json: unknown;
  readonly headers: Headers;
}

/** One server-sent event as this client parsed it. */
export interface SseFrame {
  readonly event: string | undefined;
  readonly id: string | undefined;
  readonly data: string;
}

/**
 * A browser-shaped SSE connection.
 *
 * There is deliberately **no** way to give it a header: `new EventSource(url)`
 * cannot set one, and a fixture that could would let a test pass against a
 * listener that never honoured a ticket at all.
 */
export interface SseClient {
  readonly status: number;
  readonly frames: readonly SseFrame[];
  /** Resolves with the first frame matching `event`, or rejects on timeout. */
  waitFor(event: string, timeoutMs?: number): Promise<SseFrame>;
  /** Resolves when the server closes the connection, or rejects on timeout. */
  waitForClose(timeoutMs?: number): Promise<void>;
  readonly closed: boolean;
  /** Drops the socket the way a phone leaving coverage does. */
  drop(): void;
}

export interface StreamHarness {
  readonly base: string;
  readonly store: Store;
  readonly bus: EventBus;
  readonly tokens: RemoteTokenService;
  readonly tickets: TicketStore;
  readonly streams: StreamRegistry;
  readonly grants: GrantStore;
  /** Every event the bus emitted, in order. */
  readonly events: readonly AppEvent[];
  /** Every refusal remote's audit sink recorded, as data. */
  readonly refusals: readonly { status: number; code: string; reason: string }[];
  /** Milliseconds since the epoch. Assign to move every deadline in the module. */
  now: number;
  mint(label?: string): { id: string; token: string };
  call(
    path: string,
    options?: {
      method?: string;
      token?: string;
      body?: unknown;
      headers?: Record<string, string>;
    },
  ): Promise<CallAnswer>;
  /** Opens an SSE connection with no headers at all — a browser, in other words. */
  sse(path: string): Promise<SseClient>;
  /**
   * A request that resolves on the response *headers* and then drops the socket.
   *
   * For the one case {@link StreamHarness.call} cannot serve: a long-lived stream
   * opened with an `Authorization` header, where waiting for the body to end would
   * be waiting forever.
   */
  probe(path: string, options?: { token?: string }): Promise<number>;
  /** Mints a ticket through the real route and returns its value. */
  ticketFor(token: string): Promise<string>;
  /** One heartbeat tick now instead of on a timer; returns connections reaped. */
  heartbeat(): number;
  seedAgent(name: string, options?: { archived?: boolean }): string;
  seedProject(): string;
  seedAssignment(projectId: string, agentIds: readonly string[]): string;
  seedSession(assignmentId: string, agentId: string, projectId: string): string;
  /** Flushes the real log streams and returns `access.log` verbatim. */
  readAccessLog(): Promise<string>;
  close(): Promise<void>;
}

export interface StreamHarnessOptions {
  readonly ticketTtlSec?: number;
  readonly grantTtlHours?: number;
  readonly startAt?: number;
  readonly routes?: readonly RouteDefinition[];
  /** Omit for the enabled default; `false` exercises §6.3's global kill switch. */
  readonly remoteEnabled?: () => boolean;
}

function quiet(): Logger {
  return pino({ level: 'silent' });
}

function request(
  port: number,
  path: string,
  options: {
    readonly method: string;
    readonly token?: string;
    readonly body?: unknown;
    readonly headers?: Record<string, string>;
  },
): Promise<CallAnswer> {
  const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
  const headers: Record<string, string> = {
    host: HARNESS_HOST,
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
      { hostname: HARNESS_HOST, port, path, method: options.method, headers },
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

/** Parses an SSE byte stream into frames as they arrive. */
function openSseClient(port: number, path: string): Promise<SseClient> {
  return new Promise<SseClient>((resolve, reject) => {
    const frames: SseFrame[] = [];
    const waiters: { event: string; settle: (frame: SseFrame) => void }[] = [];
    const closeWaiters: (() => void)[] = [];
    let closed = false;
    let buffer = '';

    const finish = (): void => {
      if (closed) return;
      closed = true;
      for (const settle of [...closeWaiters]) settle();
    };

    const push = (block: string): void => {
      let event: string | undefined;
      let id: string | undefined;
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7);
        else if (line.startsWith('id: ')) id = line.slice(4);
        else if (line.startsWith('data: ')) data.push(line.slice(6));
      }
      // A bare `: comment` keep-alive carries no fields and is not a frame.
      if (event === undefined && id === undefined && data.length === 0) return;
      const frame: SseFrame = { event, id, data: data.join('\n') };
      frames.push(frame);
      for (const waiter of [...waiters]) {
        if (waiter.event !== frame.event) continue;
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.settle(frame);
      }
    };

    // Exactly the headers a browser's EventSource sends: no authorization, no
    // custom header of any kind.
    const pending: ClientRequest = httpRequest(
      {
        hostname: HARNESS_HOST,
        port,
        path,
        method: 'GET',
        headers: { host: HARNESS_HOST, accept: 'text/event-stream' },
      },
      (response: IncomingMessage) => {
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          buffer += chunk;
          for (;;) {
            const split = buffer.indexOf('\n\n');
            if (split === -1) break;
            const block = buffer.slice(0, split);
            buffer = buffer.slice(split + 2);
            push(block);
          }
        });
        response.on('end', finish);
        response.on('close', finish);
        response.on('error', finish);

        resolve({
          status: response.statusCode ?? 0,
          get frames() {
            return frames;
          },
          get closed() {
            return closed;
          },
          waitFor: (event, timeoutMs = 2_000) =>
            new Promise<SseFrame>((settle, fail) => {
              const existing = frames.find((frame) => frame.event === event);
              if (existing !== undefined) {
                settle(existing);
                return;
              }
              const timer = setTimeout(
                () => fail(new Error(`no "${event}" frame within ${String(timeoutMs)} ms`)),
                timeoutMs,
              );
              waiters.push({
                event,
                settle: (frame) => {
                  clearTimeout(timer);
                  settle(frame);
                },
              });
            }),
          waitForClose: (timeoutMs = 2_000) =>
            new Promise<void>((settle, fail) => {
              if (closed) {
                settle();
                return;
              }
              const timer = setTimeout(
                () => fail(new Error(`the stream stayed open past ${String(timeoutMs)} ms`)),
                timeoutMs,
              );
              closeWaiters.push(() => {
                clearTimeout(timer);
                settle();
              });
            }),
          drop: () => {
            // A phone driving out of coverage: the socket goes without a graceful
            // close from the application layer.
            response.destroy();
            pending.destroy();
            finish();
          },
        });
      },
    );
    pending.on('error', (cause) => {
      if (closed) return;
      reject(cause);
    });
    pending.end();
  });
}

/**
 * Foundation's real schema plus remote's own module migration, in a throwaway
 * data root.
 */
function openTestStorage(clock: Clock): { store: Store; cleanup: () => void; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'agentmanager-remote-stream-'));
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
    dir,
    cleanup: () => {
      storage.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    },
  };
}

export async function createRemoteStreamHarness(
  options: StreamHarnessOptions = {},
): Promise<StreamHarness> {
  const state = { now: options.startAt ?? Date.parse('2026-08-17T12:00:00.000Z') };
  const clock: Clock = () => new Date(state.now);
  const storage = openTestStorage(clock);
  const logsDir = join(storage.dir, 'logs');
  // The **real** logger, with the real redaction chain: IMPLEMENTATION §7's "no
  // `ticket` or `Authorization` value appears in `access.log`" is a property of
  // that chain, and a silent logger would make the assertion vacuous.
  const logging: Logging = createLogging({ logsDir, level: 'debug', pretty: false });

  const events: AppEvent[] = [];
  const bus = createEventBus({
    clock,
    events: storage.store.events,
    onPersistError: (error) => {
      throw error;
    },
  });
  bus.subscribe((event) => void events.push(event));

  const tokens = createRemoteTokenService({
    tokens: storage.store.remoteTokens,
    clock,
    defaultTtlDays: 90,
    maxActive: 10,
  });
  const tickets = createTicketStore({ ttlSec: options.ticketTtlSec ?? TICKET_TTL_SEC });
  const streams = createStreamRegistry();
  const grants = createGrantStore({
    settings: storage.store.settings,
    agents: storage.store.agents,
    clock,
    bus,
    logger: quiet(),
    ttlHours: options.grantTtlHours ?? GRANT_TTL_HOURS,
  });

  const refusals: { status: number; code: string; reason: string }[] = [];
  const audit: RemoteAuditSink = {
    authFailed: () => {},
    authBlocked: () => {},
    browsed: () => {},
    refused: (detail) =>
      void refusals.push({ status: detail.status, code: detail.code, reason: detail.reason }),
  };

  const middleware = createRemoteMiddleware({
    tokens,
    limiter: createAuthLimiter({ maxFailures: 10, failWindowMs: 300_000, blockMs: 900_000 }),
    browseBucket: createRouteBucket({ limit: 60, windowMs: 60_000 }),
    clock,
    audit,
    // Loopback, because that is where the socket is. Both production predicates
    // refuse it, correctly, and they have their own tests.
    allowPeer: (address) => address === '127.0.0.1' || address === '::1',
    allowedHosts: () => [HARNESS_HOST],
    tickets,
    streams,
    gate: {
      grants,
      stores: {
        sessions: storage.store.sessions,
        assignments: storage.store.assignments,
        agents: storage.store.agents,
      },
      enabled: options.remoteEnabled ?? ((): boolean => true),
    },
  });

  const fixtures = launchFixtures(storage.store, bus);
  const remoteRoutes = [
    ...createStreamRoutes({ tickets, streams, clock, logger: quiet() }),
    ...createGrantRoutes({ grants, clock, logger: quiet() }),
    ...createTokenRoutes({
      tokens,
      // The kill switch and status are not under test here; the token routes are
      // included for §4.5's revoke, which is.
      listener: {
        start: () => Promise.resolve(),
        stop: () => Promise.resolve(),
        restart: () => Promise.resolve(),
        boundAddress: () => null,
        status: () => ({
          state: 'listening',
          enabled: true,
          boundAddress: null,
          port: 0,
          magicDnsName: null,
          tailscaleState: null,
          lastError: null,
          recentBindFailures: 0,
          detectionSource: null,
          mode: 'tailscale',
        }),
        poll: () => Promise.resolve(),
      },
      settings: storage.store.settings,
      clientHints: { publicUrl: null, hostnameHint: null },
      logger: quiet(),
      streams,
      grants,
      onEnabledChanged: () => {},
    }),
  ];

  const listener: HttpListener = mountRoutes(
    toRegistered([...(options.routes ?? []), ...remoteRoutes, ...fixtures]),
    {
      bind: HARNESS_HOST,
      port: 0,
      origin: 'remote',
      name: 'remote-stream-fixture',
      logger: quiet(),
      // The real access logger, so the redaction assertion is about production code.
      accessLogger: logging.accessLogger,
      middleware,
      // The SSE keep-alive timer is remote's job here, not foundation's: a
      // 15-second foundation heartbeat would interleave with the deterministic
      // one the tests drive.
      heartbeatMs: 0,
    },
  );
  const address = await listener.listen();

  return {
    base: `http://${HARNESS_HOST}:${String(address.port)}`,
    store: storage.store,
    bus,
    tokens,
    tickets,
    streams,
    grants,
    events,
    refusals,
    get now() {
      return state.now;
    },
    set now(value: number) {
      state.now = value;
    },

    mint: (label = 'Pixel 9') => {
      const minted = tokens.mint({ label });
      return { id: minted.view.id, token: minted.token };
    },

    call: (path, callOptions = {}) =>
      request(address.port, path, {
        method: callOptions.method ?? 'GET',
        ...(callOptions.token === undefined ? {} : { token: callOptions.token }),
        ...(callOptions.body === undefined ? {} : { body: callOptions.body }),
        ...(callOptions.headers === undefined ? {} : { headers: callOptions.headers }),
      }),

    sse: (path) => openSseClient(address.port, path),

    probe: (path, probeOptions = {}) =>
      new Promise<number>((resolve, reject) => {
        const pending = httpRequest(
          {
            hostname: HARNESS_HOST,
            port: address.port,
            path,
            method: 'GET',
            headers: {
              host: HARNESS_HOST,
              ...(probeOptions.token === undefined
                ? {}
                : { authorization: `Bearer ${probeOptions.token}` }),
            },
          },
          (response) => {
            const status = response.statusCode ?? 0;
            response.destroy();
            pending.destroy();
            resolve(status);
          },
        );
        pending.on('error', reject);
        pending.end();
      }),

    ticketFor: async (token) => {
      const answer = await request(address.port, '/api/remote/stream-ticket', {
        method: 'POST',
        token,
      });
      const ticket = (answer.json as { ticket?: string } | undefined)?.ticket;
      if (typeof ticket !== 'string') {
        throw new Error(`the ticket route answered ${String(answer.status)}: ${answer.text}`);
      }
      return ticket;
    },

    heartbeat: () => {
      tickets.sweep(state.now);
      return streams.beat();
    },

    seedAgent: (name, agentOptions = {}) => {
      const id = newId();
      storage.store.agents.upsert({
        id,
        name,
        ...(agentOptions.archived === true
          ? { archivedAt: new Date(state.now).toISOString() }
          : {}),
      });
      return id;
    },

    seedProject: () => {
      const slug = `project-${newId().toLowerCase()}`;
      const project = storage.store.projects.create({
        name: slug,
        slug,
        localPath: join(storage.dir, slug),
      });
      return project.id;
    },

    seedAssignment: (projectId, agentIds) =>
      storage.store.assignments.create({
        projectId,
        pattern: agentIds.length > 1 ? 'pair' : 'solo',
        members: agentIds.map((agentId) => ({ agentId, role: 'implementer' })),
      }).id,

    seedSession: (assignmentId, agentId, projectId) =>
      storage.store.sessions.create({ assignmentId, agentId, projectId }).id,

    readAccessLog: async () => {
      await logging.flushAndClose();
      return readFileSync(join(logsDir, 'access.log'), 'utf8');
    },

    close: async () => {
      streams.closeAll();
      await listener.close();
      await logging.flushAndClose().catch(() => undefined);
      storage.cleanup();
    },
  };
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
 * Stand-ins for the routes of the live inventory that M7/M8 are about.
 *
 * The streaming three are foundation's and runner's; the launch and control verbs
 * are orchestrator's and runner's. Each fixture does the *minimum that makes the
 * criterion meaningful* — and for the launch verbs that means really writing rows,
 * so "creates no assignment and no session row" is a claim about the gate rather
 * than about a stub.
 */
function launchFixtures(store: Store, bus: EventBus): readonly RouteDefinition[] {
  const field = (body: unknown, key: string): string => {
    const record =
      typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
    const value = record[key];
    return typeof value === 'string' ? value : '';
  };
  const members = (body: unknown): { agentId: string }[] => {
    const record =
      typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
    const raw = record['members'];
    return Array.isArray(raw) ? (raw as { agentId: string }[]) : [];
  };

  return [
    // --- the streaming surfaces of §3.4 -------------------------------------
    {
      method: 'GET',
      path: '/api/events',
      handler: (request, response) => {
        const stream = response.sse();
        const unsubscribe = bus.subscribe((event) => {
          stream.send({ event: 'event', data: JSON.stringify({ type: event.type }) });
        });
        stream.onClose(unsubscribe);
        request.signal.addEventListener('abort', () => stream.close(), { once: true });
        stream.send({ event: 'replay-complete', data: '{}' });
      },
    },
    {
      method: 'GET',
      path: '/api/logs/stream',
      handler: (_request, response) => {
        const stream = response.sse();
        stream.send({ event: 'replay-complete', data: '{}' });
      },
    },
    {
      method: 'GET',
      path: '/api/sessions/:id/stream',
      handler: (_request, response) => {
        const stream = response.sse();
        stream.send({ event: 'replay-complete', data: '{}' });
      },
    },

    // --- the Initiate tier of §6.2 ------------------------------------------
    {
      method: 'POST',
      path: '/api/assignments/solo',
      handler: (request, response) => {
        const projectId = field(request.body, 'projectId');
        const agentId = field(request.body, 'agentId');
        const assignment = store.assignments.create({
          projectId,
          pattern: 'solo',
          members: [{ agentId, role: 'implementer' }],
        });
        const session = store.sessions.create({
          assignmentId: assignment.id,
          agentId,
          projectId,
          origin: request.origin,
        });
        return response.json(
          { assignmentId: assignment.id, sessionId: session.id, origin: session.origin },
          { status: 201 },
        );
      },
    },
    {
      method: 'POST',
      path: '/api/assignments',
      handler: (request, response) => {
        const assignment = store.assignments.create({
          projectId: field(request.body, 'projectId'),
          pattern: 'pair',
          members: members(request.body).map((member) => ({
            agentId: member.agentId,
            role: 'implementer',
          })),
        });
        return response.json({ assignmentId: assignment.id }, { status: 201 });
      },
    },
    {
      // Named by DESIGN §6.2 and not yet registered by orchestrator; the fixture
      // exists so the criterion "the same test covers POST /api/assignments/:id/
      // advance" is exercised against a *matched* route, with `:id` bound, rather
      // than only against the unresolved-agents fallback.
      method: 'POST',
      path: '/api/assignments/:id/advance',
      handler: (request, response) => {
        const assignmentId = request.params['id'] ?? '';
        const assignment = store.assignments.get(assignmentId);
        if (assignment === undefined) {
          return response.error(404, 'not_found', `No assignment ${assignmentId}.`);
        }
        for (const member of store.assignments.listMembers(assignmentId)) {
          store.sessions.create({
            assignmentId,
            agentId: member.agentId,
            projectId: assignment.projectId,
            origin: request.origin,
          });
        }
        return response.json({ advanced: assignmentId }, { status: 201 });
      },
    },
    {
      method: 'POST',
      path: '/api/sessions/:id/steer',
      handler: (request, response) => response.json({ steered: request.params['id'] }),
    },
    {
      method: 'POST',
      path: '/api/sessions/:id/resume',
      handler: (request, response) => response.json({ resumed: request.params['id'] }),
    },

    // --- the Restrain tier of §6.2, ungated in both directions --------------
    {
      method: 'POST',
      path: '/api/sessions/:id/stop',
      handler: (request, response) => response.json({ stopped: request.params['id'] }),
    },
    {
      method: 'POST',
      path: '/api/sessions/:id/pause',
      handler: (request, response) => response.json({ paused: request.params['id'] }),
    },

    // --- the Observe tier, including §7.4's hard invariant ------------------
    {
      method: 'GET',
      path: '/api/sessions/:id/transcript',
      handler: (request, response) => response.json({ sessionId: request.params['id'], lines: [] }),
    },
    {
      method: 'POST',
      path: '/api/questions/:id/answer',
      handler: (request, response) =>
        response.json({ questionId: request.params['id'], answeredVia: request.origin }),
    },
    {
      method: 'POST',
      path: '/api/sessions/:id/pin',
      handler: (request, response) => response.json({ pinned: request.params['id'] }),
    },
    {
      method: 'GET',
      path: '/api/health',
      handler: (_request, response) => response.json({ status: 'ok' }),
    },

    // Foundation's SPA route and its history fallback, including the rule that
    // `/api/**` never falls through to it.
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
