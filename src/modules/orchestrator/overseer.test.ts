/**
 * The overseer pattern end to end — DESIGN §3.5, §7.5, §8.2-1; IMPLEMENTATION
 * M10.
 *
 * `patterns.test.ts` proves what the lead *decides* from a fixture of rows.
 * This proves what the engine, the service and the toolset *do* with those
 * decisions against real storage: the assignment tree, the budget debited from
 * the parent, the write gate that holds a child at `phase: planned`, the review
 * turn that a child's close triggers, and the projection the UI renders the team
 * from.
 *
 * The runner is the same fake `engine.test.ts` uses, for the same reason: session
 * mechanics are runner's own suite's business, and no test here needs a token.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LEAD_SEAT } from './patterns.js';
import { OVERSEER_TOOL_NAMES, WORKER_TOOL_NAMES, type ToolResult } from './toolset.js';
import { endSession, flush, makeHarness, PROJECT_ID, type Harness } from './__tests__/helpers.js';

/** The lead: the overseer **role** and roster §11's capability, which are two facts. */
const IRIS = { id: 'iris', name: 'Iris', roles: ['overseer' as const], overseer: true };
/** Declares the role and not the capability — what §9-6 exists to catch. */
const OLLIE = { id: 'ollie', name: 'Ollie', roles: ['overseer' as const], overseer: false };
const ADA = { id: 'ada', name: 'Ada', roles: ['architect' as const, 'implementer' as const] };
const SAM = { id: 'sam', name: 'Sam', roles: ['skeptic' as const] };

let harness: Harness;

beforeEach(() => {
  harness = makeHarness({ agents: [IRIS, OLLIE, ADA, SAM] });
});

afterEach(() => {
  harness.cleanup();
});

function payloadOf(result: ToolResult): Record<string, unknown> {
  return JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;
}

interface OverseerOptions {
  readonly tokenBudget?: number | null;
  readonly roundCap?: number | null;
  readonly agentId?: string;
}

/** The user creating an overseer assignment — `POST /api/assignments`'s path. */
async function makeOverseer(options: OverseerOptions = {}): Promise<string> {
  const created = await harness.service.createAssignment({
    projectId: PROJECT_ID,
    pattern: 'overseer',
    goal: 'Get the billing subsystem documented',
    members: [{ agentId: options.agentId ?? 'iris', role: 'overseer' }],
    tokenBudget: options.tokenBudget === undefined ? 500_000 : options.tokenBudget,
    ...(options.roundCap === undefined ? {} : { roundCap: options.roundCap }),
  });
  await flush();
  return created.assignmentId;
}

/** The lead's own tools, as roster's `compileSession` mounts them for an overseer. */
function lead(assignmentId: string, agentId = 'iris'): ReturnType<Harness['toolset']> {
  return harness.toolset({ assignmentId, agentId, isOverseer: true });
}

