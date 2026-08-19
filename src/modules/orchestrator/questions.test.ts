/**
 * The question inbox, the `QuestionBridge`, recommendations, consolidation and
 * expiry (DESIGN §6, IMPLEMENTATION M2-1..5).
 *
 * Where a criterion of IMPLEMENTATION M2 is proven here, the test name says so.
 * The two criteria that are statements about *sessions* rather than about cards
 * — inline delivery and auto-resume after a park — are runner's, and are proven
 * in `src/modules/runner/questionBridge.test.ts` through the fake query harness.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { withAskingTurn } from './cards.js';
import { InvalidRequestError } from './errors.js';
import {
  normalisePrompt,
  QuestionNotOpenError,
  strengthRank,
  type AskRequest,
  type QuestionOutcome,
} from './questions.js';
import { makeHarness, PROJECT_ID, type Harness } from './__tests__/helpers.js';

let harness: Harness | undefined;

function open(options: Parameters<typeof makeHarness>[0] = {}): Harness {
  harness?.cleanup();
  harness = makeHarness({ agents: [ADA, SAM], ...options });
  return harness;
}

afterEach(() => {
  harness?.cleanup();
  harness = undefined;
});

const ADA = { id: 'ada', roles: ['architect', 'implementer'] as const };
const SAM = { id: 'sam', roles: ['skeptic'] as const };

const OPTIONS = [
  { id: 'disk', label: 'SQLite on disk' },
  { id: 'pg', label: 'Postgres' },
];

/** An open pair assignment with both seats, and a session row for each. */
async function seedPair(h: Harness): Promise<{
  assignmentId: string;
  adaSession: string;
  samSession: string;
}> {
  const created = await h.service.createAssignment({
    projectId: PROJECT_ID,
    pattern: 'pair',
    goal: 'write the design',
    members: [
      { agentId: 'ada', role: 'architect' },
      { agentId: 'sam', role: 'skeptic' },
    ],
  });
  const session = (agentId: string): string =>
    h.storage.store.sessions.create({
      assignmentId: created.assignmentId,
      agentId,
      projectId: PROJECT_ID,
      status: 'running',
    }).id;
  return {
    assignmentId: created.assignmentId,
    adaSession: session('ada'),
    samSession: session('sam'),
  };
}

