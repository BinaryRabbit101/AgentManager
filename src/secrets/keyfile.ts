/**
 * The `keyfile` provider of DESIGN §3.1 — the automatic fallback.
 *
 * "AES-256-GCM with a 32-byte random key at `state/secrets/master.key`, written
 * with an ACL granting the current user only and inheritance disabled. This is
 * weaker (anything running as the user can read the key) but keeps the service
 * running instead of bricking it."
 *
 * Weaker is the point of the comment, not an excuse: DPAPI binds ciphertext to
 * the Windows user *and machine*, so a copied data root is worthless, while a
 * copied `master.key` + `secrets.json` pair is not. That is why the fallback
 * logs a `WARN` and raises the degraded flag rather than being silent.
 */
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { tightenFileAcl } from './acl.js';
import type { AclOutcome, TightenOptions } from './acl.js';
import type { SecretCipher } from './envelope.js';
import { SecretError } from './errors.js';

/** The key filename, fixed by §3.1. */
export const MASTER_KEY_FILENAME = 'master.key';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
/** 96 bits: the GCM nonce size every implementation agrees on and the only one it is safe to reuse a key across. */
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** The master key file is present but is not a 32-byte key. */
export class MasterKeyError extends SecretError {
  constructor(path: string, detail: string, options?: ErrorOptions) {
    super(`The keyfile master key at ${path} is unusable: ${detail}`, options);
  }
}

export interface MasterKeyResult {
  readonly key: Buffer;
  /** True when this call generated the key, false when it read an existing one. */
  readonly created: boolean;
  /** Only present when the key was created — an existing file keeps the ACL it has. */
  readonly acl?: AclOutcome;
}

/**
 * Reads `master.key`, generating and ACLing it on first use.
 *
 * The file is created with the `wx` flag so two processes racing to a fresh
 * data root cannot both write a key — the loser's `EEXIST` sends it back to the
 * read path and both end up using the same bytes, instead of one silently
 * re-keying every secret the other just wrote.
 */
export async function loadOrCreateMasterKey(
  secretsDir: string,
  options: TightenOptions = {},
): Promise<MasterKeyResult> {
  const path = resolve(secretsDir, MASTER_KEY_FILENAME);

  const existing = await readMasterKey(path);
  if (existing !== undefined) return { key: existing, created: false };

  const key = randomBytes(KEY_BYTES);
  try {
    // `mode` is advisory on Windows — the ACL below is what actually protects
    // the file — but it is correct on any platform a developer runs tests on.
    await writeFile(path, key.toString('base64'), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw new MasterKeyError(path, 'it could not be written', { cause });
    }
    const raced = await readMasterKey(path);
    if (raced === undefined) throw new MasterKeyError(path, 'it could not be written', { cause });
    return { key: raced, created: false };
  }

  return { key, created: true, acl: tightenFileAcl(path, options) };
}

async function readMasterKey(path: string): Promise<Buffer | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new MasterKeyError(path, 'it could not be read', { cause });
  }
  const key = Buffer.from(text.trim(), 'base64');
  if (key.length !== KEY_BYTES) {
    throw new MasterKeyError(
      path,
      `expected ${KEY_BYTES} bytes of base64 key material, found ${key.length}`,
    );
  }
  return key;
}

/**
 * The {@link SecretCipher} the envelope store uses under the `keyfile` provider.
 *
 * Blob layout: `iv(12) || tag(16) || ciphertext`. The tag sits next to the iv
 * rather than trailing the ciphertext so the header is a fixed 28 bytes and
 * parsing needs no length arithmetic on attacker-influenced input.
 */
export function createKeyfileCipher(key: Buffer): SecretCipher {
  if (key.length !== KEY_BYTES) {
    throw new TypeError(`keyfile cipher: expected a ${KEY_BYTES}-byte key, received ${key.length}`);
  }
  return {
    provider: 'keyfile',
    encrypt(plaintext) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(ALGORITHM, key, iv);
      const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]);
    },
    decrypt(blob) {
      if (blob.length < IV_BYTES + TAG_BYTES) {
        throw new Error('keyfile ciphertext is shorter than its own header');
      }
      const iv = blob.subarray(0, IV_BYTES);
      const tag = blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
      const decipher = createDecipheriv(ALGORITHM, key, iv);
      decipher.setAuthTag(tag);
      // `final()` throws when the tag does not verify, so a tampered envelope
      // fails loudly instead of yielding attacker-chosen plaintext.
      return Buffer.concat([
        decipher.update(blob.subarray(IV_BYTES + TAG_BYTES)),
        decipher.final(),
      ]);
    },
  };
}

/** Constant-time key comparison, for tests and for a future re-key check. */
export function sameKey(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
