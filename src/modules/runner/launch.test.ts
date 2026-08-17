/**
 * The launch chain (runner IMPLEMENTATION M3), one `describe` per acceptance
 * bullet.
 *
 * Everything here runs against a **scripted `query`** (`__tests__/fakeQuery.ts`)
 * whose message sequences are the ones SDK-NOTES records for the pinned SDK. The
 * live half — a real subscription, a real subprocess — stays token-gated at the
 * bottom of this file and in `__spike__/sdk.spike.test.ts`, because the engine
 * is a compiled binary and the mechanics under test here are runner's, not the
 * model's.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeTempDir, type TempDir } from './__tests__/helpers.js';
import {
  fakeAssistant,
  fakeInit,
  fakeReplay,
  fakeResult,
  fakeSessionStateChanged,
  fakeToolResult,
  fakeUnknownMessage,
  scriptedQuery,
  successScript,
} from './__tests__/fakeQuery.js';
import {
  fakeProjects,
  fakeRoster,
  fakeSecrets,
  makeLaunchHarness,
  type LaunchHarness,
} from './__tests__/launchHarness.js';
import { diffOptionPaths, WHITELISTED_OPTION_PATHS } from './optionGuard.js';
import type { SDKMessage } from './sdk.js';

let temp: TempDir;

beforeEach(() => {
  temp = makeTempDir('agentmanager-runner-launch-');
});

afterEach(() => {
  temp.cleanup();
});

function dataRoot(): string {
  return `${temp.path}\\data`;
}

/** Line types in a session's transcript, in order. */
function lineTypes(harness: LaunchHarness, sessionId: string): string[] {
  return harness.transcriptLines(sessionId).map((line) => String(line['type']));
}

// ---------------------------------------------------------------------------

describe('the launch chain runs a session end to end (§3.1)', () => {
  it('lands done / completed with a transcript carrying the §8.1 line vocabulary', async () => {
    const script = scriptedQuery({
      messages: [
        fakeInit(),
        fakeAssistant({
          text: 'Reading the file.',
          toolUse: { id: 'tu_1', name: 'Read', input: { file: 'a.ts' } },
        }),
        fakeToolResult({ toolUseId: 'tu_1', content: 'file contents', output: { lines: 3 } }),
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
        prompt: 'Explain the launch chain.',
      });
      expect(started.status).toBe('queued');

      const settled = await harness.service.awaitSettled(started.sessionId);
      expect(settled.status).toBe('done');
      expect(settled.exitReason).toBe('completed');
      expect(settled.sdkSessionId).not.toBeNull();
      expect(settled.model).toBe('claude-sonnet-4-5');
      expect(settled.permissionMode).toBe('default');
      expect(settled.transcriptPath).not.toBeNull();
      expect(settled.summary).toBe('Explain the launch chain. — completed: All done.');

      const types = lineTypes(harness, started.sessionId);
      expect(types).toEqual([
        'session.start',
        'system',
        'assistant',
        'tool_use',
        'user',
        'tool_result',
        'assistant',
        'usage',
        'system',
        'session.end',
      ]);

      // The prompt really reached the SDK, through the streaming input queue.
      expect(script.pushed).toHaveLength(1);
      const pushed = script.pushed[0];
      expect(JSON.stringify(pushed?.message.content)).toContain('Explain the launch chain.');
    } finally {
      harness.close();
    }
  });

  it('emits session.queued, session.started and session.ended with populated ids (§10)', async () => {
    const harness = makeLaunchHarness({ dataRoot: dataRoot() });
    try {
      const seed = harness.seed();
      const started = await harness.service.startSession({
        assignmentId: seed.assignmentId,
        agentId: seed.agentId,
        projectId: seed.projectId,
        prompt: 'Do the thing.',
      });
      await harness.service.awaitSettled(started.sessionId);

      // The scheduler's `runner.queue.changed` and the unpersisted per-message
      // events of §10 (`session.usage`, `session.message`, `session.tool.*`)
      // interleave with the lifecycle events; the three lifecycle events keep
      // their order.
      const unpersisted = new Set([
        'session.usage',
        'session.message',
        'session.delta',
        'session.tool.start',
        'session.tool.end',
      ]);
      const types = harness.events
        .map((event) => event.type)
        .filter((type) => type.startsWith('session.') && !unpersisted.has(type));
      expect(types).toEqual(['session.queued', 'session.started', 'session.ended']);
      for (const event of harness.events) {
        if (!event.type.startsWith('session.')) continue;
        expect(event.ids.sessionId).toBe(started.sessionId);
        expect(event.ids.assignmentId).toBe(seed.assignmentId);
        expect(event.ids.projectId).toBe(seed.projectId);
        expect(event.ids.agentId).toBe(seed.agentId);
        expect(event.persist).toBe(!unpersisted.has(event.type));
      }
    } finally {
      harness.close();
    }
  });

  it('refuses admission before any row exists: closed assignment, unknown agent, queue full', async () => {
    const harness = makeLaunchHarness({ dataRoot: dataRoot() });
    try {
      const seed = harness.seed();
      const request = {
        assignmentId: seed.assignmentId,
        agentId: seed.agentId,
        projectId: seed.projectId,
        prompt: 'x',
      };

      await expect(
        harness.service.startSession({ ...request, agentId: 'nobody' }),
      ).rejects.toMatchObject({ code: 'agent_unknown', status: 404 });
      expect(harness.sessions.list()).toHaveLength(0);

      harness.storage.store.assignments.close(seed.assignmentId, { reason: 'user_closed' });
      await expect(harness.service.startSession(request)).rejects.toMatchObject({
        code: 'assignment_closed',
        status: 409,
      });
      expect(harness.sessions.list()).toHaveLength(0);
    } finally {
      harness.close();
    }
  });

  it('refuses a session past runner.queueLimit with no row (§6.2)', async () => {
    // A query that never yields keeps the first session in flight, so both rows
    // are genuinely still `queued` when the third launch is refused.
    const script = scriptedQuery({ messages: [], hang: true });
    const harness = makeLaunchHarness({
      dataRoot: dataRoot(),
      query: script.query,
      config: { queueLimit: 2, startTimeoutMs: 50 },
    });
    try {
      const seed = harness.seed();
      const request = {
        assignmentId: seed.assignmentId,
        agentId: seed.agentId,
        projectId: seed.projectId,
        prompt: 'x',
      };
      const first = await harness.service.startSession(request);
      const second = await harness.service.startSession(request);
      await expect(harness.service.startSession(request)).rejects.toMatchObject({
        code: 'queue_full',
        status: 429,
      });
      expect(harness.sessions.list()).toHaveLength(2);
      await harness.service.awaitSettled(first.sessionId);
      await harness.service.awaitSettled(second.sessionId);
    } finally {
      harness.close();
    }
  });
});