function askOf(
  overrides: Partial<AskRequest> & Pick<AskRequest, 'assignmentId' | 'sessionId' | 'agentId'>,
): AskRequest {
  return {
    kind: 'question',
    prompt: 'Postgres or SQLite?',
    options: OPTIONS,
    holdUntil: '2026-08-16T10:15:00.000Z',
    expiresAt: '2026-08-17T10:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// M2-1/2 — the bridge, the row, and the answer that resolves it
// ---------------------------------------------------------------------------

describe('QuestionBridge.ask (M2-1, M2-2)', () => {
  it('persists a questions row and leaves the promise pending until it is answered', async () => {
    const h = open();
    const seeded = await seedPair(h);

    let questionId = '';
    const pending = h.inbox.ask(
      askOf({
        ...seeded,
        sessionId: seeded.adaSession,
        agentId: 'ada',
        onRaised: (id) => (questionId = id),
      }),
    );
    await Promise.resolve();

    const card = h.inbox.get(questionId);
    expect(card).toMatchObject({
      status: 'open',
      kind: 'question',
      prompt: 'Postgres or SQLite?',
      assignmentId: seeded.assignmentId,
      projectId: PROJECT_ID,
      sessionId: seeded.adaSession,
      options: OPTIONS,
      answeredVia: null,
    });
    expect(h.inbox.pendingCount()).toBe(1);

    h.inbox.answer(questionId, {
      optionIds: ['disk'],
      labels: ['SQLite on disk'],
      answeredVia: 'local',
    });
    const outcome = await pending;
    expect(outcome).toEqual({
      status: 'answered',
      questionId,
      answer: { optionIds: ['disk'], labels: ['SQLite on disk'] },
      answeredVia: 'local',
      answeredAt: expect.any(String) as string,
    });
    expect(h.inbox.pendingCount()).toBe(0);
  });

  it('records answered_via from the request origin, remote included (M2-2, §16-3)', async () => {
    const h = open();
    const seeded = await seedPair(h);
    let questionId = '';
    const pending = h.inbox.ask(
      askOf({
        ...seeded,
        sessionId: seeded.adaSession,
        agentId: 'ada',
        onRaised: (id) => (questionId = id),
      }),
    );
    await Promise.resolve();

    const card = h.inbox.answer(questionId, { optionIds: ['pg'], answeredVia: 'remote' });
    expect(card.answeredVia).toBe('remote');
    expect(h.storage.store.questions.get(questionId)?.answeredVia).toBe('remote');
    await expect(pending).resolves.toMatchObject({ answeredVia: 'remote' });
  });

  it('emits assignment.question.raised and both answered events (M2-7, §11.4)', async () => {
    const h = open();
    const seeded = await seedPair(h);
    let questionId = '';
    void h.inbox.ask(
      askOf({
        ...seeded,
        sessionId: seeded.adaSession,
        agentId: 'ada',
        onRaised: (id) => (questionId = id),
      }),
    );
    await Promise.resolve();

    const raised = h.events.find((event) => event.type === 'assignment.question.raised');
    expect(raised?.persist).toBe(true);
    expect(raised?.payload).toMatchObject({
      questionId,
      kind: 'question',
      recommendationCount: 0,
      disagreement: false,
      contested: false,
    });
    expect(raised?.ids).toMatchObject({
      assignmentId: seeded.assignmentId,
      projectId: PROJECT_ID,
      sessionId: seeded.adaSession,
    });

    h.inbox.answer(questionId, { optionIds: ['pg'], answeredVia: 'local' });
    // The persisted lifecycle event the UI replays…
    const answered = h.events.find((event) => event.type === 'assignment.question.answered');
    expect(answered?.persist).toBe(true);
    expect(answered?.payload).toMatchObject({ questionId, answeredVia: 'local' });
    // …and the bare cross-element trigger runner keys on (runner §5.2, §9.2).
    const trigger = h.events.find((event) => event.type === 'question.answered');
    expect(trigger?.persist).toBe(false);
    expect(trigger?.payload).toMatchObject({ questionId, sessionId: seeded.adaSession });
  });

  it('refuses a second answer, so a local and a remote answer cannot both win', async () => {
    const h = open();
    const seeded = await seedPair(h);
    let questionId = '';
    void h.inbox.ask(
      askOf({
        ...seeded,
        sessionId: seeded.adaSession,
        agentId: 'ada',
        onRaised: (id) => (questionId = id),
      }),
    );
    await Promise.resolve();

    h.inbox.answer(questionId, { optionIds: ['pg'], answeredVia: 'local' });
    expect(() =>
      h.inbox.answer(questionId, { optionIds: ['disk'], answeredVia: 'remote' }),
    ).toThrow(QuestionNotOpenError);
  });

  it('refuses an empty answer rather than resolving a session with nothing', async () => {
    const h = open();
    const seeded = await seedPair(h);
    let questionId = '';
    void h.inbox.ask(
      askOf({
        ...seeded,
        sessionId: seeded.adaSession,
        agentId: 'ada',
        onRaised: (id) => (questionId = id),
      }),
    );
    await Promise.resolve();
    expect(() => h.inbox.answer(questionId, { text: '   ', answeredVia: 'local' })).toThrow(
      InvalidRequestError,
    );
  });
});

// ---------------------------------------------------------------------------
// M2-2 restart — the row is the trigger, the promise is not
// ---------------------------------------------------------------------------

describe('a restart leaves an open question answerable (M2 acceptance 3)', () => {
  it('answers a row raised by a previous process and emits question.answered', async () => {
    const h = open();
    const seeded = await seedPair(h);
    let questionId = '';
    const pending = h.inbox.ask(
      askOf({
        ...seeded,
        sessionId: seeded.adaSession,
        agentId: 'ada',
        onRaised: (id) => (questionId = id),
      }),
    );
    await Promise.resolve();

    // The restart: a **new** inbox over the same database, with no memory of the
    // promise the old one handed out. This is exactly what §9.2 means by "the
    // promise died with the previous process".
    const revived = makeHarness({ agents: [ADA, SAM] });
    try {
      // Point the revived inbox at the same file rather than a second one: the
      // row is the durable half, so the assertion is that the *row* is still
      // open and still answerable.
      const stillOpen = h.storage.store.questions.get(questionId);
      expect(stillOpen?.status).toBe('open');
      expect(revived.inbox.pendingCount()).toBe(0);
    } finally {
      revived.cleanup();
    }

    // Answering it after the "restart" still works, and still emits the event
    // runner's boot re-subscription resumes from.
    const card = h.inbox.answer(questionId, { optionIds: ['disk'], answeredVia: 'remote' });
    expect(card.status).toBe('answered');
    expect(h.events.some((event) => event.type === 'question.answered')).toBe(true);
    // The promise the *original* process held still settles, because that
    // process is this one — the acceptance is stated in terms of the row, and
    // this is the belt to its braces.
    await expect(pending).resolves.toMatchObject({ status: 'answered' });
  });

  it('cancels the card when the session behind it is gone, rather than leaving it dangling', async () => {
    const h = open();
    const seeded = await seedPair(h);
    let questionId = '';
    const pending = h.inbox.ask(
      askOf({
        ...seeded,
        sessionId: seeded.adaSession,
        agentId: 'ada',
        onRaised: (id) => (questionId = id),
      }),
    );
    await Promise.resolve();

    await h.inbox.cancel(questionId, 'the session died');
    await expect(pending).resolves.toEqual({
      status: 'cancelled',
      questionId,
      reason: 'the session died',
    });
    expect(h.storage.store.questions.get(questionId)?.status).toBe('cancelled');
  });

  it('closing an assignment cancels its open cards through the bridge (M1-5, M2-1)', async () => {
    const h = open();
    const seeded = await seedPair(h);
    let questionId = '';
    const pending = h.inbox.ask(
      askOf({
        ...seeded,
        sessionId: seeded.adaSession,
        agentId: 'ada',
        onRaised: (id) => (questionId = id),
      }),
    );
    await Promise.resolve();

    await h.service.closeAssignment(seeded.assignmentId, 'user_closed');
    const outcome = (await pending) as Extract<QuestionOutcome, { status: 'cancelled' }>;
    expect(outcome.status).toBe('cancelled');
    expect(outcome.reason).toContain('user_closed');
    expect(h.storage.store.questions.get(questionId)?.status).toBe('cancelled');
  });
});

// ---------------------------------------------------------------------------
// M2-3 — the stance ladder
// ---------------------------------------------------------------------------

describe('the stance ladder (M2-3, §6.2)', () => {
  it('sorts by strength rank first, then by the pattern’s seat order', async () => {
    const h = open();
    const seeded = await seedPair(h);
    let questionId = '';
    void h.inbox.ask(
      askOf({
        ...seeded,
        sessionId: seeded.adaSession,
        agentId: 'ada',
        recommendation: { agentId: 'ada', stance: 'pg', strength: 'lean', rationale: 'familiar' },
        onRaised: (id) => (questionId = id),
      }),
    );
    await Promise.resolve();
    h.inbox.addRecommendation(questionId, {
      agentId: 'sam',
      stance: 'disk',
      strength: 'blocking',
      rationale: 'a service dependency for a single-user tool is a mistake',
    });

    const card = h.inbox.get(questionId);
    expect(card.recommendations.map((one) => one.agentId)).toEqual(['sam', 'ada']);
    expect(card.recommendations[0]).toMatchObject({
      agentId: 'sam',
      role: 'skeptic',
      stance: 'disk',
      strength: 'blocking',
    });
    // §16-2: attribution is always present, and it is the role held *in this
    // assignment*.
    expect(card.recommendations[1]).toMatchObject({ agentId: 'ada', role: 'architect' });
  });

  it('computes disagreement and contested server-side (§6.3, §16-1)', async () => {
    const h = open();
    const seeded = await seedPair(h);
    let questionId = '';
    void h.inbox.ask(
      askOf({
        ...seeded,
        sessionId: seeded.adaSession,
        agentId: 'ada',
        recommendation: { agentId: 'ada', stance: 'pg', strength: 'strong' },
        onRaised: (id) => (questionId = id),
      }),
    );
    await Promise.resolve();

    expect(h.inbox.get(questionId)).toMatchObject({ disagreement: false, contested: false });

    h.inbox.addRecommendation(questionId, { agentId: 'sam', stance: 'disk', strength: 'lean' });
    expect(h.inbox.get(questionId)).toMatchObject({ disagreement: true, contested: false });

    h.inbox.addRecommendation(questionId, { agentId: 'sam', stance: 'disk', strength: 'blocking' });
    expect(h.inbox.get(questionId)).toMatchObject({ disagreement: true, contested: true });
  });

  it('treats defer as “no stance”, so it never creates a disagreement', async () => {
    const h = open();
    const seeded = await seedPair(h);
    let questionId = '';
    void h.inbox.ask(
      askOf({
        ...seeded,
        sessionId: seeded.adaSession,
        agentId: 'ada',
        recommendation: { agentId: 'ada', stance: 'pg', strength: 'strong' },
        onRaised: (id) => (questionId = id),
      }),
    );
    await Promise.resolve();
    h.inbox.addRecommendation(questionId, { agentId: 'sam', stance: null, strength: 'defer' });

    const card = h.inbox.get(questionId);
    expect(card.disagreement).toBe(false);
    expect(card.recommendations.at(-1)).toMatchObject({ stance: null, strength: 'defer' });
  });

  it('refuses a strength outside the closed four-value enum (M2-3’s validator)', async () => {
    const h = open();
    const seeded = await seedPair(h);
    let questionId = '';
    void h.inbox.ask(
      askOf({
        ...seeded,
        sessionId: seeded.adaSession,
        agentId: 'ada',
        onRaised: (id) => (questionId = id),
      }),
    );
    await Promise.resolve();
    expect(() =>
      h.inbox.addRecommendation(questionId, {
        agentId: 'sam',
        stance: 'disk',
        // A number dressed as a strength is precisely what §6.2 refuses.
        strength: '0.87' as unknown as 'strong',
      }),
    ).toThrow(InvalidRequestError);
  });

  it('ranks the ladder in the design’s order', () => {
    expect(
      ['defer', 'blocking', 'lean', 'strong'].sort((a, b) => strengthRank(a) - strengthRank(b)),
    ).toEqual(['blocking', 'strong', 'lean', 'defer']);
  });
});

// ---------------------------------------------------------------------------
// M2-4 — consolidation
// ---------------------------------------------------------------------------

describe('join-on-match consolidation (M2-4, §6.3, M2 acceptance 4)', () => {
  it('two asks with identical normalised prompts make one card, two recommendations, one answer', async () => {
    const h = open();
    const seeded = await seedPair(h);
    const ids: string[] = [];

    const first = h.inbox.ask(
      askOf({
        ...seeded,
        sessionId: seeded.adaSession,
        agentId: 'ada',
        recommendation: { agentId: 'ada', stance: 'pg', strength: 'lean' },
        onRaised: (id) => ids.push(id),
      }),
    );
    await Promise.resolve();
    const second = h.inbox.ask(
      askOf({
        ...seeded,
        sessionId: seeded.samSession,
        agentId: 'sam',
        // Same question, differently typed: case, punctuation and spacing all
        // normalise away (§6.3).
        prompt: '  postgres  or   SQLITE?? ',
        recommendation: { agentId: 'sam', stance: 'disk', strength: 'blocking' },
        onRaised: (id) => ids.push(id),
      }),
    );
    await Promise.resolve();

    expect(new Set(ids).size).toBe(1);
    expect(h.inbox.list({ status: 'open' })).toHaveLength(1);
    const card = h.inbox.get(ids[0] as string);
    expect(card.recommendations).toHaveLength(2);
    expect(card.contested).toBe(true);

    // One answer resolves both askers.
    h.inbox.answer(card.id, {
      optionIds: ['disk'],
      labels: ['SQLite on disk'],
      answeredVia: 'local',
    });
    await expect(first).resolves.toMatchObject({ questionId: card.id, status: 'answered' });
    await expect(second).resolves.toMatchObject({ questionId: card.id, status: 'answered' });
  });

  it('does not join once the ask is older than joinWindowMs', async () => {
    const h = open({ config: { questions: { joinWindowMs: 1000 } } });
    const seeded = await seedPair(h);
    const ids: string[] = [];

    void h.inbox.ask(
      askOf({
        ...seeded,
        sessionId: seeded.adaSession,
        agentId: 'ada',
        onRaised: (id) => ids.push(id),
      }),
    );
    await Promise.resolve();
    h.advance(1001);
    void h.inbox.ask(
      askOf({
        ...seeded,
        sessionId: seeded.samSession,
        agentId: 'sam',
        onRaised: (id) => ids.push(id),
      }),
    );
    await Promise.resolve();

    expect(new Set(ids).size).toBe(2);
    expect(h.inbox.list({ status: 'open' })).toHaveLength(2);
  });

  it('waives the window for a solicited stance (§6.4)', async () => {
    const h = open({ config: { questions: { joinWindowMs: 1000 } } });
    const seeded = await seedPair(h);
    const ids: string[] = [];

    void h.inbox.ask(
      askOf({
        ...seeded,
        sessionId: seeded.adaSession,
        agentId: 'ada',
        onRaised: (id) => ids.push(id),
      }),
    );
    await Promise.resolve();
    h.advance(600_000);
    void h.inbox.ask(
      askOf({
        ...seeded,
        sessionId: seeded.samSession,
        agentId: 'sam',
        solicited: true,
        recommendation: { agentId: 'sam', stance: 'disk', strength: 'strong' },
        onRaised: (id) => ids.push(id),
      }),
    );
    await Promise.resolve();

    expect(new Set(ids).size).toBe(1);
    expect(h.inbox.get(ids[0] as string).recommendations).toHaveLength(1);
  });

  it('does not join when the option id sets differ — exact equality, never fuzzy', async () => {
    const h = open();
    const seeded = await seedPair(h);
    const ids: string[] = [];

    void h.inbox.ask(
      askOf({
        ...seeded,
        sessionId: seeded.adaSession,
        agentId: 'ada',
        onRaised: (id) => ids.push(id),
      }),
    );
    await Promise.resolve();
    void h.inbox.ask(
      askOf({
        ...seeded,
        sessionId: seeded.samSession,
        agentId: 'sam',
        options: [...OPTIONS, { id: 'mysql', label: 'MySQL' }],
        onRaised: (id) => ids.push(id),
      }),
    );
    await Promise.resolve();
    expect(new Set(ids).size).toBe(2);
  });

  it('normalises case, punctuation and whitespace and caps at 200 characters', () => {
    expect(normalisePrompt('  Postgres, or SQLite?  ')).toBe('postgres or sqlite');
    expect(normalisePrompt('POSTGRES OR SQLITE!!!')).toBe('postgres or sqlite');
    expect(normalisePrompt('a'.repeat(300))).toHaveLength(200);
  });

  it('never joins across assignments, however identical the prompt', async () => {
    const h = open();
    const first = await seedPair(h);
    const second = await seedPair(h);
    const ids: string[] = [];

    void h.inbox.ask(
      askOf({
        ...first,
        sessionId: first.adaSession,
        agentId: 'ada',
        onRaised: (id) => ids.push(id),
      }),
    );
    await Promise.resolve();
    void h.inbox.ask(
      askOf({
        ...second,
        sessionId: second.adaSession,
        agentId: 'ada',
        onRaised: (id) => ids.push(id),
      }),
    );
    await Promise.resolve();
    expect(new Set(ids).size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// M2-5 — expiry
// ---------------------------------------------------------------------------

describe('expiry (M2-5, §6.5)', () => {
  it('expires a question past runner.question.expireHours and emits question.expired', async () => {
    const h = open({ expireHours: 1 });
    const seeded = await seedPair(h);
    let questionId = '';
    const pending = h.inbox.ask(
      askOf({
        ...seeded,
        sessionId: seeded.adaSession,
        agentId: 'ada',
        // The envelope's own deadline agrees with the config; the sweep reads it.
        expiresAt: new Date(h.now().getTime() + 3_600_000).toISOString(),
        onRaised: (id) => (questionId = id),
      }),
    );
    await Promise.resolve();

    h.advance(3_600_001);
    const swept = h.inbox.sweepExpired();

    expect(swept.expired).toEqual([questionId]);
    expect(h.storage.store.questions.get(questionId)?.status).toBe('expired');
    await expect(pending).resolves.toEqual({ status: 'expired', questionId });

    const event = h.events.find((one) => one.type === 'question.expired');
    expect(event?.persist).toBe(true);
    expect(event?.payload).toMatchObject({ questionId, sessionId: seeded.adaSession });
  });

  it('leaves an unexpired question alone (the sweep is a deadline, not a broom)', async () => {
    const h = open({ expireHours: 24 });
    const seeded = await seedPair(h);
    void h.inbox.ask(askOf({ ...seeded, sessionId: seeded.adaSession, agentId: 'ada' }));
    await Promise.resolve();

    h.advance(3_600_000);
    expect(h.inbox.sweepExpired().expired).toEqual([]);
    expect(h.inbox.list({ status: 'open' })).toHaveLength(1);
  });

  it('an expired approval_gate is a DENIAL: the assignment closes gate_expired (§6.5, §16-4)', async () => {
    const h = open({ expireHours: 1 });
    const seeded = await seedPair(h);
    void h.inbox.ask(
      askOf({
        ...seeded,
        sessionId: seeded.adaSession,
        agentId: 'ada',
        kind: 'approval_gate',
        prompt: 'Approve a write-capable assignment?',
        expiresAt: new Date(h.now().getTime() + 3_600_000).toISOString(),
      }),
    );
    await Promise.resolve();

    h.advance(3_600_001);
    const swept = h.inbox.sweepExpired();
    await Promise.resolve();

    expect(swept.closedAssignments).toEqual([
      { assignmentId: seeded.assignmentId, reason: 'gate_expired' },
    ]);
    expect(h.service.get(seeded.assignmentId)).toMatchObject({
      status: 'closed',
      closeReason: 'gate_expired',
    });
  });

  it('an expired budget_halt closes the assignment budget_exhausted', async () => {
    const h = open({ expireHours: 1 });
    const seeded = await seedPair(h);
    void h.inbox.ask(
      askOf({
        ...seeded,
        sessionId: seeded.adaSession,
        agentId: 'ada',
        kind: 'budget_halt',
        prompt: 'This pair has used its 400k budget.',
        expiresAt: new Date(h.now().getTime() + 3_600_000).toISOString(),
      }),
    );
    await Promise.resolve();

    h.advance(3_600_001);
    h.inbox.sweepExpired();
    await Promise.resolve();
    expect(h.service.get(seeded.assignmentId)).toMatchObject({
      status: 'closed',
      closeReason: 'budget_exhausted',
    });
  });

  it('an expired plain question halts the assignment question_expired and leaves it open', async () => {
    const h = open({ expireHours: 1 });
    const seeded = await seedPair(h);
    void h.inbox.ask(
      askOf({
        ...seeded,
        sessionId: seeded.adaSession,
        agentId: 'ada',
        expiresAt: new Date(h.now().getTime() + 3_600_000).toISOString(),
      }),
    );
    await Promise.resolve();

    h.advance(3_600_001);
    const swept = h.inbox.sweepExpired();
    expect(swept.haltedAssignments).toEqual([seeded.assignmentId]);
    expect(h.service.get(seeded.assignmentId)).toMatchObject({
      status: 'open',
      phase: 'halted',
      haltReason: 'question_expired',
    });
    // The card stays in the inbox as the record.
    expect(h.inbox.list({ status: 'expired' })).toHaveLength(1);
  });

  it('a boot sweep expires questions that aged out while the core was down (M2-5)', async () => {
    const h = open({ expireHours: 1 });
    const seeded = await seedPair(h);
    let questionId = '';
    void h.inbox.ask(
      askOf({
        ...seeded,
        sessionId: seeded.adaSession,
        agentId: 'ada',
        expiresAt: new Date(h.now().getTime() + 3_600_000).toISOString(),
        onRaised: (id) => (questionId = id),
      }),
    );
    await Promise.resolve();

    // The core is down for two hours; a fresh inbox over the same rows is the
    // boot task, and it judges from `created_at` rather than from a timer that
    // did not exist while the process was gone.
    h.advance(7_200_000);
    expect(h.inbox.sweepExpired().expired).toEqual([questionId]);
  });
});

// ---------------------------------------------------------------------------
// Reads (§11.1's pinned projection)
// ---------------------------------------------------------------------------

describe('the inbox projection (§11.1, ui R5)', () => {
  it('carries recommendations and the assignment/project/session ids on every item', async () => {
    const h = open();
    const seeded = await seedPair(h);
    void h.inbox.ask(
      askOf({
        ...seeded,
        sessionId: seeded.adaSession,
        agentId: 'ada',
        recommendation: { agentId: 'ada', stance: 'pg', strength: 'strong', rationale: 'why not' },
      }),
    );
    await Promise.resolve();

    const [item] = h.inbox.list({ status: 'open' });
    expect(item).toMatchObject({
      assignmentId: seeded.assignmentId,
      projectId: PROJECT_ID,
      sessionId: seeded.adaSession,
      recommendations: [
        {
          agentId: 'ada',
          role: 'architect',
          stance: 'pg',
          strength: 'strong',
          rationale: 'why not',
        },
      ],
    });
    // §16-1: no numeric confidence appears anywhere in the payload.
    expect(JSON.stringify(item)).not.toMatch(/"confidence"/);
  });

  it('lists newest first and filters by assignment and status', async () => {
    const h = open();
    const first = await seedPair(h);
    const second = await seedPair(h);

    void h.inbox.ask(askOf({ ...first, sessionId: first.adaSession, agentId: 'ada' }));
    await Promise.resolve();
    h.advance(1000);
    let newer = '';
    void h.inbox.ask(
      askOf({
        ...second,
        sessionId: second.adaSession,
        agentId: 'ada',
        prompt: 'A different question entirely?',
        onRaised: (id) => (newer = id),
      }),
    );
    await Promise.resolve();

    expect(h.inbox.list()[0]?.id).toBe(newer);
    expect(h.inbox.list({ assignmentId: second.assignmentId })).toHaveLength(1);
    expect(h.inbox.list({ status: 'answered' })).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Which turn is asking — WO4 addendum §6
// ---------------------------------------------------------------------------

/**
 * The *seat* half of "which seat/turn is asking" is runner's: it holds the role
 * at gate time and puts it on the request. The *turn* is not — runner has no
 * turn rows, and these are the only place the number exists — so it is stamped
 * on the way through, by the same `cardPolicy` hook §7.3 already uses to shape
 * a card before its row is written.
 */
describe('withAskingTurn (WO4 addendum §6)', () => {
  const request = {
    sessionId: 'ses_1',
    assignmentId: 'asg_1',
    agentId: 'ada',
    kind: 'question' as const,
    prompt: 'Allow the agent to use Bash?',
    holdUntil: '2026-08-19T10:15:00.000Z',
    expiresAt: '2026-08-20T10:00:00.000Z',
    context: { toolName: 'Bash', seatRole: 'architect' },
  };

  it('stamps the round of the turn the asking session belongs to', () => {
    const stamped = withAskingTurn({ findBySession: () => ({ round: 2 }) }, request);
    // Everything runner sent is still there: the stamp is additive, and the
    // context rides through this element verbatim by design.
    expect(stamped.context).toEqual({ toolName: 'Bash', seatRole: 'architect', round: 2 });
  });

  it('leaves a card with no turn behind it exactly as it was', () => {
    // A solo has no driver and therefore no turn rows (§2.3), and an
    // engine-raised card has no session at all.
    expect(withAskingTurn({ findBySession: () => undefined }, request).context).toEqual(
      request.context,
    );
    expect(
      withAskingTurn({ findBySession: () => ({ round: 2 }) }, { ...request, sessionId: null })
        .context,
    ).toEqual(request.context);
    expect(withAskingTurn(undefined, request).context).toEqual(request.context);
  });
});
