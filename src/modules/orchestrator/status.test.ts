/**
 * IMPLEMENTATION M9 — status aggregation and the UI-facing polish.
 *
 * Three things are pinned to ui by §16 and are therefore asserted literally
 * rather than approximately: the **six-word** state vocabulary, the
 * `disagreement`/`contested` flags being computed server-side, and the promise
 * that **no numeric confidence appears anywhere in any payload** — §6.2's whole
 * argument is that a self-reported number looks precise and is not, so the check
 * is a scan of the serialised card rather than a spot-check of one field.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FLEET_STATES } from './status.js';
import { endSession, flush, makeHarness, PROJECT_ID, type Harness } from './__tests__/helpers.js';

const AGENTS = [
  { id: 'ada', name: 'Ada', roles: ['architect' as const] },
  { id: 'sam', name: 'Sam', roles: ['skeptic' as const] },
  { id: 'kim', name: 'Kim', roles: ['implementer' as const] },
];

let harness: Harness;

beforeEach(() => {
  harness = makeHarness({ agents: AGENTS });
});

afterEach(() => {
  harness.cleanup();
});

async function makePair(): Promise<string> {
  const created = await harness.service.createAssignment({
    projectId: PROJECT_ID,
    pattern: 'pair',
    goal: 'Write docs/x/DESIGN.md',
    members: [
      { agentId: 'ada', role: 'architect' },
      { agentId: 'sam', role: 'skeptic' },
    ],
    scope: { paths: ['docs/x/'], artifactPath: 'docs/x/DESIGN.md' },
  });
  await flush();
  return created.assignmentId;
}

/** Records the session row runner would have written for a planned turn. */
function recordSession(
  assignmentId: string,
  status: 'queued' | 'running' | 'paused',
  exitReason?: string,
): string {
  const turn = harness.turns.active(assignmentId);
  const sessionId = turn?.sessionId ?? '';
  harness.storage.store.sessions.create({
    id: sessionId,
    assignmentId,
    agentId: turn?.agentId ?? 'ada',
    projectId: PROJECT_ID,
    status,
    origin: 'local',
    startedAt: harness.now().toISOString(),
    ...(exitReason === undefined ? {} : { exitReason }),
  });
  return sessionId;
}

