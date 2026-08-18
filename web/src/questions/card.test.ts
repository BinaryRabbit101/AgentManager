/**
 * The card's rules (DESIGN §11.2; orchestrator §16.1–§16.4; IMPLEMENTATION §5).
 *
 * The two negative criteria live here because they are about the *pipeline* and
 * not about one render: an engine-raised gate is never attributed to an agent,
 * and nothing in the stance path can produce a number.
 */

import { describe, expect, it } from 'vitest';

import type { QuestionCard as Card } from '../api/types';
import { QUESTION_STRENGTHS } from '../api/types';

import {
  ALLOW_ALWAYS_OPTION_ID,
  alwaysAllowFailedMessage,
  alwaysAllowPreview,
  alwaysAllowRememberedMessage,
  answerBody,
  askedAgo,
  askedBy,
  canSubmit,
  durableAllow,
  ENGINE_ATTRIBUTION,
  expiryLabel,
  gatedCall,
  isEngineRaised,
  KIND_LABELS,
  STRENGTH_EMPHASIS,
  strengthWord,
} from './card';

function aCard(overrides: Partial<Card> = {}): Card {
  return {
    id: 'q1',
    kind: 'question',
    status: 'open',
    prompt: 'Store transcripts in the DB or on disk?',
    options: [
      { id: 'disk', label: 'On disk' },
      { id: 'db', label: 'In SQLite' },
    ],
    multiSelect: false,
    allowFreeText: true,
    context: null,
    createdAt: '2026-08-17T09:00:00.000Z',
    holdUntil: null,
    expiresAt: '2026-08-18T05:00:00.000Z',
    assignmentId: 'a1',
    projectId: 'lpm',
    sessionId: 's1',
    recommendations: [],
    disagreement: false,
    contested: false,
    answeredVia: null,
    answeredAt: null,
    answer: null,
    ...overrides,
  };
}

describe('one inbox, three kinds (§16-3)', () => {
  it('has a chip for each kind and no fourth', () => {
    expect(Object.keys(KIND_LABELS)).toEqual(['question', 'approval_gate', 'budget_halt']);
    expect(KIND_LABELS.approval_gate).toBe('APPROVAL');
  });
});

describe('an engine-raised gate is attributed to AgentManager (§16-2)', () => {
  it('names AgentManager for a gate and a budget halt with no agent stance', () => {
    for (const kind of ['approval_gate', 'budget_halt'] as const) {
      const card = aCard({ kind, recommendations: [] });
      expect(isEngineRaised(card)).toBe(true);
      expect(askedBy(card)).toBe(ENGINE_ATTRIBUTION);
      expect(askedBy(card)).toBe('AgentManager');
    }
  });

  it('never names AgentManager when an agent actually asked', () => {
    const card = aCard({
      kind: 'approval_gate',
      recommendations: [
        { agentId: 'sam', role: 'skeptic', stance: 'disk', strength: 'blocking', rationale: null },
      ],
    });
    expect(isEngineRaised(card)).toBe(false);
    expect(askedBy(card)).toBe('sam');
  });

  it('never attributes a plain question to AgentManager', () => {
    // A `question` always comes from an agent through runner's bridge, so the
    // engine word must not appear on one even when the projection carries no
    // recommendation (see the milestone report's note on that gap).
    const card = aCard({ kind: 'question', recommendations: [] });
    expect(isEngineRaised(card)).toBe(false);
    expect(askedBy(card)).toBeUndefined();
  });
});

