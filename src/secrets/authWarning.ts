/**
 * The startup check of DESIGN §3.5, which exists because of architecture D2:
 *
 * "If `ANTHROPIC_API_KEY` is set in the environment it silently overrides
 * subscription auth → startup warning."
 *
 * Silently is the whole problem. The service comes up, agents run, and the
 * owner's Claude Max subscription is not what is paying for them — the first
 * symptom is a bill or an API error, not a failure at boot. So the condition is
 * both logged once at boot (M7 wires it) and kept as a persistent health
 * condition the UI displays, rather than a line that scrolls away.
 */
import type { HealthCondition, LogFn } from './types.js';

/** The environment variable that does the overriding. */
export const OVERRIDING_ENV_VAR = 'ANTHROPIC_API_KEY';

/** Stable id, so the UI can track the condition across restarts. */
export const ANTHROPIC_API_KEY_CONDITION_ID = 'secrets.anthropicApiKeyOverridesSubscription';

/** The `auth.mode` values of the config schema. */
export type AuthMode = 'subscription' | 'env' | 'bedrock';

export interface AnthropicApiKeyCheckOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly authMode: AuthMode;
}

/**
 * The condition to raise, or `undefined` when there is nothing to warn about.
 *
 * Only `subscription` mode is affected: under `env` the key is the configured
 * credential and under `bedrock` it is inert, so warning in either case would
 * be noise that trains the owner to ignore the warning that matters.
 */
export function checkAnthropicApiKeyOverride(
  options: AnthropicApiKeyCheckOptions,
): HealthCondition | undefined {
  const { authMode, env } = options;
  if (authMode !== 'subscription') return undefined;

  const value = env[OVERRIDING_ENV_VAR];
  if (value === undefined || value.trim().length === 0) return undefined;

  return {
    id: ANTHROPIC_API_KEY_CONDITION_ID,
    level: 'warn',
    message:
      `${OVERRIDING_ENV_VAR} is set in the environment while auth.mode is "subscription". ` +
      'The Claude Agent SDK prefers the API key, so agents will bill the API account instead of the Claude subscription. ' +
      `Unset ${OVERRIDING_ENV_VAR} for this user, or set auth.mode to "env" if billing the API account is intended.`,
  };
}

/**
 * The boot half of §3.5: log the `WARN` and hand back the condition to register.
 *
 * One function so the log line and the health condition can never disagree
 * about whether there is a problem. M7's composition root calls this; the
 * message deliberately carries no value from the environment, only its name.
 */
export function warnOnAnthropicApiKeyOverride(
  log: LogFn,
  options: AnthropicApiKeyCheckOptions,
): HealthCondition | undefined {
  const condition = checkAnthropicApiKeyOverride(options);
  if (condition !== undefined) {
    log('warn', condition.message, { conditionId: condition.id, authMode: options.authMode });
  }
  return condition;
}