describe('GET /api/orchestrator/status (§11.3, M9-1)', () => {
  it('uses ui’s six words and nothing else (§16-6)', async () => {
    await makePair();
    recordSession(await Promise.resolve(harness.repository.list()[0]?.id ?? ''), 'running');

    const status = harness.fleetStatus();
    for (const agent of status.agents) {
      expect(FLEET_STATES).toContain(agent.state);
    }
    expect([...FLEET_STATES].sort()).toEqual(
      ['awaiting_user', 'halted', 'idle', 'paused', 'queued', 'working'].sort(),
    );
  });

  it('reports working, queued and paused from runner’s session status', async () => {
    const assignmentId = await makePair();

    recordSession(assignmentId, 'running');
    expect(harness.fleetStatus().agents.find((a) => a.agentId === 'ada')?.state).toBe('working');

    harness.storage.store.sessions.setStatus(
      harness.turns.active(assignmentId)?.sessionId ?? '',
      'queued',
    );
    expect(harness.fleetStatus().agents.find((a) => a.agentId === 'ada')?.state).toBe('queued');

    harness.storage.store.sessions.setStatus(
      harness.turns.active(assignmentId)?.sessionId ?? '',
      'paused',
      { exitReason: 'user_stopped' },
    );
    expect(harness.fleetStatus().agents.find((a) => a.agentId === 'ada')?.state).toBe('paused');
  });

  it('reads a park on a question as awaiting_user, not paused (runner §11.1)', async () => {
    const assignmentId = await makePair();
    recordSession(assignmentId, 'paused', 'awaiting_answer');

    expect(harness.fleetStatus().agents.find((a) => a.agentId === 'ada')?.state).toBe(
      'awaiting_user',
    );
  });

  it('lets the assignment’s phase win over the session, for halted and awaiting_user', async () => {
    const assignmentId = await makePair();
    recordSession(assignmentId, 'running');

    harness.repository.setPhase(assignmentId, 'halted', 'turn_failures');
    expect(harness.fleetStatus().agents.find((a) => a.agentId === 'ada')?.state).toBe('halted');

    harness.repository.setPhase(assignmentId, 'awaiting_user', null);
    expect(harness.fleetStatus().agents.find((a) => a.agentId === 'ada')?.state).toBe(
      'awaiting_user',
    );
  });

  it('shows an agent with no work as idle, and carries the ids ui renders', async () => {
    const assignmentId = await makePair();
    const sessionId = recordSession(assignmentId, 'running');

    const status = harness.fleetStatus();
    const kim = status.agents.find((agent) => agent.agentId === 'kim');
    expect(kim).toMatchObject({ state: 'idle', assignmentId: null, projectId: null });

    const ada = status.agents.find((agent) => agent.agentId === 'ada');
    expect(ada).toMatchObject({
      assignmentId,
      sessionId,
      projectId: PROJECT_ID,
      role: 'architect',
    });
    expect(ada?.since).toEqual(expect.any(String));
  });

  it('reports a live mix of solo and pair, with the counts §11.3 pins (M9 acceptance)', async () => {
    const pairId = await makePair();
    recordSession(pairId, 'running');

    const solo = await harness.service.createSolo({
      projectId: PROJECT_ID,
      agentId: 'kim',
      prompt: 'go',
    });
    harness.storage.store.sessions.create({
      id: solo.sessionId,
      assignmentId: solo.assignmentId,
      agentId: 'kim',
      projectId: PROJECT_ID,
      status: 'paused',
      origin: 'local',
      exitReason: 'budget_halt',
    });
    harness.repository.setPhase(solo.assignmentId, 'awaiting_user', null);

    void harness.inbox.ask({
      sessionId: null,
      assignmentId: solo.assignmentId,
      agentId: 'kim',
      kind: 'budget_halt',
      prompt: 'This solo has used its budget.',
      holdUntil: harness.now().toISOString(),
      expiresAt: new Date(harness.now().getTime() + 3_600_000).toISOString(),
    });
    await flush();

    const status = harness.fleetStatus();
    expect(status.assignments).toEqual({ open: 2, halted: 0, awaitingUser: 1 });
    expect(status.questions.open).toBe(1);
    expect(status.questions.oldestOpenedAt).toEqual(expect.any(String));
    expect(status.agents.find((agent) => agent.agentId === 'ada')?.state).toBe('working');
    expect(status.agents.find((agent) => agent.agentId === 'kim')?.state).toBe('awaiting_user');
  });

  it('shows the busiest of an agent’s assignments, because that is what needs a human', async () => {
    const first = await makePair();
    recordSession(first, 'running');
    const second = await harness.service.createSolo({
      projectId: PROJECT_ID,
      agentId: 'ada',
      prompt: 'the other one',
    });
    harness.repository.setPhase(second.assignmentId, 'halted', 'stale');

    expect(harness.fleetStatus().agents.find((a) => a.agentId === 'ada')?.state).toBe('halted');
  });
});

describe('the card’s flags are computed server-side (§16-1, M9-3)', () => {
  async function cardWith(
    recommendations: readonly { agentId: string; stance: string | null; strength: string }[],
  ): Promise<ReturnType<Harness['inbox']['get']>> {
    const assignmentId = await makePair();
    let questionId = '';
    void harness.inbox.ask({
      sessionId: null,
      assignmentId,
      agentId: 'ada',
      kind: 'question',
      prompt: 'Store transcripts in the DB or on disk?',
      options: [
        { id: 'disk', label: 'On disk' },
        { id: 'db', label: 'In SQLite' },
      ],
      holdUntil: harness.now().toISOString(),
      expiresAt: new Date(harness.now().getTime() + 3_600_000).toISOString(),
      onRaised: (id) => {
        questionId = id;
      },
    });
    await flush();
    for (const recommendation of recommendations) {
      harness.inbox.addRecommendation(questionId, {
        agentId: recommendation.agentId,
        stance: recommendation.stance,
        strength: recommendation.strength as 'blocking',
        rationale: 'because',
      });
    }
    return harness.inbox.get(questionId);
  }

  it('one recommendation: neither disagreement nor contested', async () => {
    const card = await cardWith([{ agentId: 'ada', stance: 'disk', strength: 'strong' }]);
    expect(card.disagreement).toBe(false);
    expect(card.contested).toBe(false);
  });

  it('two agreeing: neither', async () => {
    const card = await cardWith([
      { agentId: 'ada', stance: 'disk', strength: 'strong' },
      { agentId: 'sam', stance: 'disk', strength: 'lean' },
    ]);
    expect(card.disagreement).toBe(false);
    expect(card.contested).toBe(false);
  });

  it('two disagreeing without a blocking stance: disagreement, not contested', async () => {
    const card = await cardWith([
      { agentId: 'ada', stance: 'disk', strength: 'strong' },
      { agentId: 'sam', stance: 'db', strength: 'lean' },
    ]);
    expect(card.disagreement).toBe(true);
    expect(card.contested).toBe(false);
  });

  it('one blocking against one lean: disagreement AND contested, blocking sorted first', async () => {
    const card = await cardWith([
      { agentId: 'ada', stance: 'disk', strength: 'lean' },
      { agentId: 'sam', stance: 'db', strength: 'blocking' },
    ]);
    expect(card.disagreement).toBe(true);
    expect(card.contested).toBe(true);
    expect(card.recommendations[0]).toMatchObject({ agentId: 'sam', strength: 'blocking' });
    // §16-2: attribution is always present, with the role the agent held.
    expect(card.recommendations.every((one) => one.role !== null)).toBe(true);
  });

  it('renders the strength as a word and never as a number anywhere in the payload', async () => {
    const card = await cardWith([
      { agentId: 'ada', stance: 'disk', strength: 'blocking' },
      { agentId: 'sam', stance: 'db', strength: 'defer' },
    ]);
    const serialised = JSON.stringify(card);
    for (const forbidden of ['confidence', 'score', 'percent', 'weight']) {
      expect(serialised.toLowerCase()).not.toContain(forbidden);
    }
    for (const recommendation of card.recommendations) {
      expect(typeof recommendation.strength).toBe('string');
    }
  });
});

