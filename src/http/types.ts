/**
 * **The route handler contract** (foundation DESIGN §6.4, milestone M8).
 *
 * This is the surface every feature module and the remote element code against.
 * M7 owned the route *table* and left the handler deliberately opaque
 * (`(...args: never[]) => unknown`) because "the request/response contract
 * arrives with the server in M8". This file is that contract, and
 * `src/modules/types.ts` now re-exports {@link RouteHandler} from here so there
 * is exactly one definition.
 *
 * ```ts
 * const route: RouteDefinition = {
 *   method: 'GET',
 *   path: '/api/sessions/:id',
 *   remote: 'allow',
 *   handler: (req, res) => res.json({ id: req.params['id'] }),
 * };
 * ```
 *
 * Three properties the shape exists to guarantee:
 *
 * - **A handler never sees a Node `IncomingMessage`.** It receives a parsed,
 *   framework-agnostic {@link RequestContext} and returns a value. That is what
 *   makes the same handler mountable on two listeners (§6.4: "One API, two
 *   listeners") and unit-testable without a socket.
 * - **`origin` is data, not a code path.** The local listener stamps `'local'`,
 *   remote stamps `'remote'` and attributes a `tokenId`; a handler that cares
 *   reads the field, and foundation itself enforces nothing (§6.4).
 * - **Streaming is explicit.** A handler that opens an SSE stream takes over the
 *   response and returns nothing, so the caller can tell a buffered response
 *   from a long-lived one without inspecting the socket.
 */
import type { IncomingHttpHeaders } from 'node:http';

import type { Logger } from 'pino';

import type { HttpMethod, RegisteredRoute } from '../modules/types.js';

/**
 * Which listener the request arrived on (§6.4).
 *
 * "The remote module […] mounts the same route table on a second server bound to
 * the Tailscale address with bearer-token middleware in front and an
 * `origin: 'remote'` marker on the request context."
 */
export type RequestOrigin = 'local' | 'remote';

/**
 * One request, as a handler sees it.
 *
 * `query` is a standard `URLSearchParams` rather than a hand-rolled record: it
 * already answers `get`/`getAll`/`has` correctly for repeated parameters, and
 * inventing a third convention for query strings would be a contract every
 * element has to learn.
 */
export interface RequestContext {
  /** The method as received (`GET`, `POST`, …). Never the route's `ALL`. */
  readonly method: string;
  /** Path only — no query string, always starting with `/`. */
  readonly path: string;
  /** Values captured by the matched pattern's `:name` segments. */
  readonly params: Readonly<Record<string, string>>;
  readonly query: URLSearchParams;
  /** Parsed JSON body, or `undefined` when the request carried none. */
  readonly body: unknown;
  readonly origin: RequestOrigin;
  /** ULID, echoed in the `x-request-id` response header and in `access.log`. */
  readonly requestId: string;
  /**
   * `remote_tokens.id` of the credential that authenticated the request — never
   * the token itself (§5.1). Set by remote's middleware through
   * {@link attributeToken}; always absent on the loopback listener, which has no
   * authentication by design (§6.4).
   */
  readonly tokenId: string | undefined;
  readonly headers: IncomingHttpHeaders;
  /** Path and query as received, before parsing. */
  readonly url: string;
  readonly remoteAddress: string | undefined;
  /** Child logger already tagged with `requestId`. */
  readonly logger: Logger;
  /** Aborts when the client disconnects — the exit condition for a stream. */
  readonly signal: AbortSignal;
  /** The route this request matched, once one has. */
  readonly route: RegisteredRoute | undefined;

  /** Records the credential that authenticated this request (remote's middleware). */
  attributeToken(tokenId: string): void;
}

export interface ResponseInit {
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * A finished response, still just data.
 *
 * The body is serialised by the helper that built it, so a test can assert on a
 * handler's return value without a socket, and the writer has nothing left to
 * decide.
 */
export interface HttpResult {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  /** `undefined` for `204`/`304` and for `HEAD`. */
  readonly body: Buffer | undefined;
}

/** One server-sent event. `data` is JSON-encoded unless it is already a string. */
export interface SseMessage {
  readonly data: unknown;
  /** SSE `event:` field — the event type a browser's `addEventListener` keys on. */
  readonly event?: string;
  /** SSE `id:` field — what the client sends back as `Last-Event-ID`. */
  readonly id?: string;
  /** Reconnection hint, milliseconds. */
  readonly retry?: number;
}

/** A live server-sent-events response the handler owns until it closes. */
export interface SseStream {
  send(message: SseMessage): void;
  /** A `: comment` line — the keep-alive that stops an idle proxy timing out. */
  comment(text: string): void;
  /** Runs when either side closes. Safe to register more than once. */
  onClose(listener: () => void): void;
  close(): void;
  readonly closed: boolean;
}

/** Response helpers handed to every handler (§6.4: "json, status, stream/SSE"). */
export interface ResponseTools {
  /** `application/json`, status 200 unless overridden. */
  json(body: unknown, init?: ResponseInit): HttpResult;
  text(body: string, init?: ResponseInit): HttpResult;
  bytes(body: Buffer, contentType: string, init?: ResponseInit): HttpResult;
  /** A body-less response: `204` by default. */
  empty(status?: number, init?: ResponseInit): HttpResult;
  /** The one error shape every foundation route returns: `{error, message}`. */
  error(status: number, code: string, message: string, extra?: Record<string, unknown>): HttpResult;
  /**
   * Opens a server-sent-events stream, writing the headers immediately.
   *
   * The handler owns the response from here and returns nothing; the listener
   * writes its access-log line as soon as the handler returns, because a stream
   * that lives for an hour must not hold its audit line for an hour.
   */
  sse(init?: ResponseInit): SseStream;
}

/**
 * What a route does. Returning nothing means "I wrote the response myself",
 * which in v1 means an SSE stream.
 */
export type RouteHandler = (
  req: RequestContext,
  res: ResponseTools,
) => HttpResult | void | Promise<HttpResult | void>;

/**
 * Runs before the matched handler. Returning a result short-circuits the
 * request — which is exactly how remote's bearer check refuses one (§6.4).
 */
export type Middleware = (
  req: RequestContext,
  res: ResponseTools,
) => HttpResult | void | Promise<HttpResult | void>;

/** Anything the mount function accepts as a route table. */
export type RouteSource =
  readonly RegisteredRoute[] | { readonly routes: readonly RegisteredRoute[] };

export type { HttpMethod };
