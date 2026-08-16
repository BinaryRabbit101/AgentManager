/**
 * DESIGN §3.5 / architecture D2: `ANTHROPIC_API_KEY` silently overrides
 * subscription auth, so its presence under `auth.mode: "subscription"` is both
 * a boot `WARN` and a persistent health condition.
 */
import { describe, expect, it } from 'vitest';

import {
  ANTHROPIC_API_KEY_CONDITION_ID,
  checkAnthropicApiKeyOverride,
  OVERRIDING_ENV_VAR,
  warnOnAnthropicApiKeyOverride,
} from './authWarning.js';
import { recordingLog } from './__tests__/helpers.js';

describe('ANTHROPIC_API_KEY startup check', () => {
  it('raises the condition when the key is set under subscription auth', () => {
    const condition = checkAnthropicApiKeyOverride({
      env: { [OVERRIDING_ENV_VAR]: 'sk-ant-api03-abcd' },
      authMode: 'subscription',
    });

    expect(condition?.id).toBe(ANTHROPIC_API_KEY_CONDITION_ID);
    expect(condition?.level).toBe('warn');
    expect(condition?.message).toContain(OVERRIDING_ENV_VAR);
    expect(condition?.message).toContain('subscription');
    // The value itself must never reach a health payload or a log line (§3.5).
    expect(condition?.message).not.toContain('sk-ant-api03-abcd');
  });

  it('logs the WARN and returns the same condition, so the two cannot disagree', () => {
    const log = recordingLog();
    const condition = warnOnAnthropicApiKeyOverride(log, {
      env: { [OVERRIDING_ENV_VAR]: 'sk-ant-api03-abcd' },
      authMode: 'subscription',
    });

    expect(condition).toBeDefined();
    expect(log.records).toHaveLength(1);
    expect(log.records[0]?.level).toBe('warn');
    expect(log.records[0]?.msg).toBe(condition?.message);
    expect(log.records[0]?.data).toEqual({
      conditionId: ANTHROPIC_API_KEY_CONDITION_ID,
      authMode: 'subscription',
    });
    expect(log.records[0]?.msg).not.toContain('sk-ant-api03-abcd');
  });

  it('stays silent when the key is absent, empty, or the configured credential', () => {
    const log = recordingLog();
    const cases = [
      { env: {}, authMode: 'subscription' as const },
      { env: { [OVERRIDING_ENV_VAR]: '   ' }, authMode: 'subscription' as const },
      { env: { [OVERRIDING_ENV_VAR]: 'sk-ant-api03-abcd' }, authMode: 'env' as const },
      { env: { [OVERRIDING_ENV_VAR]: 'sk-ant-api03-abcd' }, authMode: 'bedrock' as const },
    ];

    for (const options of cases) {
      expect(warnOnAnthropicApiKeyOverride(log, options)).toBeUndefined();
    }
    expect(log.records).toEqual([]);
  });
});