describe('GET /api/patterns drives the create dialog (§16-9, M9-4)', () => {
  it('carries seats, allowed roles, defaults, preferredTier and ranked candidates', () => {
    const pair = harness.engine.patterns().find((pattern) => pattern.id === 'pair');
    expect(pair?.seats.map((seat) => seat.key)).toEqual(['drafter', 'critic']);
    expect(pair?.seats.find((seat) => seat.key === 'critic')?.preferredTier).toBe('balanced');
    expect(pair?.defaults).toEqual({
      roundCap: harness.config.patterns.pair.roundCap,
      tokenBudget: harness.config.budgets.defaultPairTokens,
    });

    // Eligibility is the same rule §9-5 refuses on, so the dialog cannot offer a
    // choice the validator would reject.
    expect(pair?.candidates?.['critic']?.map((one) => one.agentId)).toEqual(['sam']);
    expect(pair?.candidates?.['drafter']?.map((one) => one.agentId)).toEqual(['ada', 'kim']);
    expect(pair?.candidates?.['drafter']?.[0]).toMatchObject({ name: 'Ada', available: true });
  });

  it('ranks an agent at its cap last, rather than hiding it', async () => {
    await makePair();
    await harness.service.createSolo({ projectId: PROJECT_ID, agentId: 'ada', prompt: 'more' });

    const pair = harness.engine.patterns().find((pattern) => pattern.id === 'pair');
    const drafters = pair?.candidates?.['drafter'] ?? [];
    expect(drafters.map((one) => one.agentId)).toEqual(['kim', 'ada']);
    expect(drafters.at(-1)).toMatchObject({ agentId: 'ada', available: false });
  });
});

describe('event replay reconstructs an assignment (§16-10, M9-5)', () => {
  it('replays a run’s lifecycle from the persisted assignment.* events with no gaps', async () => {
    const assignmentId = await makePair();

    // One full round, driven as the engine drives it.
    const first = harness.turns.active(assignmentId);
    await harness.toolset({ assignmentId, agentId: 'ada' }).call('report_status', {
      state: 'done',
      headline: 'Draft complete',
      artifacts: [{ path: 'docs/x/DESIGN.md' }],
    });
    await endSession(harness, first?.sessionId ?? '');

    const second = harness.turns.active(assignmentId);
    await harness.toolset({ assignmentId, agentId: 'sam' }).call('report_status', {
      state: 'done',
      headline: 'Accepted',
      verdict: { decision: 'accept', blocking: [] },
    });
    await endSession(harness, second?.sessionId ?? '');

    // A reconnecting client replays only what was persisted — the same query
    // `/api/events?since=&types=` serves, oldest first.
    const replayed = harness.storage.store.events
      .list({ since: '', types: ['assignment.*'], assignmentId })
      .map((event) => event.type);

    expect(replayed).toContain('assignment.created');
    expect(replayed).toContain('assignment.started');
    expect(replayed.filter((type) => type === 'assignment.turn.started')).toHaveLength(2);
    expect(replayed.filter((type) => type === 'assignment.turn.reported')).toHaveLength(2);
    expect(replayed.filter((type) => type === 'assignment.turn.ended')).toHaveLength(2);
    expect(replayed).toContain('assignment.round.completed');
    expect(replayed).toContain('assignment.closed');

    // …and the conversation endpoint is the record of everything that is not.
    const conversation = harness.conversation(assignmentId);
    expect(conversation.rounds).toHaveLength(1);
    expect(conversation.rounds[0]?.entries.filter((entry) => entry.type === 'turn')).toHaveLength(
      2,
    );
    expect(conversation.phase).toBe('converged');
  });
});
