/**
 * The pure pattern layer (DESIGN §3.1, §3.3; IMPLEMENTATION M5-1/M5-6, M6-1..3).
 *
 * M5's first acceptance criterion, verbatim: *"`plan()` is pure: a table-driven
 * suite feeds turn-row fixtures and asserts the next plan, **with no database and
 * no runner in the test**."* So this file imports neither — every case is a
 * literal `AssignmentState` and an expected `PlanResult`. The engine's own tests
 * (`engine.test.ts`) then prove the same decisions against real rows; the point of
 * having both is that convergence is decided here, where it can be enumerated.
 */
import { describe, expect, it } from 'vitest';

import {
  isConverged,
  cardSeatOrder,
  childrenAwaitingReview,
  leadOf,
  patternFor,
  planChildSolo,
  seatsOf,
  CRITIC_SEAT,
  DRAFTER_SEAT,
  LEAD_SEAT,
  NO_BREAKERS,
  OVERSEER_PATTERN,
  PAIR_PATTERN,
  PATTERNS,
  SOLO_PATTERN,
  SOLO_SEAT,
  type AssignmentState,
  type ChildState,
  type PlanResult,
  type StateMember,
} from './patterns.js';
import type { AssignmentRow } from './repository.js';
import type { TurnReport, TurnRow, TurnStatus, TurnVerdict } from './turns.js';

// ---------------------------------------------------------------------------
// Fixtures — plain data, no storage
// ---------------------------------------------------------------------------

const MEMBERS: readonly StateMember[] = [
  { agentId: 'ada', role: 'architect', seatOrder: 0 },
  { agentId: 'sam', role: 'skeptic', seatOrder: 1 },
];

function row(overrides: Partial<AssignmentRow> = {}): AssignmentRow {
  return {
    id: 'a1',
    projectId: 'p1',
    pattern: 'pair',
    status: 'open',
    goal: 'Write the design',
    scopeJson: null,
    tokenBudget: 400_000,
    tokensUsed: 0,
    roundCap: 3,
    roundsUsed: 0,
    createdAt: '2026-08-16T10:00:00.000Z',
    closedAt: null,
    closeReason: null,
    createdBy: 'user',
    parentAssignmentId: null,
    leadAgentId: 'ada',
    write: true,
    artifactPath: 'docs/x/DESIGN.md',
    patternConfigJson: '{}',
    preGrantsJson: '[]',
    templateId: null,
    origin: 'user',
    triggerId: null,
    phase: 'running',
    haltReason: null,
    updatedAt: null,
    ...overrides,
  };
}

let turnSeq = 0;

function turn(overrides: Partial<TurnRow> & { seat: string; status: TurnStatus }): TurnRow {
  turnSeq += 1;
  return {
    id: `t${String(turnSeq)}`,
    assignmentId: 'a1',
    round: 1,
    agentId: overrides.seat === DRAFTER_SEAT ? 'ada' : 'sam',
    sessionId: `s${String(turnSeq)}`,
    prevSessionId: null,
    permissionDenials: 0,
    permissionDeniedTools: null,
    report: null,
    outputText: null,
    artifactHash: null,
    startedAt: '2026-08-16T10:00:00.000Z',
    endedAt: '2026-08-16T10:05:00.000Z',
    exitReason: null,
    retryOfTurnId: null,
    ...overrides,
  };
}

function report(overrides: Partial<TurnReport> = {}): TurnReport {
  return {
    state: 'done',
    headline: 'Draft complete',
    artifacts: [{ path: 'docs/x/DESIGN.md' }],
    at: '2026-08-16T10:05:00.000Z',
    ...overrides,
  };
}

function verdict(overrides: Partial<TurnVerdict> = {}): TurnVerdict {
  return { decision: 'revise', blocking: [], nonBlocking: [], ...overrides };
}

function state(
  turns: readonly TurnRow[],
  overrides: Partial<AssignmentState> = {},
): AssignmentState {
  return {
    assignment: row(),
    scope: { paths: ['docs/x/'], artifactPath: 'docs/x/DESIGN.md' },
    members: MEMBERS,
    turns,
    children: [],
    roundsUsed: 0,
    tokensUsed: 0,
    budget: 400_000,
    roundCap: 3,
    breakers: NO_BREAKERS,
    ...overrides,
  };
}

function plan(turns: readonly TurnRow[], overrides: Partial<AssignmentState> = {}): PlanResult {
  return PAIR_PATTERN.plan(state(turns, overrides));
}

// ---------------------------------------------------------------------------

