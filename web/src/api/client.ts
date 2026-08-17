/**
 * The API client (DESIGN §3.1).
 *
 * "One thin `fetch` wrapper." Its entire responsibility is the list in §3.1:
 * prefix `/api`, JSON in and out, attach a bearer **only when one is held**, and
 * map remote's five status codes onto typed outcomes so a screen can tell
 * "you are not paired" from "this is not allowed remotely" from "the network
 * blinked". Everything else surfaces the server's own message **verbatim** —
 * backend messages are written for humans (runner §3.2) and paraphrasing them
 * hides the fix.
 *
 * Two things are deliberately absent:
 *
 * - **A base URL.** Every request is same-origin and relative (§1.3). There is
 *   nothing to configure, no CORS, and no build-time difference between the
 *   Electron client and the tailnet browser.
 * - **Retries.** The five outcomes each have a *specific* correct response and
 *   none of them is "try again silently": a `401` clears the token, a `403` is
 *   final, a `409` retries only after the grant prompt is answered, and a `429`
 *   waits for `Retry-After`. The caller decides.
 */

import type { ApiFailure, ApiResult } from './result';
import { isRetryAfter, success } from './result';

/** Where the bearer lives when the app is paired (§3.2). One key, one place. */
export const TOKEN_STORAGE_KEY = 'agentmanager.token';

export interface ApiRequestOptions {
  readonly method?: string;
  readonly body?: unknown;
  readonly query?: Readonly<Record<string, string | undefined>>;
  readonly signal?: AbortSignal;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface TokenStore {
  get(): string | null;
  set(token: string | null): void;
}

/** `localStorage`, or an in-memory stand-in where storage is unavailable. */
export function browserTokenStore(storage?: Storage): TokenStore {
  let memory: string | null = null;
  const backing = storage ?? safeLocalStorage();
  if (backing === undefined) {
    return {
      get: () => memory,
      set: (token) => {
        memory = token;
      },
    };
  }
  return {
    get: () => backing.getItem(TOKEN_STORAGE_KEY),
    set: (token) => {
      if (token === null) backing.removeItem(TOKEN_STORAGE_KEY);
      else backing.setItem(TOKEN_STORAGE_KEY, token);
    },
  };
}

function safeLocalStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export interface ApiClientOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly tokens?: TokenStore;
  /** Called whenever a `401` clears the token, so the app can show pairing. */
  readonly onUnauthorized?: () => void;
}

/** The `{ error, message, ... }` body every foundation route returns. */
interface ErrorBody {
  readonly error?: unknown;
  readonly message?: unknown;
  readonly [key: string]: unknown;
}

export class ApiClient {
  readonly #fetch: typeof globalThis.fetch;
  readonly #tokens: TokenStore;
  readonly #onUnauthorized: (() => void) | undefined;

  constructor(options: ApiClientOptions = {}) {
    // Bound, because an unbound `fetch` throws "Illegal invocation" in a browser.
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#tokens = options.tokens ?? browserTokenStore();
    this.#onUnauthorized = options.onUnauthorized;
  }

  get token(): string | null {
    return this.#tokens.get();
  }

  setToken(token: string | null): void {
    this.#tokens.set(token);
  }

