/**
 * The assignment budget halt (runner IMPLEMENTATION M8), one `describe` per
 * acceptance bullet.
 *
 * Everything runs against the scripted/controllable `query` of
 * `__tests__/fakeQuery.ts`, because every claim M8 makes is about *when* runner
 * reacts to a number it just wrote — "pauses within one turn of crossing it, not
 * several turns later" — and a turn-by-turn fake is the only way to state that
 * as an assertion rather than a hope.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeTempDir, type TempDir } from './__tests__/helpers.js';
import {
  controllableQuery,
  fakeAssistant,
  fakeResult,
  fakeSessionStateChanged,
  scriptedQuery,
  successScript,
} from './__tests__/fakeQuery.js';
import {
  makeLaunchHarness,
  type LaunchHarness,
  type RecordedEvent,
} from './__tests__/launchHarness.js';
import { budgetAllowsResume, budgetCrossing, budgetHaltPrompt } from './budget.js';

let temp: TempDir;

beforeEach(() => {
  temp = makeTempDir('agentmanager-runner-budget-');
});

afterEach(() => {
  temp.cleanup();
});

function dataRoot(): string {
  return `${temp.path}\\data`;
}

/** One assistant message meters `input 120 + output 30` = 150 billable tokens. */
const TOKENS_PER_MESSAGE = 150;

function eventsOfType(harness: LaunchHarness, type: string): RecordedEvent[] {
  return harness.events.filter((event) => event.type === type);
}

/** The `questions` row the fallback bridge wrote for a halted assignment. */
function budgetCard(
  harness: LaunchHarness,
  assignmentId: string,
): { id: string; kind: string; prompt: string; sessionId: string | null } | undefined {
  const rows = harness.storage.store.questions.listByAssignment(assignmentId);
  const row = rows.find((candidate) => candidate.kind === 'budget_halt');
  return row === undefined
    ? undefined
    : { id: row.id, kind: row.kind, prompt: row.prompt, sessionId: row.sessionId };
}

// ---------------------------------------------------------------------------

describe('the budget halt fires inside the turn that crosses (§7.2)', () => {
  it('pauses within one turn of crossing a small token_budget', async () => {
    const query = controllableQuery();
    const harness = makeLaunchHarness({ dataRoot: dataRoot(), query: query.query });
    try {
      const seed = harness.seed();
      // 100 < 150, so the very first assistant message crosses it.
      harness.storage.store.assignments.update(seed.assignmentId, { tokenBudget: 100 });

      const started = await harness.service.startSession({
        assignmentId: seed.assignmentId,
        agentId: seed.agentId,
        projectId: seed.projectId,
        prompt: 'Spend the budget.',
      });
      await query.started(1);

      // One assistant message, and **no** `result`: the turn has not ended, so a
      // halt that only fired at the turn boundary could not have happened yet.
      await query.sessions[0]?.emit(fakeAssistant({ text: 'working' }));

      const settled = await harness.service.awaitSettled(started.sessionId);
      expect(settled.status).toBe('paused');
      expect(settled.exitReason).toBe('budget_halt');
      // Nothing was allowed to start a second turn.
      expect(settled.turns).toBe(0);
      expect(harness.launch.liveSessionIds()).toEqual([]);
      // §7.2: the slot is released, the **lease is kept**.
      expect(harness.projects.releases).toEqual([]);
    } finally {
      query.endAll();
      harness.close();
    }
  });

  it('references one assignment and one session across the pause, the card and the event', async () => {
    const query = controllableQuery();
    const harness = makeLaunchHarness({ dataRoot: dataRoot(), query: query.query });
    try {
      const seed = harness.seed();
      harness.storage.store.assignments.update(seed.assignmentId, { tokenBudget: 100 });
      const started = await harness.service.startSession({
        assignmentId: seed.assignmentId,
        agentId: seed.agentId,
        projectId: seed.projectId,
        prompt: 'Spend the budget.',
      });
      await query.started(1);
      await query.sessions[0]?.emit(fakeAssistant({ text: 'working' }));
      await harness.service.awaitSettled(started.sessionId);

      // 1 — the event.
      const exceeded = eventsOfType(harness, 'assignment.budget.exceeded');
      expect(exceeded).toHaveLength(1);
      expect(exceeded[0]?.ids).toMatchObject({
        assignmentId: seed.assignmentId,
        sessionId: started.sessionId,
        projectId: seed.projectId,
        agentId: seed.agentId,
      });
      expect(exceeded[0]?.payload).toMatchObject({
        assignmentId: seed.assignmentId,
        tokenBudget: 100,
        tokensUsed: TOKENS_PER_MESSAGE,
        overshoot: TOKENS_PER_MESSAGE - 100,
        sessionId: started.sessionId,
      });
      // It is persisted: orchestrator turns it into `phase: awaiting_user`, and a
      // UI that was not connected still has to be able to replay it.
      expect(exceeded[0]?.persist).toBe(true);

      // 2 — the card, naming the budget and the overshoot.
      const card = budgetCard(harness, seed.assignmentId);
      expect(card).toBeDefined();
      expect(card?.sessionId).toBe(started.sessionId);
      expect(card?.prompt).toContain('100');
      expect(card?.prompt).toContain(`overshoot of ${String(TOKENS_PER_MESSAGE - 100)}`);

      // 3 — the pause, carrying the card that will resume it.
      const paused = eventsOfType(harness, 'session.paused');
      expect(paused).toHaveLength(1);
      expect(paused[0]?.ids.assignmentId).toBe(seed.assignmentId);
      expect(paused[0]?.payload).toMatchObject({
        reason: 'budget_halt',
        questionId: card?.id,
      });
    } finally {
      query.endAll();
      harness.close();
    }
  });
});

