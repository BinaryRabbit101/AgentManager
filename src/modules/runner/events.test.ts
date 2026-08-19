/**
 * §10's event table, the per-session stream, and the diagnostics `init` makes
 * checkable (runner IMPLEMENTATION M10) — one `describe` per acceptance bullet.
 *
 * The persist split is the load decision this milestone exists to protect: "a
 * session producing hundreds of deltas and tool calls adds a single-digit number
 * of `events` rows". So one test emits hundreds of them against a **real**
 * events table and counts the rows, rather than asserting on a flag.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeTempDir, type TempDir } from './__tests__/helpers.js';
import {
  fakeAssistant,
  fakeInit,
  fakeResult,
  fakeSessionStateChanged,
  fakeStreamEvent,
  fakeToolResult,
  fakeUnknownMessage,
  scriptedQuery,
  successScript,
} from './__tests__/fakeQuery.js';
import {
  fakeCompiledOptions,
  fakeRoster,
  makeLaunchHarness,
  type LaunchHarness,
  type RecordedEvent,
} from './__tests__/launchHarness.js';
import { EVENT_PERSIST, persistsEvent, preview, SESSION_EVENT_TYPES } from './events.js';
import type { SDKMessage } from './sdk.js';

let temp: TempDir;

beforeEach(() => {
  temp = makeTempDir('agentmanager-runner-events-');
});

afterEach(() => {
  temp.cleanup();
});

function dataRoot(): string {
  return `${temp.path}\\data`;
}

function ofType(harness: LaunchHarness, type: string): RecordedEvent[] {
  return harness.events.filter((event) => event.type === type);
}

// ---------------------------------------------------------------------------

describe('§10’s table, as data', () => {
  it('carries every row of §10 with the design’s persist flag', () => {
    // Transcribed from DESIGN §10 rather than derived from the code, so a change
    // to the code that is not a change to the design fails here.
    const design: Readonly<Record<string, boolean>> = {
      'session.queued': true,
      'session.started': true,
      'session.message': false,
      'session.delta': false,
      'session.tool.start': false,
      'session.tool.end': false,
      'session.usage': false,
      'session.steered': true,
      'session.question.raised': true,
      'session.question.answered': true,
      'session.paused': true,
      'session.resumed': true,
      'session.ended': true,
      'session.orphaned': true,
      'session.diagnostic': true,
      'runner.queue.changed': false,
      'runner.ratelimited': true,
      'runner.mcp.status': false,
      // §7.2 step 3, orchestrator-facing rather than a §10 session event.
      'assignment.budget.exceeded': true,
    };
    expect(EVENT_PERSIST).toEqual(design);
  });

  it('refuses to classify an event §10 does not list', () => {
    expect(() => persistsEvent('session.invented')).toThrow(/§10's event table/u);
  });

  it('offers exactly the session-scoped subset to the per-session stream', () => {
    expect([...SESSION_EVENT_TYPES].sort()).toEqual(
      [
        'session.delta',
        'session.diagnostic',
        'session.ended',
        'session.message',
        'session.orphaned',
        'session.paused',
        'session.queued',
        'session.question.answered',
        'session.question.raised',
        'session.resumed',
        'session.started',
        'session.steered',
        'session.tool.end',
        'session.tool.start',
        'session.usage',
        'runner.mcp.status',
      ].sort(),
    );
  });

  it('previews a tool input rather than shipping it whole', () => {
    expect(preview('short')).toBe('short');
    expect(preview('x'.repeat(500))).toHaveLength(200);
    expect(preview({ file: 'a.ts' })).toBe('{"file":"a.ts"}');
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(() => preview(circular)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------

describe('every §10 event fires at the right moment with populated ids', () => {
  it('emits message, tool.start, tool.end, delta and usage across one turn', async () => {
    const script = scriptedQuery({
      messages: [
        fakeInit(),
        fakeStreamEvent('Read'),
        fakeStreamEvent('ing…'),
        fakeAssistant({
          text: 'Reading the file.',
          toolUse: { id: 'tu_1', name: 'Read', input: { file: 'a.ts' } },
        }),
        fakeToolResult({ toolUseId: 'tu_1', content: 'file contents' }),
        fakeAssistant({ text: 'All done.' }),
        fakeResult({ text: 'All done.' }),
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
        prompt: 'Read a.ts.',
      });
      await harness.service.awaitSettled(started.sessionId);
      await Promise.resolve();

      const deltas = ofType(harness, 'session.delta');
      expect(deltas.map((event) => (event.payload as { text: string }).text)).toEqual([
        'Read',
        'ing…',
      ]);

      const messages = ofType(harness, 'session.message');
      expect(messages.map((event) => (event.payload as { role: string }).role)).toEqual([
        'assistant',
        'user',
        'assistant',
      ]);
      expect(messages[0]?.payload).toMatchObject({ text: 'Reading the file.' });

      const toolStart = ofType(harness, 'session.tool.start');
      expect(toolStart).toHaveLength(1);
      expect(toolStart[0]?.payload).toMatchObject({
        toolUseId: 'tu_1',
        name: 'Read',
        inputPreview: '{"file":"a.ts"}',
      });

      const toolEnd = ofType(harness, 'session.tool.end');
      expect(toolEnd).toHaveLength(1);
      expect(toolEnd[0]?.payload).toMatchObject({
        toolUseId: 'tu_1',
        name: 'Read',
        isError: false,
        resultPreview: 'file contents',
      });

      expect(ofType(harness, 'session.usage').length).toBeGreaterThan(0);

      // §10: "`ids = { sessionId, assignmentId, projectId, agentId }` always
      // populated". The two scheduler events are the documented exception — they
      // describe the queue, not a session.
      for (const event of harness.events) {
        if (event.type === 'runner.queue.changed' || event.type === 'runner.ratelimited') continue;
        expect(event.ids, event.type).toEqual({
          sessionId: started.sessionId,
          assignmentId: seed.assignmentId,
          projectId: seed.projectId,
          agentId: seed.agentId,
        });
      }

      // The `seq` on a live event is the transcript line it belongs to, which is
      // what lets a client merge the two streams instead of guessing.
      const lines = harness.transcriptLines(started.sessionId);
      const assistantSeq = messages[0]?.payload as { seq: number };
      expect(lines[assistantSeq.seq - 1]?.['type']).toBe('assistant');
      const startSeq = toolStart[0]?.payload as { seq: number };
      expect(lines[startSeq.seq - 1]?.['type']).toBe('tool_use');
    } finally {
      harness.close();
    }
  });

  it('adds a single-digit number of events rows for hundreds of live ones', async () => {
    const noisy: SDKMessage[] = [fakeInit()];
    for (let index = 0; index < 120; index += 1) {
      noisy.push(fakeStreamEvent(`chunk ${String(index)}`));
      noisy.push(
        fakeAssistant({
          messageId: `msg_${String(index)}`,
          text: `step ${String(index)}`,
          toolUse: { id: `tu_${String(index)}`, name: 'Read', input: { i: index } },
        }),
      );
      noisy.push(fakeToolResult({ toolUseId: `tu_${String(index)}`, content: 'ok' }));
    }
    noisy.push(fakeResult({ text: 'done' }), fakeSessionStateChanged('idle'));

    const script = scriptedQuery({ messages: noisy });
    const harness = makeLaunchHarness({
      dataRoot: dataRoot(),
      query: script.query,
      // A cap this run would blow through without the persist split would make
      // the count meaningless, so the transcript is left uncapped-in-practice.
      config: {
        transcript: { flushLines: 50, flushMs: 2000, maxMb: 512, maxTailBytes: 1_048_576 },
      },
    });
    try {
      const seed = harness.seed();
      const started = await harness.service.startSession({
        assignmentId: seed.assignmentId,
        agentId: seed.agentId,
        projectId: seed.projectId,
        prompt: 'Be noisy.',
      });
      await harness.service.awaitSettled(started.sessionId);
      await Promise.resolve();

      // Hundreds of live events…
      const live = harness.events.filter((event) => !event.persist);
      expect(live.length).toBeGreaterThan(400);

      // …and a single-digit number of durable rows.
      const rows = harness.storage.store.events.list({ sessionId: started.sessionId });
      expect(rows.length).toBeLessThan(10);
      expect(rows.map((row) => row.type)).toEqual([
        'session.queued',
        'session.started',
        'session.ended',
      ]);
    } finally {
      harness.close();
    }
  });
});

// ---------------------------------------------------------------------------

describe('the replay contract (§15.2-12)', () => {
  it('replays persisted events from since= and tails the transcript with no gap and no duplicate', async () => {
    const script = scriptedQuery({
      messages: [
        fakeInit(),
        fakeAssistant({
          text: 'one',
          toolUse: { id: 'tu_1', name: 'Read', input: { file: 'a.ts' } },
        }),
        fakeToolResult({ toolUseId: 'tu_1', content: 'contents' }),
        fakeAssistant({ text: 'two' }),
        fakeResult({ text: 'two' }),
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
        prompt: 'Two turns.',
      });
      await harness.service.awaitSettled(started.sessionId);

      const rows = harness.storage.store.events.list({ sessionId: started.sessionId });
      const watermark = rows[0]?.id;
      expect(watermark).toBeDefined();
      if (watermark === undefined) return;

      // The half a client already had is never sent again…
      const replayed = harness.storage.store.events.list({
        sessionId: started.sessionId,
        since: watermark,
      });
      expect(replayed.map((row) => row.id)).not.toContain(watermark);
      // …and nothing between the watermark and now is missing.
      expect(replayed.map((row) => row.type)).toEqual(rows.slice(1).map((row) => row.type));

      // The transcript half: a client that had read `head` bytes resumes from
      // `next` and sees every remaining line exactly once.
      const head = harness.reader.read(started.sessionId, { limit: 3 });
      const rest = harness.reader.read(started.sessionId, { from: head.next });
      const seen = [...head.lines, ...rest.lines].map((line) => line.seq);
      const all = harness.transcriptLines(started.sessionId).map((line) => Number(line['seq']));
      expect(seen).toEqual(all);
      expect(new Set(seen).size).toBe(seen.length);
      expect(rest.next).toBe(harness.sessions.require(started.sessionId).transcriptBytes);
    } finally {
      harness.close();
    }
  });
});

// ---------------------------------------------------------------------------

describe('what init makes checkable (§10, roster §7.1, roster §10)', () => {
  it('raises an MCP needs-auth server as a diagnostic and does not fail the session', async () => {
    const script = scriptedQuery({
      messages: [
        fakeInit({
          mcpServers: [
            { name: 'github', status: 'needs-auth' },
            { name: 'files', status: 'connected' },
          ],
        }),
        fakeAssistant({ text: 'carrying on without github' }),
        fakeResult({ text: 'done' }),
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
        prompt: 'Use the MCP server.',
      });
      const settled = await harness.service.awaitSettled(started.sessionId);
      await Promise.resolve();
      await Promise.resolve();

      // roster §10's vocabulary, unchanged — runner re-maps none of it.
      const status = ofType(harness, 'runner.mcp.status');
      expect(status).toHaveLength(1);
      expect(status[0]?.payload).toMatchObject({
        sessionId: started.sessionId,
        servers: [
          { name: 'github', status: 'needs-auth' },
          { name: 'files', status: 'connected' },
        ],
      });
      expect(status[0]?.persist).toBe(false);

      const diagnostics = ofType(harness, 'session.diagnostic');
      const needsAuth = diagnostics.find(
        (event) => (event.payload as { code: string }).code === 'mcp_needs_auth',
      );
      expect(needsAuth?.payload).toMatchObject({ severity: 'warn', server: 'github' });
      expect(needsAuth?.persist).toBe(true);
      // WO6 item 3: the card is actionable, and honest about the relaunch. The
      // scripted session has no `reconnectMcpServer`, which is the build where
      // "authorise and relaunch" is the true instruction.
      expect(needsAuth?.payload).toMatchObject({ action: 'authenticate', relaunchRequired: true });
      expect(String((needsAuth?.payload as { message: string }).message)).toContain('relaunch');

      // WO6 item 4's second bullet: the fact is *also* in the session's own
      // context, so the agent starts knowing rather than discovering.
      const notes = script.pushed
        .map((message) => JSON.stringify(message.message.content))
        .filter((content) => content.includes('system-reminder'));
      expect(notes).toHaveLength(1);
      expect(notes[0]).toContain('github (mcp__github__*)');
      expect(notes[0]).toContain('not authorised');
      expect(notes[0]).not.toContain('files (mcp__files__*)');
      expect(notes[0]).toContain('report_status');

      // "the session is not failed for it".
      expect(settled.status).toBe('done');
    } finally {
      harness.close();
    }
  });

  it('says a failed server out loud, and injects no note when every server connected', async () => {
    const failing = scriptedQuery({
      messages: [
        fakeInit({ mcpServers: [{ name: 'todo', status: 'failed' }] }),
        ...successScript('done'),
      ],
    });
    const clean = scriptedQuery({
      messages: [
        fakeInit({ mcpServers: [{ name: 'todo', status: 'connected' }] }),
        ...successScript('done'),
      ],
    });

    const withFailure = makeLaunchHarness({ dataRoot: dataRoot(), query: failing.query });
    try {
      const seed = withFailure.seed();
      const started = await withFailure.service.startSession({
        assignmentId: seed.assignmentId,
        agentId: seed.agentId,
        projectId: seed.projectId,
        prompt: 'Use the MCP server.',
      });
      await withFailure.service.awaitSettled(started.sessionId);
      await Promise.resolve();
      await Promise.resolve();

      const failed = ofType(withFailure, 'session.diagnostic').find(
        (event) => (event.payload as { code: string }).code === 'mcp_failed',
      );
      expect(failed?.payload).toMatchObject({ severity: 'warn', server: 'todo' });
      expect(
        failing.pushed.some((message) =>
          JSON.stringify(message.message.content).includes('system-reminder'),
        ),
      ).toBe(true);
    } finally {
      withFailure.close();
    }

    const healthy = makeLaunchHarness({ dataRoot: `${temp.path}\\data2`, query: clean.query });
    try {
      const seed = healthy.seed();
      const started = await healthy.service.startSession({
        assignmentId: seed.assignmentId,
        agentId: seed.agentId,
        projectId: seed.projectId,
        prompt: 'Use the MCP server.',
      });
      await healthy.service.awaitSettled(started.sessionId);
      await Promise.resolve();
      await Promise.resolve();

      // Nothing to say, so nothing is said: a reminder on every healthy launch
      // would be tokens spent teaching the agent to skip reminders.
      expect(
        clean.pushed.some((message) =>
          JSON.stringify(message.message.content).includes('system-reminder'),
        ),
      ).toBe(false);
    } finally {
      healthy.close();
    }
  });

  it('raises a diagnostic when requested plugins and skills are not in the init message', async () => {
    const roster = fakeRoster({
      compile: (input, base) => ({
        ...base,
        options: {
          ...fakeCompiledOptions(input.project?.cwd ?? 'C:\\workspace'),
          plugins: [{ type: 'local', path: 'C:\\library\\agents\\architect' }],
          skills: ['design-review'],
        },
      }),
    });
    // The CLI "silently skips" a nonexistent plugin path (roster §7.1), which is
    // exactly what an init reporting neither plugins nor skills looks like.
    const script = scriptedQuery({ messages: successScript() });
    const harness = makeLaunchHarness({ dataRoot: dataRoot(), query: script.query, roster });
    try {
      const seed = harness.seed();
      const started = await harness.service.startSession({
        assignmentId: seed.assignmentId,
        agentId: seed.agentId,
        projectId: seed.projectId,
        prompt: 'Use my skills.',
      });
      const settled = await harness.service.awaitSettled(started.sessionId);

      const codes = ofType(harness, 'session.diagnostic').map(
        (event) => (event.payload as { code: string }).code,
      );
      expect(codes).toContain('plugins_not_loaded');
      expect(codes).toContain('skills_not_loaded');
      // A missing skill is a degraded session, not a failed one.
      expect(settled.status).toBe('done');
    } finally {
      harness.close();
    }
  });

  it('carries non-fatal compile diagnostics on session.started and in the transcript header', async () => {
    const roster = fakeRoster({
      diagnostics: [
        { level: 'warn', code: 'model_fallback', message: 'no model declared; using the default' },
        { level: 'info', code: 'scope_empty', message: 'the assignment declared no scope rules' },
      ],
    });
    const script = scriptedQuery({ messages: successScript() });
    const harness = makeLaunchHarness({ dataRoot: dataRoot(), query: script.query, roster });
    try {
      const seed = harness.seed();
      const started = await harness.service.startSession({
        assignmentId: seed.assignmentId,
        agentId: seed.agentId,
        projectId: seed.projectId,
        prompt: 'Compile with warnings.',
      });
      const settled = await harness.service.awaitSettled(started.sessionId);
      expect(settled.status).toBe('done');

      const startedEvent = ofType(harness, 'session.started')[0];
      expect(
        (startedEvent?.payload as { diagnostics: { code: string }[] }).diagnostics.map(
          (one) => one.code,
        ),
      ).toEqual(['model_fallback', 'scope_empty']);

      const header = harness
        .transcriptLines(started.sessionId)
        .find((line) => line['type'] === 'session.start');
      expect((header?.['diagnostics'] as { code: string }[]).map((one) => one.code)).toEqual([
        'model_fallback',
        'scope_empty',
      ]);

      const emitted = ofType(harness, 'session.diagnostic').map(
        (event) => (event.payload as { code: string }).code,
      );
      expect(emitted).toEqual(expect.arrayContaining(['model_fallback', 'scope_empty']));
    } finally {
      harness.close();
    }
  });

  it('tolerates an SDK message type it has never heard of', async () => {
    const script = scriptedQuery({
      messages: [
        fakeInit(),
        fakeUnknownMessage(),
        fakeAssistant({ text: 'unbothered' }),
        fakeUnknownMessage(),
        fakeResult({ text: 'unbothered' }),
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
        prompt: 'Survive the future.',
      });
      const settled = await harness.service.awaitSettled(started.sessionId);

      expect(settled.status).toBe('done');
      expect(settled.exitReason).toBe('completed');
      // The unknown messages produced neither a transcript line nor an event.
      expect(harness.transcriptLines(started.sessionId).map((line) => line['type'])).toEqual([
        'session.start',
        'system',
        'assistant',
        'usage',
        'system',
        'session.end',
      ]);
      expect(ofType(harness, 'session.message')).toHaveLength(1);
    } finally {
      harness.close();
    }
  });
});

// ---------------------------------------------------------------------------

describe('GET /api/sessions/:id/stream (§11.1)', () => {
  it('carries this session’s §10 events and nobody else’s', async () => {
    const script = scriptedQuery({ messages: successScript() });
    const harness = makeLaunchHarness({ dataRoot: dataRoot(), query: script.query });
    try {
      const seed = harness.seed();
      const started = await harness.service.startSession({
        assignmentId: seed.assignmentId,
        agentId: seed.agentId,
        projectId: seed.projectId,
        prompt: 'Watch me.',
      });
      await harness.service.awaitSettled(started.sessionId);

      const sse = await harness.streamSession(started.sessionId);
      expect(sse.sent[0]).toMatchObject({ event: 'attached' });

      const ids = {
        sessionId: started.sessionId,
        assignmentId: seed.assignmentId,
        projectId: seed.projectId,
        agentId: seed.agentId,
      };
      harness.bus.emit({ type: 'session.delta', ids, payload: { seq: 9, text: 'hi' } });
      // A different session's frame, and a queue event that is not in §10's
      // session subset: neither may reach this socket.
      harness.bus.emit({
        type: 'session.delta',
        ids: { ...ids, sessionId: 'somebody-else' },
        payload: { seq: 1, text: 'not yours' },
      });
      harness.bus.emit({ type: 'runner.queue.changed', ids: {}, payload: { running: 1 } });

      const frames = sse.sent.filter((message) => message.event === 'event');
      expect(frames).toHaveLength(1);
      expect(frames[0]?.data).toMatchObject({
        type: 'session.delta',
        ids,
        payload: { seq: 9, text: 'hi' },
        persist: false,
      });

      // Closing the socket unsubscribes, so a long-lived UI cannot leak listeners.
      const before = harness.bus.subscriberCount();
      sse.close();
      expect(harness.bus.subscriberCount()).toBe(before - 1);
    } finally {
      harness.close();
    }
  });

  it('404s an unknown session before it opens a socket', async () => {
    const harness = makeLaunchHarness({ dataRoot: dataRoot() });
    try {
      const answer = await harness.call('GET', '/api/sessions/:id/stream', {
        params: { id: 'nope' },
      });
      expect(answer.status).toBe(404);
      expect(answer.body['error']).toBe('session_not_found');
    } finally {
      harness.close();
    }
  });
});

// ---------------------------------------------------------------------------

describe('the rest of §11.1’s table', () => {
  it('starts, lists, pages and continues a session over HTTP', async () => {
    const script = scriptedQuery({ messages: successScript() });
    const harness = makeLaunchHarness({
      dataRoot: dataRoot(),
      query: script.query,
      // The fixture has no real CLAUDE_CONFIG_DIR, so §9.3's file check is
      // answered here; without it every finished session is honestly
      // "relaunch only", which is a fact about the fixture, not the route.
      recoveryFs: { exists: () => true, entries: () => [] },
    });
    try {
      const seed = harness.seed();

      const created = await harness.call('POST', '/api/sessions', {
        body: {
          assignmentId: seed.assignmentId,
          agentId: seed.agentId,
          projectId: seed.projectId,
          prompt: 'Do it.',
          priority: 'interactive',
        },
      });
      expect(created.status).toBe(201);
      const sessionId = String(created.body['sessionId']);
      const settled = await harness.service.awaitSettled(sessionId);
      expect(settled.status).toBe('done');

      const listed = await harness.call('GET', '/api/sessions', {
        query: `assignmentId=${seed.assignmentId}`,
      });
      expect(listed.status).toBe(200);
      expect((listed.body['sessions'] as { id: string }[]).map((row) => row.id)).toEqual([
        sessionId,
      ]);

      // A bad status is a 400 that names the field, not an empty list.
      const bad = await harness.call('GET', '/api/sessions', { query: 'status=exploded' });
      expect(bad.status).toBe(400);

      const detail = await harness.call('GET', '/api/sessions/:id', { params: { id: sessionId } });
      expect(detail.body['affordances']).toMatchObject({ canStop: false, canRelaunch: false });

      const continued = await harness.call('POST', '/api/sessions/:id/continue', {
        params: { id: sessionId },
        body: { prompt: 'And again.' },
      });
      expect(continued.status).toBe(201);
      const next = String(continued.body['sessionId']);
      expect(harness.sessions.require(next).resumedFrom).toBe(sessionId);
      await harness.service.awaitSettled(next);

      // `before` pages backwards through the two rows without repeating one.
      const page = await harness.call('GET', '/api/sessions', {
        query: `limit=1&before=${next}`,
      });
      expect((page.body['sessions'] as { id: string }[]).map((row) => row.id)).toEqual([sessionId]);
    } finally {
      harness.close();
    }
  });

  it('refuses a start with a missing field before any row exists', async () => {
    const harness = makeLaunchHarness({ dataRoot: dataRoot() });
    try {
      const seed = harness.seed();
      const answer = await harness.call('POST', '/api/sessions', {
        body: { assignmentId: seed.assignmentId, agentId: seed.agentId, projectId: seed.projectId },
      });
      expect(answer.status).toBe(400);
      expect(answer.body['error']).toBe('invalid_request');
      expect(harness.sessions.list()).toHaveLength(0);
    } finally {
      harness.close();
    }
  });
});