describe('the pattern registry (M5-1)', () => {
  it('ships exactly the patterns it has drivers for, and names their drivers', () => {
    expect(PATTERNS.map((pattern) => [pattern.id, pattern.driver])).toEqual([
      ['solo', 'none'],
      ['pair', 'sequential'],
      // `review` shipped in WO5 (§3.6) — see `review.test.ts` for its own suite.
      ['review', 'sequential'],
      ['overseer', 'sequential'],
    ]);
    // A pattern with no driver is not in the registry, whatever a caller asks
    // for: this is what `unsupported_pattern` is derived from.
    expect(patternFor('swarm')).toBeUndefined();
  });

  it('declares what a pair requires: an artifact, a round cap and a budget', () => {
    expect(PAIR_PATTERN.requires).toEqual({
      artifactPath: true,
      roundCap: true,
      tokenBudget: true,
    });
    expect(PAIR_PATTERN.seats.map((seat) => seat.key)).toEqual([DRAFTER_SEAT, CRITIC_SEAT]);
    expect(PAIR_PATTERN.seats[0]?.roles).toEqual(['architect', 'implementer']);
    expect(PAIR_PATTERN.seats[1]?.roles).toEqual(['skeptic']);
  });

  it('orders the card critic-first, which is not the launch order (§6.2)', () => {
    expect(cardSeatOrder('pair')).toEqual([CRITIC_SEAT, DRAFTER_SEAT]);
    expect(PAIR_PATTERN.seats.map((seat) => seat.key)).not.toEqual(cardSeatOrder('pair'));
  });
});

describe('solo has no driver, and that is the abstraction working (M5-6)', () => {
  it('plans nothing, ever — not even for a first turn', () => {
    expect(SOLO_PATTERN.plan(state([]))).toEqual({ wait: true, reason: 'no_driver' });
    expect(SOLO_PATTERN.plan(state([turn({ seat: 'solo', status: 'reported' })]))).toEqual({
      wait: true,
      reason: 'no_driver',
    });
  });
});

describe('pair.validate (M6-1)', () => {
  it('refuses a pair with no skeptic and a pair with no drafter, naming the seat', () => {
    expect(PAIR_PATTERN.validate({}, [MEMBERS[0] as StateMember])[0]).toMatchObject({
      level: 'error',
      code: 'seat_unfilled',
    });
    expect(PAIR_PATTERN.validate({}, [MEMBERS[1] as StateMember])[0]).toMatchObject({
      code: 'seat_unfilled',
    });
    expect(PAIR_PATTERN.validate({}, MEMBERS)).toEqual([]);
  });

  it('refuses a convergence rule this build does not ship', () => {
    expect(PAIR_PATTERN.validate({ convergence: 'both-agree' }, MEMBERS)).toEqual([
      expect.objectContaining({ code: 'unsupported_convergence' }),
    ]);
    expect(PAIR_PATTERN.validate({ convergence: 'critic-accepts' }, MEMBERS)).toEqual([]);
  });

  it('maps members onto seats by role, in seat order', () => {
    expect(seatsOf(MEMBERS)).toEqual({ drafter: MEMBERS[0], critic: MEMBERS[1] });
    // An implementer may hold the drafting seat too (§3.3's "architect **or**
    // implementer").
    expect(
      seatsOf([
        { agentId: 'ivy', role: 'implementer', seatOrder: 0 },
        { agentId: 'sam', role: 'skeptic', seatOrder: 1 },
      ]).drafter?.agentId,
    ).toBe('ivy');
  });
});