// ---------------------------------------------------------------------------

describe('resolving a budget halt (§7.2, M8)', () => {
  it('resumes the parked session when the budget is raised', async () => {
    const query = controllableQuery();
    const harness = makeLaunchHarness({ dataRoot: dataRoot(), query: query.query });
    const unsubscribe = harness.subscribeQuestions();
    try {
      const seed = harness.seed();
      harness.storage.store.assignments.update(seed.assignmentId, { tokenBudget: 100 });
      const started = await harness.service.startSession({
        assignmentId: seed.assignmentId,
        agentId: seed.agentId,
        projectId: seed.projectId,
        prompt: 'Spend the budget.',
      });
      await query.started(1);
      await query.sessions[0]?.emit(fakeAssistant({ text: 'working' }));
      expect((await harness.service.awaitSettled(started.sessionId)).exitReason).toBe(
        'budget_halt',
      );

      const card = budgetCard(harness, seed.assignmentId);
      expect(card).toBeDefined();
      if (card === undefined) return;

      // Orchestrator's side of §7.2: the *row* is what changes, and it is the row
      // runner re-reads before it resumes anything.
      harness.storage.store.assignments.update(seed.assignmentId, { tokenBudget: 1_000_000 });
      harness.storage.store.questions.answer(card.id, {
        answer: { optionIds: ['raise'], labels: ['Raise the budget'] },
        answeredVia: 'local',
      });
      harness.bus.emit({
        type: 'question.answered',
        ids: { assignmentId: seed.assignmentId, sessionId: started.sessionId },
        payload: { questionId: card.id },
        persist: true,
      });
      await Promise.resolve();
      await Promise.resolve();

      // §9.4 path 1: the **same** row, back in the queue and running again.
      await query.started(2);
      expect(harness.sessions.require(started.sessionId).status).toBe('running');
      expect(query.sessions[1]?.resume).toBe(query.sessions[0]?.sdkSessionId);

      query.sessions[1]
        ?.emit(fakeResult({ sessionId: query.sessions[1].sdkSessionId }))
        .catch(() => undefined);
      query.sessions[1]?.end();
      await harness.service.awaitSettled(started.sessionId);
    } finally {
      unsubscribe();
      query.endAll();
      harness.close();
    }
  });

  it('leaves the session paused when the answer did not raise the budget', async () => {
    const query = controllableQuery();
    const harness = makeLaunchHarness({ dataRoot: dataRoot(), query: query.query });
    const unsubscribe = harness.subscribeQuestions();
    try {
      const seed = harness.seed();
      harness.storage.store.assignments.update(seed.assignmentId, { tokenBudget: 100 });
      const started = await harness.service.startSession({
        assignmentId: seed.assignmentId,
        agentId: seed.agentId,
        projectId: seed.projectId,
        prompt: 'Spend the budget.',
      });
      await query.started(1);
      await query.sessions[0]?.emit(fakeAssistant({ text: 'working' }));
      await harness.service.awaitSettled(started.sessionId);

      const card = budgetCard(harness, seed.assignmentId);
      if (card === undefined) throw new Error('no budget card was raised');
      harness.storage.store.questions.answer(card.id, {
        answer: { text: 'not yet' },
        answeredVia: 'local',
      });
      harness.bus.emit({
        type: 'question.answered',
        ids: { assignmentId: seed.assignmentId },
        payload: { questionId: card.id },
        persist: true,
      });
      await Promise.resolve();
      await Promise.resolve();

      expect(harness.sessions.require(started.sessionId).status).toBe('paused');
      expect(query.sessions).toHaveLength(1);
    } finally {
      unsubscribe();
      query.endAll();
      harness.close();
    }
  });

  it('closing the assignment instead leaves it interrupted and releases the lease', async () => {
    const query = controllableQuery();
    const harness = makeLaunchHarness({ dataRoot: dataRoot(), query: query.query });
    try {
      const seed = harness.seed();
      harness.storage.store.assignments.update(seed.assignmentId, { tokenBudget: 100 });
      const started = await harness.service.startSession({
        assignmentId: seed.assignmentId,
        agentId: seed.agentId,
        projectId: seed.projectId,
        prompt: 'Spend the budget.',
      });
      await query.started(1);
      await query.sessions[0]?.emit(fakeAssistant({ text: 'working' }));
      await harness.service.awaitSettled(started.sessionId);
      expect(harness.projects.releases).toEqual([]);

      harness.storage.store.assignments.close(seed.assignmentId, { reason: 'user_closed' });
      await harness.launch.onAssignmentClosed(seed.assignmentId);

      const after = harness.sessions.require(started.sessionId);
      expect(after.status).toBe('interrupted');
      expect(harness.projects.releases).toEqual(['lease-1']);
    } finally {
      query.endAll();
      harness.close();
    }
  });
});

