/**
 * The `env` provider of DESIGN §3.1 — "reads from the process environment,
 * never persists". The disk assertions are the acceptance criterion: not one
 * file, not even the directory.
 */
import { existsSync, readdirSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createEnvSecretStore } from './env.js';
import { SecretStoreReadOnlyError } from './errors.js';
import { ENV_PREFIX } from './keys.js';
import { createSecretStore } from './store.js';
import { makeTempDir, recordingLog, type TempDir } from './__tests__/helpers.js';

const NOW = new Date('2026-08-16T10:35:00.000Z');

let temp: TempDir;

beforeEach(() => {
  temp = makeTempDir();
});
afterEach(() => {
  temp.cleanup();
});

describe('env provider', () => {
  it('reads the generic variable and the §3.3 well-known one', async () => {
    const store = createEnvSecretStore({
      env: {
        [`${ENV_PREFIX}mcp__gmail__token`]: 'mcp-token-value',
        CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token-value',
      },
      now: () => NOW,
    });

    expect((await store.get('mcp.gmail.token'))?.reveal()).toBe('mcp-token-value');
    expect((await store.get('claude.oauthToken'))?.reveal()).toBe('oauth-token-value');
    expect(await store.get('notify.ntfy.topicUrl')).toBeUndefined();
  });

  it('prefers the explicitly-named variable over the well-known alias', async () => {
    const store = createEnvSecretStore({
      env: {
        [`${ENV_PREFIX}anthropic__apiKey`]: 'explicit',
        ANTHROPIC_API_KEY: 'ambient',
      },
      now: () => NOW,
    });

    expect((await store.get('anthropic.apiKey'))?.reveal()).toBe('explicit');
    expect(await store.list()).toEqual([
      { key: 'anthropic.apiKey', setAt: NOW.toISOString(), preview: 'icit' },
    ]);
  });

  it('lists previews only, treating an empty variable as unset', async () => {
    const store = createEnvSecretStore({
      env: {
        [`${ENV_PREFIX}mcp__gmail__token`]: 'abcd1234',
        [`${ENV_PREFIX}notify__ntfy__topicUrl`]: '',
        ANTHROPIC_API_KEY: 'sk-ant-wxyz',
        PATH: 'C:\\Windows',
      },
      now: () => NOW,
    });

    expect(await store.list()).toEqual([
      { key: 'anthropic.apiKey', setAt: NOW.toISOString(), preview: 'wxyz' },
      { key: 'mcp.gmail.token', setAt: NOW.toISOString(), preview: '1234' },
    ]);
  });

  it('refuses to write instead of half-persisting into process.env', async () => {
    const store = createEnvSecretStore({ env: {}, now: () => NOW });
    await expect(store.set('claude.oauthToken', 'v')).rejects.toThrow(SecretStoreReadOnlyError);
    await expect(store.delete('claude.oauthToken')).rejects.toThrow(/never persists/);
  });

  it('writes nothing to disk — the secrets directory is never even created', async () => {
    const log = recordingLog();
    const store = await createSecretStore({
      secretsDir: temp.secretsDir,
      provider: 'env',
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token-value' },
      log,
      now: () => NOW,
    });

    expect(store.provider).toBe('env');
    expect((await store.get('claude.oauthToken'))?.reveal()).toBe('oauth-token-value');
    await expect(store.set('claude.oauthToken', 'v')).rejects.toThrow(SecretStoreReadOnlyError);
    await store.list();

    expect(existsSync(temp.secretsDir)).toBe(false);
    // Nothing anywhere under the temp root either, not just under `secrets/`.
    expect(readdirSync(temp.path)).toEqual([]);
    expect(store.health()).toEqual({ status: 'ok', provider: 'env', conditions: [] });
    expect(store.degraded).toBeUndefined();
  });
});
