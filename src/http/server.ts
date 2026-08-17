/**
 * The one HTTP framework instance of DESIGN §6.4, and the mount point remote
 * reuses.
 *
 * > "Foundation owns one route table and one HTTP/WS framework instance. The
 * > local listener binds `http.bind` (127.0.0.1). The remote module, when
 * > present, mounts **the same route table** on a second server bound to the
 * > Tailscale address with bearer-token middleware in front and an
 * > `origin: 'remote'` marker on the request context. One API, two listeners."
 *
 * {@link mountRoutes} is therefore `(routeTable, listenerOptions) => server` and
 * is called twice: once by the `http` module for the loopback listener, once by
 * remote for the tailnet one. Everything that differs between the two —
 * bind address, origin marker, the middleware chain, which routes are refused —
 * is a listener option. Nothing in this file knows what "remote" is.
 *
 * ## Framework choice: `node:http`
 *
 * No framework. The surface this file needs is a router, a JSON body reader,
 * SSE and a static handler — roughly 400 lines, all of it already written here
 * — while fastify or express would add a dependency tree to a non-admin desktop
 * install and, more to the point, a *second* request/response contract to adapt
 * to {@link RequestContext}, since handlers must stay mountable on two
 * listeners and testable without a socket. DESIGN §5.1 already sets the
 * precedent ("pino, the only logging dependency"), and the same reasoning
 * applies harder here: the framework would be load-bearing for the security
 * boundary of §6.3/§6.4.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { Logger } from 'pino';

import { newId } from '../storage/index.js';
import type { RegisteredRoute } from '../modules/types.js';

import {
  BodyTooLargeError,
  DEFAULT_MAX_BODY_BYTES,
  InvalidBodyError,
  createRequestContext,
  parseBody,
  readBody,
  type MutableRequestContext,
} from './request.js';
import {
  REQUEST_ID_HEADER,
  bytes,
  empty,
  error,
  json,
  notFound,
  text,
  writeResult,
} from './response.js';
import { Router } from './router.js';
import { openSse, type SseOptions } from './sse.js';
import type {
  HttpResult,
  Middleware,
  RequestOrigin,
  ResponseTools,
  RouteSource,
  SseStream,
} from './types.js';

export interface ListenerOptions {
  /** Interface to bind. Loopback for the local listener (§6.4). */
  readonly bind: string;
  /** `0` asks the OS for an ephemeral port; the bound one is on {@link HttpListener.address}. */
  readonly port: number;
  /** Stamped on every request context (§6.4). */
  readonly origin: RequestOrigin;
  /** Service log — binds, unbinds, handler failures. */
  readonly logger: Logger;
  /** `access.log`: one line per request (§5.1). */
  readonly accessLogger: Logger;
  /** Runs before the matched handler; returning a result short-circuits. */
  readonly middleware?: readonly Middleware[];
  /** Names this listener in log lines. Defaults to {@link origin}. */
  readonly name?: string;
  readonly maxBodyBytes?: number;
  /** Injectable for tests; defaults to a ULID (§1.3). */
  readonly requestId?: () => string;
  /** Injectable so an SSE test is not at the mercy of a 15 s timer. */
  readonly heartbeatMs?: number;
  /** Measures request duration. Defaults to `performance.now`. */
  readonly monotonicMs?: () => number;
}

export interface HttpListener {
  /** Binds the socket. Resolves with the address actually bound. */
  listen(): Promise<AddressInfo>;
  /** Ends every open stream, then closes the socket. Safe to call twice. */
  close(): Promise<void>;
  readonly address: AddressInfo | undefined;
  /** `http://127.0.0.1:7477`, once bound. */
  readonly url: string | undefined;
  readonly server: Server;
  readonly routes: readonly RegisteredRoute[];
  /** Live SSE streams, for diagnostics and tests. */
  readonly streamCount: number;
}

