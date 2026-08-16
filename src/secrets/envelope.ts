/**
 * The on-disk envelope of DESIGN §3.1 — `state/secrets/secrets.json` — and the
 * file-backed store both cipher providers share.
 *
 * `dpapi` and `keyfile` differ in exactly one respect: how a value becomes
 * bytes. Everything else — the file format, the atomic write, the preview, the
 * ISO timestamp, the read-modify-write serialization — is identical, so it
 * lives here once and each provider supplies a {@link SecretCipher}.
 *
 * Each entry records the provider that wrote it. After an `auto` fallback a
 * single file can hold both kinds, and a `get` on an entry the current provider
 * cannot read then fails with a message that says why instead of returning
 * rubbish.
 */
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { SecretDecryptError, SecretEnvelopeError } from './errors.js';
import { assertSecretKey } from './keys.js';
import { previewOf, Secret } from './secret.js';
import type { Clock, SecretKey, SecretListEntry, SecretProvider, SecretStore } from './types.js';

/** The envelope filename, fixed by §3.1. */
export const SECRETS_FILENAME = 'secrets.json';

/** Bumped only if the envelope shape changes; a newer file is refused, not guessed at. */
export const ENVELOPE_VERSION = 1;

/** How a provider turns a value into bytes and back. */
export interface SecretCipher {
  readonly provider: Exclude<SecretProvider, 'env'>;
  encrypt(plaintext: Buffer): Promise<Buffer> | Buffer;
  decrypt(ciphertext: Buffer): Promise<Buffer> | Buffer;
}

interface EnvelopeEntry {
  /** Which cipher wrote `ciphertext`. */
  readonly provider: Exclude<SecretProvider, 'env'>;
  /** Base64 of the provider's ciphertext blob (§3.1). */
  readonly ciphertext: string;
  readonly setAt: string;
  /**
   * The last four characters of the value.
   *
   * Stored rather than derived, so `list()` never decrypts: the listing path —
   * the one the UI calls — then touches no plaintext at all, and a data root
   * copied to another machine still lists what it holds instead of throwing.
   * It is the same display fragment §3.4 keeps beside a remote token hash.
   */
  readonly preview: string;
}

interface EnvelopeFile {
  readonly version: number;
  readonly entries: Record<string, EnvelopeEntry>;
}

const EMPTY: EnvelopeFile = { version: ENVELOPE_VERSION, entries: {} };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseEntry(path: string, key: string, raw: unknown): EnvelopeEntry {
  if (!isRecord(raw))
    throw new SecretEnvelopeError(path, `entry ${JSON.stringify(key)} is not an object`);
  const { provider, ciphertext, setAt, preview } = raw;
  if (provider !== 'dpapi' && provider !== 'keyfile') {
    throw new SecretEnvelopeError(path, `entry ${JSON.stringify(key)} names an unknown provider`);
  }
  if (typeof ciphertext !== 'string' || typeof setAt !== 'string' || typeof preview !== 'string') {
    throw new SecretEnvelopeError(path, `entry ${JSON.stringify(key)} is missing required fields`);
  }
  return { provider, ciphertext, setAt, preview };
}

function parseEnvelope(path: string, text: string): EnvelopeFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new SecretEnvelopeError(path, 'not valid JSON', { cause });
  }
  if (!isRecord(parsed)) throw new SecretEnvelopeError(path, 'the top level is not an object');
  if (parsed['version'] !== ENVELOPE_VERSION) {
    throw new SecretEnvelopeError(
      path,
      `unsupported version ${String(parsed['version'])} (this build writes ${ENVELOPE_VERSION})`,
    );
  }
  const rawEntries = parsed['entries'];
  if (!isRecord(rawEntries)) throw new SecretEnvelopeError(path, '"entries" is not an object');

  const entries: Record<string, EnvelopeEntry> = {};
  for (const [key, value] of Object.entries(rawEntries)) {
    entries[key] = parseEntry(path, key, value);
  }
  return { version: ENVELOPE_VERSION, entries };
}

