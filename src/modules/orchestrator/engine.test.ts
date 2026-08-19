/**
 * The pattern engine, against real storage, a real bus and a recording runner
 * (DESIGN §3, §5, §7.3, §11.2; IMPLEMENTATION M5-2..M5-6 and M6-2..M6-7).
 *
 * `patterns.test.ts` proves what the pair *decides*; this proves what the engine
 * *does* with those decisions — the turn rows, the launches, the events, the
 * cards, and the two things that only exist here: the crash-safety of the partial
 * unique index and the round-cap card's three answers.
 *
 * The runner is a fake because runner's own suite owns session mechanics; the
 * end-to-end proof against real sessions is in `module.test.ts`, through the
 * composition root with a scripted SDK.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ROUND_CAP_CARD, safeJoin } from './engine.js';
import { CRITIC_SEAT, DRAFTER_SEAT } from './patterns.js';
import type { TurnVerdict } from './turns.js';
import {
  endSession,
  fakeRunner,
  flush,
  makeHarness,
  makeTempDir,
  PROJECT_ID,
  type Harness,
  type TempDir,
} from './__tests__/helpers.js';

const AGENTS = [
  { id: 'ada', roles: ['architect' as const] },
  { id: 'sam', roles: ['skeptic' as const] },
  { id: 'kim', roles: ['implementer' as const] },
];

let harness: Harness;
let workspace: TempDir;

interface PairOptions {
  readonly roundCap?: number | null;
  readonly tokenBudget?: number | null;
  readonly autoStart?: boolean;
}

async function makePair(options: PairOptions = {}): Promise<string> {
  const created = await harness.service.createAssignment({
    projectId: PROJECT_ID,
    pattern: 'pair',
    goal: 'Write docs/x/DESIGN.md',
    members: [
      { agentId: 'ada', role: 'architect' },
      { agentId: 'sam', role: 'skeptic' },
    ],
    scope: { paths: ['docs/x/'], artifactPath: 'docs/x/DESIGN.md' },
    ...(options.roundCap === undefined ? {} : { roundCap: options.roundCap }),
    ...(options.tokenBudget === undefined ? {} : { tokenBudget: options.tokenBudget }),
    ...(options.autoStart === undefined ? {} : { autoStart: options.autoStart }),
  });
  await flush();
  return created.assignmentId;
}

/**
 * Moves the harness clock on.
 *
 * The clock is fixed by default so the join window and expiry are testable
 * (`helpers.ts`), which would otherwise give every turn, message and card the
 * same timestamp — and the conversation view's ordering is a claim about *time*.
 * A second between actions is what a real run has.
 */
function tick(): void {
  harness.advance(1_000);
}

/** Reports through the real toolset, as the agent's own tool call would. */
async function report(
  assignmentId: string,
  agentId: string,
  body: Readonly<Record<string, unknown>>,
): Promise<void> {
  const result = await harness.toolset({ assignmentId, agentId }).call('report_status', body);
  if (result.isError === true) throw new Error(result.content[0]?.text ?? 'refused');
}

const REVISE: TurnVerdict = {
  decision: 'revise',
  blocking: [{ severity: 'high', summary: 'No rollback path for step 3' }],
  nonBlocking: [],
};
const ACCEPT: TurnVerdict = { decision: 'accept', blocking: [], nonBlocking: [] };

let drafts = 0;

/**
 * What a drafter that actually did its job leaves behind.
 *
 * §3.3's artifact guard means a reporting drafter turn with no file at
 * `scope.artifactPath` is re-planned rather than handed to the critic, so a
 * fixture that never writes the file would never reach the critic at all. The
 * content changes every time, because a drafter that writes the *same* bytes
 * twice is the `no_progress` breaker's case, not this one's.
 */
function writeDraft(): void {
  drafts += 1;
  mkdirSync(join(workspace.path, 'docs', 'x'), { recursive: true });
  writeFileSync(
    join(workspace.path, 'docs', 'x', 'DESIGN.md'),
    `# Design\n\nDraft ${String(drafts)}\n`,
    'utf8',
  );
}

