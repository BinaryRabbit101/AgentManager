/**
 * Write-time redaction (foundation DESIGN.md §3.5 and §5.4).
 *
 * Redaction runs inside the pino formatter — before a record reaches the file
 * stream or the in-memory ring buffer — so there is no window in which a secret
 * sits in a buffer waiting to be filtered on the way out.
 *
 * Three mechanisms, deliberately overlapping:
 *
 * 1. **Key-path redaction** of known secret fields ({@link isSecretKey}). This
 *    is the only one that can catch an opaque credential (a remote bearer token
 *    is 32 random bytes and looks like nothing in particular).
 * 2. **Regex scrubbing** of `sk-ant-…` API keys and `Bearer …` header values in
 *    every string that is logged, wherever it sits in the payload.
 * 3. **Query-string scrubbing** of credential-bearing parameters in logged URLs
 *    and paths (`ticket=`, `access_token=` in v1): the value becomes
 *    `[redacted]` while the parameter name stays visible, because knowing that
 *    a ticket was presented is exactly what incident review needs.
 */

export const REDACTED = '[redacted]';

/** Guard against pathological payloads; deeper values are elided, not walked. */
const MAX_DEPTH = 12;

/** `sk-ant-…` Anthropic API keys (DESIGN §3.5). */
const ANTHROPIC_KEY_PATTERN = /sk-ant-[A-Za-z0-9_-]+/g;

/** `Bearer <token>` — the scheme stays, the credential does not (DESIGN §3.5). */
const BEARER_PATTERN = /(bearer\s+)[A-Za-z0-9._~+/-]{16,}/gi;

/**
 * Credential-bearing query parameters (DESIGN §5.4, v1 set). The parameter name
 * is preserved; only its value is replaced.
 */
export const CREDENTIAL_QUERY_PARAMS = ['ticket', 'access_token'] as const;

const QUERY_PARAM_PATTERN = new RegExp(
  `([?&](?:${CREDENTIAL_QUERY_PARAMS.join('|')})=)([^&\\s"'\`\\\\]*)`,
  'gi',
);

/**
 * Field names whose value is always a credential. Compared after normalising
 * (lower-cased, separators stripped), so `access_token`, `accessToken` and
 * `Access-Token` are one entry.
 */
const SECRET_KEYS: ReadonlySet<string> = new Set([
  'auth',
  'authheader',
  'authorization',
  'bearer',
  'clientsecret',
  'cookie',
  'credentials',
  'masterkey',
  'oauth',
  'pass',
  'proxyauthorization',
  'pwd',
  'secrets',
  'sessionkey',
  'setcookie',
  'ticket',
  'xapikey',
]);

/**
 * Suffixes that mark a field as secret. Suffix rather than substring matching is
 * what keeps the deliberately-logged fields of DESIGN §5.1 and §1.4 readable:
 * `tokenId`, `tokenPrefix` and the plural token *counts* (`inputTokens`,
 * `tokensUsed`) do not end in `token` and are therefore untouched.
 *
 * Because separators are stripped before matching, a suffix also covers the
 * dotted secret-key namespace of DESIGN §3.3 — `claude.oauthToken`,
 * `mcp.<server>.token`, `notify.ntfy.topicUrl`.
 */
const SECRET_KEY_SUFFIXES = [
  'token',
  'apikey',
  'password',
  'passwd',
  'secret',
  'credential',
  'privatekey',
  'topicurl',
] as const;

/**
 * Names that look secret by the rules above but carry no credential, so they
 * stay legible. `secretRef` holds a *key name* like `mcp.gmail.token`
 * (DESIGN §3.3); `tokenHash`/`tokenPrefix` are the stored, non-recoverable
 * remnants of a bearer token (DESIGN §3.4).
 */
const SAFE_KEYS: ReadonlySet<string> = new Set([
  'secretref',
  'tokenbudget',
  'tokenhash',
  'tokenid',
  'tokenprefix',
]);

function normaliseKey(key: string): string {
  return key.toLowerCase().replace(/[-_.\s]/g, '');
}