// ---------------------------------------------------------------------------

describe('what the budget halt must never do', () => {
  it('never halts an assignment whose token_budget is null', async () => {
    const script = scriptedQuery({ messages: successScript() });
    const harness = makeLaunchHarness({ dataRoot: dataRoot(), query: script.query });
    try {
      const seed = harness.seed();
      expect(harness.storage.store.assignments.get(seed.assignmentId)?.tokenBudget).toBeNull();

      const started = await harness.service.startSession({
        assignmentId: seed.assignmentId,
        agentId: seed.agentId,
        projectId: seed.projectId,
        prompt: 'Spend freely.',
      });
      const settled = await harness.service.awaitSettled(started.sessionId);

      expect(settled.status).toBe('done');
      expect(eventsOfType(harness, 'assignment.budget.exceeded')).toEqual([]);
      expect(budgetCard(harness, seed.assignmentId)).toBeUndefined();
      // The tokens were still metered — a null budget is "uncapped", not "unmetered".
      expect(harness.storage.store.assignments.get(seed.assignmentId)?.tokensUsed).toBe(
        TOKENS_PER_MESSAGE,
      );
    } finally {
      harness.close();
    }
  });

  it('leaves the SDK’s own maxBudgetUsd trip independent: failed / max_budget_usd', async () => {
    const script = scriptedQuery({
      messages: [
        successScript()[0] as never,
        fakeAssistant({ text: 'that is enough' }),
        fakeResult({ subtype: 'error_max_budget_usd', errors: ['budget exceeded'] }),
        fakeSessionStateChanged('idle'),
      ],
    });
    const harness = makeLaunchHarness({ dataRoot: dataRoot(), query: script.query });
    try {
      const seed = harness.seed();
      const started = await harness.service.startSession({
        assignmentId: seed.assignmentId,
        agentId: seed.agentId,
        projectId: seed.projectId,
        prompt: 'Spend dollars.',
      });
      const settled = await harness.service.awaitSettled(started.sessionId);

      // §7.2: "They are different guards and both are wanted." This one is the
      // SDK's per-session dollar estimate and it does not pause anything.
      expect(settled.status).toBe('failed');
      expect(settled.exitReason).toBe('max_budget_usd');
      expect(eventsOfType(harness, 'assignment.budget.exceeded')).toEqual([]);
    } finally {
      harness.close();
    }
  });
});

// ---------------------------------------------------------------------------

describe('the crossing arithmetic itself (§7.2)', () => {
  const open = { id: 'a1', status: 'open' as const, tokenBudget: 1000, tokensUsed: 0 };

  it('treats the budget as spent when it is reached, and reports the overshoot', () => {
    expect(budgetCrossing({ ...open }, 999)).toBeUndefined();
    expect(budgetCrossing({ ...open }, 1000)).toMatchObject({ overshoot: 0, tokensUsed: 1000 });
    expect(budgetCrossing({ ...open }, 1200)).toMatchObject({ overshoot: 200 });
  });

  it('never crosses a null or nonsensical budget', () => {
    expect(budgetCrossing({ ...open, tokenBudget: null }, 10 ** 9)).toBeUndefined();
    expect(budgetCrossing({ ...open, tokenBudget: 0 }, 10 ** 9)).toBeUndefined();
    expect(budgetCrossing(undefined, 10 ** 9)).toBeUndefined();
  });

  it('allows a resume only on an open assignment with room left', () => {
    expect(budgetAllowsResume({ ...open, tokensUsed: 1200 })).toBe(false);
    expect(budgetAllowsResume({ ...open, tokenBudget: 2000, tokensUsed: 1200 })).toBe(true);
    expect(budgetAllowsResume({ ...open, tokenBudget: null, tokensUsed: 1200 })).toBe(true);
    expect(
      budgetAllowsResume({ ...open, status: 'closed', tokenBudget: null, tokensUsed: 0 }),
    ).toBe(false);
  });

  it('names the assignment, the budget, the overshoot and the sessions in the card', () => {
    const prompt = budgetHaltPrompt(
      { assignmentId: 'a1', tokenBudget: 1000, tokensUsed: 1200, overshoot: 200 },
      ['s1'],
    );
    expect(prompt).toContain('a1');
    expect(prompt).toContain('1000');
    expect(prompt).toContain('1200');
    expect(prompt).toContain('overshoot of 200');
    expect(prompt).toContain('s1');
  });
});