/** Finishes whichever turn is in flight, with an optional report first. */
async function finishTurn(
  assignmentId: string,
  body?: Readonly<Record<string, unknown>>,
  session: Readonly<Record<string, unknown>> = {},
  options: { readonly artifact?: boolean } = {},
): Promise<void> {
  const active = harness.turns.active(assignmentId);
  if (active === undefined) throw new Error('no turn is in flight');
  // The tests that are *about* the artifact pass `artifact: false` and control
  // the file themselves; everywhere else the drafter behaves.
  if (options.artifact !== false && active.seat === DRAFTER_SEAT && body !== undefined) {
    writeDraft();
  }
  tick();
  if (body !== undefined) await report(assignmentId, active.agentId, body);
  tick();
  await endSession(harness, active.sessionId ?? '', session);
}

beforeEach(() => {
  drafts = 0;
  workspace = makeTempDir('agentmanager-orchestrator-ws-');
  harness = makeHarness({ agents: AGENTS, workspaceCwd: workspace.path });
});

afterEach(() => {
  harness.cleanup();
  workspace.cleanup();
});

// ---------------------------------------------------------------------------

describe('the loop plans the first turn (M5-2)', () => {
  it('drives a created pair to a drafter turn and records the row and the events', async () => {
    const assignmentId = await makePair();

    const turns = harness.turns.list(assignmentId);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      round: 1,
      seat: DRAFTER_SEAT,
      agentId: 'ada',
      status: 'running',
      prevSessionId: null,
    });
    expect(harness.runner.started).toHaveLength(1);
    expect(harness.runner.started[0]).toMatchObject({
      assignmentId,
      agentId: 'ada',
      projectId: PROJECT_ID,
      role: 'architect',
      priority: 'normal',
    });
    // The composed prompt reached runner, not a placeholder.
    expect(harness.runner.started[0]?.prompt).toContain('You are the drafter');
    expect(harness.runner.started[0]?.prompt).toContain('docs/x/DESIGN.md');

    expect(harness.events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        'assignment.created',
        'assignment.started',
        'assignment.turn.started',
      ]),
    );
  });

  it('plans nothing for an assignment created with autoStart: false until it is advanced', async () => {
    const assignmentId = await makePair({ autoStart: false });
    expect(harness.turns.list(assignmentId)).toHaveLength(0);
    expect(harness.service.get(assignmentId).phase).toBe('planned');

    const outcome = await harness.engine.advance(assignmentId, { manual: true });
    expect(outcome).toMatchObject({ kind: 'planned', seat: DRAFTER_SEAT, round: 1 });
    expect(harness.service.get(assignmentId).phase).toBe('running');
  });

  it('an event-driven advance never starts a planned assignment on its own', async () => {
    const assignmentId = await makePair({ autoStart: false });
    expect(await harness.engine.advance(assignmentId)).toEqual({
      kind: 'idle',
      reason: 'phase_planned',
    });
  });
});

describe('turn-taking through assignment_turns (M5-2, M6-2)', () => {
  it('alternates drafter → critic → drafter, one turn in flight at a time', async () => {
    const assignmentId = await makePair();

    await finishTurn(assignmentId, { state: 'done', headline: 'Draft complete' });
    expect(harness.turns.list(assignmentId).map((turn) => [turn.seat, turn.status])).toEqual([
      [DRAFTER_SEAT, 'reported'],
      [CRITIC_SEAT, 'running'],
    ]);

    await finishTurn(assignmentId, {
      state: 'done',
      headline: 'Two blocking issues',
      verdict: REVISE,
    });
    const turns = harness.turns.list(assignmentId);
    expect(turns.map((turn) => [turn.round, turn.seat, turn.status])).toEqual([
      [1, DRAFTER_SEAT, 'reported'],
      [1, CRITIC_SEAT, 'reported'],
      [2, DRAFTER_SEAT, 'running'],
    ]);
    // Exactly one is in flight, at every point, because the index says so.
    expect(harness.turns.active(assignmentId)?.round).toBe(2);
  });

  it('carries the critic’s blocking issues verbatim into the revise prompt', async () => {
    const assignmentId = await makePair();
    await finishTurn(assignmentId, { state: 'done', headline: 'Draft complete' });
    await finishTurn(assignmentId, { state: 'done', headline: 'Issues', verdict: REVISE });

    const revise = harness.runner.started.at(-1)?.prompt ?? '';
    expect(revise).toContain('[high] No rollback path for step 3');
    expect(revise).toContain('Round 2 of 3');
  });

  it('counts a round as complete only when the critic reports, and emits the event', async () => {
    const assignmentId = await makePair();
    await finishTurn(assignmentId, { state: 'done', headline: 'Draft complete' });
    expect(harness.service.get(assignmentId).roundsUsed).toBe(0);

    await finishTurn(assignmentId, { state: 'done', headline: 'Issues', verdict: REVISE });
    expect(harness.service.get(assignmentId).roundsUsed).toBe(1);
    expect(harness.events.filter((event) => event.type === 'assignment.round.completed')).toEqual([
      expect.objectContaining({
        payload: { round: 1, converged: false, blockingCount: 1 },
      }),
    ]);
  });

  it('refuses a second in-flight turn when two triggers race (the index, not a flag)', async () => {
    const assignmentId = await makePair();
    const [first, second] = await Promise.all([
      harness.engine.advance(assignmentId),
      harness.engine.advance(assignmentId),
    ]);
    expect([first.kind, second.kind]).toEqual(['idle', 'idle']);
    expect(harness.turns.list(assignmentId)).toHaveLength(1);
  });
});

