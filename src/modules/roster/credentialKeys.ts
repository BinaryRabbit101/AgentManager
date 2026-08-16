/**
 * "Looks like a credential" — roster DESIGN.md §10.
 *
 * > Any `env` or `headers` value may be either a literal string or
 * > `{ "secretRef": "<key>" }` — *except* that a key whose name matches
 * > `*TOKEN*`, `*KEY*`, `*SECRET*`, `*PASSWORD*`, or `AUTH*` (case-insensitive)
 * > **must** be the `{ secretRef }` form; a literal there is a schema
 * > validation error naming the key.
 *
 * §10 also fixes the scope of this file: "This one rule is the definition of
 * 'looks like a credential' for the whole system — foundation's load-time
 * rejection of credential-shaped values (foundation §3.3) is this rule applied
 * at a different moment, not a second heuristic with its own drift." Foundation
 * has not implemented its half yet; when it does, it imports {@link
 * isCredentialShapedKey} rather than writing a second predicate.
 *
 * This is **not** `logging/redaction.ts#isSecretKey`, which is deliberately
 * different: that one is suffix-matched so that legitimately-logged fields
 * (`tokenId`, `tokensUsed`) stay readable in a log line. This one is
 * substring-matched and therefore over-broad on purpose — the two errors are
 * not symmetric. A false positive costs an author one `secretRef` for a value
 * that did not need protecting; a false negative writes a live credential into
 * `agent.json`, into git, and into every export of that agent.
 */

/** Matched anywhere in the key: `*TOKEN*`, `*KEY*`, `*SECRET*`, `*PASSWORD*`. */
const CREDENTIAL_SUBSTRINGS = ['token', 'key', 'secret', 'password'] as const;

/** Matched only at the start: `AUTH*` — so `AUTHORIZATION` and `AUTH_HEADER`
 *  are credentials while `OAUTH_CALLBACK_URL` is judged by the rest of the
 *  rule (it contains none of the substrings above, so it may be a literal). */
const CREDENTIAL_PREFIXES = ['auth'] as const;

/**
 * True when a `env` / `headers` key name must carry a `{ secretRef }` rather
 * than a literal string.
 */
export function isCredentialShapedKey(name: string): boolean {
  const lowered = name.toLowerCase();
  return (
    CREDENTIAL_SUBSTRINGS.some((needle) => lowered.includes(needle)) ||
    CREDENTIAL_PREFIXES.some((prefix) => lowered.startsWith(prefix))
  );
}

/** The message the schema attaches to the offending key. */
export function credentialShapedKeyMessage(name: string): string {
  return (
    `"${name}" is credential-shaped, so its value must be { "secretRef": "<key>" } ` +
    `and not a literal — secrets never enter agent.json (DESIGN §10)`
  );
}