/** The lead minting one child, and the id it got back. */
async function delegate(
  parentId: string,
  args: Readonly<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const result = await lead(parentId).call('create_assignment', {
    pattern: 'solo',
    goal: 'Write the billing plan',
    members: [{ agentId: 'ada', role: 'implementer' }],
    tokenBudget: 100_000,
    scope: { paths: ['docs/billing/'], artifactPath: 'docs/billing/plan.md' },
    ...args,
  });
  await flush();
  return payloadOf(result);
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

/** Finishes whichever turn is in flight for an assignment, reporting first. */
async function finishTurn(
  assignmentId: string,
  body?: Readonly<Record<string, unknown>>,
): Promise<void> {
  const active = harness.turns.active(assignmentId);
  if (active === undefined) throw new Error(`no turn is in flight for ${assignmentId}`);
  harness.advance(1_000);
  if (body !== undefined) await report(assignmentId, active.agentId, body);
  harness.advance(1_000);
  await endSession(harness, active.sessionId ?? '');
}

const ACCEPT = { decision: 'accept', blocking: [], nonBlocking: [] };

// ---------------------------------------------------------------------------

describe('creating an overseer assignment (M10-1, §9-6, §7.2)', () => {
  it('plans the lead’s decomposition turn and nothing else', async () => {
    const assignmentId = await makeOverseer();

    const turns = harness.turns.list(assignmentId);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ round: 1, seat: LEAD_SEAT, agentId: 'iris', status: 'running' });
    expect(harness.runner.started).toHaveLength(1);
    const prompt = harness.runner.started[0]?.prompt ?? '';
    expect(prompt).toContain('You are the lead');
    expect(prompt).toContain('mcp__agentmanager__create_assignment');
    // §16-7's shape holds: one member, and the team is the children (none yet).
    expect(harness.service.get(assignmentId)).toMatchObject({ children: [], childTokensUsed: 0 });
  });

  it('warns rather than refusing a lead without capabilities.overseer, and runs it', async () => {
    // **Owner decision, 2026-08-18**: capabilities rank suggested leads; they do
    // not gate the seating. Ollie declares the role and not the capability.
    const created = await harness.service.createAssignment({
      projectId: PROJECT_ID,
      pattern: 'overseer',
      goal: 'Get the billing subsystem documented',
      members: [{ agentId: 'ollie', role: 'overseer' }],
      tokenBudget: 500_000,
    });
    await flush();

    expect(created.warnings.map((warning) => warning.code)).toContain('lead_not_overseer');
    expect(harness.turns.list(created.assignmentId)).toHaveLength(1);
  });

  it('warns rather than refusing a lead seated in a role it never declared', async () => {
    const created = await harness.service.createAssignment({
      projectId: PROJECT_ID,
      pattern: 'overseer',
      goal: 'Get the billing subsystem documented',
      // Ada declares architect and implementer, and neither is `overseer`.
      members: [{ agentId: 'ada', role: 'overseer' }],
      tokenBudget: 500_000,
    });
    await flush();

    expect(created.warnings.map((warning) => warning.code).sort()).toEqual([
      'lead_not_overseer',
      'role_not_declared',
    ]);
    // It leads: the turn is planned for Ada, and the session compiles without
    // the addendum it never had (roster's `roles/<role>.md` lookup is optional).
    expect(harness.turns.list(created.assignmentId)[0]).toMatchObject({
      seat: LEAD_SEAT,
      agentId: 'ada',
    });
    expect(harness.runner.started.at(-1)).toMatchObject({ agentId: 'ada', role: 'overseer' });
  });

  it('refuses an uncapped overseer assignment — an unbounded tree (§7.2)', async () => {
    await expect(makeOverseer({ tokenBudget: null })).rejects.toMatchObject({
      refusals: [expect.objectContaining({ code: 'budget_required' })],
    });
  });

  it('defaults the round cap from configuration, since round 1 decomposes (§3.5)', async () => {
    const assignmentId = await makeOverseer();
    expect(harness.service.get(assignmentId).roundCap).toBe(
      harness.config.patterns.overseer.roundCap,
    );
  });
});

describe('the lead’s tools are mounted, the workers’ are not (§4.1)', () => {
  it('grants the coordinator tools by the seat, not by the roster flag', async () => {
    // **Owner decision, 2026-08-18.** Ada declares no `capabilities.overseer`,
    // so roster's flag is false — and she holds the lead seat, so the two
    // coordinator tools are hers. A lead that cannot create a child assignment
    // is a lead in name only.
    const created = await harness.service.createAssignment({
      projectId: PROJECT_ID,
      pattern: 'overseer',
      goal: 'Get the billing subsystem documented',
      members: [{ agentId: 'ada', role: 'overseer' }],
      tokenBudget: 500_000,
    });
    await flush();

    const seated = harness.toolset({ assignmentId: created.assignmentId, agentId: 'ada' });
    expect(seated.toolNames).toEqual([...OVERSEER_TOOL_NAMES]);
    const child = await seated.call('create_assignment', {
      pattern: 'solo',
      goal: 'Write the billing plan',
      members: [{ agentId: 'sam', role: 'skeptic' }],
      tokenBudget: 50_000,
    });
    expect(child.isError).toBeUndefined();

    // The same agent in a *worker* seat of another assignment gets four: it is
    // the seat that grants, and Ada holds no lead seat there.
    const pair = await harness.service.createAssignment({
      projectId: PROJECT_ID,
      pattern: 'pair',
      goal: 'Draft something',
      members: [
        { agentId: 'ada', role: 'architect' },
        { agentId: 'sam', role: 'skeptic' },
      ],
      scope: { paths: ['docs/x/'], artifactPath: 'docs/x/DESIGN.md' },
    });
    await flush();
    expect(
      harness.toolset({ assignmentId: pair.assignmentId, agentId: 'ada' }).toolNames,
    ).toEqual([...WORKER_TOOL_NAMES]);
  });

  it('gives the lead all six and a child’s worker exactly four', async () => {
    const parentId = await makeOverseer();
    const child = await delegate(parentId, {});
    const childId = child['assignmentId'] as string;

    // `isOverseer` is roster's reading of `capabilities.overseer`
    // (`compileSession`), so this is the split a live launch gets.
    expect(lead(parentId).toolNames).toEqual([...OVERSEER_TOOL_NAMES]);
    expect(harness.toolset({ assignmentId: childId, agentId: 'ada' }).toolNames).toEqual([
      ...WORKER_TOOL_NAMES,
    ]);

    const refused = await harness
      .toolset({ assignmentId: childId, agentId: 'ada' })
      .call('create_assignment', { pattern: 'solo', goal: 'more work', members: [], tokenBudget: 1 });
    expect(payloadOf(refused)['code']).toBe('not_an_overseer');
  });
});

