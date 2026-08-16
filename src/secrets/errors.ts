/**
 * Secret-store failures.
 *
 * Every one of them is thrown with a message that names the key and the
 * provider but never the value — an error string ends up in a log, and §3.5
 * exists so that a log never carries a credential.
 */
import type { SecretProvider } from './types.js';

export class SecretError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** The key does not match the §3.3 namespace shape. */
export class InvalidSecretKeyError extends SecretError {
  constructor(readonly key: string) {
    super(
      `Invalid secret key ${JSON.stringify(key)}: expected dot-separated segments of letters, digits and hyphens (e.g. "claude.oauthToken")`,
    );
  }
}

/** `secrets.json` exists but is not the envelope this version writes. */
export class SecretEnvelopeError extends SecretError {
  constructor(path: string, detail: string, options?: ErrorOptions) {
    super(`Secret envelope at ${path} is unreadable: ${detail}`, options);
  }
}

/** The ciphertext is present but this process cannot turn it back into a value. */
export class SecretDecryptError extends SecretError {
  constructor(key: string, provider: SecretProvider, options?: ErrorOptions) {
    super(
      `Cannot decrypt secret ${JSON.stringify(key)}: it was written by the ${provider} provider. ` +
        (provider === 'dpapi'
          ? 'DPAPI ciphertext is bound to the Windows user and machine that wrote it, so a copied data root yields nothing.'
          : 'The master key is missing or does not match this envelope.'),
      options,
    );
  }
}

/** The native DPAPI binding could not be loaded or did not work. */
export class DpapiUnavailableError extends SecretError {
  constructor(detail: string, options?: ErrorOptions) {
    super(`The DPAPI binding is unavailable: ${detail}`, options);
  }
}

/** A write was attempted against a provider that stores nothing. */
export class SecretStoreReadOnlyError extends SecretError {
  constructor(operation: 'set' | 'delete', key: string) {
    super(
      `Cannot ${operation} ${JSON.stringify(key)}: the env provider reads secrets from the process environment and never persists them (DESIGN §3.1). Set the environment variable instead.`,
    );
  }
}
