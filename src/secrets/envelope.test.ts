/**
 * The shared envelope store: file format, atomicity, and the guarantee that
 * `list()` returns previews only (DESIGN §3.1/§3.2).
 *
 * The cipher here is the in-memory stand-in, because what is under test is the
 * file logic both real providers sit on. The real ciphers have their own tests.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDpapiCipher } from './dpapi.js';
import { createFileSecretStore, ENVELOPE_VERSION, SECRETS_FILENAME } from './envelope.js';
import { ensureSecretsDir } from './envelope.js';
import { SecretDecryptError, SecretEnvelopeError } from './errors.js';
import { createKeyfileCipher } from './keyfile.js';
import { fakeDpapiBinding, makeTempDir, type TempDir } from './__tests__/helpers.js';
import type { SecretStore } from './types.js';

const FIXED_NOW = new Date('2026-08-16T10:35:00.000Z');

let temp: TempDir;

function storeFor(dir: string): SecretStore {
  return createFileSecretStore({
    secretsDir: dir,
    cipher: createDpapiCipher(fakeDpapiBinding()),
    now: () => FIXED_NOW,
    prepareDirectory: () => ensureSecretsDir(dir),
  });
}

function envelopePath(): string {
  return resolve(temp.secretsDir, SECRETS_FILENAME);
}

beforeEach(() => {
  temp = makeTempDir();
});
afterEach(() => {
  temp.cleanup();
});

describe('file-backed secret store', () => {
  it('round-trips set/get/delete/list', async () => {
    const store = storeFor(temp.secretsDir);

    expect(await store.get('claude.oauthToken')).toBeUndefined();
    expect(await store.list()).toEqual([]);

    await store.set('claude.oauthToken', 'sk-ant-oat01-abcd');
    await store.set('notify.ntfy.topicUrl', 'https://ntfy.sh/wxyz');

    expect((await store.get('claude.oauthToken'))?.reveal()).toBe('sk-ant-oat01-abcd');
    expect((await store.get('notify.ntfy.topicUrl'))?.reveal()).toBe('https://ntfy.sh/wxyz');

    await store.delete('claude.oauthToken');
    expect(await store.get('claude.oauthToken')).toBeUndefined();
    expect((await store.list()).map((entry) => entry.key)).toEqual(['notify.ntfy.topicUrl']);

    // Deleting what is not there is not an error — the CLI and the UI both retry.
    await expect(store.delete('claude.oauthToken')).resolves.toBeUndefined();
  });

  it('lists metadata and previews only, never a value', async () => {
    const store = storeFor(temp.secretsDir);
    await store.set('claude.oauthToken', 'sk-ant-oat01-abcd1234');

    const listed = await store.list();
    expect(listed).toEqual([
      { key: 'claude.oauthToken', setAt: FIXED_NOW.toISOString(), preview: '1234' },
    ]);
    // The row carries no field that could hold the value under another name.
    expect(Object.keys(listed[0] ?? {}).sort()).toEqual(['key', 'preview', 'setAt']);
    expect(JSON.stringify(listed)).not.toContain('sk-ant-oat01');
  });

  it('writes ciphertext as base64 and no plaintext beyond the four-character preview', async () => {
    const store = storeFor(temp.secretsDir);
    await store.set('claude.oauthToken', 'sk-ant-oat01-abcd1234');

    const raw = readFileSync(envelopePath(), 'utf8');
    expect(raw).not.toContain('sk-ant-oat01-abcd');
    const parsed = JSON.parse(raw) as {
      version: number;
      entries: Record<string, { provider: string; ciphertext: string; preview: string }>;
    };
    expect(parsed.version).toBe(ENVELOPE_VERSION);
    const entry = parsed.entries['claude.oauthToken'];
    expect(entry?.provider).toBe('dpapi');
    expect(entry?.preview).toBe('1234');
    expect(entry?.ciphertext).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
  });

  it('sorts the listing by key, so the UI order does not depend on write order', async () => {
    const store = storeFor(temp.secretsDir);
    await store.set('notify.ntfy.topicUrl', 'b');
    await store.set('claude.oauthToken', 'a');
    await store.set('mcp.gmail.token', 'c');

    expect((await store.list()).map((entry) => entry.key)).toEqual([
      'claude.oauthToken',
      'mcp.gmail.token',
      'notify.ntfy.topicUrl',
    ]);
  });

  it('keeps every key when writes overlap, instead of losing a read-modify-write race', async () => {
    const store = storeFor(temp.secretsDir);
    await Promise.all(
      Array.from({ length: 12 }, (_unused, index) =>
        store.set(`mcp.server${index}.token`, `v${index}`),
      ),
    );

    expect(await store.list()).toHaveLength(12);
    expect((await store.get('mcp.server7.token'))?.reveal()).toBe('v7');
  });

  it('refuses a corrupt or future envelope rather than silently losing every key', async () => {
    await ensureSecretsDir(temp.secretsDir);
    writeFileSync(envelopePath(), 'not json', 'utf8');
    await expect(storeFor(temp.secretsDir).list()).rejects.toThrow(SecretEnvelopeError);

    writeFileSync(envelopePath(), JSON.stringify({ version: 99, entries: {} }), 'utf8');
    await expect(storeFor(temp.secretsDir).list()).rejects.toThrow(/unsupported version 99/);

    writeFileSync(envelopePath(), JSON.stringify({ version: 1, entries: { a: 1 } }), 'utf8');
    await expect(storeFor(temp.secretsDir).list()).rejects.toThrow(/is not an object/);
  });

  it('explains, rather than garbles, an entry written by the other provider', async () => {
    // What a data root looks like after `auto` fell back: dpapi entries in the
    // file, a keyfile cipher in the process.
    const dpapiStore = storeFor(temp.secretsDir);
    await dpapiStore.set('claude.oauthToken', 'written-under-dpapi');

    const keyfileStore = createFileSecretStore({
      secretsDir: temp.secretsDir,
      cipher: createKeyfileCipher(Buffer.alloc(32, 7)),
      now: () => FIXED_NOW,
      prepareDirectory: () => ensureSecretsDir(temp.secretsDir),
    });

    await expect(keyfileStore.get('claude.oauthToken')).rejects.toThrow(SecretDecryptError);
    // The listing still works, which is why the preview is stored rather than derived.
    expect((await keyfileStore.list()).map((entry) => entry.preview)).toEqual(['papi']);
  });

  it('rejects a key outside the §3.3 namespace on every operation', async () => {
    const store = storeFor(temp.secretsDir);
    await expect(store.get('../escape')).rejects.toThrow(/Invalid secret key/);
    await expect(store.set('has space', 'v')).rejects.toThrow(/Invalid secret key/);
    await expect(store.delete('two..dots')).rejects.toThrow(/Invalid secret key/);
  });
});
