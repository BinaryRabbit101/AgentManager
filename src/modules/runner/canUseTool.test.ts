/**
 * The `canUseTool` adapter M3 installs (§5.1, D10) and SDK-NOTES **G5**.
 *
 * G5 is the whole reason this has its own test: returning `null` — or throwing,
 * which leaves the control request unanswered just as effectively — blocks the
 * tool call **forever**, because permission prompts have no park deadline. The
 * adapter must be total on every path.
 */
import { describe, expect, it } from 'vitest';

import { createDefaultDenyCanUseTool } from './canUseTool.js';
import type { CanUseToolPolicyView } from './contracts.js';

const policy: CanUseToolPolicyView = {
  default: 'deny',
  humanMayApprove: true,
  ask: ['Write'],
  denyMessage: 'Denied by AgentManager: this call is not in the effective allow set.',
};

function callbackOptions(): Parameters<ReturnType<typeof createDefaultDenyCanUseTool>>[2] {
  return {
    signal: new AbortController().signal,
    toolUseID: 'tu_1',
    requestId: 'req_1',
  };
}

describe('the default-deny callback', () => {
  it('denies with roster’s message, echoing the tool use id', async () => {
    const callback = createDefaultDenyCanUseTool({ policy });
    const result = await callback('Bash', { command: 'rm -rf /' }, callbackOptions());

    expect(result).toEqual({
      behavior: 'deny',
      message: policy.denyMessage,
      toolUseID: 'tu_1',
    });
  });

  it('does not interrupt the turn — that denial belongs to §5.4’s park (M7)', async () => {
    const callback = createDefaultDenyCanUseTool({ policy });
    const result = await callback('Write', { file: 'a' }, callbackOptions());
    expect(result).not.toHaveProperty('interrupt');
  });

  it('is total: never null, even when the observer throws (G5)', async () => {
    const callback = createDefaultDenyCanUseTool({
      policy,
      onDenied: () => {
        throw new Error('an observer that would otherwise wedge the tool call');
      },
    });

    const result = await callback('Read', {}, callbackOptions());
    expect(result).not.toBeNull();
    expect(result?.behavior).toBe('deny');
  });

  it('reports every call that reached it, so a denial is diagnosable', async () => {
    const seen: string[] = [];
    const callback = createDefaultDenyCanUseTool({
      policy,
      onDenied: (toolName) => seen.push(toolName),
    });
    await callback('Bash', {}, callbackOptions());
    await callback('WebFetch', {}, callbackOptions());
    expect(seen).toEqual(['Bash', 'WebFetch']);
  });
});