describe('the stance ladder is words, all the way down (§16-1)', () => {
  it('renders each rung as its own word, with blocking shouted', () => {
    expect(strengthWord('blocking')).toBe('BLOCKING');
    expect(strengthWord('strong')).toBe('strong');
    expect(strengthWord('lean')).toBe('lean');
    expect(strengthWord('defer')).toBe('defer');
    expect(strengthWord(null)).toBe('no stance');
  });

  it('never produces a digit, a percentage or a bar for any rung', () => {
    for (const strength of QUESTION_STRENGTHS) {
      const word = strengthWord(strength);
      expect(word, strength).not.toMatch(/[0-9%]/u);
    }
    expect(strengthWord(null)).not.toMatch(/[0-9%]/u);
  });

  it('has an emphasis for every rung, so colour is never the only carrier', () => {
    for (const strength of QUESTION_STRENGTHS) {
      expect(STRENGTH_EMPHASIS[strength], strength).toBeTruthy();
    }
  });
});

describe('expiry is a countdown and nothing more (§16-4)', () => {
  const now = new Date('2026-08-17T09:00:00.000Z').getTime();

  it('counts down in minutes, hours and days', () => {
    expect(expiryLabel('2026-08-17T09:45:00.000Z', now)).toBe('expires in 45m');
    expect(expiryLabel('2026-08-18T05:00:00.000Z', now)).toBe('expires in 20h');
    expect(expiryLabel('2026-08-22T09:00:00.000Z', now)).toBe('expires in 5d');
  });

  it('says expired rather than offering a default action', () => {
    const label = expiryLabel('2026-08-17T08:00:00.000Z', now);
    expect(label).toBe('expired');
    // Nothing in this module names a default, an auto-approval or a fallback:
    // "expiry of an approval gate is a denial and the UI must not imply
    // otherwise". A label cannot be wired to a button.
    expect(label).not.toMatch(/default|approve|deny automatically/iu);
  });

  it('has nothing to say when the server declared no deadline', () => {
    expect(expiryLabel(null, now)).toBeUndefined();
  });

  it('phrases how long a card has been waiting', () => {
    expect(askedAgo('2026-08-17T08:56:00.000Z', now)).toBe('asked 4 min ago');
    expect(askedAgo('2026-08-17T08:59:45.000Z', now)).toBe('asked just now');
    expect(askedAgo('2026-08-16T09:00:00.000Z', now)).toBe('asked 1d ago');
  });
});

describe('the answer body is the server’s options, never an invention (§11.2)', () => {
  it('sends the chosen option id', () => {
    expect(answerBody(aCard(), { optionIds: ['disk'], text: '' })).toEqual({
      optionIds: ['disk'],
    });
  });

  it('sends free text only when the card allows it', () => {
    expect(answerBody(aCard(), { optionIds: [], text: '  neither  ' })).toEqual({
      text: 'neither',
    });
    expect(answerBody(aCard({ allowFreeText: false }), { optionIds: [], text: 'neither' })).toEqual(
      {},
    );
  });

  it('refuses to submit nothing', () => {
    expect(canSubmit(aCard(), { optionIds: [], text: '' })).toBe(false);
    expect(canSubmit(aCard(), { optionIds: [], text: 'x' })).toBe(true);
    expect(canSubmit(aCard({ allowFreeText: false }), { optionIds: [], text: 'x' })).toBe(false);
    expect(canSubmit(aCard({ allowFreeText: false }), { optionIds: ['db'], text: '' })).toBe(true);
  });
});

describe('the call being gated (§11.2)', () => {
  it('promotes the command, so "use Bash?" says which Bash', () => {
    const call = gatedCall(
      aCard({
        prompt: 'Allow the agent to use Bash?',
        context: { toolName: 'Bash', toolInput: { command: 'rm -rf dist', description: 'clean' } },
      }),
    );
    expect(call).toMatchObject({ toolName: 'Bash', summary: 'rm -rf dist' });
    expect(call?.detail).toContain('rm -rf dist');
  });

  it('prefers the most specific field, not the first one present', () => {
    expect(
      gatedCall(aCard({ context: { toolName: 'Edit', toolInput: { description: 'a', file_path: 'src/x.ts' } } }))
        ?.summary,
    ).toBe('src/x.ts');
  });

  it('summarises only the first line, and caps it', () => {
    const call = gatedCall(
      aCard({ context: { toolName: 'Bash', toolInput: { command: `git log\n--oneline` } } }),
    );
    expect(call?.summary).toBe('git log');
  });

  it('survives an input it cannot summarise, and one it cannot serialise', () => {
    expect(gatedCall(aCard({ context: { toolName: 'Task', toolInput: { n: 1 } } }))).toMatchObject({
      toolName: 'Task',
      summary: undefined,
    });
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(gatedCall(aCard({ context: { toolName: 'Task', toolInput: circular } }))?.detail).toBe(
      undefined,
    );
  });

  it('is absent when the card is not gating a call at all', () => {
    expect(gatedCall(aCard({ context: null }))).toBe(undefined);
    expect(gatedCall(aCard({ context: { toolInput: { command: 'ls' } } }))).toBe(undefined);
  });
});

