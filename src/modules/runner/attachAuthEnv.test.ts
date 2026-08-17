/**
 * `attachAuthEnv` (runner DESIGN §3.4) — the auth table, the credential strip,
 * and the one reveal site.
 */
import { describe, expect, it } from 'vitest';

import { Secret, type SecretResolver } from '../../secrets/index.js';

import {
  attachAuthEnv,
  BASE_URL_ENV,
  OAUTH_TOKEN_ENV,
  STRIPPED_CREDENTIAL_ENV,
} from './attachAuthEnv.js';
import type { SdkOptions } from './contracts.js';
import { SecretUnresolvedError } from './errors.js';

function resolver(values: Record<string, string>): SecretResolver {
  return {
    get: (key) => Promise.resolve(key in values ? new Secret(values[key] ?? '') : undefined),
  };
}

const TOKEN = 'sk-ant-oat01-example';

function options(env: Record<string, string> = {}): SdkOptions {
  return { allowedTools: ['Read'], env: { PATH: 'C:\\bin', ...env } };
}

interface Logged {
  level: string;
  message: string;
  detail: Record<string, unknown>;
}

function collect(): {
  lines: Logged[];
  log: (l: 'debug' | 'warn', m: string, d: Record<string, unknown>) => void;
} {
  const lines: Logged[] = [];
  return {
    lines,
    log: (level, message, detail) => lines.push({ level, message, detail }),
  };
}

describe('auth.mode: subscription', () => {
  it('sets CLAUDE_CODE_OAUTH_TOKEN from the one secret runner resolves', async () => {
    const before = options();
    const after = await attachAuthEnv(before, {
      mode: 'subscription',
      secrets: resolver({ 'claude.oauthToken': TOKEN }),
      sessionId: 's1',
    });

    expect(after.env?.[OAUTH_TOKEN_ENV]).toBe(TOKEN);
    // The compiled object is left exactly as roster produced it (§3.3).
    expect(before.env?.[OAUTH_TOKEN_ENV]).toBeUndefined();
    expect(after.env?.['PATH']).toBe('C:\\bin');
  });

  it('fails secret_unresolved pointing at Setup-Auth.ps1 when nothing is stored', async () => {
    await expect(
      attachAuthEnv(options(), {
        mode: 'subscription',
        secrets: resolver({}),
        sessionId: 's1',
      }),
    ).rejects.toBeInstanceOf(SecretUnresolvedError);

    let thrown: unknown;
    try {
      await attachAuthEnv(options(), {
        mode: 'subscription',
        secrets: resolver({}),
        sessionId: 's1',
      });
    } catch (caught) {
      thrown = caught;
    }
    expect(thrown).toBeInstanceOf(SecretUnresolvedError);
    const error = thrown as SecretUnresolvedError;
    expect(error.exitReason).toBe('secret_unresolved');
    expect(error.message).toContain('Setup-Auth.ps1');
  });

  it('strips ANTHROPIC_API_KEY with a WARN naming the session (D2, §3.4)', async () => {
    const sink = collect();
    const after = await attachAuthEnv(options({ ANTHROPIC_API_KEY: 'sk-ant-planted' }), {
      mode: 'subscription',
      secrets: resolver({ 'claude.oauthToken': TOKEN }),
      sessionId: 'session-7',
      log: sink.log,
    });

    expect(after.env?.['ANTHROPIC_API_KEY']).toBeUndefined();
    const warning = sink.lines.find((line) => line.level === 'warn');
    expect(warning?.message).toContain('ANTHROPIC_API_KEY');
    expect(warning?.detail['sessionId']).toBe('session-7');
  });

  it('strips the whole credential class, minus the token it sets (SDK-NOTES G10)', async () => {
    const planted: Record<string, string> = {};
    for (const name of STRIPPED_CREDENTIAL_ENV) planted[name] = 'planted';
    planted[OAUTH_TOKEN_ENV] = 'an-old-token';

    const after = await attachAuthEnv(options(planted), {
      mode: 'subscription',
      secrets: resolver({ 'claude.oauthToken': TOKEN }),
      sessionId: 's1',
    });

    for (const name of STRIPPED_CREDENTIAL_ENV) expect(after.env?.[name]).toBeUndefined();
    // The one it owns is replaced, not stripped.
    expect(after.env?.[OAUTH_TOKEN_ENV]).toBe(TOKEN);
  });

  it('warns about ANTHROPIC_BASE_URL but leaves it in place', async () => {
    const sink = collect();
    const after = await attachAuthEnv(options({ [BASE_URL_ENV]: 'https://proxy.internal' }), {
      mode: 'subscription',
      secrets: resolver({ 'claude.oauthToken': TOKEN }),
      sessionId: 's1',
      log: sink.log,
    });

    expect(after.env?.[BASE_URL_ENV]).toBe('https://proxy.internal');
    expect(sink.lines.some((line) => line.message.includes(BASE_URL_ENV))).toBe(true);
  });
});

describe('auth.mode: env and bedrock', () => {
  for (const mode of ['env', 'bedrock'] as const) {
    it(`${mode} sets nothing and strips nothing`, async () => {
      const before = options({ ANTHROPIC_API_KEY: 'workplace-key' });
      const after = await attachAuthEnv(before, {
        mode,
        // A resolver that would throw if it were consulted.
        secrets: {
          get: () => {
            throw new Error('secrets must not be read under this auth mode');
          },
        },
        sessionId: 's1',
      });

      expect(after).toBe(before);
      expect(after.env?.['ANTHROPIC_API_KEY']).toBe('workplace-key');
      expect(after.env?.[OAUTH_TOKEN_ENV]).toBeUndefined();
    });
  }
});