describe('a seat’s later turn continues its own session (M5, §3.2)', () => {
  it('uses continueFrom when runner has it, and records prev_session_id', async () => {
    harness.cleanup();
    workspace = makeTempDir('agentmanager-orchestrator-ws-');
    harness = makeHarness({
      agents: AGENTS,
      workspaceCwd: workspace.path,
      runner: fakeRunner({ continuable: true }),
    });

    const assignmentId = await makePair();
    await finishTurn(assignmentId, { state: 'done', headline: 'Draft complete' });
    await finishTurn(assignmentId, { state: 'done', headline: 'Issues', verdict: REVISE });

    const round2 = harness.turns.list(assignmentId).at(-1);
    expect(round2).toMatchObject({ round: 2, seat: DRAFTER_SEAT, prevSessionId: 'session-1' });
    expect(harness.runner.continued).toEqual([
      expect.objectContaining({ previousSessionId: 'session-1' }),
    ]);
    // The continuation prompt is the composed one, not a bare continuation.
    expect(harness.runner.continued[0]?.prompt).toContain('No rollback path for step 3');
  });

  it('falls back to a fresh session when runner has no continueFrom, keeping prev_session_id', async () => {
    const assignmentId = await makePair();
    await finishTurn(assignmentId, { state: 'done', headline: 'Draft complete' });
    await finishTurn(assignmentId, { state: 'done', headline: 'Issues', verdict: REVISE });

    expect(harness.runner.continued).toHaveLength(0);
    expect(harness.runner.started).toHaveLength(3);
    // The *fact* of the continuation is still recorded, so the conversation view
    // and a later `continueFrom` both have it.
    expect(harness.turns.list(assignmentId).at(-1)?.prevSessionId).toBe('session-1');
  });
});

describe('convergence and the completion of the pair (M6-3, M6-4)', () => {
  it('closes converged with phase converged when the critic accepts cleanly', async () => {
    const assignmentId = await makePair();
    await finishTurn(assignmentId, { state: 'done', headline: 'Draft complete' });
    await finishTurn(assignmentId, {
      state: 'done',
      headline: 'Looks right',
      verdict: ACCEPT,
    });

    const assignment = harness.service.get(assignmentId);
    expect(assignment).toMatchObject({
      status: 'closed',
      phase: 'converged',
      closeReason: 'converged',
      roundsUsed: 1,
    });
    expect(
      harness.events.filter((event) => event.type === 'assignment.round.completed').at(-1),
    ).toMatchObject({ payload: { converged: true, blockingCount: 0 } });
    expect(harness.events.filter((event) => event.type === 'assignment.closed')).toHaveLength(1);
    // No further turns are planned once it is closed.
    expect(await harness.engine.advance(assignmentId)).toEqual({
      kind: 'idle',
      reason: 'assignment_closed',
    });
  });

  it('does NOT converge on an accept carrying blocking issues (M6 acceptance)', async () => {
    const assignmentId = await makePair();
    await finishTurn(assignmentId, { state: 'done', headline: 'Draft complete' });
    await finishTurn(assignmentId, {
      state: 'done',
      headline: 'Accept, but…',
      verdict: {
        decision: 'accept',
        blocking: [{ severity: 'high', summary: 'still no rollback path' }],
        nonBlocking: [],
      },
    });

    expect(harness.service.get(assignmentId).status).toBe('open');
    expect(harness.turns.list(assignmentId).at(-1)).toMatchObject({
      round: 2,
      seat: DRAFTER_SEAT,
      status: 'running',
    });
  });
});

