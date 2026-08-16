/**
 * The repository acceptance criteria of IMPLEMENTATION §5, each proven
 * directly:
 *
 * - creating an assignment with members and a session under it;
 * - recording usage deltas and reading the rollup in one query;
 * - a mailbox query returning only undelivered messages in order;
 * - opening, answering and re-reading a question across a simulated restart;
 * - `countByAgent` using the `sessions(agent_id)` index, via EXPLAIN QUERY PLAN;
 * - the three referential-integrity rules of §1.4;
 * - `events` pruning by age and row cap, including the boot pass.
 *
 * Everything runs against a throwaway data root under the OS temp directory.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RecordNotFoundError, RestrictedDeleteError } from '../errors.js';
import { openStorage, type Storage } from '../storage.js';
import { makeTempRoot, type TempRoot } from '../__tests__/helpers.js';
import type { Store } from './index.js';

let root: TempRoot;
let storage: Storage;
let store: Store;

beforeEach(() => {
  root = makeTempRoot();
  storage = openStorage({ dataRoot: root.path, tightenAcl: false });
  store = storage.store;
});

afterEach(() => {
  storage.close();
  root.cleanup();
});

/** Closes and reopens the database — the "simulated restart" of §5. */
function restart(): void {
  storage.close();
  storage = openStorage({ dataRoot: root.path, tightenAcl: false });
  store = storage.store;
}

function project(slug = 'acme') {
  return store.projects.create({
    slug,
    name: slug.toUpperCase(),
    localPath: `C:\\Projects\\${slug}`,
  });
}

// ---------------------------------------------------------------------------

describe('assignments, members and sessions', () => {
  it('creates an assignment with members and a session under it', () => {
    const acme = project();

    const assignment = store.assignments.create({
      projectId: acme.id,
      pattern: 'pair',
      goal: 'Ship the mailbox',
      tokenBudget: 100_000,
      members: [
        { agentId: 'ada', role: 'implementer' },
        { agentId: 'linus', role: 'skeptic' },
      ],
    });

    expect(assignment.status).toBe('open');
    expect(assignment.tokensUsed).toBe(0);
    expect(store.assignments.listMembers(assignment.id)).toEqual([
      { assignmentId: assignment.id, agentId: 'ada', role: 'implementer' },
      { assignmentId: assignment.id, agentId: 'linus', role: 'skeptic' },
    ]);

    const session = store.sessions.create({
      assignmentId: assignment.id,
      agentId: 'ada',
      projectId: acme.id,
      status: 'running',
      model: 'sonnet',
      origin: 'local',
    });

    expect(session.assignmentId).toBe(assignment.id);
    expect(session.startedAt).not.toBeNull();
    expect(store.sessions.list({ assignmentId: assignment.id }).map((s) => s.id)).toEqual([
      session.id,
    ]);
    expect(store.assignments.listByAgent('linus').map((a) => a.id)).toEqual([assignment.id]);
  });

  it('refuses a session whose assignment does not exist — assignment_id is NOT NULL and an FK', () => {
    const acme = project();
    expect(() =>
      store.sessions.create({
        assignmentId: 'no-such-assignment',
        agentId: 'ada',
        projectId: acme.id,
      }),
    ).toThrow(/FOREIGN KEY/i);
  });

  it('closes an assignment with a reason and a timestamp', () => {
    const acme = project();
    const assignment = store.assignments.create({ projectId: acme.id, pattern: 'solo' });

    const closed = store.assignments.close(assignment.id, { reason: 'goal met' });
    expect(closed.status).toBe('closed');
    expect(closed.closeReason).toBe('goal met');
    expect(closed.closedAt).not.toBeNull();
  });
});