describe('§3.3’s turn table, row by row (M6-2)', () => {
  it('no turns → round 1, drafter, a fresh session', () => {
    expect(plan([])).toEqual({
      seat: DRAFTER_SEAT,
      agentId: 'ada',
      round: 1,
      prompt: { intent: 'draft', seat: DRAFTER_SEAT, round: 1 },
      priority: 'normal',
    });
  });

  it('drafter reported → the critic, same round, carrying the headline and the artifact', () => {
    const drafted = turn({
      seat: DRAFTER_SEAT,
      status: 'reported',
      report: report({ headline: 'Draft complete: 4 sections' }),
      outputText: 'I wrote four sections.',
      // The hash is what says a file is really there; §3.3 does not spend the
      // critic's turn without it.
      artifactHash: 'h1',
    });
    const next = plan([drafted]);
    expect(next).toMatchObject({
      seat: CRITIC_SEAT,
      agentId: 'sam',
      round: 1,
      prompt: {
        intent: 'critique',
        handoff: { seat: DRAFTER_SEAT, agentId: 'ada', headline: 'Draft complete: 4 sections' },
      },
    });
  });

  it('critic revises → round + 1, drafter, with the blocking issues verbatim', () => {
    const blocking = [{ severity: 'high', summary: 'No rollback path for step 3' }];
    const turns = [
      turn({ seat: DRAFTER_SEAT, status: 'reported', report: report() }),
      turn({
        seat: CRITIC_SEAT,
        status: 'reported',
        report: report({ verdict: verdict({ decision: 'revise', blocking }) }),
      }),
    ];
    expect(plan(turns)).toMatchObject({
      seat: DRAFTER_SEAT,
      round: 2,
      prompt: { intent: 'revise', blocking },
    });
  });

  it('a seat’s second turn continues its own previous session (§3.2)', () => {
    const turns = [
      turn({
        seat: DRAFTER_SEAT,
        status: 'reported',
        report: report(),
        sessionId: 'draft-1',
        artifactHash: 'h1',
      }),
      turn({
        seat: CRITIC_SEAT,
        status: 'reported',
        sessionId: 'critic-1',
        report: report({ verdict: verdict({ decision: 'revise' }) }),
      }),
    ];
    // Round 2's drafter turn resumes `draft-1`, not `critic-1`: a continuation is
    // per seat, which is what makes the skeptic remember its own prior critique.
    expect(plan(turns)).toMatchObject({ continueFromSessionId: 'draft-1' });

    const round2 = [
      ...turns,
      turn({
        seat: DRAFTER_SEAT,
        round: 2,
        status: 'reported',
        report: report(),
        sessionId: 'draft-2',
        artifactHash: 'h2',
      }),
    ];
    expect(plan(round2)).toMatchObject({ seat: CRITIC_SEAT, continueFromSessionId: 'critic-1' });
  });

  it('a turn already in flight is a wait, not a second plan', () => {
    expect(plan([turn({ seat: DRAFTER_SEAT, status: 'running' })])).toEqual({
      wait: true,
      reason: 'turn_in_flight',
    });
    expect(plan([turn({ seat: DRAFTER_SEAT, status: 'planned' })])).toEqual({
      wait: true,
      reason: 'turn_in_flight',
    });
  });
});

describe('convergence: the LLM proposes, the rule decides (M6-3)', () => {
  const accepted = (over: Partial<TurnVerdict>): TurnRow =>
    turn({
      seat: CRITIC_SEAT,
      status: 'reported',
      report: report({ verdict: verdict({ decision: 'accept', ...over }) }),
    });

  it('converges on accept with an empty blocking list', () => {
    const turns = [
      turn({ seat: DRAFTER_SEAT, status: 'reported', report: report() }),
      accepted({}),
    ];
    expect(plan(turns)).toMatchObject({ done: true, closeReason: 'converged' });
    expect(isConverged(turns[1] as TurnRow)).toBe(true);
  });

  it('does NOT converge on "accept" carrying blocking issues — the words lose to the structure', () => {
    const critic = accepted({
      blocking: [{ severity: 'high', summary: 'still no rollback path' }],
    });
    const turns = [turn({ seat: DRAFTER_SEAT, status: 'reported', report: report() }), critic];
    expect(isConverged(critic)).toBe(false);
    expect(plan(turns)).toMatchObject({
      seat: DRAFTER_SEAT,
      round: 2,
      prompt: { intent: 'revise' },
    });
  });

  it('does not converge on a critic turn with no verdict at all', () => {
    const critic = turn({ seat: CRITIC_SEAT, status: 'reported', report: report() });
    expect(isConverged(critic)).toBe(false);
  });

  it('terminates round_cap when another round would exceed the cap', () => {
    const turns = [
      turn({ seat: DRAFTER_SEAT, round: 3, status: 'reported', report: report() }),
      turn({
        seat: CRITIC_SEAT,
        round: 3,
        status: 'reported',
        report: report({ verdict: verdict({ decision: 'revise' }) }),
      }),
    ];
    expect(plan(turns, { roundCap: 3 })).toMatchObject({ done: true, closeReason: 'round_cap' });
    // Raise the cap and the same state plans another round instead — which is
    // what the card's "run one more round" option does.
    expect(plan(turns, { roundCap: 4 })).toMatchObject({ seat: DRAFTER_SEAT, round: 4 });
  });

  it('an assignment with no cap never terminates for the cap', () => {
    const turns = [
      turn({ seat: DRAFTER_SEAT, round: 9, status: 'reported', report: report() }),
      turn({
        seat: CRITIC_SEAT,
        round: 9,
        status: 'reported',
        report: report({ verdict: verdict({ decision: 'revise' }) }),
      }),
    ];
    expect(plan(turns, { roundCap: null })).toMatchObject({ round: 10 });
  });
});