// ---------------------------------------------------------------------------
// "Always allow" — runner §5.1's third option (owner decision 2026-08-18)
// ---------------------------------------------------------------------------

const ALWAYS_OPTIONS: Card['options'] = [
  { id: 'allow', label: 'Allow once' },
  { id: ALLOW_ALWAYS_OPTION_ID, label: 'Always allow' },
  { id: 'deny', label: 'Deny' },
];

function aToolGate(overrides: Partial<Card> = {}): Card {
  return aCard({
    options: ALWAYS_OPTIONS,
    context: {
      toolName: 'Bash',
      toolInput: { command: 'npm run build' },
      durableRule: 'Bash(npm run:*)',
      agentId: 'priya',
    },
    ...overrides,
  });
}

describe('durableAllow — the rule is the server’s, never derived here', () => {
  it('reads the rule and the agent off the card', () => {
    expect(durableAllow(aToolGate())).toEqual({ agentId: 'priya', rule: 'Bash(npm run:*)' });
  });

  it('is absent unless the server offered the option', () => {
    // §11.2: the UI never invents an option, and it never invents the write
    // behind one either.
    expect(
      durableAllow(
        aToolGate({
          options: [
            { id: 'allow', label: 'Allow once' },
            { id: 'deny', label: 'Deny' },
          ],
        }),
      ),
    ).toBeUndefined();
  });

  it('is absent unless the server named both halves', () => {
    // Half a target is not a target: guessing the missing half is the one thing
    // this must never do, because the user approved a specific string.
    expect(durableAllow(aToolGate({ context: null }))).toBeUndefined();
    expect(
      durableAllow(aToolGate({ context: { toolName: 'Bash', agentId: 'priya' } })),
    ).toBeUndefined();
    expect(
      durableAllow(aToolGate({ context: { toolName: 'Bash', durableRule: 'Read' } })),
    ).toBeUndefined();
    expect(
      durableAllow(aToolGate({ context: { durableRule: '', agentId: 'priya' } })),
    ).toBeUndefined();
    expect(
      durableAllow(aToolGate({ context: { durableRule: 'Read', agentId: '' } })),
    ).toBeUndefined();
  });

  it('phrases the preview, the success and the half-success', () => {
    const target = { agentId: 'priya', rule: 'Bash(npm run:*)' };

    expect(alwaysAllowPreview(target)).toBe('adds Bash(npm run:*) to priya');

    const remembered = alwaysAllowRememberedMessage(target);
    expect(remembered).toContain('remembered for priya');
    expect(remembered).toContain('Bash(npm run:*)');
    // The honest half: the rule is compiled at launch, so it does nothing to
    // the session that just continued.
    expect(remembered).toContain('applies from its next session');
    expect(remembered).toContain('Manage in the agent editor');

    const failed = alwaysAllowFailedMessage(target, 'the library is read-only');
    // Never a word that implies the rule landed.
    expect(failed).toContain('The call was allowed');
    expect(failed).toContain('was not saved for priya');
    expect(failed).toContain('the library is read-only');
    expect(failed).not.toMatch(/remembered/u);
  });
});
