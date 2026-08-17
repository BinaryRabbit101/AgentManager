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
  answerBody,
  askedAgo,
  askedBy,
  canSubmit,
  ENGINE_ATTRIBUTION,
  expiryLabel,
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
