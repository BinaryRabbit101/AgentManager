/**
 * Prompt composition (DESIGN §3.2, IMPLEMENTATION M5-4: "all seven sections and
 * the byte cap").
 *
 * Pure, so it is tested as a pure function. Two things are asserted about every
 * prompt and are the reason the cap degrades rather than slices: the seat
 * sentence and the *required close* survive, because the seat is what makes the
 * turn correct and the close is what the convergence rule depends on.
 */
import { describe, expect, it } from 'vitest';

import type { InlinedMail } from './messages.js';
import type { PromptSpec } from './patterns.js';
import {
  byteLength,
  composePrompt,
  REPORT_STATUS_TOOL,
  TOOLING_GUARDRAIL,
  type ComposePromptInput,
} from './prompt.js';

const NO_MAIL: InlinedMail = { messages: [], remaining: 0 };

function input(overrides: Partial<ComposePromptInput> = {}): ComposePromptInput {
  const spec: PromptSpec = { intent: 'draft', seat: 'drafter', round: 1 };
  return {
    spec,
    patternId: 'pair',
    goal: 'Draft the migration plan',
    scope: { paths: ['docs/billing/'], description: 'the billing docs' },
    artifactPath: 'docs/billing/plan.md',
    write: true,
    role: 'architect',
    roundCap: 3,
    tokenBudget: 400_000,
    tokensUsed: 12_000,
    mail: NO_MAIL,
    decisions: [],
    budgets: { maxBytes: 16_384, excerptBytes: 2048 },
    ...overrides,
  };
}

function mail(count: number, body = 'hello'): InlinedMail {
  return {
    messages: Array.from({ length: count }, (_unused, index) => ({
      id: `m${String(index)}`,
      assignmentId: 'a1',
      fromAgentId: 'sam',
      toAgentId: 'ada',
      kind: 'note',
      body,
      payload: undefined,
      createdAt: '2026-08-16T10:00:00.000Z',
      deliveredAt: null,
      readAt: null,
      delivery: 'inlined' as const,
    })),
    remaining: 0,
  };
}

describe('the eight sections (§3.2)', () => {
  it('composes goal, seat, termination rules and the required close for a bare turn', () => {
    const composed = composePrompt(input());
    // 7 is the tooling guardrail (WO6), unconditional; 8 is the required close.
    expect(composed.sections).toEqual([1, 2, 6, 7, 8]);
    expect(composed.text).toContain('Goal: Draft the migration plan');
    expect(composed.text).toContain('docs/billing/ — the billing docs');
    expect(composed.text).toContain('Artifact: docs/billing/plan.md');
    expect(composed.text).toContain(
      'You are the drafter (role: architect) in an adversarial pair. Round 1 of 3.',
    );
    expect(composed.text).toContain(REPORT_STATUS_TOOL);
    expect(composed.truncated).toBe(false);
  });

  it('states the read-only posture when the assignment is not write-capable', () => {
    expect(composePrompt(input({ write: false })).text).toContain('Posture: read-only');
    expect(composePrompt(input({ write: true })).text).toContain('only inside the scope paths');
  });

  it('carries the handoff and the blocking issues verbatim (section 3)', () => {
    const composed = composePrompt(
      input({
        spec: {
          intent: 'revise',
          seat: 'drafter',
          round: 2,
          handoff: {
            seat: 'critic',
            agentId: 'sam',
            headline: 'Two blocking issues',
            excerpt: 'The rollback path is missing.',
          },
          blocking: [{ severity: 'high', summary: 'No rollback path for step 3' }],
        },
      }),
    );
    expect(composed.sections).toContain(3);
    expect(composed.text).toContain('Two blocking issues');
    expect(composed.text).toContain('The rollback path is missing.');
    expect(composed.text).toContain('[high] No rollback path for step 3');
  });

  it('inlines mail and says how much it did not inline (section 4)', () => {
    const composed = composePrompt(input({ mail: { ...mail(2), remaining: 7 } }));
    expect(composed.sections).toContain(4);
    expect(composed.text).toContain('sam (note): hello');
    expect(composed.text).toContain('7 older — call mcp__agentmanager__read_mailbox.');
  });

  it('solicits a stance on an open decision, demanding a strength word (section 5, §6.4)', () => {
    const composed = composePrompt(
      input({
        decisions: [
          {
            questionId: 'q1',
            prompt: 'Store transcripts in the DB or on disk?',
            options: [
              { id: 'disk', label: 'On disk' },
              { id: 'db', label: 'In SQLite' },
            ],
          },
        ],
      }),
    );
    expect(composed.sections).toContain(5);
    expect(composed.text).toContain('Store transcripts in the DB or on disk?');
    expect(composed.text).toContain('  - disk: On disk');
    expect(composed.text).toContain('blocking, strong, lean or defer');
  });

  it('prepends a landed answer instead of soliciting a stance', () => {
    const composed = composePrompt(
      input({
        spec: {
          intent: 'answered',
          seat: 'drafter',
          round: 1,
          answer: { question: 'Disk or DB?', text: 'disk' },
        },
        decisions: [{ questionId: 'q1', prompt: 'Disk or DB?', options: [] }],
      }),
    );
    expect(composed.text).toContain('The user answered "Disk or DB?": disk');
    expect(composed.text).not.toContain('state your stance');
  });

  it('tells the critic seat what the engine will read off its verdict (section 7)', () => {
    const composed = composePrompt(
      input({ spec: { intent: 'critique', seat: 'critic', round: 1 }, role: 'skeptic' }),
    );
    expect(composed.text).toContain('decision "accept" or');
    expect(composed.text).toContain('The engine reads the structure, not the prose.');
    expect(composed.text).toContain(
      'Convergence: this assignment finishes when the critic reports decision "accept"',
    );
  });

  it('spells out the rounds remaining and the budget (section 6)', () => {
    const composed = composePrompt(
      input({ spec: { intent: 'critique', seat: 'critic', round: 2 }, roundCap: 3 }),
    );
    expect(composed.text).toContain('this is round 2 of at most 3; 1 remain after it');
    expect(composed.text).toContain('Neither seat can raise the cap.');
    expect(composed.text).toContain('12000 of 400000 tokens used');
  });

  it('says the retry instruction out loud when a seat produced no report', () => {
    const composed = composePrompt(
      input({ spec: { intent: 'retry', seat: 'drafter', round: 1, retryOfTurnId: 't1' } }),
    );
    expect(composed.text).toContain('ended without a structured report');
    expect(composed.text).toContain(`you MUST call ${REPORT_STATUS_TOOL}`);
  });
});

