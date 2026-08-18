/**
 * `GET /api/widget` — DESIGN §11.5.
 *
 * The properties the section argues for, each asserted as a property rather
 * than as a snapshot of one payload:
 *
 * 1. it agrees with `GET /api/orchestrator/status` by construction, because it
 *    tallies the same reader rather than re-deriving the six words;
 * 2. the cap shortens the list and never the count;
 * 3. `waitingSec` is served from the service clock and cannot go negative;
 * 4. an asker with no single answer is `null`, not a guess;
 * 5. nothing a gate was *about* — its tool input — reaches the payload.
 */
import { afterEach, describe, expect, it } from 'vitest';

import type { AskRequest } from './questions.js';
import { makeHarness, PROJECT_ID, type Harness } from './__tests__/helpers.js';

let harness: Harness | undefined;

const ADA = { id: 'ada', name: 'Ada Architect', roles: ['architect', 'implementer'] as const };
const SAM = { id: 'sam', name: 'Sam Skeptic', roles: ['skeptic'] as const };

function open(): Harness {
  harness?.cleanup();
  harness = makeHarness({ agents: [ADA, SAM] });
  return harness;
}

afterEach(() => {
  harness?.cleanup();
  harness = undefined;
});

/** An open pair, plus a running session row per seat — what runner would have written. */
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
      origin: 'local',
    }).id;
  return {
    assignmentId: created.assignmentId,
    adaSession: session('ada'),
    samSession: session('sam'),
  };
}

/** A one-seat assignment, so §11.5's "lone seat" fallback has a subject. */
async function seedSolo(h: Harness): Promise<string> {
  const created = await h.service.createAssignment({
    projectId: PROJECT_ID,
    pattern: 'solo',
    goal: 'ship it',
    members: [{ agentId: 'ada', role: 'implementer' }],
  });
  return created.assignmentId;
}