describe('the round cap and its three-option card (M6-4)', () => {
  async function toCap(): Promise<string> {
    const assignmentId = await makePair({ roundCap: 1 });
    await finishTurn(assignmentId, { state: 'done', headline: 'Draft' });
    await finishTurn(assignmentId, { state: 'done', headline: 'Nope', verdict: REVISE });
    return assignmentId;
  }

  function cardOf(assignmentId: string): { id: string; options: readonly { id: string }[] } {
    const card = harness.inbox
      .list({ assignmentId, status: 'open' })
      .find((one) => one.context?.toolName === ROUND_CAP_CARD);
    if (card === undefined) throw new Error('no round-cap card was raised');
    return card;
  }

  it('stops planning at the cap and raises one card with the three options', async () => {
    const assignmentId = await toCap();
    expect(harness.service.get(assignmentId)).toMatchObject({
      status: 'open',
      phase: 'awaiting_user',
    });
    expect(cardOf(assignmentId).options.map((option) => option.id)).toEqual([
      'accept',
      'more_rounds',
      'close',
    ]);
    // Exactly one card, however many times the loop is re-entered.
    await harness.engine.advance(assignmentId);
    expect(
      harness.inbox
        .list({ assignmentId, status: 'open' })
        .filter((one) => one.context?.toolName === ROUND_CAP_CARD),
    ).toHaveLength(1);
    expect(harness.turns.list(assignmentId)).toHaveLength(2);
  });

  it('“Run one more round” runs exactly one more and re-terminates', async () => {
    const assignmentId = await toCap();
    harness.inbox.answer(cardOf(assignmentId).id, {
      optionIds: ['more_rounds'],
      answeredVia: 'local',
    });
    await flush();

    expect(harness.service.get(assignmentId).roundCap).toBe(2);
    expect(harness.turns.active(assignmentId)).toMatchObject({ round: 2, seat: DRAFTER_SEAT });

    await finishTurn(assignmentId, { state: 'done', headline: 'Revised', verdict: undefined });
    await finishTurn(assignmentId, { state: 'done', headline: 'Still no', verdict: REVISE });

    // Exactly one more round, then the card again — the user tie-breaks once per
    // cap, not once per round.
    expect(harness.turns.list(assignmentId).map((turn) => turn.round)).toEqual([1, 1, 2, 2]);
    expect(harness.service.get(assignmentId).phase).toBe('awaiting_user');
  });

  it('“Accept as-is” closes converged; “Close unfinished” closes round_cap', async () => {
    const accepted = await toCap();
    harness.inbox.answer(cardOf(accepted).id, { optionIds: ['accept'], answeredVia: 'local' });
    await flush();
    expect(harness.service.get(accepted)).toMatchObject({
      status: 'closed',
      phase: 'converged',
      closeReason: 'converged',
    });

    const closed = await toCap();
    harness.inbox.answer(cardOf(closed).id, { optionIds: ['close'], answeredVia: 'local' });
    await flush();
    expect(harness.service.get(closed)).toMatchObject({
      status: 'closed',
      closeReason: 'round_cap',
    });
  });

  it('closes rather than raising the cap past maxRoundCap — neither agent nor card may', async () => {
    harness.cleanup();
    workspace = makeTempDir('agentmanager-orchestrator-ws-');
    harness = makeHarness({
      agents: AGENTS,
      workspaceCwd: workspace.path,
      config: {
        patterns: {
          pair: { roundCap: 1, maxRoundCap: 1, stanceSolicitation: true, requireArtifact: true },
          overseer: { roundCap: 3, maxRoundCap: 6 },
        },
      },
    });
    const assignmentId = await toCap();
    harness.inbox.answer(cardOf(assignmentId).id, {
      optionIds: ['more_rounds'],
      answeredVia: 'local',
    });
    await flush();
    expect(harness.service.get(assignmentId)).toMatchObject({
      status: 'closed',
      closeReason: 'round_cap',
    });
  });
});