describe('the byte cap (§3.2)', () => {
  it('drops the excerpt first, then the mail bodies, then the decisions', () => {
    const huge = 'x'.repeat(40_000);
    const composed = composePrompt(
      input({
        budgets: { maxBytes: 2000, excerptBytes: 40_000 },
        spec: {
          intent: 'revise',
          seat: 'drafter',
          round: 2,
          handoff: { seat: 'critic', agentId: 'sam', headline: 'issues', excerpt: huge },
        },
        mail: mail(3, 'y'.repeat(2000)),
        decisions: [{ questionId: 'q1', prompt: 'Disk or DB?', options: [] }],
      }),
    );
    expect(byteLength(composed.text)).toBeLessThanOrEqual(2000);
    expect(composed.truncated).toBe(true);
    // What survives is the contract, not the context.
    expect(composed.text).toContain('Goal: Draft the migration plan');
    expect(composed.text).toContain(REPORT_STATUS_TOOL);
    expect(composed.text).not.toContain(huge);
  });

  it('never exceeds the cap even when the goal alone is larger than it', () => {
    const composed = composePrompt(
      input({ goal: 'g'.repeat(50_000), budgets: { maxBytes: 512, excerptBytes: 128 } }),
    );
    expect(byteLength(composed.text)).toBeLessThanOrEqual(512);
    expect(composed.truncated).toBe(true);
  });

  it('is deterministic: the same input composes byte-identically twice', () => {
    const one = composePrompt(input({ mail: mail(3) }));
    const two = composePrompt(input({ mail: mail(3) }));
    expect(one.text).toBe(two.text);
  });
});

describe('a solo prompt is the same machinery with a different seat sentence', () => {
  it('names the role rather than a pair seat, and omits the pair convergence rule', () => {
    const composed = composePrompt(
      input({
        patternId: 'solo',
        spec: { intent: 'draft', seat: 'solo', round: 1 },
        role: 'implementer',
        roundCap: null,
        tokenBudget: null,
      }),
    );
    expect(composed.text).toContain('You are the implementer on this assignment.');
    expect(composed.text).toContain('this assignment has no round cap');
    expect(composed.text).not.toContain('Convergence:');
  });
});

/**
 * WO6 item 4. The incident of 2026-08-19 — an agent that could not reach its
 * todo MCP server and went looking on the machine for API credentials — was not
 * pattern-specific, so neither is the rule.
 */
describe('the no-scavenging guardrail (§3.2 section 7, WO6)', () => {
  const PATTERNS: readonly { readonly patternId: string; readonly spec: PromptSpec }[] = [
    { patternId: 'solo', spec: { intent: 'work', seat: 'solo', round: 1 } },
    { patternId: 'pair', spec: { intent: 'draft', seat: 'drafter', round: 1 } },
    { patternId: 'pair', spec: { intent: 'critique', seat: 'critic', round: 1 } },
    { patternId: 'overseer', spec: { intent: 'decompose', seat: 'lead', round: 1 } },
    { patternId: 'overseer', spec: { intent: 'review', seat: 'lead', round: 2 } },
  ];

  for (const { patternId, spec } of PATTERNS) {
    it(`is present verbatim for ${patternId}/${spec.intent}`, () => {
      const composed = composePrompt(input({ patternId, spec }));
      expect(composed.text).toContain(TOOLING_GUARDRAIL);
      expect(composed.text).toContain('## 7. Tools and integrations');
      expect(composed.sections).toContain(7);
    });
  }

  it('names both halves: never scavenge, and report blocked instead', () => {
    expect(TOOLING_GUARDRAIL).toContain('Use only the tools and MCP servers provided');
    expect(TOOLING_GUARDRAIL).toContain(`${REPORT_STATUS_TOOL} with state "blocked"`);
    expect(TOOLING_GUARDRAIL).toContain(
      'Never search the filesystem, environment, or configuration for credentials or API keys',
    );
  });

  it('survives every degradation, including the pathological slice', () => {
    // The cap drops context (3, 4, 5) before contract. A prompt small enough to
    // lose the guardrail would be one that had already lost the goal.
    const squeezed = composePrompt(
      input({ mail: mail(40, 'x'.repeat(400)), budgets: { maxBytes: 4_000, excerptBytes: 200 } }),
    );
    expect(squeezed.truncated).toBe(true);
    expect(squeezed.text).toContain(TOOLING_GUARDRAIL);
    expect(squeezed.text).toContain('## 8. Required close');
  });
});
