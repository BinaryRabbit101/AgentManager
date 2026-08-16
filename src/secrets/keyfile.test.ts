/**
 * The `keyfile` fallback of DESIGN §3.1: AES-256-GCM, a 32-byte key at
 * `state/secrets/master.key`, ACL'd to the current user with inheritance off.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureSecretsDir } from './envelope.js';
import {
  createKeyfileCipher,
  loadOrCreateMasterKey,
  MASTER_KEY_FILENAME,
  MasterKeyError,
  sameKey,
} from './keyfile.js';
import { fakeIcacls, makeTempDir, type TempDir } from './__tests__/helpers.js';

let temp: TempDir;

beforeEach(async () => {
  temp = makeTempDir();
  await ensureSecretsDir(temp.secretsDir);
});
afterEach(() => {
  temp.cleanup();
});

function keyPath(): string {
  return resolve(temp.secretsDir, MASTER_KEY_FILENAME);
}

describe('master key', () => {
  it('generates 32 bytes on first use and reuses them afterwards', async () => {
    const run = fakeIcacls();
    const first = await loadOrCreateMasterKey(temp.secretsDir, {
      platform: 'win32',
      principal: 'TESTDOMAIN\\tester',
      run,
    });
    expect(first.created).toBe(true);
    expect(first.key).toHaveLength(32);

    const second = await loadOrCreateMasterKey(temp.secretsDir, { platform: 'linux' });
    expect(second.created).toBe(false);
    expect(sameKey(first.key, second.key)).toBe(true);
  });

  it('grants the current user only and strips inheritance, in that order', async () => {
    const run = fakeIcacls();
    const result = await loadOrCreateMasterKey(temp.secretsDir, {
      platform: 'win32',
      principal: 'TESTDOMAIN\\tester',
      run,
    });

    expect(result.acl).toEqual({ applied: true });
    expect(run.calls).toEqual([
      [keyPath(), '/grant:r', 'TESTDOMAIN\\tester:F', '/Q'],
      [keyPath(), '/inheritance:r', '/Q'],
    ]);
  });

  it('does not re-ACL a key that already exists', async () => {
    await loadOrCreateMasterKey(temp.secretsDir, { platform: 'linux' });
    const run = fakeIcacls();
    const again = await loadOrCreateMasterKey(temp.secretsDir, {
      platform: 'win32',
      principal: 'TESTDOMAIN\\tester',
      run,
    });
    expect(again.created).toBe(false);
    expect(again.acl).toBeUndefined();
    expect(run.calls).toEqual([]);
  });

  it('survives two processes racing to create it', async () => {
    const results = await Promise.all([
      loadOrCreateMasterKey(temp.secretsDir, { platform: 'linux' }),
      loadOrCreateMasterKey(temp.secretsDir, { platform: 'linux' }),
      loadOrCreateMasterKey(temp.secretsDir, { platform: 'linux' }),
    ]);
    const [first] = results;
    for (const result of results) {
      expect(sameKey(result.key, first?.key ?? Buffer.alloc(0))).toBe(true);
    }
    expect(results.filter((result) => result.created)).toHaveLength(1);
  });

  it('refuses a key file that is not 32 bytes rather than encrypting with a short key', async () => {
    writeFileSync(keyPath(), Buffer.alloc(8).toString('base64'), 'utf8');
    await expect(loadOrCreateMasterKey(temp.secretsDir, { platform: 'linux' })).rejects.toThrow(
      MasterKeyError,
    );
  });

  it('never writes the key in the clear', async () => {
    const result = await loadOrCreateMasterKey(temp.secretsDir, { platform: 'linux' });
    const onDisk = readFileSync(keyPath(), 'utf8');
    expect(onDisk).toBe(result.key.toString('base64'));
    expect(onDisk).not.toContain('\0');
  });
});

describe('keyfile cipher', () => {
  const key = Buffer.alloc(32, 3);

  it('round-trips a value', () => {
    const cipher = createKeyfileCipher(key);
    const sealed = cipher.encrypt(Buffer.from('sk-ant-oat01-abcd', 'utf8')) as Buffer;
    expect(sealed.toString('utf8')).not.toContain('sk-ant');
    expect((cipher.decrypt(sealed) as Buffer).toString('utf8')).toBe('sk-ant-oat01-abcd');
  });

  it('uses a fresh nonce every time, so identical values do not produce identical blobs', () => {
    const cipher = createKeyfileCipher(key);
    const a = cipher.encrypt(Buffer.from('same', 'utf8')) as Buffer;
    const b = cipher.encrypt(Buffer.from('same', 'utf8')) as Buffer;
    expect(a.equals(b)).toBe(false);
  });

  it('fails the authentication tag rather than returning tampered plaintext', () => {
    const cipher = createKeyfileCipher(key);
    const sealed = Buffer.from(cipher.encrypt(Buffer.from('value', 'utf8')) as Buffer);
    const last = sealed.length - 1;
    sealed.writeUInt8(sealed.readUInt8(last) ^ 0xff, last);
    expect(() => cipher.decrypt(sealed)).toThrow();
  });

  it('cannot decrypt an envelope written under a different key', () => {
    const sealed = createKeyfileCipher(key).encrypt(Buffer.from('value', 'utf8')) as Buffer;
    expect(() => createKeyfileCipher(Buffer.alloc(32, 9)).decrypt(sealed)).toThrow();
  });

  it('rejects a wrong-sized key and a truncated blob', () => {
    expect(() => createKeyfileCipher(Buffer.alloc(16))).toThrow(TypeError);
    expect(() => createKeyfileCipher(key).decrypt(Buffer.alloc(4))).toThrow(/shorter than/);
  });
});