describe('halts (§8.1, M6-2)', () => {
  it('halts no_progress when the drafter re-submits an unchanged artifact', async () => {
    mkdirSync(join(workspace.path, 'docs', 'x'), { recursive: true });
    const artifact = join(workspace.path, 'docs', 'x', 'DESIGN.md');
    writeFileSync(artifact, '# Design\n', 'utf8');

    const assignmentId = await makePair();
    await finishTurn(
      assignmentId,
      { state: 'done', headline: 'Draft complete' },
      {},
      {
        artifact: false,
      },
    );
    await finishTurn(assignmentId, { state: 'done', headline: 'Issues', verdict: REVISE });
    // Round 2's drafter claims a revision and changes nothing on disk.
    await finishTurn(
      assignmentId,
      { state: 'done', headline: 'Revised, honest' },
      {},
      {
        artifact: false,
      },
    );

    const assignment = harness.service.get(assignmentId);
    expect(assignment).toMatchObject({
      status: 'open',
      phase: 'halted',
      haltReason: 'no_progress',
    });
    const halted = harness.events.filter((event) => event.type === 'assignment.halted');
    expect(halted).toHaveLength(1);
    expect(halted[0]?.payload).toMatchObject({ haltReason: 'no_progress' });
    // One card, offering a continue — §8.2's second gate.
    const cards = harness.inbox.list({ assignmentId, status: 'open' });
    expect(cards).toHaveLength(1);
    expect(cards[0]?.kind).toBe('approval_gate');
    expect(cards[0]?.options.map((option) => option.id)).toEqual(['continue', 'close']);
  });

  it('does not halt when the artifact really changed between rounds', async () => {
    mkdirSync(join(workspace.path, 'docs', 'x'), { recursive: true });
    const artifact = join(workspace.path, 'docs', 'x', 'DESIGN.md');
    writeFileSync(artifact, '# Design\n', 'utf8');

    const assignmentId = await makePair();
    await finishTurn(
      assignmentId,
      { state: 'done', headline: 'Draft complete' },
      {},
      {
        artifact: false,
      },
    );
    await finishTurn(assignmentId, { state: 'done', headline: 'Issues', verdict: REVISE });
    writeFileSync(artifact, '# Design\n\nWith a rollback path.\n', 'utf8');
    await finishTurn(assignmentId, { state: 'done', headline: 'Revised' }, {}, { artifact: false });

    expect(harness.service.get(assignmentId).phase).toBe('running');
    expect(harness.turns.active(assignmentId)).toMatchObject({ round: 2, seat: CRITIC_SEAT });
  });

  it('retries an unreported turn once, then halts no_report', async () => {
    const assignmentId = await makePair();
    await finishTurn(assignmentId); // no report at all

    const retried = harness.turns.list(assignmentId);
    expect(retried[0]?.status).toBe('unstructured');
    expect(retried[1]).toMatchObject({ seat: DRAFTER_SEAT, round: 1, status: 'running' });
    expect(retried[1]?.retryOfTurnId).toBe(retried[0]?.id);
    expect(harness.runner.started.at(-1)?.prompt).toContain('ended without a structured report');

    await finishTurn(assignmentId);
    expect(harness.service.get(assignmentId)).toMatchObject({
      phase: 'halted',
      haltReason: 'no_report',
    });
  });

  it('captures the last assistant text for an unreported turn, from the summary channel', async () => {
    const assignmentId = await makePair();
    await finishTurn(assignmentId, undefined, { summary: 'go — completed: I wrote some prose.' });
    expect(harness.turns.list(assignmentId)[0]?.outputText).toContain('I wrote some prose.');
  });

  it('halts turn_failures after two consecutive failed sessions', async () => {
    const assignmentId = await makePair();
    await finishTurn(assignmentId, undefined, { status: 'failed', exitReason: 'sdk_error' });
    expect(harness.turns.list(assignmentId)[0]?.status).toBe('failed');
    await finishTurn(assignmentId, undefined, { status: 'orphaned', exitReason: 'orphaned' });

    expect(harness.service.get(assignmentId)).toMatchObject({
      phase: 'halted',
      haltReason: 'turn_failures',
    });
  });

  it('a manual advance clears the halt and re-enters the loop (M7’s resume path)', async () => {
    const assignmentId = await makePair();
    await finishTurn(assignmentId, undefined, { status: 'failed' });
    await finishTurn(assignmentId, undefined, { status: 'failed' });
    expect(harness.service.get(assignmentId).phase).toBe('halted');

    const outcome = await harness.engine.advance(assignmentId, { manual: true });
    expect(outcome.kind).toBe('planned');
    expect(harness.service.get(assignmentId)).toMatchObject({
      phase: 'running',
      haltReason: null,
    });
  });
});

