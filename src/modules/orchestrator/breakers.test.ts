/**
 * IMPLEMENTATION M7 — the eight circuit breakers and the five approval gates.
 *
 * Two halves, matching `breakers.ts`'s ownership table. The counters are pure
 * and are tested as functions, one case per breaker, with no database at all —
 * which is what "deterministic counters over persisted state" buys. The
 * *actions* are tested through the engine, because a halt is three facts at once
 * (a phase, a card and an event) and a table of rows cannot show that.
 *
 * `engine.test.ts` already trips `no_report`, `turn_failures` and `no_progress`
 * end to end; those are named here against the counters they now share, so a
 * change to one implementation cannot pass by only being tested in the other.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  artifactMissingTurns,
  artifactUnchanged,
  BREAKER_NAMES,
  consecutiveDenialTurns,
  consecutiveFailures,
  denialBreaker,
  evaluateBreakers,
  maxDenialsPerSession,
  roundsWouldExceedCap,
  staleSinceMs,
  unstructuredForSeat,
} from './breakers.js';
import { ORCHESTRATOR_CONFIG_DEFAULTS } from './config.js';
import { GATE_CARD_PREFIX } from './cards.js';
import { HALT_CARD_PREFIX } from './engine.js';
import type { TurnRow, TurnStatus } from './turns.js';
import { endSession, flush, makeHarness, PROJECT_ID, type Harness } from './__tests__/helpers.js';

// ---------------------------------------------------------------------------
// The counters (pure)
// ---------------------------------------------------------------------------

let seq = 0;

function turn(overrides: Partial<TurnRow> & { status: TurnStatus }): TurnRow {
  seq += 1;
  return {
    id: `t${String(seq)}`,
    assignmentId: 'a1',
    round: 1,
    seat: 'drafter',
    agentId: 'ada',
    sessionId: `s${String(seq)}`,
    prevSessionId: null,
    report: null,
    outputText: null,
    artifactHash: null,
    startedAt: '2026-08-16T10:00:00.000Z',
    endedAt: '2026-08-16T10:01:00.000Z',
    permissionDenials: 0,
    permissionDeniedTools: null,
    exitReason: null,
    retryOfTurnId: null,
    ...overrides,
  };
}

describe('the counters are pure and re-derived (§8.1, M7-1)', () => {
  it('names all nine breakers', () => {
    expect([...BREAKER_NAMES]).toEqual([
      'budget',
      'round_cap',
      'turn_failures',
      'unstructured',
      'no_progress',
      'no_artifact',
      'tool_denials',
      'tool_flood',
      'stale',
    ]);
  });

  it('counts only the trailing run of failures, so an old failure cannot halt a live run', () => {
    expect(
      consecutiveFailures([
        turn({ status: 'failed' }),
        turn({ status: 'reported' }),
        turn({ status: 'failed' }),
      ]),
    ).toBe(1);
    expect(consecutiveFailures([turn({ status: 'failed' }), turn({ status: 'failed' })])).toBe(2);
  });

  it('counts unreported turns per seat, never across seats', () => {
    const rows = [
      turn({ status: 'unstructured', seat: 'drafter' }),
      turn({ status: 'unstructured', seat: 'critic' }),
    ];
    expect(unstructuredForSeat(rows, 'drafter')).toBe(1);
    expect(unstructuredForSeat(rows, 'critic')).toBe(1);
  });

  it('never reads two unknown artifact hashes as unchanged', () => {
    const a = turn({ status: 'reported', artifactHash: null });
    const b = turn({ status: 'reported', artifactHash: null });
    expect(artifactUnchanged(a, b)).toBe(false);

    const same = turn({ status: 'reported', artifactHash: 'abc' });
    expect(artifactUnchanged(same, turn({ status: 'reported', artifactHash: 'abc' }))).toBe(true);
    expect(artifactUnchanged(same, turn({ status: 'reported', artifactHash: 'def' }))).toBe(false);
  });

  it('counts only reported, hash-less turns of the seat and round it was asked about', () => {
    const turns = [
      // The round the counter is about: two reports with nothing on disk.
      turn({ seat: 'drafter', round: 1, status: 'reported', artifactHash: null }),
      turn({ seat: 'drafter', round: 1, status: 'reported', artifactHash: null }),
      // A turn that did leave a file, one that never reported, and the critic —
      // none of them is evidence that the drafter wrote nothing.
      turn({ seat: 'drafter', round: 1, status: 'reported', artifactHash: 'abc' }),
      turn({ seat: 'drafter', round: 1, status: 'unstructured', artifactHash: null }),
      turn({ seat: 'critic', round: 1, status: 'reported', artifactHash: null }),
      // Another round entirely: the guard is per drafting attempt.
      turn({ seat: 'drafter', round: 2, status: 'reported', artifactHash: null }),
    ];
    expect(artifactMissingTurns(turns, 'drafter', 1)).toBe(2);
    expect(artifactMissingTurns(turns, 'drafter', 2)).toBe(1);
    expect(artifactMissingTurns(turns, 'critic', 1)).toBe(1);
    expect(artifactMissingTurns([], 'drafter', 1)).toBe(0);
  });

  it('bounds the round cap and treats a null cap as unbounded', () => {
    expect(roundsWouldExceedCap(4, 3)).toBe(true);
    expect(roundsWouldExceedCap(3, 3)).toBe(false);
    expect(roundsWouldExceedCap(99, null)).toBe(false);
  });

  it('reads denials both ways §8.1 states them', () => {
    const config = ORCHESTRATOR_CONFIG_DEFAULTS;
    expect(maxDenialsPerSession([turn({ status: 'reported', permissionDenials: 5 })])).toBe(5);
    expect(
      denialBreaker([turn({ status: 'reported', permissionDenials: 5 })], config),
    ).toMatchObject({ breaker: 'tool_denials', haltReason: 'permission_fight' });

    const trickle = [
      turn({ status: 'reported', permissionDenials: 1 }),
      turn({ status: 'reported', permissionDenials: 1 }),
      turn({ status: 'reported', permissionDenials: 1 }),
    ];
    expect(consecutiveDenialTurns(trickle)).toBe(3);
    expect(denialBreaker(trickle, config)?.breaker).toBe('tool_denials');

    // Two turns with denials is a bad afternoon, not a configuration bug.
    expect(denialBreaker(trickle.slice(0, 2), config)).toBeUndefined();
  });

  it('measures staleness from the last turn transition, and from creation when there is none', () => {
    const nowMs = new Date('2026-08-17T10:00:00.000Z').getTime();
    const assignment = {
      updatedAt: '2026-08-16T09:00:00.000Z',
      createdAt: '2026-08-16T08:00:00.000Z',
    };
    expect(staleSinceMs(assignment, [], nowMs)).toBe(25 * 3_600_000);
    expect(
      staleSinceMs(
        assignment,
        [turn({ status: 'reported', endedAt: '2026-08-17T09:00:00.000Z' })],
        nowMs,
      ),
    ).toBe(3_600_000);
  });

  it('never trips anything but the budget once the user asked to continue', () => {
    const config = ORCHESTRATOR_CONFIG_DEFAULTS;
    const turns = [turn({ status: 'reported', permissionDenials: 9 })];
    const assignment = {
      tokenBudget: null,
      tokensUsed: 0,
      updatedAt: null,
      createdAt: '2026-08-16T10:00:00.000Z',
    };

    expect(evaluateBreakers({ assignment, turns, config, nowMs: 0 })?.breaker).toBe('tool_denials');
    expect(
      evaluateBreakers({ assignment, turns, config, nowMs: 0, resumeRequested: true }),
    ).toBeUndefined();

    // …but a budget crossing is not something "continue anyway" can wave past.
    expect(
      evaluateBreakers({
        assignment: { ...assignment, tokenBudget: 100, tokensUsed: 100 },
        turns,
        config,
        nowMs: 0,
        resumeRequested: true,
      })?.breaker,
    ).toBe('budget');
  });
});

// ---------------------------------------------------------------------------
// The actions (through the engine)
// ---------------------------------------------------------------------------

const AGENTS = [
  { id: 'ada', roles: ['architect' as const] },
  { id: 'sam', roles: ['skeptic' as const] },
  { id: 'iris', roles: ['overseer' as const], overseer: true },
];

let harness: Harness;

beforeEach(() => {
  harness = makeHarness({ agents: AGENTS });
});

afterEach(() => {
  harness.cleanup();
});

async function makePair(write = true): Promise<string> {
  const created = await harness.service.createAssignment({
    projectId: PROJECT_ID,
    pattern: 'pair',
    goal: 'Write docs/x/DESIGN.md',
    members: [
      { agentId: 'ada', role: 'architect' },
      { agentId: 'sam', role: 'skeptic' },
    ],
    scope: { paths: ['docs/x/'], artifactPath: 'docs/x/DESIGN.md' },
    write,
  });
  await flush();
  return created.assignmentId;
}

function haltCards(assignmentId: string, haltReason: string): readonly { id: string }[] {
  return harness.inbox
    .list({ assignmentId })
    .filter((card) => card.context?.toolName === `${HALT_CARD_PREFIX}${haltReason}`);
}

describe('tool_denials halts, exactly once (§8.1, M7-1/M7-2)', () => {
  it('halts permission_fight, raises one card, emits one event and plans no further turn', async () => {
    const assignmentId = await makePair();
    const active = harness.turns.active(assignmentId);

    // Runner's own number, arriving where it always arrives.
    await endSession(harness, active?.sessionId ?? '', {
      status: 'done',
      permissionDenials: 5,
      summary: 'kept hitting a wall',
    });

    const row = harness.repository.get(assignmentId);
    expect(row?.phase).toBe('halted');
    expect(row?.haltReason).toBe('permission_fight');
    expect(haltCards(assignmentId, 'permission_fight')).toHaveLength(1);
    expect(harness.events.filter((event) => event.type === 'assignment.halted')).toHaveLength(1);

    // The count is on the turn row, so a restart re-derives it rather than
    // losing it.
    expect(harness.turns.list(assignmentId).at(-1)?.permissionDenials).toBe(5);

    const before = harness.turns.list(assignmentId).length;
    await harness.engine.advance(assignmentId);
    expect(harness.turns.list(assignmentId)).toHaveLength(before);

    // Advancing again does not accumulate a second identical card.
    await harness.engine.advance(assignmentId);
    expect(haltCards(assignmentId, 'permission_fight')).toHaveLength(1);
  });

  it('does not kill the running session (§8.1: only tool_flood does)', async () => {
    const assignmentId = await makePair();
    const active = harness.turns.active(assignmentId);
    await endSession(harness, active?.sessionId ?? '', { status: 'done', permissionDenials: 6 });

    expect(harness.repository.get(assignmentId)?.phase).toBe('halted');
    expect(harness.runner.stopped).toEqual([]);
  });
});

describe('tool_flood halts AND stops the session (§8.1, §4.2)', () => {
  it('refuses the call, stops the flooded session and halts', async () => {
    harness.cleanup();
    harness = makeHarness({
      agents: AGENTS,
      config: {
        breakers: {
          denialsPerSession: 5,
          consecutiveFailures: 2,
          identicalTurns: 2,
          messagesPerTurn: 1,
          maxAssignmentsPerSession: 5,
          maxDecisionsPerSession: 3,
        },
      },
    });
    const assignmentId = await makePair();
    const sessionId = harness.turns.active(assignmentId)?.sessionId ?? '';
    const tools = harness.toolset({ assignmentId, agentId: 'ada', sessionId });

    const first = await tools.call('send_to_agent', { to: 'sam', kind: 'note', body: 'one' });
    expect(first.isError).toBeUndefined();
    const second = await tools.call('send_to_agent', { to: 'sam', kind: 'note', body: 'two' });
    expect(second.isError).toBe(true);
    await flush();

    expect(harness.repository.get(assignmentId)?.haltReason).toBe('tool_flood');
    expect(harness.runner.stopped.map((one) => one.sessionId)).toContain(sessionId);
    expect(haltCards(assignmentId, 'tool_flood')).toHaveLength(1);
  });
});

describe('the staleness sweep (§8.1, M7-5)', () => {
  it('halts an assignment nothing has moved for maxAgeHours, and only then', async () => {
    const assignmentId = await makePair();
    // The first turn is in flight, so there is nothing wedged yet.
    expect(await harness.engine.sweepStale()).toEqual([]);

    await endSession(harness, harness.turns.active(assignmentId)?.sessionId ?? '', {
      status: 'done',
      summary: 'no report',
    });
    // A retry is now in flight; end it too, leaving the assignment idle.
    await endSession(harness, harness.turns.active(assignmentId)?.sessionId ?? '', {
      status: 'done',
      summary: 'still no report',
    });

    // It halted `no_report` — which is a *human*'s to answer, so the sweep
    // leaves it alone rather than halting it a second time.
    expect(harness.repository.get(assignmentId)?.phase).toBe('halted');
    harness.advance(48 * 3_600_000);
    expect(await harness.engine.sweepStale()).toEqual([]);
  });

  it('halts a planned assignment that never started (the wedge nothing else notices)', async () => {
    const created = await harness.service.createAssignment({
      projectId: PROJECT_ID,
      pattern: 'pair',
      goal: 'never started',
      members: [
        { agentId: 'ada', role: 'architect' },
        { agentId: 'sam', role: 'skeptic' },
      ],
      scope: { paths: ['docs/y/'], artifactPath: 'docs/y/DESIGN.md' },
      autoStart: false,
    });
    await flush();

    expect(await harness.engine.sweepStale()).toEqual([]);
    harness.advance(25 * 3_600_000);
    expect(await harness.engine.sweepStale()).toEqual([created.assignmentId]);

    const row = harness.repository.get(created.assignmentId);
    expect(row?.phase).toBe('halted');
    expect(row?.haltReason).toBe('stale');
    expect(haltCards(created.assignmentId, 'stale')).toHaveLength(1);
  });
});

describe('approval gates (§8.2, M7-3)', () => {
  async function overseerChild(write: boolean): Promise<{ parentId: string; childId: string }> {
    const parent = await harness.service.createAssignment({
      projectId: PROJECT_ID,
      pattern: 'solo',
      members: [{ agentId: 'iris', role: 'overseer' }],
      write: false,
      tokenBudget: 500_000,
    });
    const created = await harness.service.createAssignment({
      projectId: PROJECT_ID,
      pattern: 'solo',
      goal: 'child work',
      members: [{ agentId: 'ada', role: 'architect' }],
      scope: { paths: ['docs/z/'] },
      write,
      tokenBudget: 100_000,
      createdBy: 'overseer:iris',
      parentAssignmentId: parent.assignmentId,
      autoStart: true,
    });
    await flush();
    return { parentId: parent.assignmentId, childId: created.assignmentId };
  }

  function gateOf(assignmentId: string): { id: string } {
    const gate = harness.inbox
      .list({ assignmentId, status: 'open' })
      .find((card) => card.context?.toolName?.startsWith(GATE_CARD_PREFIX) === true);
    if (gate === undefined) throw new Error('no gate was raised');
    return gate;
  }

  it('starts no session until the gate is approved (M7 acceptance)', async () => {
    const started = harness.runner.started.length;
    const { childId } = await overseerChild(true);

    expect(harness.repository.get(childId)?.phase).toBe('planned');
    expect(harness.runner.started.length).toBe(started);

    harness.inbox.answer(gateOf(childId).id, { optionIds: ['approve'], answeredVia: 'local' });
    await flush();
    expect(harness.repository.get(childId)?.phase).not.toBe('planned');
  });

  it('closes the assignment gate_denied when it is denied', async () => {
    const { childId } = await overseerChild(true);
    harness.inbox.answer(gateOf(childId).id, { optionIds: ['deny'], answeredVia: 'remote' });
    await flush();

    expect(harness.service.get(childId).status).toBe('closed');
    expect(harness.service.get(childId).closeReason).toBe('gate_denied');
  });

  it('closes it gate_expired when it is left to expire — expiry is denial', async () => {
    const { childId } = await overseerChild(true);
    harness.advance(25 * 3_600_000);
    harness.inbox.sweepExpired();
    await flush();

    expect(harness.service.get(childId).closeReason).toBe('gate_expired');
  });

  it('raises no gate for a read-only machine-created assignment', async () => {
    const { childId } = await overseerChild(false);
    expect(
      harness.inbox
        .list({ assignmentId: childId })
        .filter((card) => card.context?.toolName?.startsWith(GATE_CARD_PREFIX) === true),
    ).toEqual([]);
  });
});

describe('scope overlap (§2.6, §8.2-4, M7-4)', () => {
  it('gates two overlapping write-capable assignments and emits the conflict', async () => {
    await makePair(true);
    const second = await harness.service.createAssignment({
      projectId: PROJECT_ID,
      pattern: 'solo',
      goal: 'the second writer',
      members: [{ agentId: 'sam', role: 'skeptic' }],
      scope: { paths: ['docs/x/'] },
      write: true,
    });
    await flush();

    expect(second.warnings.map((warning) => warning.code)).toContain('scope_overlap');
    expect(second.gate?.reason).toContain('overlaps');
    expect(harness.repository.get(second.assignmentId)?.phase).toBe('planned');

    const conflict = harness.events.filter((event) => event.type === 'assignment.conflict');
    expect(conflict).toHaveLength(1);
    expect(conflict[0]?.payload).toMatchObject({ bothWrite: true });
  });

  it('produces nothing at all for two overlapping read-only assignments', async () => {
    await harness.service.createAssignment({
      projectId: PROJECT_ID,
      pattern: 'solo',
      members: [{ agentId: 'ada', role: 'architect' }],
      scope: { paths: ['docs/x/'] },
      write: false,
    });
    const second = await harness.service.createAssignment({
      projectId: PROJECT_ID,
      pattern: 'solo',
      members: [{ agentId: 'sam', role: 'skeptic' }],
      scope: { paths: ['docs/x/'] },
      write: false,
    });
    await flush();

    // "Recorded, no warning. Two readers cannot collide."
    expect(second.warnings.map((warning) => warning.code)).not.toContain('scope_overlap');
    expect(second.gate).toBeUndefined();
    expect(harness.events.filter((event) => event.type === 'assignment.conflict')).toEqual([]);
  });

  it('warns and emits, but does not gate, when only one side can write', async () => {
    await harness.service.createAssignment({
      projectId: PROJECT_ID,
      pattern: 'solo',
      members: [{ agentId: 'ada', role: 'architect' }],
      scope: { paths: ['docs/x/'] },
      write: true,
    });
    const second = await harness.service.createAssignment({
      projectId: PROJECT_ID,
      pattern: 'solo',
      members: [{ agentId: 'sam', role: 'skeptic' }],
      scope: { paths: ['docs/x/'] },
      write: false,
    });
    await flush();

    expect(second.warnings.map((warning) => warning.code)).toContain('scope_overlap');
    expect(second.gate).toBeUndefined();
    expect(harness.events.filter((event) => event.type === 'assignment.conflict')).toHaveLength(1);
  });

  it('gates on projects’ own overlap report too (§2.6 source 2)', async () => {
    const first = await makePair(true);
    const second = await harness.service.createAssignment({
      projectId: PROJECT_ID,
      pattern: 'solo',
      members: [{ agentId: 'iris', role: 'overseer' }],
      // A different path, so the creation-time scan finds nothing…
      scope: { paths: ['src/'] },
      write: true,
    });
    await flush();
    expect(second.gate).toBeUndefined();

    // …until projects reports that both landed in one workspace.
    harness.bus.emit({
      type: 'project.scope.overlap',
      ids: { assignmentId: second.assignmentId, projectId: PROJECT_ID },
      persist: true,
      payload: { otherAssignmentId: first, paths: ['docs/x/'] },
    });
    await flush();

    expect(harness.repository.get(second.assignmentId)?.phase).toBe('planned');
    const conflict = harness.events.filter((event) => event.type === 'assignment.conflict');
    expect(conflict.at(-1)?.payload).toMatchObject({ bothWrite: true, otherAssignmentId: first });
  });
});
