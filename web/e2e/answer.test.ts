/**
 * The question answer round-trip, end to end (ui IMPLEMENTATION §5).
 *
 * > "Answering inside runner's hold resolves the pending tool call **inline** and
 * > the session continues in the same turn."
 *
 * That sentence spans four elements — runner's `canUseTool`, orchestrator's
 * question row, the HTTP answer route, and runner's resolution of the held
 * promise — so nothing short of a booted core can prove it. Only `query()` is
 * scripted; the callback under test is the one the **launch chain compiled**,
 * captured off the SDK options exactly as runner's own suite captures it, and it
 * is invoked the way the engine invokes it.
 *
 * The two ui-side claims asserted alongside it:
 *
 * - the inbox is **one request cold**, and the projection it returns carries the
 *   options, the ids and the recommendations inline (§11.1);
 * - the answer body the UI builds (`answerBody`) is one the server accepts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';

import { controllableQuery } from '../../src/modules/runner/__tests__/fakeQuery.js';
import type { SdkOptions } from '../../src/modules/runner/contracts.js';
import type { CreateSoloResult, QuestionCard, QuestionListView } from '../src/api/types';
import { answerBody, askedBy, KIND_LABELS } from '../src/questions/card';

import {
  bootCore,
  makeTempDir,
  seedAgent,
  seedProject,
  until,
  type BootedCore,
  type TempDir,
} from './core';

type CanUseTool = NonNullable<SdkOptions['canUseTool']>;

/** The tool input the SDK's own `AskUserQuestion` carries (runner §5.3). */
const ASK_INPUT = {
  questions: [
    {
      question: 'Store transcripts in the DB or on disk?',
      header: 'Storage',
      options: [
        { label: 'On disk', description: 'One file per session' },
        { label: 'In SQLite', description: 'One store to back up' },
      ],
      multiSelect: false,
    },
  ],
};

let core: BootedCore | undefined;
let workspace: TempDir;

beforeEach(() => {
  workspace = makeTempDir('agentmanager-ui-e2e-answer-');
});

afterEach(async () => {
  await core?.shutdown();
  core = undefined;
  workspace.cleanup();
});

