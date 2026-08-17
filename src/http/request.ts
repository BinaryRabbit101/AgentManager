/**
 * Turning a Node `IncomingMessage` into the framework-agnostic
 * {@link RequestContext} handlers are written against.
 *
 * This is the only file in the tree that knows what an `IncomingMessage` is;
 * everything above it — foundation's routes, every feature module's routes, and
 * remote's middleware — sees the parsed context and nothing else.
 */
import type { IncomingMessage } from 'node:http';

import type { Logger } from 'pino';

import type { RegisteredRoute } from '../modules/types.js';

import type { RequestContext, RequestOrigin, TokenAttribution } from './types.js';

/** Bodies larger than this are refused with 413 rather than buffered. */
export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

export class BodyTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`Request body exceeds the ${String(limit)}-byte limit.`);
    this.name = 'BodyTooLargeError';
  }
}

export class InvalidBodyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidBodyError';
  }
}

/** Reads the whole body, refusing anything past `limit`. */
export async function readBody(
  request: IncomingMessage,
  limit = DEFAULT_MAX_BODY_BYTES,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.byteLength;
    if (size > limit) throw new BodyTooLargeError(limit);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/**
 * Parses the body by content type.
 *
 * JSON only in v1 — every write endpoint foundation ships takes JSON, and a
 * form parser nothing calls is a surface with no consumer. Anything else is
 * handed on as the raw buffer, so a future upload route needs no change here.
 */
export function parseBody(raw: Buffer, contentType: string | undefined): unknown {
  if (raw.byteLength === 0) return undefined;
  const type = (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (type === '' || type === 'application/json' || type.endsWith('+json')) {
    try {
      return JSON.parse(raw.toString('utf8'));
    } catch (cause) {
      throw new InvalidBodyError(
        `Request body is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }
  return raw;
}

export interface RequestContextOptions {
  readonly request: IncomingMessage;
  readonly origin: RequestOrigin;
  readonly requestId: string;
  readonly logger: Logger;
  readonly body: unknown;
  readonly signal: AbortSignal;
}

/**
 * The concrete context.
 *
 * A class rather than an object literal for one reason: `tokenId` is written
 * once, by an authenticating middleware, and read by everything downstream
 * (including the access-log line). A private field with a getter expresses
 * "assign-once, read-only to handlers" in a way a frozen literal cannot.
 */
class Request implements RequestContext {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly body: unknown;
  readonly origin: RequestOrigin;
  readonly requestId: string;
  readonly headers;
  readonly url: string;
  readonly remoteAddress: string | undefined;
  readonly logger: Logger;
  readonly signal: AbortSignal;

  #params: Readonly<Record<string, string>> = {};
  #route: RegisteredRoute | undefined = undefined;
  #tokenId: string | undefined = undefined;
  #tokenAttribution: TokenAttribution | undefined = undefined;

  constructor(options: RequestContextOptions) {
    const { request } = options;
    this.method = (request.method ?? 'GET').toUpperCase();
    this.url = request.url ?? '/';
    // A base is required by the URL parser and is never used: only the path and
    // the query survive, so the (possibly spoofed) Host header cannot matter.
    const parsed = new URL(this.url, 'http://localhost');
    this.path = normalisePath(parsed.pathname);
    this.query = parsed.searchParams;
    this.body = options.body;
    this.origin = options.origin;
    this.requestId = options.requestId;
    this.headers = request.headers;
    this.remoteAddress = request.socket.remoteAddress ?? undefined;
    this.logger = options.logger;
    this.signal = options.signal;
  }

  get params(): Readonly<Record<string, string>> {
    return this.#params;
  }

  get route(): RegisteredRoute | undefined {
    return this.#route;
  }

  get tokenId(): string | undefined {
    return this.#tokenId;
  }

  get tokenAttribution(): TokenAttribution | undefined {
    return this.#tokenAttribution;
  }

  attributeToken(tokenId: string, detail?: TokenAttribution): void {
    this.#tokenId = tokenId;
    if (detail !== undefined) this.#tokenAttribution = Object.freeze({ ...detail });
  }

  /** Called by the listener once the router has picked a route. */
  bind(route: RegisteredRoute, params: Readonly<Record<string, string>>): void {
    this.#route = route;
    this.#params = Object.freeze({ ...params });
  }
}

export type MutableRequestContext = RequestContext & {
  bind(route: RegisteredRoute, params: Readonly<Record<string, string>>): void;
};

export function createRequestContext(options: RequestContextOptions): MutableRequestContext {
  return new Request(options);
}

/**
 * Collapses `//a//b/` to `/a/b` and decodes nothing.
 *
 * Path traversal is *not* handled here — the static route resolves against its
 * own root and checks containment, which is the only place that can be done
 * correctly (§6.4's static route).
 */
export function normalisePath(pathname: string): string {
  const parts = pathname.split('/').filter((segment) => segment.length > 0);
  return `/${parts.join('/')}`;
}