// ---------------------------------------------------------------------------

describe('options immutability (§3.3)', () => {
  it('changes only whitelisted key paths on the compiled options', async () => {
    const script = scriptedQuery({ messages: successScript() });
    const harness = makeLaunchHarness({ dataRoot: dataRoot(), query: script.query });
    try {
      const seed = harness.seed();
      const started = await harness.service.startSession({
        assignmentId: seed.assignmentId,
        agentId: seed.agentId,
        projectId: seed.projectId,
        prompt: 'x',
      });
      await harness.service.awaitSettled(started.sessionId);

      // The very object roster returned, and the very object runner passed to
      // `query()` — §3.3's "snapshotted before and after runner's mutations".
      const before = harness.roster.outputs[0]?.options;
      const passed = script.calls[0]?.options;
      expect(before).toBeDefined();
      expect(passed).toBeDefined();
      if (before === undefined || passed === undefined) return;

      const changed = diffOptionPaths(before, passed);
      for (const path of changed) expect(WHITELISTED_OPTION_PATHS).toContain(path);
      expect(changed).toEqual([
        'abortController',
        'canUseTool',
        'env.CLAUDE_CODE_OAUTH_TOKEN',
        // M10: §10's `session.delta` is emitted "only when
        // `includePartialMessages`", and D11 wants the deltas for the UI's live
        // typing. It is one of §3.3's whitelisted keys precisely so runner may
        // set it.
        'includePartialMessages',
        'stderr',
      ]);

      // …and the fields §3.3 forbids are identical, field by field, so a future
      // edit that "just adds one option" fails here by name.
      for (const key of [
        'allowedTools',
        'disallowedTools',
        'permissionMode',
        'settings',
        'mcpServers',
        'systemPrompt',
        'model',
        'maxTurns',
        'maxBudgetUsd',
        'cwd',
        'plugins',
        'skills',
        'settingSources',
      ] as const) {
        expect(passed[key]).toEqual(before[key]);
      }
    } finally {
      harness.close();
    }
  });
});

