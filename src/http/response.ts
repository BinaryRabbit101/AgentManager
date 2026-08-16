/**
 * Building and writing responses.
 *
 * Every foundation route answers through the helpers here, which is what makes
 * the error shape uniform (`{error, message}`) and lets a handler be tested by
 * calling it and inspecting the returned {@link HttpResult} — no socket, no
 * framework, no mocking.
 */
import type { ServerResponse } from 'node:http';

import type { HttpResult, ResponseInit } from './types.js';

/** The header every response carries, so a log line and a client agree on an id. */
export const REQUEST_ID_HEADER = 'x-request-id';

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

function withHeaders(
  contentType: string | undefined,
  body: Buffer | undefined,
  init: ResponseInit | undefined,
): Readonly<Record<string, string>> {
  const headers: Record<string, string> = {};
  if (contentType !== undefined) headers['content-type'] = contentType;
  if (body !== undefined) headers['content-length'] = String(body.byteLength);
  for (const [key, value] of Object.entries(init?.headers ?? {})) {
    headers[key.toLowerCase()] = value;
  }
  return headers;
}

/**
 * JSON, with `undefined` serialised as `null` rather than as an empty body — a
 * client parsing every response must never have to special-case zero bytes.
 */
export function json(body: unknown, init: ResponseInit = {}): HttpResult {
  const text = JSON.stringify(body ?? null, null, 0) ?? 'null';
  const buffer = Buffer.from(text, 'utf8');
  return {
    status: init.status ?? 200,
    headers: withHeaders(JSON_CONTENT_TYPE, buffer, init),
    body: buffer,
  };
}

export function text(body: string, init: ResponseInit = {}): HttpResult {
  const buffer = Buffer.from(body, 'utf8');
  return {
    status: init.status ?? 200,
    headers: withHeaders('text/plain; charset=utf-8', buffer, init),
    body: buffer,
  };
}

export function bytes(body: Buffer, contentType: string, init: ResponseInit = {}): HttpResult {
  return {
    status: init.status ?? 200,
    headers: withHeaders(contentType, body, init),
    body,
  };
}

export function empty(status = 204, init: ResponseInit = {}): HttpResult {
  return { status, headers: withHeaders(undefined, undefined, init), body: undefined };
}

/**
 * The one error shape.
 *
 * `error` is a stable machine-readable code (`not_found`, `invalid_request`);
 * `message` is for a human reading a log or a toast. Extra fields carry the
 * detail a client can act on — the offending key, the accepted values.
 */
export function error(
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): HttpResult {
  return json({ error: code, message, ...extra }, { status });
}

/**
 * The 404 body, shared by the router's no-match path and by the SPA route's
 * refusal to serve HTML for an unknown `/api/**` path (§6.4: "an unknown API
 * path stays a JSON 404, so a typo'd endpoint fails as an API error rather than
 * as a page"). One definition, so the two cannot drift.
 */
export function notFound(path: string): HttpResult {
  return error(404, 'not_found', `No route matches ${path}.`, { path });
}

/** Writes a finished result to the socket. `HEAD` keeps the headers, drops the body. */
export function writeResult(response: ServerResponse, result: HttpResult, head = false): void {
  if (response.writableEnded) return;
  for (const [key, value] of Object.entries(result.headers)) {
    response.setHeader(key, value);
  }
  response.statusCode = result.status;
  if (head || result.body === undefined) {
    response.end();
    return;
  }
  response.end(result.body);
}