describe('budgets stop the loop with the right phase (§7.3, §8.1)', () => {
  it('plans nothing once tokens_used has crossed the budget, and says why', async () => {
    const assignmentId = await makePair({ tokenBudget: 100 });
    expect(harness.turns.list(assignmentId)).toHaveLength(1);
    // Runner owns the arithmetic; the engine consumes the total (§7.1).
    harness.storage.store.assignments.addTokensUsed(assignmentId, 150);

    // The drafter's turn finishes normally — a budget crossing does not kill work
    // in flight (§8.1) — and no critic turn is planned behind it.
    await finishTurn(assignmentId, { state: 'done', headline: 'Draft complete' });
    expect(harness.service.get(assignmentId)).toMatchObject({
      status: 'open',
      phase: 'awaiting_user',
      haltReason: null,
    });
    expect(harness.turns.list(assignmentId)).toHaveLength(1);
    // And it stays stopped — even for a manual advance, which is what makes the
    // budget a breaker rather than a phase the user can click past.
    for (const manual of [false, true]) {
      expect(await harness.engine.advance(assignmentId, { manual })).toMatchObject({
        kind: 'awaiting_user',
        reason: 'budget_exhausted',
      });
    }
    expect(harness.turns.list(assignmentId)).toHaveLength(1);
  });

  it('reacts to runner’s assignment.budget.exceeded without raising a second card', async () => {
    const assignmentId = await makePair({ tokenBudget: 400_000 });
    harness.bus.emit({
      type: 'assignment.budget.exceeded',
      ids: { assignmentId },
      persist: false,
      payload: {},
    });
    await flush();
    expect(harness.service.get(assignmentId).phase).toBe('awaiting_user');
    // Runner raises `budget_halt` in its own transaction (§7.2); the engine adds
    // nothing to the inbox.
    expect(harness.inbox.list({ assignmentId, status: 'open' })).toHaveLength(0);
  });
});

describe('messages and stance solicitation flow through the prompt (§3.2, §6.4)', () => {
  it('inlines a co-member’s handoff into the next seat’s prompt', async () => {
    const assignmentId = await makePair();
    await harness
      .toolset({ assignmentId, agentId: 'ada' })
      .call('send_to_agent', { to: 'sam', kind: 'handoff', body: 'Section 4 is the risky one.' });
    await finishTurn(assignmentId, { state: 'done', headline: 'Draft complete' });

    const critique = harness.runner.started.at(-1)?.prompt ?? '';
    expect(critique).toContain('Unread mail');
    expect(critique).toContain('Section 4 is the risky one.');
    // Inlining is a delivery, and the conversation view says so.
    const entry = harness.mailbox
      .listByAssignment(assignmentId)
      .find((message) => message.toAgentId === 'sam');
    expect(entry?.delivery).toBe('inlined');
  });

  it('asks the next seat for its stance on an open card, and the join folds it in', async () => {
    const assignmentId = await makePair();
    const asked = harness.toolset({ assignmentId, agentId: 'ada' }).call('request_user_decision', {
      question: 'Store transcripts in the DB or on disk?',
      options: [
        { id: 'disk', label: 'On disk' },
        { id: 'db', label: 'In SQLite' },
      ],
      recommendation: { optionId: 'disk', strength: 'strong', rationale: 'simpler' },
    });
    await flush(2);
    await finishTurn(assignmentId, { state: 'done', headline: 'Draft complete' });

    const critique = harness.runner.started.at(-1)?.prompt ?? '';
    expect(critique).toContain('Open question: Store transcripts in the DB or on disk?');
    expect(critique).toContain('blocking, strong, lean or defer');

    // The critic states its stance against the *same* card (§6.3's join, with the
    // window waived because the card is waiting for it).
    await harness.toolset({ assignmentId, agentId: 'sam' }).call('request_user_decision', {
      question: 'Store transcripts in the DB or on disk?',
      options: [
        { id: 'disk', label: 'On disk' },
        { id: 'db', label: 'In SQLite' },
      ],
      recommendation: { optionId: 'db', strength: 'blocking', rationale: 'ordering' },
    });
    const cards = harness.inbox.list({ assignmentId, status: 'open' });
    expect(cards).toHaveLength(1);
    expect(cards[0]?.recommendations.map((one) => one.agentId)).toEqual(['sam', 'ada']);
    expect(cards[0]).toMatchObject({ disagreement: true, contested: true });

    harness.inbox.answer(cards[0]?.id ?? '', { optionIds: ['disk'], answeredVia: 'local' });
    await asked;
  });

  it('turns off stance solicitation by configuration', async () => {
    harness.cleanup();
    workspace = makeTempDir('agentmanager-orchestrator-ws-');
    harness = makeHarness({
      agents: AGENTS,
      workspaceCwd: workspace.path,
      config: {
        patterns: {
          pair: { roundCap: 3, maxRoundCap: 6, stanceSolicitation: false, requireArtifact: true },
          overseer: { roundCap: 3, maxRoundCap: 6 },
        },
      },
    });
    const assignmentId = await makePair();
    void harness.toolset({ assignmentId, agentId: 'ada' }).call('request_user_decision', {
      question: 'Disk or DB?',
    });
    await flush(2);
    await finishTurn(assignmentId, { state: 'done', headline: 'Draft complete' });
    expect(harness.runner.started.at(-1)?.prompt).not.toContain('Open question:');
  });
});