describe('no critic turn without an artifact (§3.3, §8.1 `no_artifact`)', () => {
  const reportedWithNothing = (over: Partial<TurnRow> = {}): TurnRow =>
    turn({
      seat: DRAFTER_SEAT,
      status: 'reported',
      report: report({ headline: 'Draft complete' }),
      artifactHash: null,
      ...over,
    });

  it('re-plans the drafter, not the critic, when the report left no file behind', () => {
    const drafted = reportedWithNothing({ sessionId: 'draft-1' });
    expect(plan([drafted])).toEqual({
      seat: DRAFTER_SEAT,
      agentId: 'ada',
      round: 1,
      prompt: {
        intent: 'artifact_missing',
        seat: DRAFTER_SEAT,
        round: 1,
        retryOfTurnId: drafted.id,
      },
      // The seat resumes its own session; it already holds the draft.
      continueFromSessionId: 'draft-1',
      priority: 'normal',
    });
  });

  it('halts no_artifact on the second miss of the same round, rather than falling through', () => {
    const turns = [reportedWithNothing(), reportedWithNothing()];
    expect(plan(turns)).toEqual({ halt: true, haltReason: 'no_artifact' });
  });

  it('counts per round: a round that missed once does not condemn the next one', () => {
    const turns = [
      reportedWithNothing(),
      turn({ seat: DRAFTER_SEAT, status: 'reported', report: report(), artifactHash: 'h1' }),
      turn({
        seat: CRITIC_SEAT,
        status: 'reported',
        report: report({ verdict: verdict({ decision: 'revise' }) }),
      }),
      reportedWithNothing({ round: 2 }),
    ];
    // Round 2's first miss is round 2's first miss, so it gets its own re-plan.
    expect(plan(turns)).toMatchObject({
      seat: DRAFTER_SEAT,
      round: 2,
      prompt: { intent: 'artifact_missing' },
    });
  });

  it('plans the critic exactly as before when the file is really there', () => {
    expect(plan([reportedWithNothing({ artifactHash: 'h1' })])).toMatchObject({
      seat: CRITIC_SEAT,
      round: 1,
      prompt: { intent: 'critique' },
    });
  });

  it('does not guard an assignment with no artifact path, or one that opted out', () => {
    const noPath = plan([reportedWithNothing()], {
      assignment: row({ artifactPath: null }),
    });
    expect(noPath).toMatchObject({ seat: CRITIC_SEAT });

    const optedOut = plan([reportedWithNothing()], {
      assignment: row({ patternConfigJson: '{"requireArtifact":false}' }),
    });
    expect(optedOut).toMatchObject({ seat: CRITIC_SEAT });

    // A config column that does not parse is the empty config, which is the
    // default, which is guard on.
    expect(
      plan([reportedWithNothing()], { assignment: row({ patternConfigJson: 'not json' }) }),
    ).toMatchObject({ prompt: { intent: 'artifact_missing' } });
  });

  it('“Continue anyway” sends the critic in, because the user outranks the counter', () => {
    const turns = [reportedWithNothing(), reportedWithNothing()];
    expect(plan(turns, { resumeRequested: true })).toMatchObject({ seat: CRITIC_SEAT });
  });
});

describe('the breakers §3.3’s table states (M6-2)', () => {
  it('halts no_progress on an unchanged artifact hash while claiming a revision', () => {
    const turns = [
      turn({ seat: DRAFTER_SEAT, status: 'reported', report: report(), artifactHash: 'h1' }),
      turn({
        seat: CRITIC_SEAT,
        status: 'reported',
        report: report({ verdict: verdict({ decision: 'revise' }) }),
      }),
      turn({
        seat: DRAFTER_SEAT,
        round: 2,
        status: 'reported',
        report: report({ headline: 'Revised' }),
        artifactHash: 'h1',
      }),
    ];
    expect(plan(turns)).toEqual({ halt: true, haltReason: 'no_progress' });
  });

  it('does not halt when the hash changed, and cannot halt when there is no hash', () => {
    const base = [
      turn({ seat: DRAFTER_SEAT, status: 'reported', report: report(), artifactHash: 'h1' }),
      turn({
        seat: CRITIC_SEAT,
        status: 'reported',
        report: report({ verdict: verdict({ decision: 'revise' }) }),
      }),
    ];
    expect(
      plan([
        ...base,
        turn({
          seat: DRAFTER_SEAT,
          round: 2,
          status: 'reported',
          report: report(),
          artifactHash: 'h2',
        }),
      ]),
    ).toMatchObject({ seat: CRITIC_SEAT, round: 2 });
    // A null hash can never equal the previous one, so `no_progress` does not
    // fire rather than firing wrongly (`engine.ts`'s `hashArtifact`). The
    // artifact guard is what answers a null hash, and it is a different halt.
    expect(
      plan([
        ...base,
        turn({
          seat: DRAFTER_SEAT,
          round: 2,
          status: 'reported',
          report: report(),
          artifactHash: null,
        }),
      ]),
    ).toMatchObject({ seat: DRAFTER_SEAT, prompt: { intent: 'artifact_missing' } });
  });

  it('re-plans the same seat once for an unstructured turn, then halts no_report', () => {
    const once = [turn({ seat: DRAFTER_SEAT, status: 'unstructured' })];
    const retry = plan(once);
    expect(retry).toMatchObject({
      seat: DRAFTER_SEAT,
      round: 1,
      prompt: { intent: 'retry', retryOfTurnId: (once[0] as TurnRow).id },
    });

    const twice = [...once, turn({ seat: DRAFTER_SEAT, status: 'unstructured' })];
    expect(plan(twice)).toEqual({ halt: true, haltReason: 'no_report' });
  });

  it('halts turn_failures on two consecutive failed turns, and retries after one', () => {
    expect(plan([turn({ seat: DRAFTER_SEAT, status: 'failed' })])).toMatchObject({
      seat: DRAFTER_SEAT,
      prompt: { intent: 'retry' },
    });
    expect(
      plan([
        turn({ seat: DRAFTER_SEAT, status: 'failed' }),
        turn({ seat: DRAFTER_SEAT, status: 'failed' }),
      ]),
    ).toEqual({ halt: true, haltReason: 'turn_failures' });
  });
});