  /**
   * The relative URL for an API path, with `/api` prefixed exactly once.
   *
   * Exported behaviour rather than an internal detail because the event stream
   * builds its own URL and must agree with this one about the prefix.
   */
  url(path: string, query?: Readonly<Record<string, string | undefined>>): string {
    const withPrefix = path.startsWith('/api/') || path === '/api' ? path : `/api${path}`;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) params.set(key, value);
    }
    const search = params.toString();
    return search === '' ? withPrefix : `${withPrefix}?${search}`;
  }

  headers(extra?: Readonly<Record<string, string>>): Record<string, string> {
    const token = this.#tokens.get();
    return {
      accept: 'application/json',
      // §3.1: attached **when a token is held**. In Electron and at 127.0.0.1
      // there is none, because foundation §6.4 pins that the local listener has
      // no authentication and that this is the intended trust boundary.
      ...(token === null || token === '' ? {} : { authorization: `Bearer ${token}` }),
      ...extra,
    };
  }

  /** A JSON request. The `T` is the caller's claim about the body, not a check. */
  async request<T>(path: string, options: ApiRequestOptions = {}): Promise<ApiResult<T>> {
    const raw = await this.#send(path, options);
    if (!raw.ok) return raw.failure;

    const { response } = raw;
    if (response.status === 204) return success(undefined as T, response.status);
    const text = await response.text();
    if (text === '') return success(undefined as T, response.status);
    try {
      return success(JSON.parse(text) as T, response.status);
    } catch {
      return {
        kind: 'error',
        status: response.status,
        code: 'invalid_response',
        message: 'The core returned a response that is not JSON.',
      };
    }
  }

  /**
   * A binary GET, resolved to an object URL (§3.1's avatar rule).
   *
   * `<img src="/api/roster/agents/:id/avatar">` cannot set `Authorization`, so
   * over the tailnet it would 401. Fetching through the client and rendering
   * from an object URL is the whole fix, and it needs no backend change.
   *
   * The caller owns the URL and must revoke it (see `avatars.ts`, which
   * memoises per agent id and revokes on eviction).
   */
  async objectUrl(path: string, options: ApiRequestOptions = {}): Promise<ApiResult<string>> {
    const raw = await this.#send(path, { ...options, headers: { accept: '*/*' } });
    if (!raw.ok) return raw.failure;
    const blob = await raw.response.blob();
    return success(URL.createObjectURL(blob), raw.response.status);
  }

  async #send(
    path: string,
    options: ApiRequestOptions,
  ): Promise<{ ok: true; response: Response } | { ok: false; failure: ApiFailure }> {
    const method = options.method ?? 'GET';
    const hasBody = options.body !== undefined;
    let response: Response;
    try {
      response = await this.#fetch(this.url(path, options.query), {
        method,
        // §3.1: `Cache-Control: no-store` respected — and asked for, so a
        // reconnect never renders a cached roster as if it were live.
        cache: 'no-store',
        headers: this.headers({
          ...(hasBody ? { 'content-type': 'application/json' } : {}),
          ...options.headers,
        }),
        ...(hasBody ? { body: JSON.stringify(options.body) } : {}),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (cause) {
      // The one genuinely untyped outcome: nothing answered. Distinct from every
      // status below, because it is the only one a retry can fix by itself.
      return {
        ok: false,
        failure: {
          kind: 'offline',
          message: 'The core is not answering.',
          cause: cause instanceof Error ? cause : new Error(String(cause)),
        },
      };
    }

    if (response.ok) return { ok: true, response };
    return { ok: false, failure: await this.#refusal(response) };
  }

  /** The §3.1 table, in order. */
  async #refusal(response: Response): Promise<ApiFailure> {
    const body = await readErrorBody(response);
    const code = typeof body.error === 'string' ? body.error : undefined;
    const message =
      typeof body.message === 'string' && body.message !== ''
        ? body.message
        : `The core answered ${String(response.status)}.`;
    const details = detailsOf(body);

    switch (response.status) {
      case 401:
        // "clear the stored token, show the pairing screen, never retry".
        this.#tokens.set(null);
        this.#onUnauthorized?.();
        return { kind: 'unauthorized', message, ...(code === undefined ? {} : { code }), details };
      case 403:
        if (code === 'route_denied_remotely') {
          return { kind: 'denied-remotely', message, code, details };
        }
        break;
      case 409:
        if (code === 'remote_access_required') {
          return {
            kind: 'grant-required',
            message,
            code,
            details,
            agentIds: agentIdsOf(body),
          };
        }
        break;
      case 429: {
        const header = response.headers.get('retry-after');
        return {
          kind: 'rate-limited',
          message,
          ...(code === undefined ? {} : { code }),
          details,
          ...(isRetryAfter(header) ? { retryAfterSeconds: Number(header) } : {}),
        };
      }
      case 503:
        if (code === 'remote_unavailable') {
          return { kind: 'remote-unavailable', message, code, details };
        }
        break;
      default:
        break;
    }

    // "Everything else surfaces the server's message verbatim."
    return {
      kind: 'error',
      status: response.status,
      ...(code === undefined ? {} : { code }),
      message,
      details,
    };
  }
}

async function readErrorBody(response: Response): Promise<ErrorBody> {
  try {
    const text = await response.text();
    if (text === '') return {};
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? (parsed as ErrorBody) : {};
  } catch {
    return {};
  }
}

function detailsOf(body: ErrorBody): Readonly<Record<string, unknown>> {
  const { error: _error, message: _message, ...rest } = body;
  return rest;
}

/** remote §6.2's `409` body lists every agent the caller lacks a grant for. */
function agentIdsOf(body: ErrorBody): readonly string[] {
  const raw = body['agentIds'];
  if (!Array.isArray(raw)) return [];
  return raw.filter((value): value is string => typeof value === 'string');
}