describe('a blocked seat is re-driven by the answer, never by a second resume (§4.4)', () => {
  it('marks the turn blocked, waits, then re-plans the same seat and round', async () => {
    const assignmentId = await makePair();
    const pending = await harness
      .toolset({ assignmentId, agentId: 'ada' })
      .call('request_user_decision', { question: 'Disk or DB?' });
    expect(JSON.parse(pending.content[0]?.text ?? '{}')).toMatchObject({ status: 'pending' });

    await finishTurn(assignmentId, { state: 'blocked', headline: 'waiting on a decision' });
    expect(harness.turns.list(assignmentId)[0]?.status).toBe('blocked');
    expect(harness.turns.active(assignmentId)).toBeUndefined();
    // Orchestrator never resumed anything — the session ended cleanly.
    expect(harness.runner.stopped).toHaveLength(0);

    const card = harness.inbox.list({ assignmentId, status: 'open' })[0];
    harness.inbox.answer(card?.id ?? '', { optionIds: ['disk'], answeredVia: 'local' });
    await flush();

    const replanned = harness.turns.list(assignmentId).at(-1);
    expect(replanned).toMatchObject({ seat: DRAFTER_SEAT, round: 1, status: 'running' });
    expect(harness.runner.started.at(-1)?.prompt).toContain(
      'The user answered "Disk or DB?": disk',
    );
  });
});

describe('solo runs through the engine unchanged (M5-6)', () => {
  it('plans nothing after the first session, and the engine says why', async () => {
    const solo = await harness.service.createSolo({
      projectId: PROJECT_ID,
      agentId: 'kim',
      prompt: 'go',
    });
    await flush();
    expect(harness.turns.list(solo.assignmentId)).toHaveLength(0);
    expect(await harness.engine.advance(solo.assignmentId)).toEqual({
      kind: 'idle',
      reason: 'no_driver',
    });

    await endSession(harness, solo.sessionId);
    expect(harness.turns.list(solo.assignmentId)).toHaveLength(0);
    expect(harness.runner.started).toHaveLength(1);
  });
});

describe('restarting mid-round loses nothing (M5-5, M6 acceptance)', () => {
  it('fails the in-flight turn whose session died and resumes at the right seat', async () => {
    const assignmentId = await makePair();
    await finishTurn(assignmentId, { state: 'done', headline: 'Draft complete' });
    // The critic's turn is running when the core dies: no session row exists for
    // it, which is exactly what a crash looks like from the next boot.
    expect(harness.turns.active(assignmentId)).toMatchObject({ seat: CRITIC_SEAT });

    const result = await harness.engine.reconcileOnBoot();
    expect(result.failedTurns).toHaveLength(1);
    expect(result.resumed).toEqual([assignmentId]);
    const turns = harness.turns.list(assignmentId);
    expect(turns.map((turn) => [turn.seat, turn.status])).toEqual([
      [DRAFTER_SEAT, 'reported'],
      [CRITIC_SEAT, 'failed'],
      [CRITIC_SEAT, 'running'],
    ]);
  });

  it('leaves a turn alone whose session is still alive, and plans nothing extra', async () => {
    const assignmentId = await makePair();
    const active = harness.turns.active(assignmentId);
    harness.storage.store.sessions.create({
      id: active?.sessionId ?? '',
      assignmentId,
      agentId: 'ada',
      projectId: PROJECT_ID,
      status: 'running',
    });

    const result = await harness.engine.reconcileOnBoot();
    expect(result.failedTurns).toEqual([]);
    expect(harness.turns.list(assignmentId)).toHaveLength(1);
    expect(harness.turns.active(assignmentId)?.id).toBe(active?.id);
  });
});

