/**
 * The solo launch, end to end (ui IMPLEMENTATION §3, §4).
 *
 * > "**Under a minute, three ways**: drag→type→Enter … all reach a running
 * > session."
 *
 * The three ways are three entry points onto **one** submit (§5.4), and jsdom
 * proves the entry points (`BoardDnd.test.tsx`, `LaunchFlow.test.tsx`). What it
 * cannot prove is that the submit reaches a *running session*: that needs
 * orchestrator to mint the assignment, runner to admit it, projects to lease a
 * workspace and a transcript to appear on disk. This does that, with only
 * `query()` scripted — and then reads the transcript back through the frontend's
 * own `?tail=` path and the `blocks.ts` reducer, which is the join between M3 and
 * M4.
 *
 * The board-order round-trip is here for the same reason: "persists across a
 * reload **and across a second client**" is a claim about the server's storage,
 * not about a cache.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { scriptedQuery, successScript } from '../../src/modules/runner/__tests__/fakeQuery.js';
import type { CreateSoloResult, RosterListView, TranscriptPage } from '../src/api/types';
import { persistBoardOrder } from '../src/board/boardOrder';
import { applyPage, EMPTY_TRANSCRIPT, renderedSeqs } from '../src/session/blocks';

import {
  bootCore,
  makeTempDir,
  seedAgent,
  seedProject,
  untilTerminal,
  type BootedCore,
  type TempDir,
} from './core';

let core: BootedCore | undefined;
let workspace: TempDir;

beforeEach(() => {
  workspace = makeTempDir('agentmanager-ui-e2e-work-');
});

afterEach(async () => {
  await core?.shutdown();
  core = undefined;
  workspace.cleanup();
});

describe('the launch flow reaches a running session (§3, §6)', () => {
  it('submits POST /api/assignments/solo and the session runs to completion', async () => {
    const script = scriptedQuery({ messages: successScript('Reproduced the 500 on /invoices.') });
    core = await bootCore({ runner: { query: script.query } });

    const projectId = await seedProject(core, workspace.path, 'littlepocketmuseum');
    const agentId = await seedAgent(core, 'Priya Bug');

    // Exactly the body the launch flow posts (§6, orchestrator §16.7).
    const launched = await core.client.request<CreateSoloResult>('/assignments/solo', {
      method: 'POST',
      body: { projectId, agentId, prompt: 'reproduce the 500 on /invoices', role: 'implementer' },
    });

    expect(launched.kind).toBe('ok');
    if (launched.kind !== 'ok') throw new Error(launched.message);
    expect(launched.status).toBe(201);
    expect(launched.value.assignmentId).toEqual(expect.any(String));
    expect(launched.value.sessionId).toEqual(expect.any(String));

    // "reach a running session" — and then finish, since the script completes.
    const settled = await untilTerminal(core, launched.value.sessionId);
    expect(settled).toMatchObject({ status: 'done', exitReason: 'completed' });
    expect(script.calls).toHaveLength(1);
  });

  it('renders the session the launch produced from one ?tail= request (§9.4)', async () => {
    const script = scriptedQuery({ messages: successScript('All done.') });
    core = await bootCore({ runner: { query: script.query } });
    const projectId = await seedProject(core, workspace.path, 'lpm');
    const agentId = await seedAgent(core, 'Ada Tail');

    const launched = await core.client.request<CreateSoloResult>('/assignments/solo', {
      method: 'POST',
      body: { projectId, agentId, prompt: 'go' },
    });
    if (launched.kind !== 'ok') throw new Error(launched.message);
    await untilTerminal(core, launched.value.sessionId);

    const before = core.calls.length;
    const page = await core.client.request<TranscriptPage>(
      `/sessions/${launched.value.sessionId}/transcript`,
      { query: { tail: '65536' } },
    );
    if (page.kind !== 'ok') throw new Error(page.message);
    // One request for the whole view, regardless of transcript size (§9.4).
    expect(core.calls.length - before).toBe(1);

    const state = applyPage(EMPTY_TRANSCRIPT, page.value);
    // The reducer's `seqs` are exactly the transcript's own, in order — the
    // "no duplicated and no missing blocks" comparison, against a real file.
    const fileSeqs = page.value.lines
      .filter((one) => !['system', 'usage', 'tool_result'].includes(one.type))
      .map((one) => one.seq);
    expect(renderedSeqs(state)).toEqual(fileSeqs);
    expect(state.blocks.map((block) => block.kind)).toContain('start');
    expect(state.blocks.map((block) => block.kind)).toContain('end');
    expect(state.pruned).toBe(false);
  });

  it('refuses a launch on a project it cannot run against, with a message for a human', async () => {
    core = await bootCore();
    const agentId = await seedAgent(core, 'Bea Refused');
    const refused = await core.client.request('/assignments/solo', {
      method: 'POST',
      body: { projectId: 'no-such-project', agentId, prompt: 'go' },
    });
    expect(refused.kind).not.toBe('ok');
    if (refused.kind === 'ok') throw new Error('unreachable');
    // §3.1: the server's message, verbatim. Never a stack trace (runner §3.2).
    expect(refused.message).toBeTruthy();
    expect(refused.message).not.toContain('    at ');
  });
});

describe('board order round-trips through roster (§5.3, roster §9.5)', () => {
  it('persists, is idempotent on replay, and refuses an unknown id without losing the order', async () => {
    core = await bootCore();
    const first = await seedAgent(core, 'Ana Order');
    const second = await seedAgent(core, 'Zed Order');

    const readOrder = async (): Promise<readonly string[]> => {
      const roster = await core!.client.request<RosterListView>('/roster/agents');
      if (roster.kind !== 'ok') throw new Error(roster.message);
      return [...roster.value.agents]
        .sort((a, b) => a.uiState.boardOrder - b.uiState.boardOrder)
        .map((agent) => agent.definition.id);
    };

    const initial = await readOrder();
    expect(new Set(initial)).toEqual(new Set([first, second]));

    // The whole ordered list, in one request, through the production helper.
    const toasts: string[] = [];
    const reversed = [...initial].reverse();
    const queryClient = {
      getQueryData: () => undefined,
      setQueryData: () => undefined,
      invalidateQueries: () => Promise.resolve(),
    } as unknown as Parameters<typeof persistBoardOrder>[0]['queryClient'];

    const written = await persistBoardOrder(
      { client: core.client, queryClient, toast: (m) => toasts.push(m) },
      reversed,
    );
    expect(written.ok).toBe(true);
    expect(toasts).toEqual([]);

    // "persists … across a second client": a fresh read, no cache involved.
    expect(await readOrder()).toEqual(reversed);

    // Replaying the same order is a no-op.
    const replay = await persistBoardOrder(
      { client: core.client, queryClient, toast: (m) => toasts.push(m) },
      reversed,
    );
    expect(replay.ok).toBe(true);
    expect(await readOrder()).toEqual(reversed);

    // An unknown id is a 400 and the previous order stands.
    const refused = await persistBoardOrder(
      { client: core.client, queryClient, toast: (m) => toasts.push(m) },
      ['ghost', ...reversed],
    );
    expect(refused.ok).toBe(false);
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toContain('ghost');
    expect(await readOrder()).toEqual(reversed);
  });
});
