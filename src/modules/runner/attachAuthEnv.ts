/**
 * `attachAuthEnv(options)` — runner DESIGN §3.4, and one of the **two**
 * authorized `Secret.reveal()` sites in the system (foundation §3.2, resolved in
 * §15.4-19: roster's option compiler and this function, and nothing else).
 *
 * One key, one function. No other runner code path holds a `Secret`, and the
 * plaintext never leaves the object handed to `query()`.
 *
 * | `auth.mode` | Behaviour |
 * |---|---|
 * | `subscription` | resolve `claude.oauthToken` → `env.CLAUDE_CODE_OAUTH_TOKEN`; a missing secret fails the session `secret_unresolved`, pointing at `Setup-Auth.ps1` |
 * | `env` | set nothing — the workplace's variables arrive through the base process environment roster spreads |
 * | `bedrock` | set nothing — same |
 *
 * ## The credential strip, widened per SDK-NOTES G10
 *
 * §3.4 strips `ANTHROPIC_API_KEY` under `subscription`, because D2 calls out
 * that it silently overrides subscription auth. SDK-NOTES G10 found that the SDK
 * treats a whole *class* as credentials — `ANTHROPIC_AUTH_TOKEN`,
 * `AWS_BEARER_TOKEN_BEDROCK`, `ANTHROPIC_FOUNDRY_API_KEY`,
 * `ANTHROPIC_FOUNDRY_AUTH_TOKEN`, `ANTHROPIC_AWS_API_KEY` — any of which,
 * inherited from the base process environment, would override the subscription
 * just as silently. SDK-NOTES is the authority where it and DESIGN disagree
 * (§0), so the strip covers the class, minus `CLAUDE_CODE_OAUTH_TOKEN` itself.
 * `ANTHROPIC_BASE_URL` redirects the endpoint rather than the credential, so it
 * is **warned about and left in place**: silently rewriting where a session
 * talks to would be worse than telling the owner it is set.
 *
 * The `ANTHROPIC_API_KEY` case keeps its own `WARN` naming the session, because
 * it is the one D2 names and the one foundation's boot warning has already told
 * the user about; the rest of the class logs at `debug` under one message.
 */
import type { SecretResolver } from '../../secrets/index.js';

import type { SdkOptions } from './contracts.js';
import { SecretUnresolvedError } from './errors.js';

/** Foundation's `auth.mode` values (foundation §2.3). */
export type AuthMode = 'subscription' | 'env' | 'bedrock';

/** The secret key foundation §3.3 assigns to runner. The only one it resolves. */
export const CLAUDE_OAUTH_SECRET_KEY = 'claude.oauthToken';

/** The environment variable the SDK reads subscription auth from. */
export const OAUTH_TOKEN_ENV = 'CLAUDE_CODE_OAUTH_TOKEN';

/**
 * The credential class, minus the one runner sets (SDK-NOTES §9.4 / G10).
 *
 * Stripped only under `auth.mode: 'subscription'`: under `env` and `bedrock`
 * these variables *are* the auth, and removing them would break the work
 * edition on purpose.
 */
export const STRIPPED_CREDENTIAL_ENV: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'AWS_BEARER_TOKEN_BEDROCK',
  'ANTHROPIC_FOUNDRY_API_KEY',
  'ANTHROPIC_FOUNDRY_AUTH_TOKEN',
  'ANTHROPIC_AWS_API_KEY',
];

/** Redirects the endpoint rather than the credential: warned, never removed. */
export const BASE_URL_ENV = 'ANTHROPIC_BASE_URL';

export interface AttachAuthEnvDeps {
  readonly mode: AuthMode;
  /** The §3.2 read-only face. `.reveal()` is called here and nowhere else in runner. */
  readonly secrets: SecretResolver;
  /** The session this launch is for, so a warning names it (§3.4). */
  readonly sessionId: string;
  readonly log?: (
    level: 'debug' | 'warn',
    message: string,
    detail: Record<string, unknown>,
  ) => void;
}

/**
 * Returns a **new** options object whose `env` carries the auth decision.
 *
 * Copied rather than mutated so §3.3's before/after immutability assertion has
 * two objects to compare — and so a caller that kept the compiled options still
 * holds exactly what roster produced.
 *
 * @throws {SecretUnresolvedError} under `subscription` when `claude.oauthToken`
 * is not stored. The message names `Setup-Auth.ps1`, because "no token" is a
 * setup step the owner can take rather than a fault they can debug.
 */
export async function attachAuthEnv(
  options: SdkOptions,
  deps: AttachAuthEnvDeps,
): Promise<SdkOptions> {
  const log = deps.log ?? ((): void => {});
  const env: Record<string, string | undefined> = { ...(options.env ?? {}) };

  if (env[BASE_URL_ENV] !== undefined) {
    log(
      'warn',
      `${BASE_URL_ENV} is set in this session's environment; the agent will talk to that ` +
        'endpoint rather than the default Anthropic one (SDK-NOTES G10). It is left in place — ' +
        'rewriting it silently would be worse than reporting it.',
      { sessionId: deps.sessionId, baseUrl: env[BASE_URL_ENV] },
    );
  }

  if (deps.mode !== 'subscription') {
    // `env` and `bedrock`: the workplace's credentials arrive through the base
    // process environment that roster spreads, and runner sets nothing (§3.4).
    return options;
  }

  const stripped: string[] = [];
  for (const name of STRIPPED_CREDENTIAL_ENV) {
    if (env[name] === undefined) continue;
    delete env[name];
    stripped.push(name);
  }
  if (stripped.includes('ANTHROPIC_API_KEY')) {
    log(
      'warn',
      "ANTHROPIC_API_KEY was present in this session's environment and has been removed: " +
        'auth.mode is "subscription", and the SDK would otherwise silently prefer the API key ' +
        'over the Claude Max subscription (architecture D2, DESIGN §3.4).',
      { sessionId: deps.sessionId },
    );
  }
  const others = stripped.filter((name) => name !== 'ANTHROPIC_API_KEY');
  if (others.length > 0) {
    log('debug', 'credential-class variables were stripped from the agent environment', {
      sessionId: deps.sessionId,
      stripped: others,
    });
  }

  const secret = await deps.secrets.get(CLAUDE_OAUTH_SECRET_KEY);
  if (secret === undefined) throw new SecretUnresolvedError(CLAUDE_OAUTH_SECRET_KEY);
  env[OAUTH_TOKEN_ENV] = secret.reveal();

  return { ...options, env };
}