function toRoutes(source: RouteSource): readonly RegisteredRoute[] {
  return Array.isArray(source)
    ? (source as readonly RegisteredRoute[])
    : (source as { routes: readonly RegisteredRoute[] }).routes;
}

/** `::1` and `127.0.0.1` need different bracket treatment in a URL. */
function formatUrl(address: AddressInfo): string {
  const host = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  return `http://${host}:${String(address.port)}`;
}

/**
 * Mounts a route table on a new listener.
 *
 * Callable any number of times against the same table — that is the whole point
 * (§6.4). Nothing is bound until {@link HttpListener.listen} is called, which is
 * what lets the `http` module register in `init` and bind in `start()`, keeping
 * §4.2's "boot tasks run before any listener binds" true.
 */
export function mountRoutes(source: RouteSource, options: ListenerOptions): HttpListener {
  const routes = toRoutes(source);
  const router = new Router(routes);
  const middleware = options.middleware ?? [];
  const nextRequestId = options.requestId ?? newId;
  const monotonic = options.monotonicMs ?? ((): number => performance.now());
  const name = options.name ?? options.origin;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  const streams = new Set<SseStream>();
  let address: AddressInfo | undefined;
  let closing = false;

  const server = createServer((request, response) => {
    void handle(request, response);
  });
  // A stuck client must not hold a shutdown open past the grace budget (§4.2).
  server.keepAliveTimeout = 5_000;

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const started = monotonic();
    const requestId = nextRequestId();
    response.setHeader(REQUEST_ID_HEADER, requestId);

    const controller = new AbortController();
    const abort = (): void => controller.abort();
    request.on('aborted', abort);
    response.on('close', abort);

    let streamed = false;
    let context: MutableRequestContext | undefined;

    const tools: ResponseTools = {
      json,
      text,
      bytes,
      empty,
      error,
      sse: (init): SseStream => {
        streamed = true;
        const sseOptions: SseOptions = {
          ...init,
          ...(options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs }),
        };
        const stream = openSse(response, sseOptions);
        streams.add(stream);
        stream.onClose(() => void streams.delete(stream));
        return stream;
      },
    };

    let result: HttpResult | undefined;
    try {
      const raw =
        request.method === 'GET' || request.method === 'HEAD'
          ? Buffer.alloc(0)
          : await readBody(request, maxBodyBytes);

      context = createRequestContext({
        request,
        origin: options.origin,
        requestId,
        logger: options.logger.child({ requestId }),
        body: parseBody(raw, request.headers['content-type']),
        signal: controller.signal,
      });

      result = await dispatch(context, tools);
    } catch (cause) {
      result = toErrorResult(cause, requestId, options.logger, context?.path ?? request.url ?? '/');
    }

    if (result !== undefined && !response.writableEnded) {
      writeResult(response, result, request.method === 'HEAD');
    }

    logAccess({
      accessLogger: options.accessLogger,
      request,
      context,
      requestId,
      status: response.statusCode,
      durationMs: Math.round((monotonic() - started) * 1000) / 1000,
      origin: options.origin,
      streamed,
      listener: name,
    });
  }

  async function dispatch(
    context: MutableRequestContext,
    tools: ResponseTools,
  ): Promise<HttpResult | undefined> {
    const match = router.match(context.method, context.path);
    // The route is bound *before* the middleware chain, so an authenticating
    // middleware can read `req.route.remote` — which is precisely what remote's
    // `deny` check needs, and the reason foundation records the flag at all.
    if (match !== undefined) context.bind(match.route, match.params);

    for (const step of middleware) {
      const short = await step(context, tools);
      if (short !== undefined) return short;
    }

    if (match === undefined) {
      const allowed = router.allowedMethods(context.path);
      return allowed.length > 0
        ? methodNotAllowed(context.method, context.path, allowed)
        : notFound(context.path);
    }

    const handled = await match.route.handler(context, tools);
    return handled ?? undefined;
  }

  return {
    server,
    routes,
    get address() {
      return address;
    },
    get url() {
      return address === undefined ? undefined : formatUrl(address);
    },
    get streamCount() {
      return streams.size;
    },

    listen: () =>
      new Promise<AddressInfo>((resolve, reject) => {
        const onError = (cause: Error): void => reject(cause);
        server.once('error', onError);
        server.listen(options.port, options.bind, () => {
          server.removeListener('error', onError);
          address = server.address() as AddressInfo;
          options.logger.info(
            { listener: name, bind: address.address, port: address.port, origin: options.origin },
            `http listener bound on ${formatUrl(address)}`,
          );
          resolve(address);
        });
      }),

    close: async () => {
      if (closing) return;
      closing = true;
      // Live streams hold the socket open forever by design, so they are ended
      // first; without this `server.close()` never calls back and §4.2's
      // shutdown budget would be spent waiting on a log viewer.
      for (const stream of [...streams]) stream.close();
      streams.clear();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections();
        server.closeAllConnections();
      });
      options.logger.info({ listener: name }, 'http listener closed');
      address = undefined;
    },
  };
}

