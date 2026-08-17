/**
 * IMPLEMENTATION M8 — notification when the user is away.
 *
 * The channel is one outbound POST, so the whole test surface is: does it fire
 * when §10 says, does it carry the tailnet link, does it stay quiet when it
 * should, and — the criterion that matters most — does a broken channel leave
 * the question completely unaffected.
 *
 * `fetch` and the 60-second timer are both injected (`helpers.ts`), which is why
 * this file makes no network call and takes no minute.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ORCHESTRATOR_CONFIG_DEFAULTS } from './config.js';
import { makeHarness, NTFY_TOPIC, PROJECT_ID, type Harness } from './__tests__/helpers.js';

let harness: Harness;

/** Enough seats that one test can raise several cards without hitting §9-7. */
const AGENTS = Array.from({ length: 8 }, (_unused, index) => ({
  id: `ada${String(index + 1)}`,
  roles: ['implementer' as const],
}));

/** The shipped defaults, which are the *closed* ones (R5). */
const SHIPPED_NOTIFY = ORCHESTRATOR_CONFIG_DEFAULTS.notify;

function open(options: Parameters<typeof makeHarness>[0] = {}): Harness {
  harness = makeHarness({
    agents: AGENTS,
    // The home edition's value: a test that wants the channel on has to say so,
    // exactly as `edition.home.json` does.
    config: { notify: { ...SHIPPED_NOTIFY, enabled: true } },
    ...options,
  });
  return harness;
}

afterEach(() => {
  harness.cleanup();
});

beforeEach(() => {
  agentSeq = 0;
  harness = makeHarness({ agents: AGENTS });
});

let agentSeq = 0;

/** Raises a card of the given kind, as runner or the engine would. */
async function raise(
  h: Harness,
  kind: 'approval_gate' | 'budget_halt' | 'question',
  urgency?: string,
): Promise<string> {
  // A fresh agent each time: several cards in one test means several
  // assignments, and one agent may hold only `maxConcurrentPerAgent` seats.
  agentSeq += 1;
  const agentId = `ada${String(agentSeq)}`;
  const created = await h.service.createSolo({
    projectId: PROJECT_ID,
    agentId,
    prompt: 'work',
  });
  let questionId = '';
  void h.inbox.ask({
    sessionId: null,
    assignmentId: created.assignmentId,
    agentId,
    kind,
    prompt: 'Approve the write-capable assignment?',
    options: [
      { id: 'approve', label: 'Approve' },
      { id: 'deny', label: 'Deny' },
    ],
    holdUntil: h.now().toISOString(),
    expiresAt: new Date(h.now().getTime() + 24 * 3_600_000).toISOString(),
    ...(urgency === undefined
      ? {}
      : {
          context: { toolName: 'mcp__agentmanager__request_user_decision', toolInput: { urgency } },
        }),
    onRaised: (id) => {
      questionId = id;
    },
  });
  await Promise.resolve();
  await Promise.resolve();
  return questionId;
}