function askOf(
  overrides: Partial<AskRequest> & Pick<AskRequest, 'assignmentId' | 'sessionId' | 'agentId'>,
): AskRequest {
  return {
    kind: 'question',
    prompt: 'Postgres or SQLite?',
    holdUntil: '2026-08-16T10:15:00.000Z',
    expiresAt: '2099-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * Raises a card and returns its id.
 *
 * The promise `ask()` returns is deliberately never awaited — an open question
 * is one nobody has answered, which is the entire subject of this file.
 */
async function raise(h: Harness, request: AskRequest): Promise<string> {
  let id = '';
  void h.inbox.ask({ ...request, onRaised: (raised) => (id = raised) }).catch(() => undefined);
  // `ask()` writes the row on a microtask, exactly as `questions.test.ts` awaits it.
  await Promise.resolve();
  return id;
}

describe('the glanceable projection (§11.5)', () => {
  it('is empty in the same shape it is full', () => {
    const h = open();
    const feed = h.widgetFeed();

    expect(feed.waiting).toEqual([]);
    expect(feed.waitingTotal).toBe(0);
    expect(feed.oldestWaitingSec).toBeNull();
    expect(feed.agents).toEqual({
      working: 0,
      queued: 0,
      awaitingUser: 0,
      paused: 0,
      halted: 0,
      idle: 2,
    });
  });

  it('tallies exactly the states the fleet reader assigned — the two cannot disagree', async () => {
    const h = open();
    await seedPair(h);

    const feed = h.widgetFeed();
    const fleet = h.fleetStatus();

    const tallied = Object.values(feed.agents).reduce((sum, n) => sum + n, 0);
    expect(tallied).toBe(fleet.agents.length);
    expect(feed.agents.working).toBe(
      fleet.agents.filter((agent) => agent.state === 'working').length,
    );
    expect(feed.assignments).toEqual(fleet.assignments);
  });

  it('names the asking agent from its session, as a display name', async () => {
    const h = open();
    const seeded = await seedPair(h);
    await raise(h, askOf({ ...seeded, sessionId: seeded.samSession, agentId: 'sam' }));

    const feed = h.widgetFeed();
    expect(feed.waiting).toHaveLength(1);
    expect(feed.waiting[0]?.agentName).toBe('Sam Skeptic');
  });

  it('falls back to the lone seat when nothing is asking', async () => {
    const h = open();
    const solo = await seedSolo(h);
    await raise(
      h,
      askOf({ assignmentId: solo, sessionId: null, agentId: 'ada', kind: 'budget_halt' }),
    );

    expect(h.widgetFeed().waiting[0]?.agentName).toBe('Ada Architect');
  });

  it('says null rather than guessing when two seats could be the asker', async () => {
    const h = open();
    const pair = await seedPair(h);
    await raise(
      h,
      askOf({
        assignmentId: pair.assignmentId,
        sessionId: null,
        agentId: 'ada',
        kind: 'budget_halt',
      }),
    );

    expect(h.widgetFeed().waiting[0]?.agentName).toBeNull();
  });

  it('orders oldest first and reports the oldest age in whole seconds', async () => {
    const h = open();
    const seeded = await seedPair(h);

    await raise(
      h,
      askOf({ ...seeded, sessionId: seeded.adaSession, agentId: 'ada', prompt: 'first?' }),
    );
    h.advance(90_000);
    await raise(
      h,
      askOf({ ...seeded, sessionId: seeded.samSession, agentId: 'sam', prompt: 'second?' }),
    );
    h.advance(10_000);

    const feed = h.widgetFeed();
    expect(feed.waiting.map((item) => item.prompt)).toEqual(['first?', 'second?']);
    expect(feed.waiting[0]?.waitingSec).toBe(100);
    expect(feed.waiting[1]?.waitingSec).toBe(10);
    expect(feed.oldestWaitingSec).toBe(100);
  });

  it('never reports a negative age, whatever the two clocks did', async () => {
    const h = open();
    const seeded = await seedPair(h);
    await raise(h, askOf({ ...seeded, sessionId: seeded.adaSession, agentId: 'ada' }));

    // A row that is "in the future": clock skew, a restored backup, a hand-edited db.
    h.advance(-60_000);

    expect(h.widgetFeed().waiting[0]?.waitingSec).toBe(0);
    expect(h.widgetFeed().oldestWaitingSec).toBe(0);
  });

  it('caps the list and not the count, so a "+N more" line is honest', async () => {
    const h = open();
    const seeded = await seedPair(h);
    for (let i = 0; i < 7; i += 1) {
      await raise(
        h,
        askOf({ ...seeded, sessionId: seeded.adaSession, agentId: 'ada', prompt: `q${i}?` }),
      );
      h.advance(1_000);
    }

    const feed = h.widgetFeed();
    expect(feed.waiting).toHaveLength(h.config.widget.maxWaiting);
    expect(feed.waitingTotal).toBe(7);
  });

  it('clips a prompt to the configured budget and marks it clipped', async () => {
    const h = open();
    const seeded = await seedPair(h);
    const long = 'x'.repeat(h.config.widget.promptChars + 50);
    await raise(
      h,
      askOf({ ...seeded, sessionId: seeded.adaSession, agentId: 'ada', prompt: long }),
    );

    const prompt = h.widgetFeed().waiting[0]?.prompt ?? '';
    expect(prompt).toHaveLength(h.config.widget.promptChars);
    expect(prompt.endsWith('…')).toBe(true);
  });

  it('carries no tool input — what a gate is about is not glance material', async () => {
    const h = open();
    const seeded = await seedPair(h);
    await raise(
      h,
      askOf({
        ...seeded,
        sessionId: seeded.adaSession,
        agentId: 'ada',
        kind: 'approval_gate',
        prompt: 'Run the build?',
        context: { toolName: 'Bash', toolInput: { command: 'cat ~/.ssh/id_ed25519' } },
      }),
    );

    const serialised = JSON.stringify(h.widgetFeed());
    expect(serialised).not.toContain('id_ed25519');
    expect(serialised).not.toContain('toolInput');
  });
});