describe('minting children debits the parent (M10-2, §7.5, §9-8)', () => {
  it('sets parent_assignment_id, names the caller, and launches the child’s one turn', async () => {
    const parentId = await makeOverseer();
    const childId = (await delegate(parentId, {}))['assignmentId'] as string;

    const child = harness.service.get(childId);
    expect(child).toMatchObject({
      parentAssignmentId: parentId,
      createdBy: 'overseer:iris',
      projectId: PROJECT_ID,
      tokenBudget: 100_000,
    });
    // §3.5: a machine-created solo has no other launcher, so the engine drives
    // its single turn. Two sessions are now live: the lead's and the child's.
    expect(harness.turns.list(childId)).toHaveLength(1);
    expect(harness.runner.started).toHaveLength(2);
    expect(harness.runner.started[1]).toMatchObject({ assignmentId: childId, agentId: 'ada' });
  });

  it('refuses a child whose budget is more than the parent’s remainder', async () => {
    const parentId = await makeOverseer({ tokenBudget: 120_000 });
    await delegate(parentId, {}); // 100 000 reserved
    const second = await lead(parentId).call('create_assignment', {
      pattern: 'solo',
      goal: 'spend what is left twice',
      members: [{ agentId: 'sam', role: 'skeptic' }],
      tokenBudget: 100_000,
    });

    expect(second.isError).toBe(true);
    const refusals = (payloadOf(second)['detail'] as { refusals: { code: string }[] }).refusals;
    expect(refusals.map((one) => one.code)).toContain('budget_exceeds_parent');
  });

  it('keeps a closed child’s spend against the remainder, so it never heals (§7.5)', async () => {
    const parentId = await makeOverseer({ tokenBudget: 120_000 });
    const childId = (await delegate(parentId, {}))['assignmentId'] as string;

    // The child spends 90 000 and finishes. Its reservation is released — and
    // what it actually spent takes the reservation's place.
    harness.storage.store.assignments.addTokensUsed(childId, 90_000);
    await finishTurn(childId, { state: 'done', headline: 'Plan written' });
    expect(harness.service.get(childId).status).toBe('closed');

    const refused = await lead(parentId).call('create_assignment', {
      pattern: 'solo',
      goal: 'the same tokens twice',
      members: [{ agentId: 'sam', role: 'skeptic' }],
      tokenBudget: 31_000,
    });
    const refusals = (payloadOf(refused)['detail'] as { refusals: { code: string }[] }).refusals;
    expect(refusals.map((one) => one.code)).toContain('budget_exceeds_parent');

    // 30 000 is exactly what is left, and it is accepted.
    const fits = await lead(parentId).call('create_assignment', {
      pattern: 'solo',
      goal: 'what is genuinely left',
      members: [{ agentId: 'sam', role: 'skeptic' }],
      tokenBudget: 30_000,
    });
    expect(fits.isError).toBeUndefined();
  });

  it('rolls the children’s spend up onto the parent’s projection (§16-8)', async () => {
    const parentId = await makeOverseer();
    const childId = (await delegate(parentId, {}))['assignmentId'] as string;
    harness.storage.store.assignments.addTokensUsed(childId, 40_000);
    harness.storage.store.assignments.addTokensUsed(parentId, 5_000);

    const parent = harness.service.get(parentId);
    // Two numbers, not one: `tokensUsed` stays exactly what runner metered onto
    // this row (§7.1), and the tree total is `tokensUsed + childTokensUsed`.
    expect(parent.tokensUsed).toBe(5_000);
    expect(parent.childTokensUsed).toBe(40_000);
  });
});