// ---------------------------------------------------------------------------

describe('auth (§3.4)', () => {
  it('fails secret_unresolved naming Setup-Auth.ps1 when no token is stored', async () => {
    const harness = makeLaunchHarness({ dataRoot: dataRoot(), secrets: fakeSecrets({}) });
    try {
      const seed = harness.seed();
      const started = await harness.service.startSession({
        assignmentId: seed.assignmentId,
        agentId: seed.agentId,
        projectId: seed.projectId,
        prompt: 'x',
      });
      const settled = await harness.service.awaitSettled(started.sessionId);
      expect(settled.status).toBe('failed');
      expect(settled.exitReason).toBe('secret_unresolved');

      const ended = harness.events.find((event) => event.type === 'session.ended');
      expect(String((ended?.payload as { message?: string }).message)).toContain('Setup-Auth.ps1');
    } finally {
      harness.close();
    }
  });

  it('runs on the subscription and strips a planted ANTHROPIC_API_KEY with a WARN', async () => {
    const script = scriptedQuery({ messages: successScript() });
    const roster = fakeRoster({
      compile: (_input, base) => ({
        ...base,
        options: {
          ...base.options,
          env: {
            ...base.options.env,
            ANTHROPIC_API_KEY: 'sk-ant-planted',
            ANTHROPIC_AUTH_TOKEN: 'planted-too',
          },
        },
      }),
    });
    const harness = makeLaunchHarness({ dataRoot: dataRoot(), query: script.query, roster });
    try {
      const seed = harness.seed();
      const started = await harness.service.startSession({
        assignmentId: seed.assignmentId,
        agentId: seed.agentId,
        projectId: seed.projectId,
        prompt: 'x',
      });
      const settled = await harness.service.awaitSettled(started.sessionId);
      expect(settled.status).toBe('done');

      const env = script.calls[0]?.options.env ?? {};
      expect(env['CLAUDE_CODE_OAUTH_TOKEN']).toBe('sk-ant-oat01-fixture');
      expect(env['ANTHROPIC_API_KEY']).toBeUndefined();
      // SDK-NOTES G10: the whole credential class, not just the one key.
      expect(env['ANTHROPIC_AUTH_TOKEN']).toBeUndefined();

      const warning = harness.logs.find(
        (line) => line.level === 'warn' && line.message.includes('ANTHROPIC_API_KEY'),
      );
      expect(warning).toBeDefined();
    } finally {
      harness.close();
    }
  });

  it('sets no token at all under auth.mode "env" (the work edition)', async () => {
    const script = scriptedQuery({ messages: successScript() });
    const harness = makeLaunchHarness({
      dataRoot: dataRoot(),
      query: script.query,
      auth: 'env',
      secrets: fakeSecrets({}),
    });
    try {
      const seed = harness.seed();
      const started = await harness.service.startSession({
        assignmentId: seed.assignmentId,
        agentId: seed.agentId,
        projectId: seed.projectId,
        prompt: 'x',
      });
      const settled = await harness.service.awaitSettled(started.sessionId);
      expect(settled.status).toBe('done');
      expect(script.calls[0]?.options.env?.['CLAUDE_CODE_OAUTH_TOKEN']).toBeUndefined();
    } finally {
      harness.close();
    }
  });
});

// ---------------------------------------------------------------------------

