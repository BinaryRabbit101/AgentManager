/**
 * The key namespace of DESIGN §3.3, and its mapping onto environment variables.
 *
 * §3.3 fixes four key shapes: `claude.oauthToken`, `anthropic.apiKey`,
 * `mcp.<serverId>.<field>`, `project.<projectId>.<name>` and
 * `notify.<channel>.<field>`. All of them are dot-separated segments, and two
 * of them embed an identifier whose case is significant (a ULID project id), so
 * nothing here uppercases a key on the way out and lowercases it on the way
 * back.
 */
import { InvalidSecretKeyError } from './errors.js';
import type { SecretKey } from './types.js';

/**
 * Segments of letters, digits and hyphens, joined by dots.
 *
 * Underscores are excluded on purpose: {@link envVarName} encodes `.` as `__`,
 * and that encoding is only reversible while the key contains no underscore of
 * its own.
 */
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*(?:\.[A-Za-z0-9][A-Za-z0-9-]*)*$/;

/** The prefix every generically-named secret environment variable carries. */
export const ENV_PREFIX = 'AGENTMANAGER_SECRET_';

/** Throws {@link InvalidSecretKeyError} unless `key` matches the §3.3 shape. */
export function assertSecretKey(key: string): asserts key is SecretKey {
  if (!KEY_PATTERN.test(key)) throw new InvalidSecretKeyError(key);
}

/** True when `key` matches the §3.3 shape. */
export function isSecretKey(key: string): boolean {
  return KEY_PATTERN.test(key);
}

/**
 * The environment variable a key is read from under the `env` provider.
 *
 * `claude.oauthToken` → `AGENTMANAGER_SECRET_claude__oauthToken`. Case is
 * preserved so the mapping round-trips; on Windows the lookup is
 * case-insensitive anyway, so an all-caps variable still resolves.
 */
export function envVarName(key: SecretKey): string {
  return `${ENV_PREFIX}${key.replaceAll('.', '__')}`;
}

/** The inverse of {@link envVarName}; `undefined` for a name outside the namespace. */
export function keyFromEnvVarName(name: string): SecretKey | undefined {
  if (!name.startsWith(ENV_PREFIX)) return undefined;
  const key = name.slice(ENV_PREFIX.length).replaceAll('__', '.');
  return isSecretKey(key) ? key : undefined;
}

/**
 * The variables §3.3 already names, honoured in addition to the generic form.
 *
 * The work edition's model credentials arrive as `ANTHROPIC_API_KEY`, and
 * `Setup-Auth.ps1` produces a `CLAUDE_CODE_OAUTH_TOKEN` — requiring a developer
 * to re-export those under a second name would be ceremony for its own sake.
 * The generic name still wins when both are set, because it is the one that was
 * chosen deliberately.
 */
export const WELL_KNOWN_ENV_VARS: ReadonlyMap<SecretKey, string> = new Map([
  ['claude.oauthToken', 'CLAUDE_CODE_OAUTH_TOKEN'],
  ['anthropic.apiKey', 'ANTHROPIC_API_KEY'],
]);

/** Every environment variable a key may be read from, most specific first. */
export function envVarNamesFor(key: SecretKey): readonly string[] {
  const alias = WELL_KNOWN_ENV_VARS.get(key);
  return alias === undefined ? [envVarName(key)] : [envVarName(key), alias];
}