describe('the write gate on a write-capable child (§8.2-1, §9-10)', () => {
  it('creates it at phase planned, starts nothing, and starts it when approved', async () => {
    const parentId = await makeOverseer();
    const before = harness.runner.started.length;

    const child = await delegate(parentId, { write: true });
    const childId = child['assignmentId'] as string;
    expect(child['phase']).toBe('planned');
    expect(child['gate']).toBeDefined();
    // Nothing the model said widened this: the gate is decided by §9-10 in the
    // validator, and the child holds no session at all until a human answers.
    expect(harness.runner.started.length).toBe(before);
    expect(harness.turns.list(childId)).toHaveLength(0);

    const card = harness.inbox.list({ assignmentId: childId, status: 'open' })[0];
    expect(card?.kind).toBe('approval_gate');
    harness.inbox.answer(card?.id ?? '', { optionIds: ['approve'], answeredVia: 'local' });
    await flush();

    expect(harness.service.get(childId).phase).toBe('running');
    expect(harness.turns.list(childId)).toHaveLength(1);
  });

  it('closes the child gate_denied when the gate is refused, and leaves the parent open', async () => {
    const parentId = await makeOverseer();
    const childId = (await delegate(parentId, { write: true }))['assignmentId'] as string;

    const card = harness.inbox.list({ assignmentId: childId, status: 'open' })[0];
    harness.inbox.answer(card?.id ?? '', { optionIds: ['deny'], answeredVia: 'local' });
    await flush();

    expect(harness.service.get(childId)).toMatchObject({
      status: 'closed',
      closeReason: 'gate_denied',
    });
    expect(harness.service.get(parentId).status).toBe('open');
  });
});

describe('the review round (M10-2, §3.5)', () => {
  it('waits while the child runs, then reviews it with its artifact when it closes', async () => {
    const parentId = await makeOverseer();
    const childId = (await delegate(parentId, {}))['assignmentId'] as string;

    await finishTurn(parentId, { state: 'done', headline: 'Delegated one work item' });
    // The lead's turn is over and the child is still running: no new turn.
    expect(harness.turns.list(parentId)).toHaveLength(1);
    expect(await harness.engine.advance(parentId)).toEqual({
      kind: 'idle',
      reason: 'children_running',
    });

    await finishTurn(childId, {
      state: 'done',
      headline: 'Plan written: 4 sections',
      artifacts: [{ path: 'docs/billing/plan.md' }],
    });

    // Closing the child is what drives the parent (§3.5's trigger).
    expect(harness.service.get(childId)).toMatchObject({
      status: 'closed',
      closeReason: 'converged',
    });
    const turns = harness.turns.list(parentId);
    expect(turns).toHaveLength(2);
    expect(turns[1]).toMatchObject({ round: 2, seat: LEAD_SEAT, status: 'running' });

    const prompt = harness.runner.started.at(-1)?.prompt ?? '';
    expect(prompt).toContain('docs/billing/plan.md');
    expect(prompt).toContain('A report is a claim');
    expect(prompt).toContain('Plan written: 4 sections');
    expect(prompt).toContain(childId);
  });

  it('converges when the lead accepts, and closes with §2.2’s completion phase', async () => {
    const parentId = await makeOverseer();
    const childId = (await delegate(parentId, {}))['assignmentId'] as string;
    await finishTurn(parentId, { state: 'done', headline: 'Delegated one work item' });
    await finishTurn(childId, { state: 'done', headline: 'Plan written' });
    await finishTurn(parentId, {
      state: 'done',
      headline: 'Read the plan; it is right',
      verdict: ACCEPT,
    });

    expect(harness.service.get(parentId)).toMatchObject({
      status: 'closed',
      phase: 'converged',
      closeReason: 'converged',
      roundsUsed: 2,
    });
  });

  it('halts review_unresolved when the lead asks for revisions it did not delegate', async () => {
    const parentId = await makeOverseer();
    const childId = (await delegate(parentId, {}))['assignmentId'] as string;
    await finishTurn(parentId, { state: 'done', headline: 'Delegated one work item' });
    await finishTurn(childId, { state: 'done', headline: 'Plan written' });
    await finishTurn(parentId, {
      state: 'needs_review',
      headline: 'The rollback section is missing',
      verdict: {
        decision: 'revise',
        blocking: [{ severity: 'high', summary: 'no rollback section' }],
        nonBlocking: [],
      },
    });

    const parent = harness.service.get(parentId);
    expect(parent).toMatchObject({ status: 'open', phase: 'halted', haltReason: 'review_unresolved' });
    // Exactly one card, and it is a gate the user answers — not a second halt.
    const cards = harness.inbox.list({ assignmentId: parentId, status: 'open' });
    expect(cards).toHaveLength(1);
    expect(cards[0]?.kind).toBe('approval_gate');
    expect(
      harness.events.filter((event) => event.type === 'assignment.halted'),
    ).toHaveLength(1);
  });
});