describe('the §3.2 failure table', () => {
  it('a retryable workspace refusal stays queued with blocked_reason and no slot held', async () => {
    const projects = fakeProjects({
      refusal: {
        code: 'shared_policy',
        reason: 'another write assignment holds the tree',
        retryable: true,
      },
    });
    const harness = makeLaunchHarness({ dataRoot: dataRoot(), projects });
    try {
      const seed = harness.seed();
      const started = await harness.service.startSession({
        assignmentId: seed.assignmentId,
        agentId: seed.agentId,
        projectId: seed.projectId,
        prompt: 'x',
      });
      const blocked = await harness.service.awaitSettled(started.sessionId);
      expect(blocked.status).toBe('queued');
      expect(blocked.blockedReason).toBe('another write assignment holds the tree');
      expect(harness.launch.activeCount()).toBe(0);

      // §6.2: re-evaluated on `workspace.released`.
      projects.clearRefusal();
      harness.launch.onWorkspaceReleased();
      const settled = await harness.service.awaitSettled(started.sessionId);
      expect(settled.status).toBe('done');
    } finally {
      harness.close();
    }
  });

  it('a terminal workspace refusal fails workspace_unavailable, carrying projects’ reason verbatim', async () => {
    const projects = fakeProjects({
      refusal: {
        code: 'unc_path',
        reason: 'This project lives on a network share; git worktrees are refused there.',
        retryable: false,
      },
    });
    const harness = makeLaunchHarness({ dataRoot: dataRoot(), projects });
    try {
      const seed = harness.seed();
      const started = await harness.service.startSession({
        assignmentId: seed.assignmentId,
        agentId: seed.agentId,
        projectId: seed.projectId,
        prompt: 'x',
      });
      const settled = await harness.service.awaitSettled(started.sessionId);
      expect(settled.status).toBe('failed');
      expect(settled.exitReason).toBe('workspace_unavailable');

      const ended = harness.events.find((event) => event.type === 'session.ended');
      expect((ended?.payload as { message?: string }).message).toBe(
        'This project lives on a network share; git worktrees are refused there.',
      );
    } finally {
      harness.close();
    }
  });

  it('a fatal compile diagnostic fails launch_failed with the diagnostic message', async () => {
    const roster = fakeRoster({
      diagnostics: [
        {
          level: 'error',
          code: 'roster.skill.unknown',
          message: 'skill "deploy" is not installed',
        },
      ],
    });
    const harness = makeLaunchHarness({ dataRoot: dataRoot(), roster });
    try {
      const seed = harness.seed();
      const started = await harness.service.startSession({
        assignmentId: seed.assignmentId,
        agentId: seed.agentId,
        projectId: seed.projectId,
        prompt: 'x',
      });
      const settled = await harness.service.awaitSettled(started.sessionId);
      expect(settled.status).toBe('failed');
      expect(settled.exitReason).toBe('launch_failed');
      const ended = harness.events.find((event) => event.type === 'session.ended');
      expect(String((ended?.payload as { message?: string }).message)).toContain(
        'skill "deploy" is not installed',
      );
    } finally {
      harness.close();
    }
  });

  it('a non-fatal diagnostic is emitted and recorded, and does not stop the launch', async () => {
    const roster = fakeRoster({
      diagnostics: [
        {
          level: 'warn',
          code: 'roster.model.unrecognised',
          message: 'model "claude-x" is unknown',
        },
      ],
    });
    const harness = makeLaunchHarness({ dataRoot: dataRoot(), roster });
    try {
      const seed = harness.seed();
      const started = await harness.service.startSession({
        assignmentId: seed.assignmentId,
        agentId: seed.agentId,
        projectId: seed.projectId,
        prompt: 'x',
      });
      const settled = await harness.service.awaitSettled(started.sessionId);
      expect(settled.status).toBe('done');
      expect(harness.events.map((event) => event.type)).toContain('session.diagnostic');

      const header = harness
        .transcriptLines(started.sessionId)
        .find((line) => line['type'] === 'session.start');
      expect(JSON.stringify(header?.['diagnostics'])).toContain('roster.model.unrecognised');
    } finally {
      harness.close();
    }
  });

  it('no system/init inside startTimeoutMs fails start_timeout with the stderr tail', async () => {
    const script = scriptedQuery({
      messages: [],
      hang: true,
      stderr: 'claude: error while loading the model\n',
    });
    const harness = makeLaunchHarness({
      dataRoot: dataRoot(),
      query: script.query,
      config: { startTimeoutMs: 30 },
    });
    try {
      const seed = harness.seed();
      const started = await harness.service.startSession({
        assignmentId: seed.assignmentId,
        agentId: seed.agentId,
        projectId: seed.projectId,
        prompt: 'x',
      });
      const settled = await harness.service.awaitSettled(started.sessionId);
      expect(settled.status).toBe('failed');
      expect(settled.exitReason).toBe('start_timeout');

      const errorLine = harness
        .transcriptLines(started.sessionId)
        .find((line) => line['type'] === 'error');
      expect(errorLine?.['code']).toBe('start_timeout');
      expect(String(errorLine?.['stderrTail'])).toContain('error while loading the model');
    } finally {
      harness.close();
    }
  });

  it('never lets a stack trace reach the caller: every failure is a typed message', async () => {
    const roster = fakeRoster({ throws: new Error('the agent library could not be read') });
    const harness = makeLaunchHarness({ dataRoot: dataRoot(), roster });
    try {
      const seed = harness.seed();
      const started = await harness.service.startSession({
        assignmentId: seed.assignmentId,
        agentId: seed.agentId,
        projectId: seed.projectId,
        prompt: 'x',
      });
      const settled = await harness.service.awaitSettled(started.sessionId);
      expect(settled.status).toBe('failed');
      expect(settled.exitReason).toBe('launch_failed');

      const ended = harness.events.find((event) => event.type === 'session.ended');
      const message = String((ended?.payload as { message?: string }).message);
      expect(message).toBe('the agent library could not be read');
      // Nothing carries a stack: not the event, not the transcript.
      const serialised = JSON.stringify([ended, harness.transcriptLines(started.sessionId)]);
      expect(serialised).not.toContain('    at ');
      expect(serialised).not.toContain('stack');
    } finally {
      harness.close();
    }
  });
});