/** True when a field name is a known secret field (DESIGN §5.4 key paths). */
export function isSecretKey(key: string): boolean {
  const normalised = normaliseKey(key);
  if (SAFE_KEYS.has(normalised)) return false;
  if (SECRET_KEYS.has(normalised)) return true;
  return SECRET_KEY_SUFFIXES.some((suffix) => normalised.endsWith(suffix));
}

/**
 * Scrubs credential material out of a single string: Anthropic keys, bearer
 * values and credential query parameters. Applied to every logged string and,
 * as a backstop, to the fully serialised JSON line before it is written.
 */
export function scrubText(text: string): string {
  return text
    .replace(ANTHROPIC_KEY_PATTERN, REDACTED)
    .replace(BEARER_PATTERN, `$1${REDACTED}`)
    .replace(QUERY_PARAM_PATTERN, `$1${REDACTED}`);
}

function redactError(error: Error, seen: WeakSet<object>, depth: number): Record<string, unknown> {
  // Shaped like pino-std-serializers' output, which passes non-Error values
  // through untouched — so the standard `err` serializer leaves this alone.
  const out: Record<string, unknown> = {
    type: error.name,
    message: scrubText(error.message),
  };
  if (typeof error.stack === 'string') out['stack'] = scrubText(error.stack);
  for (const [key, value] of Object.entries(error)) {
    if (key === 'type' || key === 'message' || key === 'stack') continue;
    out[key] = isSecretKey(key) ? REDACTED : redact(value, seen, depth + 1);
  }
  return out;
}

function redact(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (typeof value === 'string') return scrubText(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth > MAX_DEPTH) return '[truncated]';

  const object: object = value;
  if (seen.has(object)) return '[circular]';
  seen.add(object);
  try {
    if (object instanceof Error) return redactError(object, seen, depth);
    if (Array.isArray(object)) return object.map((item) => redact(item, seen, depth + 1));

    // Values with their own JSON shape (Date, and the `Secret` wrapper of
    // DESIGN §3.2, whose toJSON already yields "[redacted]") are redacted
    // through that shape rather than by walking their internals.
    const toJson: unknown = (object as { toJSON?: unknown }).toJSON;
    if (typeof toJson === 'function') {
      const json: unknown = (object as { toJSON: () => unknown }).toJSON();
      return redact(json, seen, depth + 1);
    }

    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(object)) {
      out[key] = isSecretKey(key) ? REDACTED : redact(item, seen, depth + 1);
    }
    return out;
  } finally {
    seen.delete(object);
  }
}

/** Deep-redacts an arbitrary logged value. Never mutates its input. */
export function redactValue(value: unknown): unknown {
  return redact(value, new WeakSet<object>(), 0);
}

/** Deep-redacts the merged log object handed to pino's `formatters.log`. */
export function redactRecord(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const seen = new WeakSet<object>();
  for (const [key, value] of Object.entries(record)) {
    out[key] = isSecretKey(key) ? REDACTED : redact(value, seen, 0);
  }
  return out;
}

/**
 * Redacts the arguments of a log call before pino formats them.
 *
 * Handles what `formatters.log` cannot reach: the message string (and its
 * interpolation arguments), and the message pino derives from an `Error` passed
 * as the first argument — that message is taken before any formatter runs, so
 * the error is rewrapped as `{ err }` with an explicit, scrubbed message.
 */
export function redactLogArguments(args: readonly unknown[]): unknown[] {
  if (args.length === 0) return [];

  const [first, ...rest] = args;
  const tail = rest.map((argument) =>
    typeof argument === 'string' ? scrubText(argument) : redactValue(argument),
  );

  if (first instanceof Error) {
    const wrapped = { err: redactValue(first) };
    return tail.length > 0 ? [wrapped, ...tail] : [wrapped, scrubText(first.message)];
  }
  if (typeof first === 'string') return [scrubText(first), ...tail];

  // Objects are left for `formatters.log`, which redacts the merged record —
  // walking them here as well would be a second full pass for no extra safety.
  return [first, ...tail];
}
