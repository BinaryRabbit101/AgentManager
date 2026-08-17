/**
 * The ownership boundary of runner DESIGN §3.3, enforced rather than stated.
 *
 * > "Runner receives `options` from `compileSession` and treats them as
 * > immutable except for this whitelist… This is enforced, not merely stated:
 * > in tests and in development builds, runner snapshots the compiled options
 * > object before and after its own mutations and asserts that only whitelisted
 * > key paths differ. A permission bug introduced by the runner would be
 * > invisible in review and obvious in that assertion."
 *
 * So this file is two things: the whitelist as data, and a diff that reports
 * key *paths* rather than a boolean — because "the launch changed something it
 * should not have" is only actionable if it says what.
 *
 * ## How the diff decides two values are the same
 *
 * By identity (`Object.is`), not by structural equality. Everything runner does
 * to the compiled options is either "leave the key alone" (the reference
 * survives a spread untouched) or "replace it deliberately", so identity is
 * exactly the question being asked and cannot be fooled by a deep clone that
 * happens to look equal. `env` is compared entry by entry, because
 * §3.3 whitelists a single *variable* inside it rather than the whole object,
 * and §3.4's credential strip removes named entries from it.
 */
import type { SdkOptions } from './contracts.js';
import { OptionWhitelistError } from './errors.js';
import { OAUTH_TOKEN_ENV, STRIPPED_CREDENTIAL_ENV } from './attachAuthEnv.js';

/** §3.3's table, key for key. Nothing else may differ after runner's mutations. */
export const WHITELISTED_OPTION_PATHS: readonly string[] = [
  `env.${OAUTH_TOKEN_ENV}`,
  'canUseTool',
  'abortController',
  'includePartialMessages',
  'resume',
  'sessionId',
  'stderr',
];

/**
 * The §3.4 credential strip, as key paths.
 *
 * Separate from the whitelist above because they are different permissions:
 * §3.3 grants runner the right to *set* the OAuth token, §3.4 grants it the
 * right to *remove* the variables that would silently override it (widened to
 * the SDK's credential class per SDK-NOTES G10).
 */
export const STRIPPABLE_OPTION_PATHS: readonly string[] = STRIPPED_CREDENTIAL_ENV.map(
  (name) => `env.${name}`,
);

const ALLOWED: ReadonlySet<string> = new Set([
  ...WHITELISTED_OPTION_PATHS,
  ...STRIPPABLE_OPTION_PATHS,
]);

/**
 * Every key path that differs between two option objects.
 *
 * Top-level keys are compared by identity; `env` is descended into and compared
 * per variable. Paths are returned sorted, so a failure message is stable.
 */
export function diffOptionPaths(before: SdkOptions, after: SdkOptions): readonly string[] {
  const changed: string[] = [];
  const keys = new Set<string>([...Object.keys(before), ...Object.keys(after)]);

  for (const key of keys) {
    if (key === 'env') continue;
    const left = (before as Record<string, unknown>)[key];
    const right = (after as Record<string, unknown>)[key];
    if (!Object.is(left, right)) changed.push(key);
  }

  const beforeEnv: Record<string, string | undefined> = before.env ?? {};
  const afterEnv: Record<string, string | undefined> = after.env ?? {};
  const names = new Set<string>([...Object.keys(beforeEnv), ...Object.keys(afterEnv)]);
  for (const name of names) {
    if (!Object.is(beforeEnv[name], afterEnv[name])) changed.push(`env.${name}`);
  }

  return changed.sort();
}

/**
 * §3.3's assertion: only whitelisted key paths may differ.
 *
 * @throws {OptionWhitelistError} naming every path that should not have moved.
 */
export function assertOptionsWhitelisted(before: SdkOptions, after: SdkOptions): void {
  const violations = diffOptionPaths(before, after).filter((path) => !ALLOWED.has(path));
  if (violations.length > 0) throw new OptionWhitelistError(violations);
}