describe('a blocked seat waits for the user, then resumes (§3.3, §4.4)', () => {
  const blocked = (): TurnRow =>
    turn({
      seat: DRAFTER_SEAT,
      status: 'blocked',
      report: report({ state: 'blocked', headline: 'waiting on a decision' }),
      endedAt: '2026-08-16T10:05:00.000Z',
    });

  it('waits while the card is open', () => {
    expect(
      plan([blocked()], {
        openQuestion: { id: 'q1', seat: DRAFTER_SEAT, prompt: 'Disk or DB?' },
      }),
    ).toEqual({ wait: true, reason: 'awaiting_answer' });
  });

  it('re-plans the same seat and round with the answer prepended', () => {
    expect(
      plan([blocked()], {
        openQuestion: {
          id: 'q1',
          seat: DRAFTER_SEAT,
          prompt: 'Disk or DB?',
          answerText: 'disk',
          answeredAt: '2026-08-16T10:06:00.000Z',
        },
      }),
    ).toMatchObject({
      seat: DRAFTER_SEAT,
      round: 1,
      prompt: { intent: 'answered', answer: { question: 'Disk or DB?', text: 'disk' } },
    });
  });

  it('ignores an answer that landed before the seat blocked', () => {
    expect(
      plan([blocked()], {
        openQuestion: {
          id: 'q0',
          seat: DRAFTER_SEAT,
          prompt: 'An older question',
          answerText: 'yes',
          answeredAt: '2026-08-16T09:00:00.000Z',
        },
      }),
    ).toEqual({ wait: true, reason: 'awaiting_answer' });
  });

  // WO1: the wait is only correct while an answer is still possible. When the
  // only answer there is landed *before* the seat blocked and nothing is open,
  // no `question.answered` will ever arrive — the assignment is wedged.
  const staleAnswer = {
    id: 'q0',
    seat: DRAFTER_SEAT,
    prompt: 'An older question',
    answerText: 'yes',
    answeredAt: '2026-08-16T09:00:00.000Z',
  };

  it('re-plans the seat when the answer is stale and no card is open', () => {
    const first = blocked();
    expect(plan([first], { openQuestion: staleAnswer, hasOpenQuestion: false })).toMatchObject({
      seat: DRAFTER_SEAT,
      round: 1,
      prompt: { intent: 'retry', retryOfTurnId: first.id },
    });
  });

  it('re-plans a seat that blocked without ever raising a card', () => {
    const first = blocked();
    expect(plan([first], { hasOpenQuestion: false })).toMatchObject({
      seat: DRAFTER_SEAT,
      round: 1,
      prompt: { intent: 'retry', retryOfTurnId: first.id },
    });
  });

  it('still waits while a card is open, however stale the last answer is', () => {
    expect(plan([blocked()], { openQuestion: staleAnswer, hasOpenQuestion: true })).toEqual({
      wait: true,
      reason: 'awaiting_answer',
    });
  });

  it('retries a blocked seat once per round, then waits rather than spinning', () => {
    expect(
      plan([blocked(), blocked()], { openQuestion: staleAnswer, hasOpenQuestion: false }),
    ).toEqual({ wait: true, reason: 'awaiting_answer' });
  });

  it('keeps waiting when the build cannot see the inbox at all', () => {
    // `hasOpenQuestion: undefined` is "this build could not tell". A state that
    // cannot read the inbox must not conclude that nothing is in it.
    expect(plan([blocked()], { openQuestion: staleAnswer })).toEqual({
      wait: true,
      reason: 'awaiting_answer',
    });
  });
});

