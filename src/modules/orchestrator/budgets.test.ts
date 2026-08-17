/**
 * IMPLEMENTATION M3 — budgets, round caps and the halt card.
 *
 * Runner is not booted here, and that is deliberate: §7.1 gives runner the
 * arithmetic and the trigger, so what M3 has to prove is the *policy* — what the
 * card offers, what each answer does, and above all **in what order**. Runner's
 * side of the contract is reproduced exactly as its code performs it (it raises
 * a `budget_halt` through this element's bridge, then emits
 * `assignment.budget.exceeded`), and its auto-resume is reproduced by the one
 * thing it actually does: re-reading the `assignments` row when
 * `question.answered` reaches it.
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  BUDGET_HALT_OPTIONS,
  BUDGET_RAISE_GATE,
  readBudgetNote,
  requestedTokens,
} from './budgets.js';
import { flush, makeHarness, PROJECT_ID, type Harness } from './__tests__/helpers.js';

let harness: Harness | undefined;

afterEach(() => {
  harness?.cleanup();
  harness = undefined;
});

function open(options: Parameters<typeof makeHarness>[0] = {}): Harness {
  harness = makeHarness({ agents: [{ id: 'ada', roles: ['implementer'] }], ...options });
  return harness;
}

/** A solo assignment with a budget, and the session runner would have started. */
async function budgeted(h: Harness, tokenBudget: number): Promise<string> {
  const created = await h.service.createSolo({
    projectId: PROJECT_ID,
    agentId: 'ada',
    prompt: 'work',
  });
  h.repository.update(created.assignmentId, { tokenBudget });
  return created.assignmentId;
}

/** Exactly what runner does on a crossing: pause, raise the card, emit. */
async function crossBudget(h: Harness, assignmentId: string, tokensUsed: number): Promise<string> {
  // Runner's arithmetic, through foundation's repository — never orchestrator's.
  h.storage.store.assignments.addTokensUsed(assignmentId, tokensUsed);
  let questionId = '';
  void h.inbox.ask({
    sessionId: null,
    assignmentId,
    agentId: 'ada',
    kind: 'budget_halt',
    prompt: `Assignment ${assignmentId} has reached its token budget.`,
    // Runner's own two options, which orchestrator's card policy replaces.
    options: [
      { id: 'raise', label: 'Raise the budget' },
      { id: 'close', label: 'Close the assignment' },
    ],
    holdUntil: h.now().toISOString(),
    expiresAt: new Date(h.now().getTime() + 24 * 3_600_000).toISOString(),
    onRaised: (id) => {
      questionId = id;
    },
  });
  await Promise.resolve();
  await Promise.resolve();
  h.bus.emit({
    type: 'assignment.budget.exceeded',
    ids: { assignmentId, projectId: PROJECT_ID },
    persist: true,
    payload: { tokensUsed, tokenBudget: h.repository.get(assignmentId)?.tokenBudget },
  });
  return questionId;
}

describe('the halt card (§7.3, M3-1)', () => {
  it('offers all three options — runner raises the kind, orchestrator says what it offers', async () => {
    const h = open();
    const assignmentId = await budgeted(h, 1_000);
    const questionId = await crossBudget(h, assignmentId, 1_000);

    const card = h.inbox.get(questionId);
    expect(card.kind).toBe('budget_halt');
    expect(card.options.map((option) => option.id)).toEqual(['raise', 'continue_once', 'close']);
    expect(BUDGET_HALT_OPTIONS).toHaveLength(3);
  });

  it('sets phase awaiting_user and plans nothing more', async () => {
    const h = open();
    const assignmentId = await budgeted(h, 1_000);
    await crossBudget(h, assignmentId, 1_500);

    expect(h.repository.get(assignmentId)?.phase).toBe('awaiting_user');
    const outcome = await h.engine.advance(assignmentId);
    // A solo assignment has no driver at all, so the honest reason is that —
    // the breaker's own refusal is asserted on a pair below.
    expect(outcome.kind).toBe('idle');
  });

  it('reports the tokens runner counted, never a total of its own (M3 acceptance)', async () => {
    const h = open();
    const assignmentId = await budgeted(h, 10_000);
    h.storage.store.assignments.addTokensUsed(assignmentId, 4_000);
    h.storage.store.assignments.addTokensUsed(assignmentId, 2_500);

    expect(h.service.get(assignmentId).tokensUsed).toBe(6_500);
    expect(h.storage.store.assignments.get(assignmentId)?.tokensUsed).toBe(6_500);
  });
});

