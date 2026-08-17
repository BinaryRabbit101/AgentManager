/**
 * The assignment fixtures, in one place because three test files need the same
 * three-round pair and a fourth needs it with one field flipped.
 *
 * Every shape here is orchestrator's own, field for field (`types.ts`,
 * `conversation.ts`, `patterns.ts` in `src/modules/orchestrator/`). Where the
 * design doc and the implementation disagree — the doc shows per-turn `tokens`,
 * the code emits none — these follow the **code**, because the code is what the
 * screen will be handed.
 */

import type {
  AssignmentView,
  ConversationRound,
  ConversationView,
  PatternListView,
} from '../api/types';

export function anAssignment(overrides: Partial<AssignmentView> = {}): AssignmentView {
  return {
    id: 'asg_1',
    projectId: 'lpm',
    pattern: 'pair',
    status: 'closed',
    phase: 'converged',
    goal: 'Move transcripts off the hot path',
    scope: { paths: ['src/transcripts'], artifactPath: 'docs/decision.md' },
    write: true,
    createdBy: 'user',
    parentAssignmentId: null,
    leadAgentId: 'ada',
    artifactPath: 'docs/decision.md',
    tokenBudget: 400_000,
    tokensUsed: 120_000,
    roundCap: 3,
    roundsUsed: 3,
    haltReason: null,
    closeReason: 'converged',
    createdAt: '2026-08-17T09:00:00.000Z',
    updatedAt: '2026-08-17T10:00:00.000Z',
    closedAt: '2026-08-17T10:00:00.000Z',
    members: [
      { agentId: 'ada', role: 'architect', seatOrder: 0, joinedAt: '2026-08-17T09:00:00.000Z' },
      { agentId: 'sam', role: 'skeptic', seatOrder: 1, joinedAt: '2026-08-17T09:00:00.000Z' },
    ],
    ...overrides,
  };
}

export function aSoloAssignment(): AssignmentView {
  return anAssignment({
    id: 'asg_solo',
    pattern: 'solo',
    status: 'open',
    phase: 'running',
    tokenBudget: null,
    roundCap: null,
    roundsUsed: 0,
    closeReason: null,
    artifactPath: null,
    members: [
      { agentId: 'ada', role: 'implementer', seatOrder: 0, joinedAt: '2026-08-17T09:00:00.000Z' },
    ],
  });
}

/** One round of a pair: the drafter reports, the critic answers with a verdict. */
function aRound(round: number, decision: 'accept' | 'revise'): ConversationRound {
  return {
    round,
    entries: [
      {
        type: 'turn',
        turnId: `t${String(round)}a`,
        seat: 'drafter',
        agentId: 'ada',
        role: 'architect',
        sessionId: `ses_${String(round)}a`,
        status: 'reported',
        report: {
          state: 'needs_review',
          headline: `Draft ${String(round)}: store transcripts on disk`,
          artifacts: [{ path: 'docs/decision.md' }],
          at: '2026-08-17T09:10:00.000Z',
        },
        excerpt: 'I moved the write path behind a queue.',
        startedAt: '2026-08-17T09:05:00.000Z',
        endedAt: '2026-08-17T09:10:00.000Z',
        retryOfTurnId: null,
      },
      {
        type: 'turn',
        turnId: `t${String(round)}b`,
        seat: 'critic',
        agentId: 'sam',
        role: 'skeptic',
        sessionId: `ses_${String(round)}b`,
        status: 'reported',
        report: {
          state: decision === 'accept' ? 'done' : 'needs_review',
          headline: `Review ${String(round)}`,
          artifacts: [],
          verdict: {
            decision,
            blocking:
              decision === 'revise'
                ? [{ severity: 'high', summary: 'A 500MB transcript blows the WAL.' }]
                : [],
            nonBlocking: ['Consider naming the queue after what it drains.'],
          },
          at: '2026-08-17T09:20:00.000Z',
        },
        excerpt: null,
        startedAt: '2026-08-17T09:15:00.000Z',
        endedAt: '2026-08-17T09:20:00.000Z',
        retryOfTurnId: null,
      },
    ],
  };
}