/** 405 with the `Allow` header RFC 9110 §15.5.6 requires. */
function methodNotAllowed(method: string, path: string, allowed: readonly string[]): HttpResult {
  const result = error(405, 'method_not_allowed', `${method} is not allowed for ${path}.`, {
    allow: [...allowed],
  });
  return { ...result, headers: { ...result.headers, allow: allowed.join(', ') } };
}

function toErrorResult(
  cause: unknown,
  requestId: string,
  logger: Logger,
  path: string,
): HttpResult {
  if (cause instanceof BodyTooLargeError) {
    return error(413, 'payload_too_large', cause.message, { limit: cause.limit });
  }
  if (cause instanceof InvalidBodyError) {
    return error(400, 'invalid_request', cause.message);
  }
  logger.error({ err: cause, requestId, path }, 'request handler failed');
  return error(500, 'internal_error', 'The request could not be completed.', { requestId });
}

interface AccessLogInput {
  readonly accessLogger: Logger;
  readonly request: IncomingMessage;
  readonly context: MutableRequestContext | undefined;
  readonly requestId: string;
  readonly status: number;
  readonly durationMs: number;
  readonly origin: RequestOrigin;
  readonly streamed: boolean;
  readonly listener: string;
}

/**
 * One line per request on `access.log` (§5.1) — "method, path, status,
 * duration, origin, `tokenId`, token prefix, remote peer. Auth failures at
 * `warn`."
 *
 * `url` carries the query string and goes through the logger's redaction, which
 * scrubs credential-bearing parameters (§5.4); `path` stays clean so a log query
 * can group by endpoint.
 */
function logAccess(input: AccessLogInput): void {
  const level = input.status === 401 || input.status === 403 ? 'warn' : 'info';
  const context = input.context;
  input.accessLogger[level](
    {
      requestId: input.requestId,
      method: context?.method ?? input.request.method ?? 'GET',
      path: context?.path ?? input.request.url ?? '/',
      url: input.request.url ?? '/',
      status: input.status,
      durationMs: input.durationMs,
      origin: input.origin,
      listener: input.listener,
      ...(input.streamed ? { streamed: true } : {}),
      ...(context?.tokenId === undefined ? {} : { tokenId: context.tokenId }),
      // Remote's audit enrichment (its §9.1 #4): the display prefix and the
      // tailnet node name, present only on the listener that authenticates.
      ...(context?.tokenAttribution?.prefix === undefined
        ? {}
        : { tokenPrefix: context.tokenAttribution.prefix }),
      ...(context?.tokenAttribution?.peerName === undefined
        ? {}
        : { peerName: context.tokenAttribution.peerName }),
      ...(context?.remoteAddress === undefined ? {} : { peer: context.remoteAddress }),
      ...(context?.route === undefined ? {} : { route: context.route.path }),
    },
    'request',
  );
}