// ---------------------------------------------------------------------------
// `overseer` — §3.5, M10
// ---------------------------------------------------------------------------

const IRIS: StateMember = { agentId: 'iris', role: 'overseer', seatOrder: 0 };

function child(overrides: Partial<ChildState> & { id: string }): ChildState {
  return {
    goal: 'Draft the migration plan',
    pattern: 'pair',
    status: 'closed',
    phase: 'converged',
    closeReason: 'converged',
    haltReason: null,
    artifactPath: 'docs/billing/plan.md',
    tokenBudget: 100_000,
    tokensUsed: 40_000,
    closedAt: '2026-08-16T11:00:00.000Z',
    members: [{ agentId: 'ada', role: 'architect' }],
    report: report({ headline: 'Plan written' }),
    ...overrides,
  };
}

function leadState(
  turns: readonly TurnRow[],
  overrides: Partial<AssignmentState> = {},
): AssignmentState {
  return state(turns, {
    assignment: row({ pattern: 'overseer', leadAgentId: 'iris', artifactPath: null }),
    members: [IRIS],
    scope: null,
    ...overrides,
  });
}

function leadPlan(turns: readonly TurnRow[], overrides: Partial<AssignmentState> = {}): PlanResult {
  return OVERSEER_PATTERN.plan(leadState(turns, overrides));
}

/** A lead turn. The overseer has one seat, so every turn is that seat's. */
function leadTurn(overrides: Partial<TurnRow> & { status: TurnStatus }): TurnRow {
  return turn({ seat: LEAD_SEAT, agentId: 'iris', ...overrides });
}

describe('the overseer pattern’s shape (M10-1, §3.5)', () => {
  it('has one seat, only an overseer may fill it, and it writes nothing itself', () => {
    expect(OVERSEER_PATTERN.seats).toEqual([
      { key: LEAD_SEAT, roles: ['overseer'], required: true, preferredTier: 'max', write: false },
    ]);
    expect(cardSeatOrder('overseer')).toEqual([LEAD_SEAT]);
  });

  it('requires a budget and a round cap, and no artifact of its own', () => {
    // The artifacts belong to the children; demanding one here would make the
    // lead write a file to prove it coordinated (§3.5).
    expect(OVERSEER_PATTERN.requires).toEqual({ roundCap: true, tokenBudget: true });
  });

  it('refuses an empty lead seat, and a second seat the pattern does not have', () => {
    expect(OVERSEER_PATTERN.validate({}, [])).toEqual([
      expect.objectContaining({ level: 'error', code: 'seat_unfilled' }),
    ]);
    expect(
      OVERSEER_PATTERN.validate({}, [IRIS, { agentId: 'sam', role: 'skeptic', seatOrder: 1 }]).map(
        (diagnostic) => diagnostic.code,
      ),
    ).toEqual(['seat_not_in_pattern']);
    expect(OVERSEER_PATTERN.validate({}, [IRIS])).toEqual([]);
  });

  it('finds the lead by role, and falls back to the first seat (owner decision 2026-08-18)', () => {
    expect(leadOf([{ agentId: 'ada', role: 'architect', seatOrder: 1 }, IRIS])).toEqual(IRIS);
    // Roles are ranking hints, so an implementer the user seated as the lead
    // *is* the lead — answering `undefined` here would be a capability gate
    // wearing a state machine's clothes.
    const seated: StateMember = { agentId: 'ada', role: 'architect', seatOrder: 0 };
    expect(leadOf([seated])).toEqual(seated);
    expect(leadOf([])).toBeUndefined();
  });

  it('warns, and does not error, when the lead seat is held by another role', () => {
    const seated: StateMember = { agentId: 'ada', role: 'architect', seatOrder: 0 };
    expect(OVERSEER_PATTERN.validate({}, [seated])).toEqual([
      expect.objectContaining({ level: 'warn', code: 'lead_not_overseer' }),
    ]);
    expect(OVERSEER_PATTERN.plan(leadState([], { members: [seated] }))).toMatchObject({
      seat: LEAD_SEAT,
      agentId: 'ada',
      prompt: { intent: 'decompose' },
    });
  });
});