describe('GET /api/patterns’ payload (M5-1)', () => {
  it('describes every pattern, its seats, defaults and card order', () => {
    const patterns = harness.engine.patterns();
    expect(patterns.map((pattern) => pattern.id)).toEqual(['solo', 'pair', 'overseer']);
    const pair = patterns.find((pattern) => pattern.id === 'pair');
    expect(pair).toMatchObject({
      driver: 'sequential',
      requires: { artifactPath: true, roundCap: true, tokenBudget: true },
      defaults: { roundCap: 3, tokenBudget: 400_000 },
      maxRoundCap: 6,
      cardSeatOrder: [CRITIC_SEAT, DRAFTER_SEAT],
    });
    expect(pair?.seats.map((seat) => seat.key)).toEqual([DRAFTER_SEAT, CRITIC_SEAT]);
    expect(patterns.find((pattern) => pattern.id === 'solo')?.driver).toBe('none');
  });
});

describe('the conversation view (M6-6, §11.2)', () => {
  it('renders the rounds, the turns, the handoffs and the cards in order', async () => {
    const assignmentId = await makePair();
    tick();
    await harness
      .toolset({ assignmentId, agentId: 'ada' })
      .call('send_to_agent', { to: 'sam', kind: 'handoff', body: 'Section 4 is the risky one.' });
    await finishTurn(assignmentId, {
      state: 'done',
      headline: 'Draft complete: 4 sections',
      artifacts: [{ path: 'docs/x/DESIGN.md' }],
    });
    await finishTurn(assignmentId, { state: 'done', headline: 'Two issues', verdict: REVISE });
    await finishTurn(assignmentId, { state: 'done', headline: 'Revised' });
    await finishTurn(assignmentId, { state: 'done', headline: 'Good now', verdict: ACCEPT });

    const view = harness.conversation(assignmentId);
    expect(view).toMatchObject({
      pattern: 'pair',
      phase: 'converged',
      status: 'closed',
      artifactPath: 'docs/x/DESIGN.md',
      roundsUsed: 2,
    });
    expect(view.rounds.map((round) => round.round)).toEqual([1, 2]);

    const firstRound = view.rounds[0]?.entries ?? [];
    expect(firstRound.map((entry) => entry.type)).toEqual(['turn', 'message', 'turn']);
    expect(firstRound[0]).toMatchObject({
      type: 'turn',
      seat: DRAFTER_SEAT,
      role: 'architect',
      report: { headline: 'Draft complete: 4 sections' },
    });
    expect(firstRound[1]).toMatchObject({
      type: 'message',
      from: 'ada',
      to: 'sam',
      kind: 'handoff',
      delivery: 'inlined',
    });
    expect(view.rounds[1]?.entries.at(-1)).toMatchObject({
      type: 'turn',
      seat: CRITIC_SEAT,
      report: { verdict: { decision: 'accept' } },
    });
    // Every turn carries its session id, so the full transcript is one click away.
    for (const round of view.rounds) {
      for (const entry of round.entries) {
        if (entry.type === 'turn') expect(entry.sessionId).toEqual(expect.any(String));
      }
    }
  });

  it('is stable: two reads of the same assignment produce the same document', async () => {
    const assignmentId = await makePair();
    await finishTurn(assignmentId, { state: 'done', headline: 'Draft' });
    expect(JSON.stringify(harness.conversation(assignmentId))).toBe(
      JSON.stringify(harness.conversation(assignmentId)),
    );
  });

  it('shows mail nobody ever saw as undeliverable once the assignment closed', async () => {
    const assignmentId = await makePair();
    await harness
      .toolset({ assignmentId, agentId: 'sam' })
      .call('send_to_agent', { to: 'ada', kind: 'note', body: 'too late to matter' });
    await harness.service.closeAssignment(assignmentId, 'user_closed');

    const entries = harness.conversation(assignmentId).rounds.flatMap((round) => round.entries);
    // §5.1: "at assignment close, undelivered messages are marked
    // `undeliverable`" — the assignment is closed, so there is no next turn at
    // which the note could still arrive, and the UI must be able to say so.
    expect(entries.find((entry) => entry.type === 'message')).toMatchObject({
      delivery: 'undeliverable',
    });
  });
});

describe('safeJoin', () => {
  it('joins a repo-relative path and refuses anything that escapes the workspace', () => {
    expect(safeJoin('/root', 'docs/x/DESIGN.md')).toContain('DESIGN.md');
    expect(safeJoin('/root', '../secrets.txt')).toBeUndefined();
    expect(safeJoin('/root', 'docs/../../secrets.txt')).toBeUndefined();
  });
});