describe('answering inside the hold resolves the tool call inline (§11.3, §5)', () => {
  it('raises one card, answers it over HTTP, and the session continues in the same turn', async () => {
    const captured: CanUseTool[] = [];
    const held = controllableQuery({
      onCall: (args) => {
        if (args.options.canUseTool !== undefined) captured.push(args.options.canUseTool);
      },
    });
    core = await bootCore({ runner: { query: held.query } });

    const projectId = await seedProject(core, workspace.path, 'lpm');
    const agentId = await seedAgent(core, 'Sam Asker');
    const launched = await core.client.request<CreateSoloResult>('/assignments/solo', {
      method: 'POST',
      body: { projectId, agentId, prompt: 'decide where transcripts live' },
    });
    if (launched.kind !== 'ok') throw new Error(launched.message);
    const sessionId = launched.value.sessionId;

    await held.started(1);
    const canUseTool = await until(
      () => captured[0],
      (value) => value !== undefined,
    );
    if (canUseTool === undefined) throw new Error('the launch chain compiled no canUseTool');

    // The agent asks. The promise is the tool call, held open by runner.
    const pending = canUseTool('AskUserQuestion', ASK_INPUT, {
      signal: new AbortController().signal,
      toolUseID: 'toolu_01',
      requestId: 'req_01',
    }) as Promise<PermissionResult>;

    // --- the inbox, cold and in one request (§11.1) ------------------------
    const before = core.calls.length;
    const inbox = await until(
      async () =>
        core!.client.request<QuestionListView>('/questions', { query: { status: 'open' } }),
      (result) => result.kind === 'ok' && result.value.questions.length === 1,
    );
    if (inbox.kind !== 'ok') throw new Error(inbox.message);
    // Every poll is one request and nothing else: no roster, project or
    // assignment fetch stands between arriving and drawing the card.
    expect(core.calls.slice(before).every((path) => path.startsWith('/api/questions'))).toBe(true);

    const card = inbox.value.questions[0] as QuestionCard;
    expect(KIND_LABELS[card.kind]).toBe('QUESTION');
    expect(card.prompt).toBe('Store transcripts in the DB or on disk?');
    // The options are the tool's own, verbatim — the UI invents nothing.
    expect(card.options.map((option) => option.label)).toEqual(['On disk', 'In SQLite']);
    // Denormalised ids, so no join is needed to render the card.
    expect(card.assignmentId).toBe(launched.value.assignmentId);
    expect(card.projectId).toBe(projectId);
    expect(card.sessionId).toBe(sessionId);
    expect(card.recommendations).toBeInstanceOf(Array);
    // A plain question is never attributed to the engine (§16-2).
    expect(askedBy(card)).not.toBe('AgentManager');

    // The session is parked on the ask, not finished.
    const live = await core.client.request<{ session: { status: string } }>(
      `/sessions/${sessionId}`,
    );
    if (live.kind !== 'ok') throw new Error(live.message);
    expect(['running', 'paused']).toContain(live.value.session.status);

    // --- the answer, through the body the UI builds (§11.3) ----------------
    const chosen = card.options[0];
    if (chosen === undefined) throw new Error('the card carried no option');
    const body = answerBody(card, { optionIds: [chosen.id], text: '' });
    const answered = await core.client.request<QuestionCard>(`/questions/${card.id}/answer`, {
      method: 'POST',
      body,
    });
    if (answered.kind !== 'ok') throw new Error(answered.message);
    expect(answered.value.status).toBe('answered');
    // `answered_via` is recorded from the listener, never from the body (§16-3).
    expect(answered.value.answeredVia).toBe('local');

    // --- the tool call resolves inline (§11.3, runner §5.3) ----------------
    const result = await pending;
    expect(result.behavior).toBe('allow');
    if (result.behavior !== 'allow') throw new Error('unreachable');
    // The agent never left the tool call: the answer came back as the tool's own
    // result, keyed by the question the SDK asked.
    expect(result.updatedInput).toMatchObject({
      questions: ASK_INPUT.questions,
      answers: { 'Store transcripts in the DB or on disk?': 'On disk' },
    });

    // The session continued in the same turn rather than being restarted.
    const after = await core.client.request<{ session: { status: string } }>(
      `/sessions/${sessionId}`,
    );
    if (after.kind !== 'ok') throw new Error(after.message);
    expect(after.value.session.status).toBe('running');

    // The card has left Open and is in Answered, with the choice on it.
    const open = await core.client.request<QuestionListView>('/questions', {
      query: { status: 'open' },
    });
    if (open.kind !== 'ok') throw new Error(open.message);
    expect(open.value.questions).toHaveLength(0);

    const closed = await core.client.request<QuestionListView>('/questions', {
      query: { status: 'answered' },
    });
    if (closed.kind !== 'ok') throw new Error(closed.message);
    expect(closed.value.questions.map((one) => one.id)).toEqual([card.id]);
    expect(closed.value.questions[0]?.answeredVia).toBe('local');

    held.endAll();
  });

  it('refuses a second answer with a message a human can act on', async () => {
    const captured: CanUseTool[] = [];
    const held = controllableQuery({
      onCall: (args) => {
        if (args.options.canUseTool !== undefined) captured.push(args.options.canUseTool);
      },
    });
    core = await bootCore({ runner: { query: held.query } });
    const projectId = await seedProject(core, workspace.path, 'lpm');
    const agentId = await seedAgent(core, 'Ada Twice');
    const launched = await core.client.request<CreateSoloResult>('/assignments/solo', {
      method: 'POST',
      body: { projectId, agentId, prompt: 'decide' },
    });
    if (launched.kind !== 'ok') throw new Error(launched.message);

    await held.started(1);
    const canUseTool = await until(
      () => captured[0],
      (value) => value !== undefined,
    );
    if (canUseTool === undefined) throw new Error('no canUseTool');
    const pending = canUseTool('AskUserQuestion', ASK_INPUT, {
      signal: new AbortController().signal,
      toolUseID: 'toolu_02',
      requestId: 'req_02',
    }) as Promise<PermissionResult>;

    const inbox = await until(
      async () =>
        core!.client.request<QuestionListView>('/questions', { query: { status: 'open' } }),
      (result) => result.kind === 'ok' && result.value.questions.length === 1,
    );
    if (inbox.kind !== 'ok') throw new Error(inbox.message);
    const card = inbox.value.questions[0] as QuestionCard;
    const first = card.options[0];
    if (first === undefined) throw new Error('no option');

    await core.client.request(`/questions/${card.id}/answer`, {
      method: 'POST',
      body: answerBody(card, { optionIds: [first.id], text: '' }),
    });
    await pending;

    // The phone answered a moment after the desktop did. That is a 409 with the
    // server's own sentence, which is what the card renders (§3.1).
    const again = await core.client.request(`/questions/${card.id}/answer`, {
      method: 'POST',
      body: answerBody(card, { optionIds: [first.id], text: '' }),
    });
    expect(again.kind).toBe('error');
    if (again.kind !== 'error') throw new Error('unreachable');
    expect(again.status).toBe(409);
    expect(again.code).toBe('question_not_open');
    expect(again.message).toContain('only an open question can be answered');

    held.endAll();
  });
});