describe('usage metering (§8)', () => {
  it('records deltas and reads the rollup in one query, assignment total included', () => {
    const acme = project();
    const assignment = store.assignments.create({ projectId: acme.id, pattern: 'solo' });
    const session = store.sessions.create({
      assignmentId: assignment.id,
      agentId: 'ada',
      projectId: acme.id,
      status: 'running',
    });

    store.usage.record({
      sessionId: session.id,
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 5,
      model: 'sonnet',
    });
    const totals = store.usage.record({
      sessionId: session.id,
      inputTokens: 40,
      outputTokens: 10,
      cacheCreationTokens: 7,
      model: 'sonnet',
    });

    // The return value *is* the rollup: no second read to enforce a budget.
    expect(totals).toMatchObject({
      sessionId: session.id,
      inputTokens: 140,
      outputTokens: 30,
      cacheReadTokens: 5,
      cacheCreationTokens: 7,
      totalTokens: 182,
      events: 2,
    });
    expect(store.usage.totals(session.id)).toEqual(totals);

    // The raw time series survives alongside the rollup.
    expect(store.usage.listEvents(session.id).map((e) => e.inputTokens)).toEqual([100, 40]);

    // …and the assignment total was rolled on in the same transaction.
    expect(store.assignments.get(assignment.id)?.tokensUsed).toBe(182);
  });

  it('leaves nothing behind when the delta cannot be attributed', () => {
    expect(() => store.usage.record({ sessionId: 'ghost', inputTokens: 1 })).toThrow();
    expect(store.usage.totals('ghost')).toBeUndefined();
  });

  it('rolls up per session, not across them', () => {
    const acme = project();
    const assignment = store.assignments.create({ projectId: acme.id, pattern: 'pair' });
    const first = store.sessions.create({
      assignmentId: assignment.id,
      agentId: 'ada',
      projectId: acme.id,
    });
    const second = store.sessions.create({
      assignmentId: assignment.id,
      agentId: 'linus',
      projectId: acme.id,
    });

    store.usage.record({ sessionId: first.id, inputTokens: 10 });
    store.usage.record({ sessionId: second.id, inputTokens: 25 });

    expect(store.usage.totals(first.id)?.totalTokens).toBe(10);
    expect(store.usage.totals(second.id)?.totalTokens).toBe(25);
    expect(store.assignments.get(assignment.id)?.tokensUsed).toBe(35);
  });
});

describe('the mailbox (§1.4)', () => {
  it('returns only undelivered messages, oldest first', () => {
    const acme = project();
    const assignment = store.assignments.create({ projectId: acme.id, pattern: 'pair' });

    const first = store.messages.send({
      assignmentId: assignment.id,
      fromAgentId: 'ada',
      toAgentId: 'linus',
      kind: 'note',
      body: 'first',
      createdAt: '2026-08-16T10:00:00.000Z',
    });
    const second = store.messages.send({
      assignmentId: assignment.id,
      fromAgentId: 'ada',
      toAgentId: 'linus',
      kind: 'note',
      body: 'second',
      createdAt: '2026-08-16T10:00:01.000Z',
    });
    const alreadyRead = store.messages.send({
      assignmentId: assignment.id,
      fromAgentId: 'ada',
      toAgentId: 'linus',
      kind: 'note',
      body: 'old news',
      createdAt: '2026-08-16T09:00:00.000Z',
    });
    // Addressed elsewhere: must not appear in linus's mailbox.
    store.messages.send({
      assignmentId: assignment.id,
      fromAgentId: 'linus',
      toAgentId: 'ada',
      kind: 'note',
      body: 'not yours',
    });

    store.messages.markRead(alreadyRead.id);

    expect(store.messages.mailbox('linus').map((m) => m.body)).toEqual(['first', 'second']);
    expect(store.messages.unreadCount('linus')).toBe(2);

    store.messages.markRead(first.id);
    expect(store.messages.mailbox('linus').map((m) => m.id)).toEqual([second.id]);

    // Reading implies delivery: a read message with no delivery time is a state
    // nothing should be able to produce.
    expect(store.messages.get(first.id)?.deliveredAt).not.toBeNull();
  });

  it('uses the mailbox index rather than scanning and sorting', () => {
    const plan = storage.db
      .prepare<[string], { detail: string }>(
        'EXPLAIN QUERY PLAN SELECT id FROM messages ' +
          'WHERE to_agent_id = ? AND read_at IS NULL ORDER BY created_at',
      )
      .all('linus')
      .map((row) => row.detail)
      .join(' | ');

    expect(plan).toContain('messages_mailbox_idx');
    expect(plan).not.toContain('TEMP B-TREE');
  });

  it('leaves a broadcast (to_agent_id NULL) out of every agent mailbox', () => {
    const acme = project();
    const assignment = store.assignments.create({ projectId: acme.id, pattern: 'pair' });
    store.messages.send({ assignmentId: assignment.id, kind: 'broadcast', body: 'all hands' });

    expect(store.messages.mailbox('ada')).toEqual([]);
    expect(store.messages.listByAssignment(assignment.id)).toHaveLength(1);
  });
});

