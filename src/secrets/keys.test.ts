import { describe, expect, it } from 'vitest';

import { InvalidSecretKeyError } from './errors.js';
import {
  assertSecretKey,
  ENV_PREFIX,
  envVarName,
  envVarNamesFor,
  isSecretKey,
  keyFromEnvVarName,
} from './keys.js';

describe('secret keys', () => {
  it('accepts every key shape DESIGN §3.3 defines', () => {
    for (const key of [
      'claude.oauthToken',
      'anthropic.apiKey',
      'mcp.gmail.token',
      'project.01JAV9K7Q0X2M3N4P5R6S7T8V9.DATABASE-URL',
      'notify.ntfy.topicUrl',
    ]) {
      expect(isSecretKey(key)).toBe(true);
      expect(() => assertSecretKey(key)).not.toThrow();
    }
  });

  it('rejects keys that would break the env-variable mapping or path handling', () => {
    for (const key of [
      '',
      '.leading',
      'trailing.',
      'two..dots',
      'has_underscore',
      'has space',
      '../escape',
    ]) {
      expect(isSecretKey(key)).toBe(false);
      expect(() => assertSecretKey(key)).toThrow(InvalidSecretKeyError);
    }
  });

  it('maps a key onto an environment variable reversibly, preserving case', () => {
    expect(envVarName('claude.oauthToken')).toBe(`${ENV_PREFIX}claude__oauthToken`);
    // A project id is a ULID, whose case is significant — so the mapping never
    // uppercases, because it could not put the case back.
    const key = 'project.01JAV9K7Q0X2M3N4P5R6S7T8V9.apiKey';
    expect(keyFromEnvVarName(envVarName(key))).toBe(key);
  });

  it('ignores environment variables outside the namespace', () => {
    expect(keyFromEnvVarName('PATH')).toBeUndefined();
    expect(keyFromEnvVarName('ANTHROPIC_API_KEY')).toBeUndefined();
    expect(keyFromEnvVarName(`${ENV_PREFIX}not a key`)).toBeUndefined();
  });

  it('reads the §3.3 well-known variables as a fallback, generic form first', () => {
    expect(envVarNamesFor('claude.oauthToken')).toEqual([
      `${ENV_PREFIX}claude__oauthToken`,
      'CLAUDE_CODE_OAUTH_TOKEN',
    ]);
    expect(envVarNamesFor('anthropic.apiKey')).toEqual([
      `${ENV_PREFIX}anthropic__apiKey`,
      'ANTHROPIC_API_KEY',
    ]);
    expect(envVarNamesFor('mcp.gmail.token')).toEqual([`${ENV_PREFIX}mcp__gmail__token`]);
  });
});