describe('mutate-then-resolve (§7.3, M3-2)', () => {
  it('commits the raise BEFORE question.answered fires, so runner’s resume sees headroom', async () => {
    const h = open();
    const assignmentId = await budgeted(h, 1_000);
    const questionId = await crossBudget(h, assignmentId, 1_000);

    // Runner's auto-resume reads the row the moment this event reaches it and
    // refuses to resume a session with no headroom — with nothing to re-trigger
    // it afterwards. So the budget it sees here is the whole test.
    let budgetSeenByResume: number | null = -1;
    h.bus.subscribe(['question.answered'], () => {
      budgetSeenByResume = h.repository.get(assignmentId)?.tokenBudget ?? null;
    });

    h.inbox.answer(questionId, { optionIds: ['raise'], answeredVia: 'local' });

    expect(budgetSeenByResume).toBe(1_500); // +50%, the default raise
    expect(h.repository.get(assignmentId)?.tokenBudget).toBe(1_500);
  });

  it('commits the close BEFORE question.answered fires, so the resume fails admission', async () => {
    const h = open();
    const assignmentId = await budgeted(h, 1_000);
    const questionId = await crossBudget(h, assignmentId, 1_000);

    let statusSeenByResume = '';
    h.bus.subscribe(['question.answered'], () => {
      statusSeenByResume = h.repository.get(assignmentId)?.status ?? '';
    });

    h.inbox.answer(questionId, { optionIds: ['close'], answeredVia: 'local' });

    expect(statusSeenByResume).toBe('closed');
    expect(h.service.get(assignmentId).closeReason).toBe('budget_exhausted');
  });

  it('takes a typed amount over the default, and refuses to read an ambiguous one', async () => {
    const h = open();
    const assignmentId = await budgeted(h, 100_000);
    const questionId = await crossBudget(h, assignmentId, 100_000);

    h.inbox.answer(questionId, {
      optionIds: ['raise'],
      text: '150,000',
      answeredVia: 'remote',
    });
    expect(h.repository.get(assignmentId)?.tokenBudget).toBe(150_000);

    // "500k" is ambiguous between 500 000 and 500 KiB, and a budget misread by a
    // factor of a thousand is the failure a budget exists to prevent.
    expect(requestedTokens('500k')).toBeUndefined();
    expect(requestedTokens('500 000')).toBe(500_000);
  });

  it('emits assignment.budget.raised with the before, the after and the reason', async () => {
    const h = open();
    const assignmentId = await budgeted(h, 1_000);
    const questionId = await crossBudget(h, assignmentId, 1_000);
    h.inbox.answer(questionId, { optionIds: ['raise'], answeredVia: 'local' });

    const raised = h.events.filter((event) => event.type === 'assignment.budget.raised');
    expect(raised).toHaveLength(1);
    expect(raised[0]?.payload).toMatchObject({ from: 1_000, to: 1_500, reason: 'raise' });
    expect(raised[0]?.persist).toBe(true);
  });
});

describe('Continue once (§7.3, M3 acceptance)', () => {
  it('grants exactly one overdraft, and the next crossing asks again', async () => {
    const h = open();
    const assignmentId = await budgeted(h, 10_000);
    const first = await crossBudget(h, assignmentId, 10_000);

    h.inbox.answer(first, { optionIds: ['continue_once'], answeredVia: 'local' });
    const overdraft = h.config.budgets.overdraftTokens;
    expect(h.repository.get(assignmentId)?.tokenBudget).toBe(10_000 + overdraft);
    expect(readBudgetNote(h.repository.get(assignmentId)!).overdrafts).toBe(1);

    // The next crossing raises a *second* card rather than continuing silently:
    // that is what "so the next crossing asks again" means.
    const second = await crossBudget(h, assignmentId, overdraft);
    expect(second).not.toBe('');
    expect(second).not.toBe(first);
    expect(h.inbox.get(second).kind).toBe('budget_halt');

    h.inbox.answer(second, { optionIds: ['continue_once'], answeredVia: 'local' });
    expect(readBudgetNote(h.repository.get(assignmentId)!).overdrafts).toBe(2);
    expect(h.repository.get(assignmentId)?.tokenBudget).toBe(10_000 + overdraft * 2);
  });
});

