/**
 * Provider selection — the fallback chain of DESIGN §3.1.
 *
 * | `secrets.provider` | Behaviour |
 * |---|---|
 * | `auto` (default) | DPAPI, falling back to `keyfile` if the binding will not load: `WARN` + degraded flag. |
 * | `dpapi` | DPAPI, and a load failure is fatal. |
 * | `keyfile` | AES-256-GCM keyfile, chosen deliberately — not degraded. |
 * | `env` | Read the process environment, write nothing. |
 *
 * Only `auto` falls back. An install that names `dpapi` explicitly has stated
 * that machine-bound protection is a requirement, and silently downgrading it
 * to something a copied folder can decrypt would be the store deciding a
 * security question on the owner's behalf. `keyfile` chosen deliberately is
 * likewise not "degraded" — degradation means *not what was asked for*, which
 * is why the flag names the requested provider alongside the reason.
 */
import { createDpapiCipher, loadDpapiBinding } from './dpapi.js';
import type { DpapiLoader } from './dpapi.js';
import { createEnvSecretStore } from './env.js';
import {
  createFileSecretStore,
  discardTempEnvelope,
  ensureSecretsDir,
  type SecretCipher,
} from './envelope.js';
import { createKeyfileCipher, loadOrCreateMasterKey } from './keyfile.js';
import { describeAclOutcome, tightenSecretsDirectoryAcl } from './acl.js';
import type { TightenOptions } from './acl.js';
import type {
  Clock,
  LogFn,
  SecretProviderSelection,
  SecretsDegradation,
  SecretsHealth,
  SecretStore,
  SecretStoreHandle,
} from './types.js';
import { silentLog } from './types.js';

/** Stable id for the degraded-security condition, so the UI can track it. */
export const DEGRADED_CONDITION_ID = 'secrets.degradedToKeyfile';

export interface CreateSecretStoreOptions {
  /** `<dataRoot>\state\secrets\`. Injected rather than derived, so tests use a temp dir. */
  readonly secretsDir: string;
  /** The `secrets.provider` config value. Taken as a plain option — this module never imports config. */
  readonly provider: SecretProviderSelection;
  /** The process environment, for the `env` provider and for the ACL principal. */
  readonly env: NodeJS.ProcessEnv;
  /** Where the fallback `WARN` goes. Defaults to discarding it. */
  readonly log?: LogFn;
  /** Injectable clock, so `setAt` is deterministic under test. */
  readonly now?: Clock;
  /** Injectable binding loader. A loader that throws is what an ABI mismatch looks like. */
  readonly loadDpapi?: DpapiLoader;
  /** Injectable `icacls` platform/principal/runner, so tests need not mutate real ACLs. */
  readonly acl?: TightenOptions;
}

/**
 * Builds the store for the configured provider.
 *
 * Asynchronous because the DPAPI binding is imported dynamically: a static
 * import would evaluate the native module in every process that loads this file
 * — including the `env`-provider install that is meant to need no binary at all
 * — and would make the load failure a module-evaluation crash instead of a
 * catchable event.
 */
export async function createSecretStore(
  options: CreateSecretStoreOptions,
): Promise<SecretStoreHandle> {
  const log = options.log ?? silentLog;
  const now = options.now ?? (() => new Date());
  const aclOptions: TightenOptions = {
    ...(options.acl ?? {}),
    ...(options.acl?.env === undefined ? { env: options.env } : {}),
  };

  if (options.provider === 'env') {
    // No directory, no envelope, no ACL: the env provider must leave the disk
    // untouched, and the only way to guarantee that is to never reach for it.
    log('info', 'secrets: using the env provider; nothing will be written to disk', {
      provider: 'env',
    });
    return handleFor(createEnvSecretStore({ env: options.env, now }), undefined);
  }

  let prepared = false;
  const prepareDirectory = async (): Promise<void> => {
    if (prepared) return;
    await ensureSecretsDir(options.secretsDir);
    await discardTempEnvelope(options.secretsDir);
    const outcome = tightenSecretsDirectoryAcl(options.secretsDir, aclOptions);
    log(outcome.applied ? 'debug' : 'warn', `secrets: ${describeAclOutcome(outcome)}`, {
      directory: options.secretsDir,
    });
    prepared = true;
  };

  if (options.provider === 'keyfile') {
    const cipher = await keyfileCipher(options.secretsDir, prepareDirectory, aclOptions, log);
    return handleFor(fileStore(options, cipher, now, prepareDirectory), undefined);
  }

  const loader = options.loadDpapi ?? loadDpapiBinding;
  try {
    const cipher = createDpapiCipher(await loader());
    return handleFor(fileStore(options, cipher, now, prepareDirectory), undefined);
  } catch (cause) {
    if (options.provider === 'dpapi') {
      // Explicitly requested: fail loudly rather than quietly weakening the install.
      throw cause;
    }
    const reason = cause instanceof Error ? cause.message : String(cause);
    log(
      'warn',
      'secrets: the DPAPI binding could not be loaded; falling back to the keyfile provider. ' +
        'Secrets are now protected by a key file readable by anything running as this Windows user.',
      { requested: options.provider, provider: 'keyfile', reason },
    );
    const cipher = await keyfileCipher(options.secretsDir, prepareDirectory, aclOptions, log);
    const degradation: SecretsDegradation = {
      provider: 'keyfile',
      requested: options.provider,
      reason,
      since: now().toISOString(),
    };
    return handleFor(fileStore(options, cipher, now, prepareDirectory), degradation);
  }
}

async function keyfileCipher(
  secretsDir: string,
  prepareDirectory: () => Promise<void>,
  aclOptions: TightenOptions,
  log: LogFn,
): Promise<SecretCipher> {
  // The key must exist before the first `get`, so unlike the DPAPI path this
  // one touches the disk at construction time.
  await prepareDirectory();
  const master = await loadOrCreateMasterKey(secretsDir, aclOptions);
  if (master.created) {
    const acl = master.acl ?? { applied: false as const, reason: 'failed' as const };
    log(
      acl.applied ? 'info' : 'warn',
      `secrets: generated master.key; ${describeAclOutcome(acl)}`,
      {
        provider: 'keyfile',
      },
    );
  }
  return createKeyfileCipher(master.key);
}

function fileStore(
  options: CreateSecretStoreOptions,
  cipher: SecretCipher,
  now: Clock,
  prepareDirectory: () => Promise<void>,
): SecretStore {
  return createFileSecretStore({
    secretsDir: options.secretsDir,
    cipher,
    now,
    prepareDirectory,
  });
}

/** Wraps a store with the health surface `/api/health` reads (§3.1). */
function handleFor(
  store: SecretStore,
  degraded: SecretsDegradation | undefined,
): SecretStoreHandle {
  const health = (): SecretsHealth =>
    degraded === undefined
      ? { status: 'ok', provider: store.provider, conditions: [] }
      : {
          status: 'degraded',
          provider: store.provider,
          degraded,
          conditions: [
            {
              id: DEGRADED_CONDITION_ID,
              level: 'warn',
              message:
                `Secrets fell back to the ${degraded.provider} provider because the DPAPI binding could not be loaded (${degraded.reason}). ` +
                'They are protected by a key file readable by anything running as this Windows user, not by DPAPI. ' +
                'Reinstall the native binding to restore machine-bound protection.',
            },
          ],
        };

  const handle: SecretStoreHandle = {
    provider: store.provider,
    get: (key) => store.get(key),
    set: (key, value) => store.set(key, value),
    delete: (key) => store.delete(key),
    list: () => store.list(),
    health,
    ...(degraded === undefined ? {} : { degraded }),
  };
  return handle;
}
