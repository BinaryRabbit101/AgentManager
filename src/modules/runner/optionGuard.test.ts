/**
 * §3.3's ownership boundary, tested as the design describes it: "the compiled
 * options are snapshotted before and after runner's mutations, and only §3.3's
 * whitelisted key paths differ. The test fails if runner touches `allowedTools`,
 * `disallowedTools`, `permissionMode`, `settings`, `mcpServers`, `systemPrompt`,
 * `model`, `maxTurns`, `maxBudgetUsd`, `cwd`, `plugins`, `skills`, or
 * `settingSources`."
 */
import { describe, expect, it } from 'vitest';

import type { SdkOptions } from './contracts.js';
import { OptionWhitelistError } from './errors.js';
import {
  assertOptionsWhitelisted,
  diffOptionPaths,
  STRIPPABLE_OPTION_PATHS,
  WHITELISTED_OPTION_PATHS,
} from './optionGuard.js';

function compiled(): SdkOptions {
  return {
    systemPrompt: { type: 'preset', preset: 'claude_code', append: 'persona' },
    allowedTools: ['Read'],
    disallowedTools: ['Bash(rm *)'],
    permissionMode: 'default',
    settings: { permissions: { deny: ['Bash(rm *)'], ask: [] } },
    settingSources: ['project'],
    skills: [],
    plugins: [],
    mcpServers: {},
    model: 'claude-sonnet-4-5',
    maxTurns: 60,
    maxBudgetUsd: 2.5,
    cwd: 'C:\\workspace',
    env: { PATH: 'C:\\bin', ANTHROPIC_API_KEY: 'planted' },
  };
}

describe('the whitelist', () => {
  it('accepts every §3.3 field runner owns', () => {
    const before = compiled();
    const after: SdkOptions = {
      ...before,
      env: { ...before.env, CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-x' },
      abortController: new AbortController(),
      canUseTool: () => Promise.resolve({ behavior: 'deny', message: 'no' }),
      includePartialMessages: true,
      resume: 'a-session-id',
      stderr: () => {},
    };

    expect(() => {
      assertOptionsWhitelisted(before, after);
    }).not.toThrow();
    expect(diffOptionPaths(before, after)).toEqual([
      'abortController',
      'canUseTool',
      'env.CLAUDE_CODE_OAUTH_TOKEN',
      'includePartialMessages',
      'resume',
      'stderr',
    ]);
  });

  it('accepts the §3.4 credential strip', () => {
    const before = compiled();
    const env = { ...before.env };
    delete env['ANTHROPIC_API_KEY'];
    const after: SdkOptions = { ...before, env };

    expect(diffOptionPaths(before, after)).toEqual(['env.ANTHROPIC_API_KEY']);
    expect(STRIPPABLE_OPTION_PATHS).toContain('env.ANTHROPIC_API_KEY');
    expect(() => {
      assertOptionsWhitelisted(before, after);
    }).not.toThrow();
  });

  const forbidden = [
    'allowedTools',
    'disallowedTools',
    'permissionMode',
    'settings',
    'mcpServers',
    'systemPrompt',
    'model',
    'maxTurns',
    'maxBudgetUsd',
    'cwd',
    'plugins',
    'skills',
    'settingSources',
  ] as const;

  for (const key of forbidden) {
    it(`refuses a change to ${key}`, () => {
      const before = compiled();
      const after: SdkOptions = { ...before, [key]: replacementFor(key) };

      expect(diffOptionPaths(before, after)).toEqual([key]);
      expect(() => {
        assertOptionsWhitelisted(before, after);
      }).toThrow(OptionWhitelistError);

      const error = captureError(() => {
        assertOptionsWhitelisted(before, after);
      });
      expect(error?.message).toContain(key);
      expect(error?.exitReason).toBe('launch_failed');
    });
  }

  it('refuses an environment variable runner does not own', () => {
    const before = compiled();
    const after: SdkOptions = { ...before, env: { ...before.env, SNEAKY: '1' } };
    expect(() => {
      assertOptionsWhitelisted(before, after);
    }).toThrow(/env\.SNEAKY/u);
  });

  it('is the §3.3 table, key for key', () => {
    expect([...WHITELISTED_OPTION_PATHS].sort()).toEqual([
      'abortController',
      'canUseTool',
      'env.CLAUDE_CODE_OAUTH_TOKEN',
      'includePartialMessages',
      'resume',
      'sessionId',
      'stderr',
    ]);
  });
});

function replacementFor(key: string): unknown {
  switch (key) {
    case 'permissionMode':
      return 'acceptEdits';
    case 'model':
      return 'claude-opus-4-1';
    case 'maxTurns':
      return 1;
    case 'maxBudgetUsd':
      return 0.01;
    case 'cwd':
      return 'C:\\elsewhere';
    case 'systemPrompt':
      return 'replaced';
    case 'settings':
      return { permissions: { deny: [] } };
    case 'mcpServers':
      return { extra: { type: 'stdio', command: 'x' } };
    default:
      return ['Write'];
  }
}

function captureError(run: () => void): OptionWhitelistError | undefined {
  try {
    run();
  } catch (error) {
    return error instanceof OptionWhitelistError ? error : undefined;
  }
  return undefined;
}
