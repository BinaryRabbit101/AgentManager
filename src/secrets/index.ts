/**
 * The secrets module of DESIGN §3.
 *
 * `createSecretStore` is the entry point; everything else exported here exists
 * because a consumer named in §3.2–§3.5 needs it. Note what is *not* exported
 * as a convenience: there is no "reveal this key" helper and no plaintext
 * accessor beyond `Secret.reveal()`, because §3.2 fixes the number of
 * authorized reveal sites at two and a helper would make it easy to add a third.
 */
export { createSecretStore, DEGRADED_CONDITION_ID } from './store.js';
export type { CreateSecretStoreOptions } from './store.js';

export { REDACTED, Secret, isSecret, previewOf } from './secret.js';

export {
  ANTHROPIC_API_KEY_CONDITION_ID,
  OVERRIDING_ENV_VAR,
  checkAnthropicApiKeyOverride,
  warnOnAnthropicApiKeyOverride,
} from './authWarning.js';
export type { AuthMode, AnthropicApiKeyCheckOptions } from './authWarning.js';

export { ENV_PREFIX, envVarName, envVarNamesFor, isSecretKey, keyFromEnvVarName } from './keys.js';

/**
 * The ACL injection point, exported for the composition root (M7): it passes
 * `CreateSecretStoreOptions.acl` through, and a test booting against a temp
 * data root must be able to substitute the `icacls` runner rather than mutate
 * a real ACL.
 */
export type { TightenOptions } from './acl.js';

export { SECRETS_FILENAME } from './envelope.js';
export { MASTER_KEY_FILENAME } from './keyfile.js';
export { DPAPI_ENTROPY } from './dpapi.js';
export type { DpapiBinding, DpapiLoader } from './dpapi.js';

export {
  DpapiUnavailableError,
  InvalidSecretKeyError,
  SecretDecryptError,
  SecretEnvelopeError,
  SecretError,
  SecretStoreReadOnlyError,
} from './errors.js';
export { MasterKeyError } from './keyfile.js';

export { silentLog } from './types.js';
export type {
  Clock,
  HealthCondition,
  LogFn,
  LogLevel,
  SecretKey,
  SecretListEntry,
  SecretProvider,
  SecretProviderSelection,
  SecretResolver,
  SecretStore,
  SecretStoreHandle,
  SecretsDegradation,
  SecretsHealth,
} from './types.js';