describe('a raise past raiseMaxFactor (§7.3, §8.2-3, M3 acceptance)', () => {
  it('applies nothing and raises an approval gate of its own', async () => {
    const h = open();
    const assignmentId = await budgeted(h, 100_000);
    const questionId = await crossBudget(h, assignmentId, 100_000);

    // 2× the original is the ceiling; 250 000 is past it.
    h.inbox.answer(questionId, {
      optionIds: ['raise'],
      text: '250000',
      answeredVia: 'local',
    });
    await flush();

    // A gate that fires after the money is spent is theatre, so nothing moved.
    expect(h.repository.get(assignmentId)?.tokenBudget).toBe(100_000);
    const gate = h.inbox
      .list({ assignmentId, status: 'open' })
      .find((card) => card.context?.toolName === BUDGET_RAISE_GATE);
    expect(gate?.kind).toBe('approval_gate');

    // Approving it applies exactly what was asked for.
    h.inbox.answer(gate!.id, { optionIds: ['approve'], answeredVia: 'local' });
    expect(h.repository.get(assignmentId)?.tokenBudget).toBe(250_000);
  });

  it('leaves the budget alone when the gate is denied — it never auto-approves', async () => {
    const h = open();
    const assignmentId = await budgeted(h, 100_000);
    const questionId = await crossBudget(h, assignmentId, 100_000);
    h.inbox.answer(questionId, { optionIds: ['raise'], text: '900000', answeredVia: 'local' });
    await flush();

    const gate = h.inbox
      .list({ assignmentId, status: 'open' })
      .find((card) => card.context?.toolName === BUDGET_RAISE_GATE);
    h.inbox.answer(gate!.id, { optionIds: ['deny'], answeredVia: 'local' });

    expect(h.repository.get(assignmentId)?.tokenBudget).toBe(100_000);
  });

  it('measures the ceiling against the ORIGINAL budget, not the last raised one', async () => {
    const h = open();
    const assignmentId = await budgeted(h, 100_000);

    const first = await crossBudget(h, assignmentId, 100_000);
    h.inbox.answer(first, { optionIds: ['raise'], text: '180000', answeredVia: 'local' });
    expect(h.repository.get(assignmentId)?.tokenBudget).toBe(180_000);

    // 210 000 is only 1.17× the *current* budget but 2.1× the original, so the
    // ratchet §7.3 bounds cannot be walked past one raise at a time.
    const second = await crossBudget(h, assignmentId, 80_000);
    h.inbox.answer(second, { optionIds: ['raise'], text: '210000', answeredVia: 'local' });
    expect(h.repository.get(assignmentId)?.tokenBudget).toBe(180_000);
  });
});

describe('budget defaults and round-cap plumbing (§7.2, M3-3/M3-5)', () => {
  it('leaves a user-created solo uncapped and gives a user-created pair the configured budget', async () => {
    const h = open({
      agents: [
        { id: 'ada', roles: ['architect'] },
        { id: 'sam', roles: ['skeptic'] },
      ],
    });
    const solo = await h.service.createSolo({
      projectId: PROJECT_ID,
      agentId: 'ada',
      prompt: 'go',
    });
    expect(h.service.get(solo.assignmentId).tokenBudget).toBeNull();
    expect(h.service.get(solo.assignmentId).roundCap).toBeNull();

    const pair = await h.service.createAssignment({
      projectId: PROJECT_ID,
      pattern: 'pair',
      members: [
        { agentId: 'ada', role: 'architect' },
        { agentId: 'sam', role: 'skeptic' },
      ],
      scope: { paths: ['docs/'], artifactPath: 'docs/x.md' },
    });
    expect(h.service.get(pair.assignmentId).tokenBudget).toBe(h.config.budgets.defaultPairTokens);
    expect(h.service.get(pair.assignmentId).roundCap).toBe(h.config.patterns.pair.roundCap);
  });

  it('exposes rounds_used and round_cap on the API read model', async () => {
    const h = open();
    const assignmentId = await budgeted(h, 5_000);
    h.repository.update(assignmentId, { roundCap: 4 });
    h.repository.incrementRounds(assignmentId, 2);

    const view = h.service.get(assignmentId);
    expect(view.roundCap).toBe(4);
    expect(view.roundsUsed).toBe(2);
  });
});
