/**
 * SDK message → transcript vocabulary (§8.1) and status (§2.2), including the
 * two SDK facts the mapping exists to absorb: G1's replay flag and G2's
 * "there are no tool_use / tool_result message types".
 */
import { describe, expect, it } from 'vitest';

import {
  isInitMessage,
  outcomeForResult,
  readAssistant,
  readInitFacts,
  readResult,
  readUser,
} from './messages.js';
import { isReplayMessage } from './sdk.js';
import {
  fakeAssistant,
  fakeInit,
  fakeReplay,
  fakeResult,
  fakeToolResult,
  fakeUnknownMessage,
} from './__tests__/fakeQuery.js';

describe('init', () => {
  it('reads the facts §3.1 step 10 and §8.1 need, including the CLI version', () => {
    const message = fakeInit({ model: 'claude-opus-4-1', capabilities: ['interrupt_receipt_v1'] });
    expect(isInitMessage(message)).toBe(true);

    const facts = readInitFacts(message);
    expect(facts.model).toBe('claude-opus-4-1');
    expect(facts.permissionMode).toBe('default');
    expect(facts.claudeCodeVersion).toBe('2.1.233');
    expect(facts.apiKeySource).toBe('oauth');
    expect(facts.capabilities).toEqual(['interrupt_receipt_v1']);
    expect(facts.sdkSessionId).not.toBe('');
  });
});

describe('G2 — tool calls are content blocks, not message types', () => {
  it('derives a tool_use line from an assistant content block', () => {
    const parts = readAssistant(
      fakeAssistant({
        text: 'reading',
        toolUse: { id: 'tu_1', name: 'Read', input: { file: 'a' } },
      }),
    );
    expect(parts.text).toBe('reading');
    expect(parts.messageId).toBe('msg_01FAKE');
    expect(parts.toolUses).toEqual([{ toolUseId: 'tu_1', name: 'Read', input: { file: 'a' } }]);
  });

  it('derives a tool_result line from a user content block, with the structured twin', () => {
    const parts = readUser(
      fakeToolResult({
        toolUseId: 'tu_1',
        content: 'the text sent to the model',
        output: { lines: 3 },
      }),
    );
    expect(parts.toolResults).toEqual([
      {
        toolUseId: 'tu_1',
        isError: false,
        content: 'the text sent to the model',
        output: { lines: 3 },
      },
    ]);
  });
});

describe('G1 — the replay filter', () => {
  it('recognises a replayed user message and nothing else', () => {
    expect(isReplayMessage(fakeReplay('old history'))).toBe(true);
    expect(isReplayMessage(fakeToolResult({ toolUseId: 't', content: 'x' }))).toBe(false);
    expect(isReplayMessage(fakeAssistant({ text: 'hello' }))).toBe(false);
    expect(isReplayMessage(fakeInit())).toBe(false);
    expect(isReplayMessage(fakeUnknownMessage())).toBe(false);
  });
});

describe('result', () => {
  it('reads every field §7 and §2.2 consume', () => {
    const facts = readResult(fakeResult({ text: 'finished', costUsd: 0.5, turns: 3 }));
    expect(facts.subtype).toBe('success');
    expect(facts.isError).toBe(false);
    expect(facts.turns).toBe(3);
    expect(facts.costUsd).toBe(0.5);
    expect(facts.resultText).toBe('finished');
    expect(facts.permissionDenials).toEqual([]);
    expect(facts.errors).toEqual([]);
  });

  it('reads the error half, including terminal_reason (SDK-NOTES G7)', () => {
    const facts = readResult(
      fakeResult({
        subtype: 'error_during_execution',
        errors: ['rate limited'],
        terminalReason: 'blocking_limit',
      }),
    );
    expect(facts.isError).toBe(true);
    expect(facts.errors).toEqual(['rate limited']);
    expect(facts.terminalReason).toBe('blocking_limit');
    expect(facts.resultText).toBeNull();
  });

  it('maps every subtype to §2.2, and an unknown one to a finishable failure', () => {
    expect(outcomeForResult('success')).toEqual({ status: 'done', exitReason: 'completed' });
    expect(outcomeForResult('error_max_turns')).toEqual({
      status: 'failed',
      exitReason: 'max_turns',
    });
    expect(outcomeForResult('error_max_budget_usd')).toEqual({
      status: 'failed',
      exitReason: 'max_budget_usd',
    });
    expect(outcomeForResult('error_max_structured_output_retries')).toEqual({
      status: 'failed',
      exitReason: 'error_structured_output',
    });
    expect(outcomeForResult('error_during_execution')).toEqual({
      status: 'failed',
      exitReason: 'error_during_execution',
    });
    expect(outcomeForResult('error_from_a_future_sdk')).toEqual({
      status: 'failed',
      exitReason: 'error_during_execution',
    });
  });
});
