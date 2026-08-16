/**
 * The `env` provider of DESIGN §3.1 — "development, and any install that must
 * store nothing".
 *
 * It touches the filesystem in no code path at all: no directory is created, no
 * envelope is written, no ACL is applied. `set` and `delete` throw rather than
 * mutating `process.env`, because a half-working write that vanished at the
 * next restart — and leaked into every child process in the meantime — would be
 * worse than a clear refusal.
 *
 * §3.1 is explicit that this is **not** what the work edition selects: the work
 * edition sets `auth.mode: "env"` and keeps `secrets.provider` at its
 * dpapi-with-keyfile default, because it still has non-auth secrets to hold.
 * Choosing this provider is a deliberate override.
 */
import { SecretStoreReadOnlyError } from './errors.js';
import { assertSecretKey, envVarNamesFor, keyFromEnvVarName, WELL_KNOWN_ENV_VARS } from './keys.js';
import { previewOf, Secret } from './secret.js';
import type { SecretKey, SecretListEntry, SecretStore } from './types.js';

export interface EnvSecretStoreOptions {
  /** The environment to read. Injected rather than reaching for `process.env` directly. */
  readonly env: NodeJS.ProcessEnv;
  /**
   * The instant reported as `setAt`. An environment variable carries no
   * history, so the honest answer is "as of this process", not a fabricated
   * past — see the note on {@link createEnvSecretStore}.
   */
  readonly now: () => Date;
}

/**
 * A read-only store over the process environment.
 *
 * `list()` reports what it can prove: every `AGENTMANAGER_SECRET_*` variable
 * that maps back to a valid key, plus the §3.3 well-known variables that are
 * set. `setAt` is process start time by definition — the environment records no
 * "when", and inventing one would put a false timestamp in the UI.
 */
export function createEnvSecretStore(options: EnvSecretStoreOptions): SecretStore {
  const { env, now } = options;
  const setAt = now().toISOString();

  function read(key: SecretKey): string | undefined {
    for (const name of envVarNamesFor(key)) {
      const value = env[name];
      if (value !== undefined && value.length > 0) return value;
    }
    return undefined;
  }

  return {
    provider: 'env',

    get(key: SecretKey): Promise<Secret | undefined> {
      assertSecretKey(key);
      const value = read(key);
      return Promise.resolve(value === undefined ? undefined : new Secret(value));
    },

    set(key: SecretKey): Promise<void> {
      return Promise.reject(new SecretStoreReadOnlyError('set', key));
    },

    delete(key: SecretKey): Promise<void> {
      return Promise.reject(new SecretStoreReadOnlyError('delete', key));
    },

    list(): Promise<SecretListEntry[]> {
      const found = new Map<SecretKey, string>();

      for (const [name, value] of Object.entries(env)) {
        if (value === undefined || value.length === 0) continue;
        const key = keyFromEnvVarName(name);
        if (key !== undefined) found.set(key, value);
      }

      for (const [key, name] of WELL_KNOWN_ENV_VARS) {
        if (found.has(key)) continue; // The explicit prefixed form wins.
        const value = env[name];
        if (value !== undefined && value.length > 0) found.set(key, value);
      }

      return Promise.resolve(
        [...found]
          .map(([key, value]) => ({ key, setAt, preview: previewOf(value) }))
          .sort((a, b) => a.key.localeCompare(b.key)),
      );
    },
  };
}