describe('questions across a restart (§1.4)', () => {
  it('opens, answers and re-reads a question after closing and reopening the DB', () => {
    const acme = project();
    const assignment = store.assignments.create({ projectId: acme.id, pattern: 'review' });
    const session = store.sessions.create({
      assignmentId: assignment.id,
      agentId: 'ada',
      projectId: acme.id,
    });

    const question = store.questions.open({
      assignmentId: assignment.id,
      sessionId: session.id,
      kind: 'approval_gate',
      prompt: 'Push to main?',
      options: ['yes', 'no'],
      recommendations: [
        { agentId: 'linus', stance: 'no', rationale: 'tests are red', strength: 'strong' },
      ],
    });

    expect(question.status).toBe('open');
    expect(store.questions.listOpen().map((q) => q.id)).toEqual([question.id]);

    // The core restarts here — the whole point of persisting the question.
    restart();

    const reopened = store.questions.get(question.id);
    expect(reopened?.status).toBe('open');
    expect(reopened?.prompt).toBe('Push to main?');
    expect(store.questions.listRecommendations(question.id)).toEqual([
      {
        questionId: question.id,
        agentId: 'linus',
        stance: 'no',
        rationale: 'tests are red',
        strength: 'strong',
      },
    ]);

    // Answered from the tailnet browser, which is the other half of "never
    // stranded on the desktop".
    const answered = store.questions.answer(question.id, {
      answer: { choice: 'no' },
      answeredVia: 'remote',
    });
    expect(answered.status).toBe('answered');
    expect(answered.answeredVia).toBe('remote');

    restart();

    expect(store.questions.get(question.id)?.status).toBe('answered');
    expect(store.questions.answerOf<{ choice: string }>(question.id)).toEqual({ choice: 'no' });
    expect(store.questions.listOpen()).toEqual([]);
  });

  it('refuses a second answer, so local and remote cannot both win', () => {
    const acme = project();
    const assignment = store.assignments.create({ projectId: acme.id, pattern: 'solo' });
    const question = store.questions.open({ assignmentId: assignment.id, prompt: 'Proceed?' });

    store.questions.answer(question.id, { answer: 'yes', answeredVia: 'local' });
    expect(() =>
      store.questions.answer(question.id, { answer: 'no', answeredVia: 'remote' }),
    ).toThrow(/already answered/);
  });

  it('reports a missing question rather than silently doing nothing', () => {
    expect(() => store.questions.answer('nope', { answer: 1, answeredVia: 'local' })).toThrow(
      RecordNotFoundError,
    );
  });
});