// ---------------------------------------------------------------------------

describe('workspace lease refcounting (§3.1)', () => {
  it('acquires once per assignment, refcounts a second session, and releases on assignment.closed', async () => {
    const projects = fakeProjects();
    const harness = makeLaunchHarness({ dataRoot: dataRoot(), projects });
    try {
      const seed = harness.seed();
      const request = {
        assignmentId: seed.assignmentId,
        agentId: seed.agentId,
        projectId: seed.projectId,
        prompt: 'x',
      };

      const first = await harness.service.startSession(request);
      await harness.service.awaitSettled(first.sessionId);
      const second = await harness.service.startSession(request);
      await harness.service.awaitSettled(second.sessionId);

      // One acquisition for two sessions, and nothing released while the
      // assignment is still open — a terminal session alone does not free it.
      expect(projects.acquisitions).toHaveLength(1);
      expect(projects.releases).toHaveLength(0);
      expect(harness.sessions.require(first.sessionId).leaseId).toBe('lease-1');
      expect(harness.sessions.require(second.sessionId).leaseId).toBe('lease-1');

      await harness.launch.onAssignmentClosed(seed.assignmentId);
      expect(projects.releases).toEqual(['lease-1']);
    } finally {
      harness.close();
    }
  });

  it('releases through the safety net when the last session ends on a closed assignment', async () => {
    const projects = fakeProjects();
    const harness = makeLaunchHarness({ dataRoot: dataRoot(), projects });
    try {
      const seed = harness.seed();
      const started = await harness.service.startSession({
        assignmentId: seed.assignmentId,
        agentId: seed.agentId,
        projectId: seed.projectId,
        prompt: 'x',
      });
      // The assignment closes while the session runs; the safety net notices at
      // the session's terminal transition.
      harness.storage.store.assignments.close(seed.assignmentId, { reason: 'user_closed' });
      await harness.service.awaitSettled(started.sessionId);
      expect(projects.releases).toEqual(['lease-1']);
    } finally {
      harness.close();
    }
  });
});

// ---------------------------------------------------------------------------

