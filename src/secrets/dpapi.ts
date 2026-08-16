/**
 * The `dpapi` provider of DESIGN §3.1.
 *
 * Windows DPAPI at `CurrentUser` scope plus a fixed application entropy string,
 * through a native binding called **in-process** — not by shelling out to
 * PowerShell's `ConvertFrom-SecureString`, which §3.1 rejects both because
 * CLAUDE.md restricts PowerShell to install/setup scripts and because piping a
 * credential through a child process adds an exposure surface for no gain.
 *
 * ## Binding substitution
 *
 * §3.1 names `win-dpapi`. That package is a `nan` addon with no prebuilt
 * binaries, so installing it runs `node-gyp rebuild`, which needs a C++
 * toolchain that a non-admin install of this app cannot assume — it fails on
 * this machine today (Node 25.2.0, no usable Visual Studio detected by
 * node-gyp 11.4.2). `@primno/dpapi` is the same thing done with N-API and
 * `prebuildify`: prebuilt `win32-x64`/`win32-arm64` binaries ship in the
 * tarball, so there is no build step and no ABI recompile after a Node or
 * Electron upgrade. The requirement §3.1 actually states — DPAPI, CurrentUser,
 * entropy, in-process — is unchanged; only the binding differs. See the M6
 * report's proposed doc amendment.
 */
import { DpapiUnavailableError } from './errors.js';
import type { SecretCipher } from './envelope.js';

/**
 * The application entropy of §3.1.
 *
 * Not a secret — it ships in the binary and adds no strength against anyone who
 * has the code. It is a domain separator: ciphertext produced by this app
 * cannot be decrypted by another program running as the same user that merely
 * calls `CryptUnprotectData` with no entropy.
 */
export const DPAPI_ENTROPY = 'AgentManager/v1/secrets';

/** The narrow face of the native binding this module depends on. */
export interface DpapiBinding {
  protect(plaintext: Buffer, entropy: Buffer): Buffer;
  unprotect(ciphertext: Buffer, entropy: Buffer): Buffer;
}

/**
 * Loads the native binding, or rejects.
 *
 * Injectable, which is how the fallback of §3.1 is tested: a loader that throws
 * is exactly what an ABI mismatch looks like from here.
 */
export type DpapiLoader = () => Promise<DpapiBinding>;

const SELF_TEST_PROBE = 'agentmanager-dpapi-self-test';

/**
 * Wrapped so the module's shape is inferred once.
 *
 * The return type is deliberately not annotated: `@primno/dpapi` is CommonJS
 * with both named and default exports, so the namespace TypeScript synthesizes
 * for `await import(...)` is not the same type as `typeof import(...)`, and
 * writing either one out by hand is how that mismatch becomes a cast.
 */
function importDpapiModule() {
  return import('@primno/dpapi');
}

/**
 * Imports `@primno/dpapi` and proves it works before anyone depends on it.
 *
 * The package deliberately swallows a failed binary load and exposes
 * `isPlatformSupported: false` with stub methods that throw on first use. A
 * store that only checked `typeof protectData === 'function'` would therefore
 * come up "healthy" and fail at the first `set`, long after the moment where
 * falling back to `keyfile` was still possible — so the load path both checks
 * the flag and round-trips a probe value.
 */
export const loadDpapiBinding: DpapiLoader = async () => {
  let mod: Awaited<ReturnType<typeof importDpapiModule>>;
  try {
    mod = await importDpapiModule();
  } catch (cause) {
    throw new DpapiUnavailableError(
      `the @primno/dpapi module could not be imported (${describe(cause)})`,
      { cause },
    );
  }

  if (!mod.isPlatformSupported) {
    throw new DpapiUnavailableError('the native binary did not load for this platform or Node ABI');
  }

  const binding: DpapiBinding = {
    protect: (plaintext, entropy) =>
      Buffer.from(mod.Dpapi.protectData(plaintext, entropy, 'CurrentUser')),
    unprotect: (ciphertext, entropy) =>
      Buffer.from(mod.Dpapi.unprotectData(ciphertext, entropy, 'CurrentUser')),
  };

  selfTest(binding);
  return binding;
};

/** Encrypts and decrypts a probe, so a binding that loads but cannot call DPAPI is caught here. */
function selfTest(binding: DpapiBinding): void {
  const entropy = Buffer.from(DPAPI_ENTROPY, 'utf8');
  let roundTripped: string;
  try {
    const sealed = binding.protect(Buffer.from(SELF_TEST_PROBE, 'utf8'), entropy);
    roundTripped = binding.unprotect(sealed, entropy).toString('utf8');
  } catch (cause) {
    throw new DpapiUnavailableError(`the self-test call failed (${describe(cause)})`, { cause });
  }
  if (roundTripped !== SELF_TEST_PROBE) {
    throw new DpapiUnavailableError('the self-test round-trip returned different bytes');
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** The {@link SecretCipher} the envelope store uses under the `dpapi` provider. */
export function createDpapiCipher(binding: DpapiBinding): SecretCipher {
  const entropy = Buffer.from(DPAPI_ENTROPY, 'utf8');
  return {
    provider: 'dpapi',
    encrypt: (plaintext) => binding.protect(plaintext, entropy),
    decrypt: (ciphertext) => binding.unprotect(ciphertext, entropy),
  };
}
