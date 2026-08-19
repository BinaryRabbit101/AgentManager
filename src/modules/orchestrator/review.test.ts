/**
 * §3.6's `review` pattern — implementer ↔ reviewer over real changes (WO5).
 *
 * The incident this file is the regression test for (owner report, 2026-08-19):
 * a four-agent run ended after two rounds having produced one document saying
 * the seats agreed, and nothing implemented. Every assertion below is about the
 * two facts that made that possible — no pattern's terminal condition mentioned
 * a *change*, and neither pair prompt contained the word "implement".
 *
 * Split the way `patterns.test.ts` and `engine.test.ts` are split: the pure
 * plan-level decisions first, with no database and no runner, then one full run
 * through the real engine because `rounds_used` is a fact about rows.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ORCHESTRATOR_CONFIG_DEFAULTS } from './config.js';
import {
  cardSeatOrder,
  patternFor,
  reviewSeatsOf,
  IMPLEMENTER_SEAT,
  NO_BREAKERS,
  PATTERNS,
  REVIEWER_SEAT,
  REVIEW_PATTERN,
  type AssignmentState,
  type PlanResult,
  type StateMember,
} from './patterns.js';
import { composePrompt } from './prompt.js';
import type { AssignmentRow } from './repository.js';
import type { TurnReport, TurnRow, TurnStatus, TurnVerdict } from './turns.js';
import { validateCreateAssignment, type ValidationInput } from './validate.js';
import {
  endSession,
  flush,
  makeHarness,
  makeTempDir,
  PROJECT_ID,
  type Harness,
  type TempDir,
} from './__tests__/helpers.js';

// ---------------------------------------------------------------------------
// Fixtures — plain data, no storage
// ---------------------------------------------------------------------------

const MEMBERS: readonly StateMember[] = [
  { agentId: 'kim', role: 'implementer', seatOrder: 0 },
  { agentId: 'rex', role: 'reviewer', seatOrder: 1 },
];

function row(overrides: Partial<AssignmentRow> = {}): AssignmentRow {
  return {
    id: 'a1',
    projectId: 'p1',
    pattern: 'review',
    status: 'open',
    goal: 'Fix the retry loop',
    scopeJson: null,
    tokenBudget: 400_000,
    tokensUsed: 0,
    roundCap: 3,
    roundsUsed: 0,
    createdAt: '2026-08-19T10:00:00.000Z',
    closedAt: null,
    closeReason: null,
    createdBy: 'user',
    parentAssignmentId: null,
    leadAgentId: 'kim',
    write: true,
    artifactPath: null,
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
    agentId: overrides.seat === IMPLEMENTER_SEAT ? 'kim' : 'rex',
    sessionId: `s${String(turnSeq)}`,
    prevSessionId: null,
    permissionDenials: 0,
    permissionDeniedTools: null,
    report: null,
    outputText: null,
    artifactHash: null,
    startedAt: '2026-08-19T10:00:00.000Z',
    endedAt: '2026-08-19T10:05:00.000Z',
    exitReason: null,
    retryOfTurnId: null,
    ...overrides,
  };
}

/** A report that names files — the implementer's evidence that anything changed. */
function report(overrides: Partial<TurnReport> = {}): TurnReport {
  return {
    state: 'done',
    headline: 'Retry loop fixed',
    artifacts: [{ path: 'src/retry.ts' }, { path: 'src/retry.test.ts' }],
    at: '2026-08-19T10:05:00.000Z',
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
    scope: { paths: ['src/'] },
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
  return REVIEW_PATTERN.plan(state(turns, overrides));
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

describe('the registry ships `review` (§3.6)', () => {
  it('registers it beside the other three, with two seats and one writer', () => {
    expect(PATTERNS.map((pattern) => pattern.id)).toEqual(['solo', 'pair', 'review', 'overseer']);
    expect(patternFor('review')).toBe(REVIEW_PATTERN);
    expect(REVIEW_PATTERN.seats.map((seat) => [seat.key, seat.write])).toEqual([
      [IMPLEMENTER_SEAT, true],
      [REVIEWER_SEAT, false],
    ]);
  });

  it('requires no artifact path: the deliverable is the working tree', () => {
    // The whole point of the pattern. A `requires.artifactPath: true` here would
    // put it straight back into producing a document that says work happened.
    expect(REVIEW_PATTERN.requires?.artifactPath ?? false).toBe(false);
    expect(REVIEW_PATTERN.requires?.roundCap).toBe(true);
    expect(REVIEW_PATTERN.requires?.tokenBudget).toBe(true);
  });

  it('puts the reviewer first in the card order, as the pair puts the critic first', () => {
    expect(cardSeatOrder('review')).toEqual([REVIEWER_SEAT, IMPLEMENTER_SEAT]);
  });

  it('seats a skeptic as the reviewer and an architect as the implementer', () => {
    // Roles rank, they never gate (owner, 2026-08-18) — so the neighbouring role
    // fills the seat rather than leaving it empty over a label.
    const seats = reviewSeatsOf([
      { agentId: 'ada', role: 'architect', seatOrder: 0 },
      { agentId: 'sam', role: 'skeptic', seatOrder: 1 },
    ]);
    expect(seats.implementer?.agentId).toBe('ada');
    expect(seats.reviewer?.agentId).toBe('sam');
  });
});

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

describe('plan() drives implement → review → implement (§3.6)', () => {
  it('opens on the implementer with the `implement` intent', () => {
    expect(plan([])).toMatchObject({
      seat: IMPLEMENTER_SEAT,
      agentId: 'kim',
      round: 1,
      prompt: { intent: 'implement', round: 1 },
    });
  });

  it('hands a reporting implementer to the reviewer in the same round', () => {
    const first = turn({ seat: IMPLEMENTER_SEAT, status: 'reported', report: report() });
    expect(plan([first])).toMatchObject({
      seat: REVIEWER_SEAT,
      agentId: 'rex',
      round: 1,
      prompt: { intent: 'review_changes', handoff: { seat: IMPLEMENTER_SEAT } },
    });
  });

  it('converges only on accept with an empty blocking list', () => {
    const turns = [
      turn({ seat: IMPLEMENTER_SEAT, status: 'reported', report: report() }),
      turn({
        seat: REVIEWER_SEAT,
        status: 'reported',
        report: report({ verdict: verdict({ decision: 'accept' }) }),
      }),
    ];
    expect(plan(turns)).toMatchObject({ done: true, closeReason: 'converged' });
  });

  it('treats "accept, but these are blocking" as revise — the words lose to the structure', () => {
    const turns = [
      turn({ seat: IMPLEMENTER_SEAT, status: 'reported', report: report() }),
      turn({
        seat: REVIEWER_SEAT,
        status: 'reported',
        report: report({
          verdict: verdict({
            decision: 'accept',
            blocking: [{ severity: 'high', summary: 'The retry has no ceiling' }],
          }),
        }),
      }),
    ];
    expect(plan(turns)).toMatchObject({
      seat: IMPLEMENTER_SEAT,
      round: 2,
      prompt: {
        intent: 'reimplement',
        blocking: [{ severity: 'high', summary: 'The retry has no ceiling' }],
      },
    });
  });

  it('closes round_cap rather than running a fourth round', () => {
    const turns = [
      turn({ seat: IMPLEMENTER_SEAT, status: 'reported', round: 3, report: report() }),
      turn({
        seat: REVIEWER_SEAT,
        status: 'reported',
        round: 3,
        report: report({ verdict: verdict() }),
      }),
    ];
    expect(plan(turns, { roundCap: 3 })).toMatchObject({ done: true, closeReason: 'round_cap' });
  });

  it('waits rather than planning while a turn is in flight', () => {
    expect(plan([turn({ seat: IMPLEMENTER_SEAT, status: 'running' })])).toEqual({
      wait: true,
      reason: 'turn_in_flight',
    });
  });
});

// ---------------------------------------------------------------------------
// The no-change guard
// ---------------------------------------------------------------------------

describe('the no-change guard: an implementer that touched nothing (§3.6)', () => {
  it('re-plans the implementer once with `implementation_missing`, not the reviewer', () => {
    // The cheapest honest signal in the turn plumbing: an empty `artifacts` list
    // is the seat's own structured claim that it changed nothing, and sending
    // the reviewer in to review nothing spends half a round on a fact the report
    // already carries.
    const empty = turn({
      seat: IMPLEMENTER_SEAT,
      status: 'reported',
      report: report({ artifacts: [] }),
    });
    expect(plan([empty])).toMatchObject({
      seat: IMPLEMENTER_SEAT,
      round: 1,
      prompt: { intent: 'implementation_missing', retryOfTurnId: empty.id },
      continueFromSessionId: empty.sessionId ?? undefined,
    });
  });

  it('falls through to the reviewer on the second empty report of a round', () => {
    // Not a halt: the reviewer is the seat that can tell "did nothing" from "did
    // the work and forgot to list it" by reading the workspace, and a halt card
    // naming an artifact path this pattern does not have would be a wrong
    // diagnosis in front of a human. The round cap is the outer bound.
    const turns = [
      turn({ seat: IMPLEMENTER_SEAT, status: 'reported', report: report({ artifacts: [] }) }),
      turn({ seat: IMPLEMENTER_SEAT, status: 'reported', report: report({ artifacts: [] }) }),
    ];
    expect(plan(turns)).toMatchObject({ seat: REVIEWER_SEAT, round: 1 });
  });

  it('does not fire when the implementer named the files it touched', () => {
    expect(
      plan([turn({ seat: IMPLEMENTER_SEAT, status: 'reported', report: report() })]),
    ).toMatchObject({ seat: REVIEWER_SEAT });
  });

  it('still applies the pair’s artifact guard when the run declared a path', () => {
    // `scope.artifactPath` stays optional: a doc-plus-code run may declare one,
    // and when it does the engine's hash is the better evidence.
    const missing = turn({
      seat: IMPLEMENTER_SEAT,
      status: 'reported',
      report: report(),
      artifactHash: null,
    });
    expect(
      plan([missing], {
        assignment: row({ artifactPath: 'docs/x/NOTES.md' }),
        scope: { paths: ['src/'], artifactPath: 'docs/x/NOTES.md' },
      }),
    ).toMatchObject({ seat: IMPLEMENTER_SEAT, prompt: { intent: 'artifact_missing' } });
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validationInput(
  pattern: 'pair' | 'review',
  members: readonly { readonly agentId: string; readonly role: string }[],
): ValidationInput {
  const agents = new Map(
    ['kim', 'rex', 'ada'].map((id) => [
      id,
      {
        id,
        name: id,
        archived: false,
        overseer: false,
        roles: ['implementer', 'reviewer'],
        openAssignments: 0,
      },
    ]),
  );
  return {
    request: {
      projectId: 'p1',
      pattern,
      members: members as ValidationInput['request']['members'],
      goal: 'Fix the retry loop',
    },
    moduleEnabled: true,
    project: { id: 'p1', status: 'active' },
    agents,
    config: ORCHESTRATOR_CONFIG_DEFAULTS,
  };
}

const codes = (input: ValidationInput): readonly string[] =>
  validateCreateAssignment(input).refusals.map((refusal) => refusal.code);

describe('the two-seat patterns refuse a first and a third member by name (§3.3, §3.6)', () => {
  for (const pattern of ['pair', 'review'] as const) {
    it(`${pattern}: two members pass`, () => {
      expect(
        codes(
          validationInput(pattern, [
            { agentId: 'kim', role: 'implementer' },
            { agentId: 'rex', role: 'reviewer' },
          ]),
        ),
      ).toEqual([]);
    });

    it(`${pattern}: one member is refused seat_unfilled, not left to wait`, () => {
      const result = validateCreateAssignment(
        validationInput(pattern, [{ agentId: 'kim', role: 'implementer' }]),
      );
      expect(result.refusals.map((refusal) => refusal.code)).toEqual(['seat_unfilled']);
      expect(result.refusals[0]?.message).toContain('two seats');
    });

    it(`${pattern}: a third member is refused seat_not_in_pattern rather than seated inertly`, () => {
      const result = validateCreateAssignment(
        validationInput(pattern, [
          { agentId: 'kim', role: 'implementer' },
          { agentId: 'rex', role: 'reviewer' },
          { agentId: 'ada', role: 'implementer' },
        ]),
      );
      expect(result.refusals.map((refusal) => refusal.code)).toEqual(['seat_not_in_pattern']);
      expect(result.refusals[0]?.message).toContain('exactly two seats');
    });
  }

  it('a role the agent does not declare stays a warning, never a gate', () => {
    // Owner decision 2026-08-18: capabilities rank, they never gate.
    const input = validationInput('review', [
      { agentId: 'kim', role: 'architect' },
      { agentId: 'rex', role: 'skeptic' },
    ]);
    const result = validateCreateAssignment(input);
    expect(result.refusals).toEqual([]);
    expect(result.warnings.map((warning) => warning.code)).toEqual([
      'role_not_declared',
      'role_not_declared',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

describe('config: `patterns.review` mirrors `patterns.pair` (§12)', () => {
  it('defaults to 3 rounds with a ceiling of 6', () => {
    expect(ORCHESTRATOR_CONFIG_DEFAULTS.patterns.review).toEqual({ roundCap: 3, maxRoundCap: 6 });
  });
});

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

function promptFor(seat: string, intent: 'implement' | 'reimplement' | 'review_changes'): string {
  return composePrompt({
    spec: { intent, seat, round: 1 },
    patternId: 'review',
    goal: 'Fix the retry loop',
    scope: { paths: ['src/'] },
    artifactPath: null,
    write: seat === IMPLEMENTER_SEAT,
    role: seat,
    roundCap: 3,
    tokenBudget: 400_000,
    tokensUsed: 0,
    mail: { messages: [], remaining: 0 },
    decisions: [],
    decisionBudget: ORCHESTRATOR_CONFIG_DEFAULTS.breakers.maxDecisionsPerSession,
    budgets: { maxBytes: 16_384, excerptBytes: 2048 },
  }).text;
}

describe('the prompts say the work is the change (§3.2, §3.6)', () => {
  it('tells the implementer to make the change in the workspace', () => {
    const text = promptFor(IMPLEMENTER_SEAT, 'implement');
    expect(text).toContain('Make the change this goal describes in the workspace');
    expect(text).toContain('edit the code, add or update the tests');
    // The failure this pattern exists to prevent, named in the sentence itself.
    expect(text).toContain('Writing a document about the change is not the work');
    expect(text).toContain('a turn that changes nothing will be sent back');
  });

  it('tells the reviewer to read the change, not to negotiate prose', () => {
    const text = promptFor(REVIEWER_SEAT, 'review_changes');
    expect(text).toContain('Review the actual change');
    expect(text).toContain('the diff around them');
    expect(text).toContain('Do not negotiate wording');
  });

  it('names the reviewer’s accept as the convergence rule, and asks it for a verdict', () => {
    const text = promptFor(REVIEWER_SEAT, 'review_changes');
    expect(text).toContain(
      'this assignment finishes when the reviewer reports decision "accept" with an empty blocking list',
    );
    expect(text).toContain('with your verdict — decision "accept" or "revise"');
  });

  it('asks the implementer for its state and the artifacts it touched, not a verdict', () => {
    const text = promptFor(IMPLEMENTER_SEAT, 'implement');
    expect(text).toContain('a one-line headline and the artifacts you touched');
    expect(text).not.toContain('with your verdict');
  });

  it('keeps every existing prompt invariant', () => {
    const text = promptFor(IMPLEMENTER_SEAT, 'reimplement');
    // WO6's tooling guardrail, the mailbox tempo (this is a multi-seat pattern)
    // and the required close, in every composed prompt.
    expect(text).toContain('Never search the filesystem, environment, or configuration');
    expect(text).toContain('Messages you send are delivered when the recipient’s next turn starts');
    expect(text).toContain('## 8. Required close');
    expect(text).toContain('mcp__agentmanager__report_status');
  });
});

// ---------------------------------------------------------------------------
// The full run, through the real engine
// ---------------------------------------------------------------------------

const REVISE: TurnVerdict = {
  decision: 'revise',
  blocking: [{ severity: 'high', summary: 'The retry has no ceiling' }],
  nonBlocking: [],
};
const ACCEPT: TurnVerdict = { decision: 'accept', blocking: [], nonBlocking: [] };

const AGENTS = [
  { id: 'kim', roles: ['implementer' as const] },
  { id: 'rex', roles: ['reviewer' as const] },
];

describe('a review runs implement → revise → implement → accept (§3.6)', () => {
  let harness: Harness;
  let workspace: TempDir;

  beforeEach(() => {
    workspace = makeTempDir('agentmanager-orchestrator-review-');
    harness = makeHarness({ agents: AGENTS, workspaceCwd: workspace.path });
  });

  afterEach(() => {
    harness.cleanup();
    workspace.cleanup();
  });

  async function finish(
    assignmentId: string,
    body: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const active = harness.turns.active(assignmentId);
    if (active === undefined) throw new Error('no turn is in flight');
    harness.advance(1_000);
    const result = await harness
      .toolset({ assignmentId, agentId: active.agentId })
      .call('report_status', body);
    if (result.isError === true) throw new Error(result.content[0]?.text ?? 'refused');
    harness.advance(1_000);
    await endSession(harness, active.sessionId ?? '', {});
  }

  it('converges with rounds_used 2, and never asks for an artifact path', async () => {
    const created = await harness.service.createAssignment({
      projectId: PROJECT_ID,
      pattern: 'review',
      goal: 'Give the retry loop a ceiling',
      members: [
        { agentId: 'kim', role: 'implementer' },
        { agentId: 'rex', role: 'reviewer' },
      ],
      scope: { paths: ['src/'] },
    });
    await flush();
    const assignmentId = created.assignmentId;

    // The defaults the pattern carries, taken without the user naming any.
    expect(harness.service.get(assignmentId)).toMatchObject({
      roundCap: 3,
      tokenBudget: 400_000,
      artifactPath: null,
    });
    expect(harness.runner.started[0]?.prompt).toContain(
      'Make the change this goal describes in the workspace',
    );

    await finish(assignmentId, {
      state: 'done',
      headline: 'Ceiling added',
      artifacts: [{ path: 'src/retry.ts' }],
    });
    await finish(assignmentId, {
      state: 'done',
      headline: 'One blocking issue',
      verdict: REVISE,
    });
    // The reviewer closed round 1, and the blocking list rode into round 2.
    expect(harness.service.get(assignmentId).roundsUsed).toBe(1);
    expect(harness.runner.started.at(-1)?.prompt).toContain('The retry has no ceiling');

    await finish(assignmentId, {
      state: 'done',
      headline: 'Ceiling capped at 5',
      artifacts: [{ path: 'src/retry.ts' }, { path: 'src/retry.test.ts' }],
    });
    await finish(assignmentId, { state: 'done', headline: 'Looks right', verdict: ACCEPT });

    const view = harness.service.get(assignmentId);
    expect(view.roundsUsed).toBe(2);
    expect(view.phase).toBe('converged');
    expect(harness.turns.list(assignmentId).map((one) => [one.round, one.seat])).toEqual([
      [1, IMPLEMENTER_SEAT],
      [1, REVIEWER_SEAT],
      [2, IMPLEMENTER_SEAT],
      [2, REVIEWER_SEAT],
    ]);
  });
});