describe('result subtypes map to §2.2', () => {
  const cases = [
    { subtype: 'success', status: 'done', exitReason: 'completed' },
    { subtype: 'error_max_turns', status: 'failed', exitReason: 'max_turns' },
    { subtype: 'error_max_budget_usd', status: 'failed', exitReason: 'max_budget_usd' },
    { subtype: 'error_during_execution', status: 'failed', exitReason: 'error_during_execution' },
    {
      subtype: 'error_max_structured_output_retries',
      status: 'failed',
      exitReason: 'error_structured_output',
    },
  ] as const;

  for (const testCase of cases) {
    it(`${testCase.subtype} → ${testCase.status} / ${testCase.exitReason}`, async () => {
      const script = scriptedQuery({
        messages: [
          fakeInit(),
          fakeAssistant({ text: 'working' }),
          fakeResult({ subtype: testCase.subtype }),
        ],
      });
      const harness = makeLaunchHarness({ dataRoot: dataRoot(), query: script.query });
      try {
        const seed = harness.seed();
        const started = await harness.service.startSession({
          assignmentId: seed.assignmentId,
          agentId: seed.agentId,
          projectId: seed.projectId,
          prompt: 'x',
        });
        const settled = await harness.service.awaitSettled(started.sessionId);
        expect(settled.status).toBe(testCase.status);
        expect(settled.exitReason).toBe(testCase.exitReason);
      } finally {
        harness.close();
      }
    });
  }

  it('a session that ends without a result fails error_during_execution', async () => {
    const script = scriptedQuery({
      messages: [fakeInit(), fakeAssistant({ text: 'half a turn' })],
    });
    const harness = makeLaunchHarness({ dataRoot: dataRoot(), query: script.query });
    try {
      const seed = harness.seed();
      const started = await harness.service.startSession({
        assignmentId: seed.assignmentId,
        agentId: seed.agentId,
        projectId: seed.projectId,
        prompt: 'x',
      });
      const settled = await harness.service.awaitSettled(started.sessionId);
      expect(settled.status).toBe('failed');
      expect(settled.exitReason).toBe('error_during_execution');
    } finally {
      harness.close();
    }
  });
});

// ---------------------------------------------------------------------------

describe('the reader loop (§2.4)', () => {
  it('continues past the first result to generator completion and keeps trailing messages', async () => {
    const script = scriptedQuery({
      messages: [
        fakeInit(),
        fakeAssistant({ text: 'turn one' }),
        fakeResult({ text: 'turn one', turns: 1 }),
        fakeSessionStateChanged('idle'),
        fakeUnknownMessage(),
        fakeAssistant({ text: 'turn two' }),
        fakeResult({ text: 'turn two', turns: 2 }),
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
        prompt: 'x',
      });
      const settled = await harness.service.awaitSettled(started.sessionId);

      // Two results, both consumed: the loop did not stop at the first, and the
      // second turn's text is what the summary carries.
      expect(settled.turns).toBe(2);
      expect(settled.summary).toContain('turn two');

      const types = lineTypes(harness, started.sessionId);
      expect(types.filter((type) => type === 'usage')).toHaveLength(2);
      // Both trailing `session_state_changed` lines survived, and the unknown
      // message type did not fail the session (§7.4).
      expect(types.filter((type) => type === 'system')).toHaveLength(3);
      expect(settled.status).toBe('done');
    } finally {
      harness.close();
    }
  });

  it('drops replayed history so a resumed session does not duplicate it (SDK-NOTES G1)', async () => {
    const messages: SDKMessage[] = [
      fakeInit(),
      fakeReplay('the prompt from the previous run'),
      fakeReplay('another replayed line'),
      fakeAssistant({ text: 'continuing' }),
      fakeResult({ text: 'continuing' }),
    ];
    const script = scriptedQuery({ messages });
    const harness = makeLaunchHarness({ dataRoot: dataRoot(), query: script.query });
    try {
      const seed = harness.seed();
      const started = await harness.service.startSession({
        assignmentId: seed.assignmentId,
        agentId: seed.agentId,
        projectId: seed.projectId,
        prompt: 'x',
      });
      await harness.service.awaitSettled(started.sessionId);

      const lines = harness.transcriptLines(started.sessionId);
      expect(lines.filter((line) => line['type'] === 'user')).toHaveLength(0);
      expect(JSON.stringify(lines)).not.toContain('the prompt from the previous run');
    } finally {
      harness.close();
    }
  });

  it('records a stream error after a result without losing the result’s status', async () => {
    const script = scriptedQuery({
      messages: [fakeInit(), fakeAssistant({ text: 'done' }), fakeResult({ text: 'done' })],
      throwAfter: new Error('Claude Code process exited with code 1. stderr: ...'),
    });
    const harness = makeLaunchHarness({ dataRoot: dataRoot(), query: script.query });
    try {
      const seed = harness.seed();
      const started = await harness.service.startSession({
        assignmentId: seed.assignmentId,
        agentId: seed.agentId,
        projectId: seed.projectId,
        prompt: 'x',
      });
      const settled = await harness.service.awaitSettled(started.sessionId);
      expect(settled.status).toBe('done');

      const errorLine = harness
        .transcriptLines(started.sessionId)
        .find((line) => line['type'] === 'error');
      expect(errorLine?.['code']).toBe('stream_error_after_result');
    } finally {
      harness.close();
    }
  });
});