describe('the trigger (§10, M8-2)', () => {
  it('pushes exactly one notification for a gate still open after afterMs (M8 acceptance)', async () => {
    const h = open();
    const questionId = await raise(h, 'approval_gate');

    expect(h.posts).toHaveLength(0); // nothing yet: the delay is the point
    await h.timers.run();

    expect(h.posts).toHaveLength(1);
    expect(h.posts[0]?.url).toBe(NTFY_TOPIC);
    // §10: "the link in the notification is the tailnet URL of the question card."
    expect(h.posts[0]?.body).toContain(`https://box.tailnet.ts.net/questions/${questionId}`);
    expect(h.posts[0]?.headers['Click']).toContain(questionId);

    // "At most one notification per question."
    await h.notifier.notify(questionId);
    expect(h.posts).toHaveLength(1);
  });

  it('emits orchestrator.notify.sent with the channel and the outcome (M8-5)', async () => {
    const h = open();
    const questionId = await raise(h, 'budget_halt');
    await h.timers.run();

    const sent = h.events.filter((event) => event.type === 'orchestrator.notify.sent');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.payload).toMatchObject({ questionId, channel: 'ntfy', ok: true });
    expect(sent[0]?.persist).toBe(true);
  });

  it('produces none when the card is answered inside afterMs (M8 acceptance)', async () => {
    const h = open();
    const questionId = await raise(h, 'approval_gate');
    h.inbox.answer(questionId, { optionIds: ['approve'], answeredVia: 'local' });

    await h.timers.run();
    expect(h.posts).toEqual([]);
    expect(h.events.filter((event) => event.type === 'orchestrator.notify.sent')).toEqual([]);
  });

  it('pushes a plain question only when the asker called it blocking (minLevel)', async () => {
    const h = open();
    await raise(h, 'question', 'advisory');
    await h.timers.run();
    expect(h.posts).toEqual([]);

    await raise(h, 'question', 'blocking');
    await h.timers.run();
    expect(h.posts).toHaveLength(1);
  });

  it('suppresses past maxPerHour and folds the count into the next digest', async () => {
    const h = open({
      config: {
        notify: { ...SHIPPED_NOTIFY, enabled: true, maxPerHour: 1 },
      },
    });
    const first = await raise(h, 'approval_gate');
    await h.timers.run();
    expect(h.posts).toHaveLength(1);

    await raise(h, 'approval_gate');
    await h.timers.run();
    expect(h.posts).toHaveLength(1); // suppressed
    expect(h.notifier.health().suppressed).toBe(1);

    // An hour later the window has rolled and the digest says what was missed.
    h.advance(3_600_001);
    await raise(h, 'approval_gate');
    await h.timers.run();
    expect(h.posts).toHaveLength(2);
    expect(h.posts[1]?.body).toContain('1 other card(s) were not pushed');
    expect(first).not.toBe('');
  });
});

describe('the work edition sends nothing (§10, R5, M8-4)', () => {
  it('arms no timer and posts nothing when notify.enabled is false', async () => {
    // The harness's default config *is* the shipped default, which is the closed
    // one — `edition.work.json` states it explicitly and `edition.home.json`
    // turns it on.
    const h = makeHarness({ agents: AGENTS });
    harness = h;
    expect(h.config.notify.enabled).toBe(false);

    await raise(h, 'approval_gate');
    expect(h.timers.pending()).toBe(0);
    await h.timers.run();

    expect(h.posts).toEqual([]);
    expect(h.events.filter((event) => event.type === 'orchestrator.notify.sent')).toEqual([]);
    // Off is not degraded: there is nothing for a human to fix.
    expect(h.notifier.health().degraded).toBe(false);
  });
});

describe('a broken channel degrades, and never blocks (§10, M8-3)', () => {
  it('leaves the question raised, listed and answerable when the topic is unreachable', async () => {
    const h = open({ notifyFails: true });
    const questionId = await raise(h, 'approval_gate');
    await h.timers.run();

    expect(h.notifier.health().degraded).toBe(true);
    expect(h.notifier.health().lastError).toContain('502');
    // The whole point: the card is untouched by the channel's failure.
    expect(h.inbox.get(questionId).status).toBe('open');
    expect(h.inbox.list({ status: 'open' }).map((card) => card.id)).toContain(questionId);
    expect(
      h.inbox.answer(questionId, { optionIds: ['approve'], answeredVia: 'local' }).status,
    ).toBe('answered');

    // Failure is reported once, never retried into a loop.
    expect(h.posts).toHaveLength(1);
    expect(h.events.filter((event) => event.type === 'orchestrator.notify.sent')).toHaveLength(1);
  });

  it('degrades the same way when the topic secret is not configured at all', async () => {
    const h = open({ secrets: {} });
    await raise(h, 'approval_gate');
    await h.timers.run();

    expect(h.posts).toEqual([]);
    expect(h.notifier.health().degraded).toBe(true);
    expect(h.notifier.health().lastError).toContain('notify.ntfy.topicUrl');
  });
});