export function aConversation(overrides: Partial<ConversationView> = {}): ConversationView {
  return {
    assignmentId: 'asg_1',
    pattern: 'pair',
    phase: 'converged',
    status: 'closed',
    artifactPath: 'docs/decision.md',
    roundsUsed: 3,
    roundCap: 3,
    tokensUsed: 120_000,
    tokenBudget: 400_000,
    closeReason: 'converged',
    haltReason: null,
    rounds: [
      {
        round: 1,
        entries: [
          ...aRound(1, 'revise').entries,
          {
            type: 'message',
            messageId: 'm1',
            from: 'sam',
            to: 'ada',
            kind: 'handoff',
            body: 'Look at the WAL numbers before you redraft.',
            delivery: 'inlined',
            createdAt: '2026-08-17T09:21:00.000Z',
          },
        ],
      },
      {
        round: 2,
        entries: [
          ...aRound(2, 'revise').entries,
          {
            type: 'message',
            messageId: 'm2',
            from: 'ada',
            to: 'sam',
            kind: 'note',
            body: 'Numbers are in the artifact now.',
            delivery: 'read',
            createdAt: '2026-08-17T09:41:00.000Z',
          },
          {
            type: 'message',
            messageId: 'm3',
            from: 'ada',
            to: 'sam',
            kind: 'note',
            body: 'And one more thing nobody ever saw.',
            delivery: 'undelivered',
            createdAt: '2026-08-17T09:42:00.000Z',
          },
          {
            type: 'question',
            questionId: 'q1',
            kind: 'question',
            prompt: 'Store transcripts in the DB or on disk?',
            recommendations: [
              {
                agentId: 'sam',
                role: 'skeptic',
                stance: 'On disk',
                strength: 'blocking',
                rationale: 'A 500MB transcript in SQLite blows the WAL.',
              },
              {
                agentId: 'ada',
                role: 'architect',
                stance: 'In SQLite',
                strength: 'lean',
                rationale: 'One store is simpler to back up.',
              },
            ],
            disagreement: true,
            contested: true,
            answer: { labels: ['On disk'] },
            createdAt: '2026-08-17T09:43:00.000Z',
          },
        ],
      },
      aRound(3, 'accept'),
    ],
    ...overrides,
  };
}

export const PATTERNS: PatternListView = {
  patterns: [
    {
      id: 'solo',
      driver: 'none',
      seats: [
        {
          key: 'solo',
          roles: ['implementer', 'architect', 'skeptic', 'reviewer', 'overseer'],
          required: true,
          write: true,
        },
      ],
      requires: { artifactPath: false, roundCap: false, tokenBudget: false },
      defaults: { roundCap: null, tokenBudget: null },
      maxRoundCap: null,
      cardSeatOrder: [],
    },
    {
      id: 'pair',
      driver: 'sequential',
      seats: [
        {
          key: 'drafter',
          roles: ['architect', 'implementer'],
          required: true,
          preferredTier: 'max',
          write: true,
        },
        {
          key: 'critic',
          roles: ['skeptic'],
          required: true,
          preferredTier: 'balanced',
          write: false,
        },
      ],
      requires: { artifactPath: true, roundCap: true, tokenBudget: true },
      defaults: { roundCap: 3, tokenBudget: 400_000 },
      maxRoundCap: 6,
      cardSeatOrder: ['critic', 'drafter'],
      candidates: {
        drafter: [
          {
            agentId: 'ada',
            name: 'Ada',
            roles: ['architect'],
            openAssignments: 1,
            available: true,
          },
        ],
        critic: [
          { agentId: 'sam', name: 'Sam', roles: ['skeptic'], openAssignments: 0, available: true },
        ],
      },
    },
  ],
};