describe('the projection the UI renders the team from (M10-4, §11.1, §11.2)', () => {
  it('carries every child’s id, goal, phase, outcome and tokens', async () => {
    const parentId = await makeOverseer();
    const first = (await delegate(parentId, { goal: 'Write the plan' }))['assignmentId'] as string;
    const second = (await delegate(parentId, {
      goal: 'Review the retention policy',
      members: [{ agentId: 'sam', role: 'skeptic' }],
      tokenBudget: 50_000,
    }))['assignmentId'] as string;
    harness.storage.store.assignments.addTokensUsed(first, 12_000);

    const view = harness.service.get(parentId);
    expect(view.children.map((child) => child.id)).toEqual([first, second]);
    expect(view.children[0]).toMatchObject({
      goal: 'Write the plan',
      pattern: 'solo',
      status: 'open',
      phase: 'running',
      closeReason: null,
      tokenBudget: 100_000,
      tokensUsed: 12_000,
      artifactPath: 'docs/billing/plan.md',
      members: [{ agentId: 'ada', role: 'implementer' }],
    });
    expect(view.childTokensUsed).toBe(12_000);

    // The conversation view serves the same shape, so the UI parses one type.
    const conversation = harness.conversation(parentId);
    expect(conversation.children.map((child) => child.id)).toEqual([first, second]);
    expect(conversation.childTokensUsed).toBe(12_000);
  });

  it('leaves it empty for an assignment nobody decomposed', async () => {
    const solo = await harness.service.createSolo({
      projectId: PROJECT_ID,
      agentId: 'ada',
      prompt: 'do a thing',
    });
    expect(harness.service.get(solo.assignmentId)).toMatchObject({
      children: [],
      childTokensUsed: 0,
    });
  });
});

describe('halt semantics across the tree (§7.5, §8.1)', () => {
  it('halts the child that exhausted its own budget, not the tree', async () => {
    const parentId = await makeOverseer({ tokenBudget: 500_000 });
    const childId = (await delegate(parentId, {}))['assignmentId'] as string;

    harness.storage.store.assignments.addTokensUsed(childId, 100_000);
    expect(await harness.engine.advance(childId)).toMatchObject({ reason: 'budget_exhausted' });
    expect(harness.service.get(childId).phase).toBe('awaiting_user');

    // The parent has 400 000 of its own budget left, so it keeps planning.
    await finishTurn(parentId, { state: 'done', headline: 'Delegated one work item' });
    expect(harness.service.get(parentId).phase).toBe('running');
  });

  it('halts the parent when the tree has spent the parent’s budget', async () => {
    const parentId = await makeOverseer({ tokenBudget: 120_000 });
    const childId = (await delegate(parentId, {}))['assignmentId'] as string;
    harness.storage.store.assignments.addTokensUsed(childId, 100_000);
    harness.storage.store.assignments.addTokensUsed(parentId, 20_000);

    // Nothing was written to the parent's own `tokens_used` beyond what runner
    // metered onto it; the crossing is the *rollup* (§7.5).
    expect(await harness.engine.advance(parentId, { manual: true })).toMatchObject({
      kind: 'awaiting_user',
      reason: 'budget_exhausted',
    });
    expect(harness.service.get(parentId).phase).toBe('awaiting_user');
  });

  it('closes the still-open children when the parent closes', async () => {
    const parentId = await makeOverseer();
    const childId = (await delegate(parentId, {}))['assignmentId'] as string;

    await harness.service.closeAssignment(parentId, 'user_closed');
    await flush();

    // Not `converged`: the child did not converge, it was stopped because its
    // parent was, and §2.2's completion phase is a claim about the work.
    expect(harness.service.get(childId)).toMatchObject({
      status: 'closed',
      closeReason: 'user_closed',
      phase: 'closed',
    });
  });
});
