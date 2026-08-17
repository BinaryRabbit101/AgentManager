/**
 * The typed outcome of every API call (DESIGN §3.1).
 *
 * §3.1's table maps five status codes onto five *semantically distinct* results
 * "because the UI must not treat them as generic failures". They are modelled as
 * a discriminated union rather than as thrown errors for one reason: each one
 * has a different correct response, and a `try`/`catch` that has to re-inspect a
 * status code to decide is the shape this file exists to prevent.
 *
 * | Code | `kind` | What the caller does |
 * |---|---|---|
 * | `401` | `unauthorized` | token already cleared; show the pairing screen; never retry |
 * | `403 route_denied_remotely` | `denied-remotely` | render "not available remotely"; never retry |
 * | `409 remote_access_required` | `grant-required` | show the grant prompt, then retry the original request |
 * | `429` | `rate-limited` | honour `retryAfterSeconds`, show a countdown |
 * | `503 remote_unavailable` | `remote-unavailable` | show the Tailscale state from `/api/remote/status` |
 *
 * Two more exist and are not status-code outcomes: `error` carries any other
 * refusal with **the server's message verbatim**, and `offline` is the one case
 * where nothing answered at all.
 */

export interface ApiSuccess<T> {
  readonly kind: 'ok';
  readonly value: T;
  readonly status: number;
}

interface FailureBase {
  readonly message: string;
  readonly code?: string;
  /** Everything the error body carried besides `error` and `message`. */
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface UnauthorizedFailure extends FailureBase {
  readonly kind: 'unauthorized';
}
export interface DeniedRemotelyFailure extends FailureBase {
  readonly kind: 'denied-remotely';
}
export interface GrantRequiredFailure extends FailureBase {
  readonly kind: 'grant-required';
  /** Every agent the caller lacks a grant for; prompt **once** for the list. */
  readonly agentIds: readonly string[];
}
export interface RateLimitedFailure extends FailureBase {
  readonly kind: 'rate-limited';
  readonly retryAfterSeconds?: number;
}
export interface RemoteUnavailableFailure extends FailureBase {
  readonly kind: 'remote-unavailable';
}
export interface ErrorFailure extends FailureBase {
  readonly kind: 'error';
  readonly status: number;
}
export interface OfflineFailure extends FailureBase {
  readonly kind: 'offline';
  readonly cause: Error;
}

export type ApiFailure =
  | UnauthorizedFailure
  | DeniedRemotelyFailure
  | GrantRequiredFailure
  | RateLimitedFailure
  | RemoteUnavailableFailure
  | ErrorFailure
  | OfflineFailure;

export type ApiResult<T> = ApiSuccess<T> | ApiFailure;

/** The five outcomes §3.1's table names, in its order. */
export const STATUS_OUTCOME_KINDS = [
  'unauthorized',
  'denied-remotely',
  'grant-required',
  'rate-limited',
  'remote-unavailable',
] as const;

export function success<T>(value: T, status: number): ApiSuccess<T> {
  return { kind: 'ok', value, status };
}

export function isOk<T>(result: ApiResult<T>): result is ApiSuccess<T> {
  return result.kind === 'ok';
}

export function isFailure<T>(result: ApiResult<T>): result is ApiFailure {
  return result.kind !== 'ok';
}

/** `Retry-After` in its delta-seconds form; the HTTP-date form is not used here. */
export function isRetryAfter(header: string | null): header is string {
  return header !== null && /^\d+$/.test(header.trim());
}

/**
 * An `Error` carrying the failure, for the one boundary that needs to throw:
 * TanStack Query signals a failed query by rejection, not by a return value.
 * The typed failure rides along so a screen can still switch on `kind`.
 */
export class ApiError extends Error {
  readonly failure: ApiFailure;

  constructor(failure: ApiFailure) {
    super(failure.message);
    this.name = 'ApiError';
    this.failure = failure;
  }
}

/** Unwraps for a query function: the value, or a rejection carrying the failure. */
export function unwrap<T>(result: ApiResult<T>): T {
  if (result.kind === 'ok') return result.value;
  throw new ApiError(result);
}

/** The failure behind a rejection, when there is one. */
export function failureOf(error: unknown): ApiFailure | undefined {
  return error instanceof ApiError ? error.failure : undefined;
}