export interface FileSecretStoreOptions {
  /** `<dataRoot>\state\secrets\`. Created on first write, never assumed to exist. */
  readonly secretsDir: string;
  readonly cipher: SecretCipher;
  readonly now: Clock;
  /** Called once before the first write, to create and tighten the directory. */
  readonly prepareDirectory: () => Promise<void> | void;
}

/**
 * The `dpapi`/`keyfile` store: one JSON file, one cipher, no plaintext at rest.
 *
 * Writes are serialized through a promise chain. Two concurrent `set` calls
 * would otherwise each read the file, add their own entry and write it back,
 * and the second would silently drop the first.
 */
export function createFileSecretStore(options: FileSecretStoreOptions): SecretStore {
  const { cipher, now, prepareDirectory, secretsDir } = options;
  const path = resolve(secretsDir, SECRETS_FILENAME);
  const tmpPath = `${path}.tmp`;

  let queue: Promise<unknown> = Promise.resolve();
  let directoryPrepared = false;

  async function read(): Promise<EnvelopeFile> {
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY;
      throw new SecretEnvelopeError(path, 'the file could not be read', { cause });
    }
    return parseEnvelope(path, text);
  }

  async function write(file: EnvelopeFile): Promise<void> {
    if (!directoryPrepared) {
      await prepareDirectory();
      directoryPrepared = true;
    }
    // Write-then-rename: a crash mid-write leaves the previous envelope intact
    // rather than a truncated file that would lock the owner out of every key.
    await writeFile(tmpPath, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
    await rename(tmpPath, path);
  }

  /** Serializes read-modify-write cycles against the single envelope file. */
  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = queue.then(operation, operation);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  return {
    provider: cipher.provider,

    async get(key: SecretKey): Promise<Secret | undefined> {
      assertSecretKey(key);
      const entry = (await read()).entries[key];
      if (entry === undefined) return undefined;
      if (entry.provider !== cipher.provider) {
        throw new SecretDecryptError(key, entry.provider);
      }
      let plaintext: Buffer;
      try {
        plaintext = await cipher.decrypt(Buffer.from(entry.ciphertext, 'base64'));
      } catch (cause) {
        throw new SecretDecryptError(key, entry.provider, { cause });
      }
      return new Secret(plaintext.toString('utf8'));
    },

    async set(key: SecretKey, value: string): Promise<void> {
      assertSecretKey(key);
      const ciphertext = Buffer.from(await cipher.encrypt(Buffer.from(value, 'utf8'))).toString(
        'base64',
      );
      const entry: EnvelopeEntry = {
        provider: cipher.provider,
        ciphertext,
        setAt: now().toISOString(),
        preview: previewOf(value),
      };
      await serialize(async () => {
        const file = await read();
        await write({ version: ENVELOPE_VERSION, entries: { ...file.entries, [key]: entry } });
      });
    },

    async delete(key: SecretKey): Promise<void> {
      assertSecretKey(key);
      await serialize(async () => {
        const file = await read();
        if (!(key in file.entries)) return; // Idempotent: deleting nothing is not an error.
        const entries = { ...file.entries };
        delete entries[key];
        await write({ version: ENVELOPE_VERSION, entries });
      });
    },

    async list(): Promise<SecretListEntry[]> {
      const file = await read();
      return Object.entries(file.entries)
        .map(([key, entry]) => ({ key, setAt: entry.setAt, preview: entry.preview }))
        .sort((a, b) => a.key.localeCompare(b.key));
    },
  };
}

/** Removes a stale `secrets.json.tmp`; exported for the store's boot path. */
export async function discardTempEnvelope(secretsDir: string): Promise<void> {
  try {
    await unlink(resolve(secretsDir, `${SECRETS_FILENAME}.tmp`));
  } catch {
    // Nothing to discard is the normal case.
  }
}

/** Creates `secretsDir` if it is absent. Separated so the ACL step can follow it. */
export async function ensureSecretsDir(secretsDir: string): Promise<void> {
  await mkdir(secretsDir, { recursive: true });
}