describe('the overseer’s cadence (M10-2, §3.5)', () => {
  it('opens with the lead decomposing the goal', () => {
    expect(leadPlan([])).toEqual({
      seat: LEAD_SEAT,
      agentId: 'iris',
      round: 1,
      prompt: { intent: 'decompose', seat: LEAD_SEAT, round: 1 },
      priority: 'normal',
    });
  });

  it('waits while any child is still open — including a halted one', () => {
    const decomposed = [leadTurn({ status: 'reported', report: report() })];
    expect(
      leadPlan(decomposed, { children: [child({ id: 'c1', status: 'open', phase: 'running' })] }),
    ).toEqual({ wait: true, reason: 'children_running' });
    // A halted child is still `open`, and its own card is already in the inbox.
    expect(
      leadPlan(decomposed, {
        children: [child({ id: 'c1', status: 'open', phase: 'halted', haltReason: 'no_report' })],
      }),
    ).toEqual({ wait: true, reason: 'children_running' });
  });

  it('plans a review round carrying every child that finished, and continues the lead’s session', () => {
    const decomposed = [leadTurn({ status: 'reported', report: report(), sessionId: 'lead-1' })];
    const finished = child({ id: 'c1' });
    const next = leadPlan(decomposed, { children: [finished] });
    expect(next).toMatchObject({
      seat: LEAD_SEAT,
      agentId: 'iris',
      round: 2,
      prompt: { intent: 'review', children: [finished] },
      continueFromSessionId: 'lead-1',
    });
  });

  it('never re-presents a child an earlier review already looked at', () => {
    const turns = [
      leadTurn({ status: 'reported', report: report(), startedAt: '2026-08-16T10:00:00.000Z' }),
      leadTurn({
        round: 2,
        status: 'reported',
        report: report({ verdict: verdict({ decision: 'revise' }) }),
        startedAt: '2026-08-16T12:00:00.000Z',
      }),
    ];
    // Closed at 11:00 — before the round-2 review started, so it was in that
    // prompt and has been judged.
    const reviewed = child({ id: 'c1', closedAt: '2026-08-16T11:00:00.000Z' });
    const fresh = child({ id: 'c2', closedAt: '2026-08-16T13:00:00.000Z' });

    expect(childrenAwaitingReview(leadState(turns, { children: [reviewed] }))).toEqual([]);
    expect(childrenAwaitingReview(leadState(turns, { children: [reviewed, fresh] }))).toEqual([
      fresh,
    ]);
    expect(leadPlan(turns, { children: [reviewed, fresh] })).toMatchObject({
      round: 3,
      prompt: { intent: 'review', children: [fresh] },
    });
  });

  it('re-presents the same children when a review turn failed rather than skipping them', () => {
    const fresh = child({ id: 'c1', closedAt: '2026-08-16T11:00:00.000Z' });
    const turns = [
      leadTurn({ status: 'reported', report: report(), startedAt: '2026-08-16T10:00:00.000Z' }),
      leadTurn({ round: 2, status: 'failed', startedAt: '2026-08-16T12:00:00.000Z' }),
    ];
    expect(leadPlan(turns, { children: [fresh] })).toMatchObject({
      round: 2,
      prompt: { intent: 'retry', children: [fresh] },
    });
  });

  it('converges only on an accept with an empty blocking list', () => {
    const accepted = [
      leadTurn({ status: 'reported', report: report(), startedAt: '2026-08-16T10:00:00.000Z' }),
      leadTurn({
        round: 2,
        status: 'reported',
        startedAt: '2026-08-16T12:00:00.000Z',
        report: report({ verdict: verdict({ decision: 'accept' }) }),
      }),
    ];
    const reviewed = child({ id: 'c1', closedAt: '2026-08-16T11:00:00.000Z' });
    expect(leadPlan(accepted, { children: [reviewed] })).toMatchObject({
      done: true,
      closeReason: 'converged',
    });
  });

  it('halts review_unresolved when the lead asks for revisions it did not delegate', () => {
    const turns = [
      leadTurn({ status: 'reported', report: report(), startedAt: '2026-08-16T10:00:00.000Z' }),
      leadTurn({
        round: 2,
        status: 'reported',
        startedAt: '2026-08-16T12:00:00.000Z',
        report: report({
          verdict: verdict({
            decision: 'revise',
            blocking: [{ severity: 'high', summary: 'c1 never wrote the rollback section' }],
          }),
        }),
      }),
    ];
    const reviewed = child({ id: 'c1', closedAt: '2026-08-16T11:00:00.000Z' });
    expect(leadPlan(turns, { children: [reviewed] })).toEqual({
      halt: true,
      haltReason: 'review_unresolved',
    });
    // "Continue anyway" is one more review round, bounded by the same cap.
    expect(leadPlan(turns, { children: [reviewed], resumeRequested: true })).toMatchObject({
      round: 3,
      prompt: { intent: 'review', children: [] },
    });
    expect(leadPlan(turns, { children: [reviewed], resumeRequested: true, roundCap: 2 })).toEqual({
      halt: true,
      haltReason: 'review_unresolved',
    });
  });

  it('halts review_unresolved when the lead reports no verdict at all', () => {
    const turns = [leadTurn({ status: 'reported', report: report() })];
    // Round 1 reported, nothing was delegated, and no structured decision was
    // made: the engine has nothing to converge on and nothing to wait for.
    expect(leadPlan(turns, { children: [] })).toEqual({
      halt: true,
      haltReason: 'review_unresolved',
    });
  });

  it('terminates round_cap when another review round would exceed the cap', () => {
    const turns = [
      leadTurn({ status: 'reported', report: report(), startedAt: '2026-08-16T10:00:00.000Z' }),
      leadTurn({
        round: 2,
        status: 'reported',
        startedAt: '2026-08-16T11:00:00.000Z',
        report: report({ verdict: verdict({ decision: 'revise' }) }),
      }),
    ];
    const fresh = child({ id: 'c2', closedAt: '2026-08-16T12:00:00.000Z' });
    expect(leadPlan(turns, { children: [fresh], roundCap: 2 })).toMatchObject({
      done: true,
      closeReason: 'round_cap',
    });
    expect(leadPlan(turns, { children: [fresh], roundCap: 3 })).toMatchObject({ round: 3 });
  });

  it('waits for an answer when the lead blocked, exactly as a pair seat does', () => {
    const blocked = leadTurn({
      status: 'blocked',
      report: report({ state: 'blocked', headline: 'waiting' }),
    });
    expect(leadPlan([blocked])).toEqual({ wait: true, reason: 'awaiting_answer' });
    expect(
      leadPlan([blocked], {
        openQuestion: {
          id: 'q1',
          seat: LEAD_SEAT,
          prompt: 'Split it in two or three?',
          answerText: 'two',
          answeredAt: '2026-08-16T10:06:00.000Z',
        },
      }),
    ).toMatchObject({ prompt: { intent: 'answered', answer: { text: 'two' } } });
  });
});