// ---------------------------------------------------------------------------

describe('what runner hands roster (§3.1 step 6)', () => {
  it('passes the assignment context, the launch context and the resolved agentEnv through untouched', async () => {
    const harness = makeLaunchHarness({ dataRoot: dataRoot() });
    try {
      const seed = harness.seed();
      const started = await harness.service.startSession({
        assignmentId: seed.assignmentId,
        agentId: seed.agentId,
        projectId: seed.projectId,
        prompt: 'x',
        role: 'reviewer',
      });
      await harness.service.awaitSettled(started.sessionId);

      const input = harness.roster.inputs[0];
      expect(input).toBeDefined();
      if (input === undefined) return;

      expect(input.agent.definition.id).toBe(seed.agentId);
      expect(input.assignment).toEqual({
        id: seed.assignmentId,
        role: 'reviewer',
        write: true,
        scopeRules: {},
      });
      expect(input.project?.env).toEqual([{ name: 'PROJECT_FLAG', value: '1' }]);
      expect(input.policy).toEqual({ allowPermissionElevation: true, globalDeny: [] });
      // Owed item: foundation's `agentEnv` null, resolved (foundation §2.3).
      expect(input.agentEnv?.['CLAUDE_CODE_DISABLE_AUTO_MEMORY']).toBe('1');
      expect(input.agentEnv?.['CLAUDE_CONFIG_DIR']).toBe(
        `${harness.storage.paths.state}\\claude-config`,
      );
      expect(input.defaultModel).toBe('sonnet');
    } finally {
      harness.close();
    }
  });

  it('refuses the launch when the roster service publishes no compiler', async () => {
    const harness = makeLaunchHarness({
      dataRoot: dataRoot(),
      roster: fakeRoster({ withCompiler: false }),
    });
    try {
      const seed = harness.seed();
      const started = await harness.service.startSession({
        assignmentId: seed.assignmentId,
        agentId: seed.agentId,
        projectId: seed.projectId,
        prompt: 'x',
      });
      const settled = await harness.service.awaitSettled(started.sessionId);
      expect(settled.status).toBe('failed');
      expect(settled.exitReason).toBe('launch_failed');
      const ended = harness.events.find((event) => event.type === 'session.ended');
      expect(String((ended?.payload as { message?: string }).message)).toContain('compileSession');
    } finally {
      harness.close();
    }
  });
});

// ---------------------------------------------------------------------------
// The live half. Skipped without a token; this is M3's "a real agent runs a
// real prompt against a real project end to end" bullet, run against the real
// `query` through the same service surface.
// ---------------------------------------------------------------------------

const token = process.env['CLAUDE_CODE_OAUTH_TOKEN'];
const hasToken = typeof token === 'string' && token !== '';

describe.skipIf(!hasToken)('a live session (M3 acceptance, real SDK)', () => {
  it(
    'lands done / completed with session.start, system, assistant and session.end lines',
    { timeout: 300_000 },
    async () => {
      const workspace = `${temp.path}\\workspace`;
      const projects = fakeProjects({ workspacePath: workspace });
      const roster = fakeRoster({
        compile: (_input, base) => ({
          ...base,
          options: {
            ...base.options,
            cwd: workspace,
            tools: [],
            settingSources: [],
            skills: [],
            maxTurns: 1,
          },
        }),
      });
      const harness = makeLaunchHarness({
        dataRoot: dataRoot(),
        projects,
        roster,
        secrets: fakeSecrets({ 'claude.oauthToken': token ?? '' }),
      });
      try {
        const { mkdirSync } = await import('node:fs');
        mkdirSync(workspace, { recursive: true });
        const seed = harness.seed();
        const started = await harness.service.startSession({
          assignmentId: seed.assignmentId,
          agentId: seed.agentId,
          projectId: seed.projectId,
          prompt: 'Reply with the single word: ok',
        });
        const settled = await harness.service.awaitSettled(started.sessionId);

        expect(settled.status).toBe('done');
        expect(settled.exitReason).toBe('completed');
        const types = lineTypes(harness, started.sessionId);
        expect(types).toContain('session.start');
        expect(types).toContain('system');
        expect(types).toContain('assistant');
        expect(types).toContain('session.end');
      } finally {
        harness.close();
      }
    },
  );
});