describe('sessions.countByAgent — roster’s purge guard (§1.4)', () => {
  it('returns the right count', () => {
    const acme = project();
    const assignment = store.assignments.create({ projectId: acme.id, pattern: 'pair' });
    for (const agentId of ['ada', 'ada', 'ada', 'linus']) {
      store.sessions.create({ assignmentId: assignment.id, agentId, projectId: acme.id });
    }

    expect(store.sessions.countByAgent('ada')).toBe(3);
    expect(store.sessions.countByAgent('linus')).toBe(1);
    expect(store.sessions.countByAgent('nobody')).toBe(0);
  });

  it('uses the sessions(agent_id) index, asserted via EXPLAIN QUERY PLAN', () => {
    const plan = storage.db
      .prepare<[string], { detail: string }>(
        'EXPLAIN QUERY PLAN SELECT COUNT(*) AS n FROM sessions WHERE agent_id = ?',
      )
      .all('ada')
      .map((row) => row.detail)
      .join(' | ');

    expect(plan).toContain('sessions_agent_idx');
    expect(plan).not.toMatch(/SCAN sessions(?! USING)/);
  });
});

describe('referential integrity (§1.4)', () => {
  it('refuses to delete a project that still has sessions', () => {
    const acme = project();
    const assignment = store.assignments.create({ projectId: acme.id, pattern: 'solo' });
    store.sessions.create({
      assignmentId: assignment.id,
      agentId: 'ada',
      projectId: acme.id,
    });

    expect(() => store.projects.delete(acme.id)).toThrow(RestrictedDeleteError);
    expect(store.projects.get(acme.id)).toBeDefined();

    // Archiving is the sanctioned alternative the error points at.
    expect(store.projects.archive(acme.id).archivedAt).not.toBeNull();
    expect(store.projects.list()).toEqual([]);
    expect(store.projects.list({ includeArchived: true })).toHaveLength(1);
  });

  it('deleting an assignment cascades its members, questions and recommendations', () => {
    const acme = project();
    const assignment = store.assignments.create({
      projectId: acme.id,
      pattern: 'review',
      members: [
        { agentId: 'ada', role: 'implementer' },
        { agentId: 'linus', role: 'reviewer' },
      ],
    });
    const question = store.questions.open({
      assignmentId: assignment.id,
      prompt: 'Merge?',
      recommendations: [{ agentId: 'linus', stance: 'yes' }],
    });
    store.messages.send({
      assignmentId: assignment.id,
      toAgentId: 'ada',
      kind: 'note',
      body: 'hi',
    });

    expect(store.assignments.delete(assignment.id)).toBe(true);

    expect(store.assignments.listMembers(assignment.id)).toEqual([]);
    expect(store.questions.get(question.id)).toBeUndefined();
    expect(store.questions.listRecommendations(question.id)).toEqual([]);
    expect(store.messages.listByAssignment(assignment.id)).toEqual([]);
    // The project itself is untouched — cascade goes one way only.
    expect(store.projects.get(acme.id)).toBeDefined();
  });

  it('refuses to delete an assignment that still has sessions', () => {
    const acme = project();
    const assignment = store.assignments.create({ projectId: acme.id, pattern: 'solo' });
    store.sessions.create({
      assignmentId: assignment.id,
      agentId: 'ada',
      projectId: acme.id,
    });

    expect(() => store.assignments.delete(assignment.id)).toThrow(RestrictedDeleteError);
  });

  it('deleting an agent row leaves its sessions intact', () => {
    const acme = project();
    const assignment = store.assignments.create({ projectId: acme.id, pattern: 'solo' });
    store.agents.upsert({ id: 'ada', name: 'Ada' });
    const session = store.sessions.create({
      assignmentId: assignment.id,
      agentId: 'ada',
      projectId: acme.id,
      status: 'done',
    });

    expect(store.agents.delete('ada')).toBe(true);

    // History survives; the UI renders the unknown id as "deleted agent".
    expect(store.sessions.get(session.id)?.agentId).toBe('ada');
    expect(store.sessions.countByAgent('ada')).toBe(1);
    expect(store.agents.get('ada')).toBeUndefined();
  });

  it('deleting a session cascades its usage rows', () => {
    const acme = project();
    const assignment = store.assignments.create({ projectId: acme.id, pattern: 'solo' });
    const session = store.sessions.create({
      assignmentId: assignment.id,
      agentId: 'ada',
      projectId: acme.id,
    });
    store.usage.record({ sessionId: session.id, inputTokens: 10 });

    expect(store.sessions.delete(session.id)).toBe(true);
    expect(store.usage.totals(session.id)).toBeUndefined();
    expect(store.usage.listEvents(session.id)).toEqual([]);
  });
});