describe('a child solo is driven as exactly one turn (M10-3, §3.5)', () => {
  const worker: StateMember = { agentId: 'ada', role: 'implementer', seatOrder: 0 };

  function childState(turns: readonly TurnRow[]): AssignmentState {
    return state(turns, {
      assignment: row({ pattern: 'solo', parentAssignmentId: 'parent-1' }),
      members: [worker],
    });
  }

  it('launches its one turn, then waits while it runs', () => {
    expect(planChildSolo(childState([]))).toEqual({
      seat: SOLO_SEAT,
      agentId: 'ada',
      round: 1,
      prompt: { intent: 'work', seat: SOLO_SEAT, round: 1 },
      priority: 'normal',
    });
    expect(planChildSolo(childState([turn({ seat: SOLO_SEAT, status: 'running' })]))).toEqual({
      wait: true,
      reason: 'turn_in_flight',
    });
  });

  it('closes converged on a reported turn, so the parent has something to review', () => {
    expect(
      planChildSolo(
        childState([
          turn({ seat: SOLO_SEAT, status: 'reported', report: report({ headline: 'Done' }) }),
        ]),
      ),
    ).toMatchObject({ done: true, closeReason: 'converged', summary: 'Done' });
  });

  it('closes failed rather than halting, because a halted child wedges its parent', () => {
    const unstructured = [
      turn({ seat: SOLO_SEAT, status: 'unstructured' }),
      turn({ seat: SOLO_SEAT, status: 'unstructured' }),
    ];
    expect(planChildSolo(childState(unstructured))).toMatchObject({
      done: true,
      closeReason: 'failed',
    });
    // One unreported turn is still retried once, exactly as a pair seat is.
    expect(planChildSolo(childState(unstructured.slice(0, 1)))).toMatchObject({
      prompt: { intent: 'retry' },
    });

    const failed = [
      turn({ seat: SOLO_SEAT, status: 'failed' }),
      turn({ seat: SOLO_SEAT, status: 'failed' }),
    ];
    expect(planChildSolo(childState(failed))).toMatchObject({ done: true, closeReason: 'failed' });
  });
});

describe('purity', () => {
  it('never mutates the state it is given, and answers the same twice', () => {
    const turns = [turn({ seat: DRAFTER_SEAT, status: 'reported', report: report() })];
    const input = state(turns);
    const snapshot = JSON.stringify(input);
    const first = PAIR_PATTERN.plan(input);
    const second = PAIR_PATTERN.plan(input);
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(first).toEqual(second);
  });

  it('waits rather than guessing when a seat is unfilled', () => {
    expect(plan([], { members: [] })).toEqual({ wait: true, reason: 'no_members' });
  });
});
