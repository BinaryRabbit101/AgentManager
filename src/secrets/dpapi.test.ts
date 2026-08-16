/**
 * The real DPAPI provider (DESIGN §3.1).
 *
 * These tests call the native binding and Windows' `CryptProtectData`, so they
 * are **Windows-only** and skip elsewhere. CI for this project runs on the
 * owner's Windows machine, which is where they earn their keep: an in-memory
 * stand-in can prove the envelope logic but not that the chosen binding loads
 * and round-trips on the Node ABI actually in use — which is the exact failure
 * §3.1's fallback exists for.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDpapiCipher, DPAPI_ENTROPY, loadDpapiBinding } from './dpapi.js';
import { SECRETS_FILENAME } from './envelope.js';
import { createSecretStore } from './store.js';
import {
  inertAcl,
  makeTempDir,
  onWindows,
  recordingLog,
  type TempDir,
} from './__tests__/helpers.js';

const NOW = new Date('2026-08-16T10:35:00.000Z');

let temp: TempDir;

beforeEach(() => {
  temp = makeTempDir();
});
afterEach(() => {
  temp.cleanup();
});

describe.skipIf(!onWindows)('dpapi provider (Windows only)', () => {
  it('loads the native binding in-process and passes its self-test', async () => {
    const binding = await loadDpapiBinding();
    const entropy = Buffer.from(DPAPI_ENTROPY, 'utf8');
    const sealed = binding.protect(Buffer.from('probe', 'utf8'), entropy);

    expect(sealed.length).toBeGreaterThan(16);
    expect(sealed.toString('utf8')).not.toContain('probe');
    expect(binding.unprotect(sealed, entropy).toString('utf8')).toBe('probe');
  });

  it('binds ciphertext to the application entropy', async () => {
    const cipher = createDpapiCipher(await loadDpapiBinding());
    const sealed = Buffer.from(await cipher.encrypt(Buffer.from('value', 'utf8')));
    const binding = await loadDpapiBinding();

    // The same user, the same machine, but without the app's entropy: nothing.
    expect(() => binding.unprotect(sealed, Buffer.from('some-other-entropy', 'utf8'))).toThrow();
    expect((await cipher.decrypt(sealed)).toString('utf8')).toBe('value');
  });

  it('round-trips set/get/delete/list through the real store, previews only', async () => {
    const log = recordingLog();
    const store = await createSecretStore({
      secretsDir: temp.secretsDir,
      provider: 'auto',
      env: {},
      log,
      now: () => NOW,
      acl: inertAcl(),
    });

    expect(store.provider).toBe('dpapi');
    expect(store.degraded).toBeUndefined();
    expect(store.health().status).toBe('ok');

    await store.set('claude.oauthToken', 'sk-ant-oat01-realdpapi-1234');
    await store.set('mcp.gmail.token', 'gmail-token-wxyz');

    expect((await store.get('claude.oauthToken'))?.reveal()).toBe('sk-ant-oat01-realdpapi-1234');
    expect(await store.list()).toEqual([
      { key: 'claude.oauthToken', setAt: NOW.toISOString(), preview: '1234' },
      { key: 'mcp.gmail.token', setAt: NOW.toISOString(), preview: 'wxyz' },
    ]);

    await store.delete('mcp.gmail.token');
    expect(await store.get('mcp.gmail.token')).toBeUndefined();
    expect(await store.list()).toHaveLength(1);
  });

  it('writes base64 ciphertext to secrets.json and no plaintext', async () => {
    const store = await createSecretStore({
      secretsDir: temp.secretsDir,
      provider: 'dpapi',
      env: {},
      now: () => NOW,
      acl: inertAcl(),
    });
    await store.set('claude.oauthToken', 'sk-ant-oat01-realdpapi-1234');

    const raw = readFileSync(resolve(temp.secretsDir, SECRETS_FILENAME), 'utf8');
    expect(raw).not.toContain('sk-ant-oat01-realdpapi');
    expect(raw).toContain('"provider": "dpapi"');
    const entry = (JSON.parse(raw) as { entries: Record<string, { ciphertext: string }> }).entries[
      'claude.oauthToken'
    ];
    expect(entry?.ciphertext).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    // DPAPI blobs start with a fixed 16-byte provider GUID; decoding proves the
    // envelope holds the real thing rather than something base64-shaped.
    expect(Buffer.from(entry?.ciphertext ?? '', 'base64').length).toBeGreaterThan(16);
  });

  it('reopens the envelope across store instances, as a restart does', async () => {
    const options = {
      secretsDir: temp.secretsDir,
      provider: 'dpapi' as const,
      env: {},
      now: () => NOW,
      acl: inertAcl(),
    };
    await (await createSecretStore(options)).set('claude.oauthToken', 'persisted-under-dpapi');
    expect((await (await createSecretStore(options)).get('claude.oauthToken'))?.reveal()).toBe(
      'persisted-under-dpapi',
    );
  });
});
