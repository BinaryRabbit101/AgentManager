/**
 * Provider selection and the fallback chain of DESIGN §3.1.
 *
 * The binding loader is injected throughout: a loader that rejects is exactly
 * what an ABI mismatch after a Node or Electron upgrade looks like from the
 * store's side, which is the failure §3.1 names as the realistic one.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DpapiUnavailableError } from './errors.js';
import { SECRETS_FILENAME } from './envelope.js';
import { MASTER_KEY_FILENAME } from './keyfile.js';
import { createSecretStore, DEGRADED_CONDITION_ID } from './store.js';
import {
  failingDpapiLoader,
  fakeDpapiLoader,
  fakeIcacls,
  inertAcl,
  makeTempDir,
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

describe('createSecretStore provider selection', () => {
  it('uses dpapi under "auto" when the binding loads, and reports healthy', async () => {
    const log = recordingLog();
    const store = await createSecretStore({
      secretsDir: temp.secretsDir,
      provider: 'auto',
      env: {},
      log,
      now: () => NOW,
      loadDpapi: fakeDpapiLoader,
      acl: inertAcl(),
    });

    expect(store.provider).toBe('dpapi');
    expect(store.degraded).toBeUndefined();
    expect(store.health()).toEqual({ status: 'ok', provider: 'dpapi', conditions: [] });

    await store.set('claude.oauthToken', 'sk-ant-oat01-abcd');
    expect((await store.get('claude.oauthToken'))?.reveal()).toBe('sk-ant-oat01-abcd');
    // No master.key: the dpapi path never touches the keyfile machinery.
    expect(existsSync(resolve(temp.secretsDir, MASTER_KEY_FILENAME))).toBe(false);
    expect(log.records.filter((record) => record.level === 'warn')).toEqual([]);
  });

  it('falls back to keyfile when the binding fails to load, logging a WARN', async () => {
    const log = recordingLog();
    const store = await createSecretStore({
      secretsDir: temp.secretsDir,
      provider: 'auto',
      env: {},
      log,
      now: () => NOW,
      loadDpapi: failingDpapiLoader,
      acl: inertAcl(),
    });

    expect(store.provider).toBe('keyfile');

    const warning = log.records.find(
      (record) => record.level === 'warn' && record.msg.includes('falling back to the keyfile'),
    );
    expect(warning).toBeDefined();
    expect(warning?.data).toMatchObject({ requested: 'auto', provider: 'keyfile' });
    expect(String(warning?.data?.['reason'])).toContain('ABI');

    // The fallback is transparent: the store still works.
    await store.set('claude.oauthToken', 'sk-ant-oat01-abcd');
    expect((await store.get('claude.oauthToken'))?.reveal()).toBe('sk-ant-oat01-abcd');
    expect(existsSync(resolve(temp.secretsDir, MASTER_KEY_FILENAME))).toBe(true);
  });

  it('surfaces the degraded flag and the health condition after a fallback', async () => {
    const store = await createSecretStore({
      secretsDir: temp.secretsDir,
      provider: 'auto',
      env: {},
      now: () => NOW,
      loadDpapi: failingDpapiLoader,
      acl: inertAcl(),
    });

    expect(store.degraded?.provider).toBe('keyfile');
    expect(store.degraded?.requested).toBe('auto');
    expect(store.degraded?.since).toBe(NOW.toISOString());
    expect(store.degraded?.reason).toContain('ABI');

    const health = store.health();
    expect(health.status).toBe('degraded');
    expect(health.provider).toBe('keyfile');
    expect(health.degraded).toEqual(store.degraded);
    expect(health.conditions).toHaveLength(1);
    expect(health.conditions[0]?.id).toBe(DEGRADED_CONDITION_ID);
    expect(health.conditions[0]?.level).toBe('warn');
    expect(health.conditions[0]?.message).toContain('key file');
  });

  it('fails loudly when dpapi is named explicitly, rather than weakening the install', async () => {
    const log = recordingLog();
    await expect(
      createSecretStore({
        secretsDir: temp.secretsDir,
        provider: 'dpapi',
        env: {},
        log,
        loadDpapi: failingDpapiLoader,
        acl: inertAcl(),
      }),
    ).rejects.toThrow(DpapiUnavailableError);

    expect(existsSync(temp.secretsDir)).toBe(false);
    expect(log.records.filter((record) => record.msg.includes('falling back'))).toEqual([]);
  });

  it('treats a deliberately chosen keyfile as healthy, not degraded', async () => {
    const store = await createSecretStore({
      secretsDir: temp.secretsDir,
      provider: 'keyfile',
      env: {},
      now: () => NOW,
      acl: inertAcl(),
    });

    expect(store.provider).toBe('keyfile');
    expect(store.degraded).toBeUndefined();
    expect(store.health()).toEqual({ status: 'ok', provider: 'keyfile', conditions: [] });

    await store.set('notify.ntfy.topicUrl', 'https://ntfy.sh/wxyz');
    expect((await store.list())[0]).toEqual({
      key: 'notify.ntfy.topicUrl',
      setAt: NOW.toISOString(),
      preview: 'wxyz',
    });
  });

  it('reopens a keyfile store over the same envelope with the same key', async () => {
    const options = {
      secretsDir: temp.secretsDir,
      provider: 'keyfile' as const,
      env: {},
      now: () => NOW,
      acl: inertAcl(),
    };
    const first = await createSecretStore(options);
    await first.set('claude.oauthToken', 'persisted-value');

    const second = await createSecretStore(options);
    expect((await second.get('claude.oauthToken'))?.reveal()).toBe('persisted-value');
  });

  it('tightens the secrets directory ACL when it creates it', async () => {
    const run = fakeIcacls();
    const store = await createSecretStore({
      secretsDir: temp.secretsDir,
      provider: 'auto',
      env: { USERNAME: 'tester', USERDOMAIN: 'TESTDOMAIN' },
      now: () => NOW,
      loadDpapi: fakeDpapiLoader,
      acl: { platform: 'win32', run },
    });
    await store.set('claude.oauthToken', 'v');

    expect(run.calls).toEqual([
      [temp.secretsDir, '/grant:r', 'TESTDOMAIN\\tester:(OI)(CI)F', '/Q'],
      [temp.secretsDir, '/inheritance:r', '/Q'],
    ]);
  });

  it('clears a stale temporary envelope left by an interrupted write', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(temp.secretsDir, { recursive: true });
    const stale = resolve(temp.secretsDir, `${SECRETS_FILENAME}.tmp`);
    await writeFile(stale, 'half a file', 'utf8');

    const store = await createSecretStore({
      secretsDir: temp.secretsDir,
      provider: 'keyfile',
      env: {},
      now: () => NOW,
      acl: inertAcl(),
    });
    await store.set('claude.oauthToken', 'v');

    expect(existsSync(stale)).toBe(false);
  });
});