describe('agents index', () => {
  it('upserts, lists live agents by default and rebuilds atomically', () => {
    store.agents.upsert({ id: 'ada', name: 'Ada', specialty: 'backend', isOverseer: false });
    store.agents.upsert({ id: 'grace', name: 'Grace', archivedAt: '2026-08-01T00:00:00.000Z' });

    expect(store.agents.list().map((a) => a.id)).toEqual(['ada']);
    expect(store.agents.list({ includeArchived: true }).map((a) => a.id)).toEqual(['ada', 'grace']);

    // Roster's full reindex replaces the whole table.
    store.agents.replaceAll([{ id: 'linus', name: 'Linus', isOverseer: true }]);
    expect(store.agents.list().map((a) => a.id)).toEqual(['linus']);
    expect(store.agents.get('linus')?.isOverseer).toBe(true);
  });
});

describe('settings (§1.4)', () => {
  it('round-trips values, scans by prefix and treats deletion as the disabled state', () => {
    store.settings.set('remote.enabled', true);
    store.settings.set('remote.agentAccess.ada', { until: '2026-09-01T00:00:00.000Z' });
    store.settings.set('remote.agentAccess.linus', { until: null });
    store.settings.set('runner.lastWindowReset', '2026-08-16T00:00:00.000Z');

    expect(store.settings.get<boolean>('remote.enabled')).toBe(true);

    const access = store.settings.listByPrefix<{ until: string | null }>('remote.agentAccess.');
    expect(access.map((row) => row.key)).toEqual([
      'remote.agentAccess.ada',
      'remote.agentAccess.linus',
    ]);
    expect(access[0]?.value.until).toBe('2026-09-01T00:00:00.000Z');
    expect(access[0]?.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    store.settings.deleteByKey('remote.agentAccess.ada');
    expect(store.settings.has('remote.agentAccess.ada')).toBe(false);
    expect(store.settings.listByPrefix('remote.agentAccess.')).toHaveLength(1);
  });

  it('does not let `_` in a prefix act as a wildcard', () => {
    store.settings.set('a_b.one', 1);
    store.settings.set('axb.two', 2);

    expect(store.settings.listByPrefix('a_b.').map((r) => r.key)).toEqual(['a_b.one']);
  });
});

describe('remote tokens (§3.4)', () => {
  it('stores only a hash, finds by hash, and revokes without recovering', () => {
    const token = store.remoteTokens.create({
      label: 'phone',
      device: 'Pixel',
      tokenHash: 'a'.repeat(64),
      tokenPrefix: 'ab12cd',
    });

    expect(store.remoteTokens.findByHash('a'.repeat(64))?.id).toBe(token.id);
    expect(store.remoteTokens.list()).toHaveLength(1);

    store.remoteTokens.touch(token.id);
    expect(store.remoteTokens.get(token.id)?.lastUsedAt).not.toBeNull();

    expect(store.remoteTokens.revoke(token.id)).toBe(true);
    // A second revoke changes nothing, keeping the first revocation's time.
    expect(store.remoteTokens.revoke(token.id)).toBe(false);
    expect(store.remoteTokens.list()).toEqual([]);
    expect(store.remoteTokens.list({ includeRevoked: true })).toHaveLength(1);
  });

  it('refuses two tokens with the same hash', () => {
    store.remoteTokens.create({ label: 'a', tokenHash: 'h', tokenPrefix: 'p' });
    expect(() =>
      store.remoteTokens.create({ label: 'b', tokenHash: 'h', tokenPrefix: 'p' }),
    ).toThrow(/UNIQUE/);
  });
});

describe('events retention (§1.4)', () => {
  const now = new Date('2026-08-16T12:00:00.000Z');
  const daysAgo = (days: number): string =>
    new Date(now.getTime() - days * 86_400_000).toISOString();

  it('prunes by age', () => {
    store.events.append({ type: 'session.started', ts: daysAgo(45) });
    store.events.append({ type: 'session.started', ts: daysAgo(31) });
    const kept = store.events.append({ type: 'session.ended', ts: daysAgo(2) });

    const result = store.events.prune({ eventDays: 30, eventMaxRows: 1000 }, now);

    expect(result.byAge).toBe(2);
    expect(result.remaining).toBe(1);
    expect(store.events.list().map((e) => e.id)).toEqual([kept.id]);
  });

  it('prunes by row cap, keeping the newest', () => {
    const ids: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      ids.push(store.events.append({ type: 'session.delta', ts: daysAgo(1) }).id);
    }

    const result = store.events.prune({ eventDays: 30, eventMaxRows: 4 }, now);

    expect(result.byCap).toBe(6);
    expect(store.events.list().map((e) => e.id)).toEqual(ids.slice(-4));
  });

  it('runs on boot', () => {
    store.events.append({ type: 'old', ts: daysAgo(400) });
    store.events.append({ type: 'new', ts: daysAgo(1) });
    storage.close();

    storage = openStorage({
      dataRoot: root.path,
      tightenAcl: false,
      retention: { eventDays: 30, eventMaxRows: 200_000 },
      clock: () => now,
    });
    store = storage.store;

    expect(store.events.list().map((e) => e.type)).toEqual(['new']);
  });

  it('replays from an id watermark and filters by type pattern (§6.5)', () => {
    const first = store.events.append({ type: 'session.started', sessionId: 's1' });
    const second = store.events.append({ type: 'session.ended', sessionId: 's1' });
    const third = store.events.append({ type: 'question.opened', assignmentId: 'a1' });

    expect(store.events.list({ since: first.id }).map((e) => e.id)).toEqual([second.id, third.id]);
    expect(store.events.list({ types: ['session.*'] }).map((e) => e.id)).toEqual([
      first.id,
      second.id,
    ]);
    expect(store.events.list({ types: ['question.opened'] }).map((e) => e.id)).toEqual([third.id]);
    expect(store.events.latestId()).toBe(third.id);
  });

  it('keeps a payload as JSON and every correlation id nullable', () => {
    const event = store.events.append({
      type: 'session.usage',
      sessionId: 's1',
      payload: { inputTokens: 12 },
    });

    expect(store.events.get(event.id)?.payloadJson).toBe('{"inputTokens":12}');
    expect(store.events.get(event.id)?.projectId).toBeNull();
  });
});

describe('the Store aggregate', () => {
  it('exposes one repository per §1.4 table group and no raw handle', () => {
    expect(Object.keys(store).sort()).toEqual([
      'agents',
      'assignments',
      'events',
      'messages',
      'projects',
      'questions',
      'remoteTokens',
      'sessions',
      'settings',
      'transaction',
      'transcripts',
      'usage',
    ]);
    expect('db' in store).toBe(false);
  });

  it('rolls back everything in a failed transaction', () => {
    const acme = project();

    expect(() =>
      store.transaction(() => {
        store.assignments.create({ projectId: acme.id, pattern: 'solo' });
        throw new Error('changed my mind');
      }),
    ).toThrow('changed my mind');

    expect(store.assignments.listByProject(acme.id)).toEqual([]);
  });

  it('nests a repository’s own transaction inside an outer one', () => {
    const acme = project();

    const id = store.transaction(() => {
      const assignment = store.assignments.create({
        projectId: acme.id,
        pattern: 'pair',
        members: [{ agentId: 'ada', role: 'implementer' }],
      });
      return assignment.id;
    });

    expect(store.assignments.listMembers(id)).toHaveLength(1);
  });
});
