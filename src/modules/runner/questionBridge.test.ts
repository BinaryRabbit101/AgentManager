/**
 * The question/answer bridge (runner IMPLEMENTATION **M7**, DESIGN §5), one
 * `describe` per acceptance bullet.
 *
 * `canUseTool` is the compiled callback the launch chain handed to `query()`,
 * captured off the fake's call arguments and invoked **directly** — which is the
 * only honest way to test it without the engine, and is exactly how the engine
 * calls it: `(toolName, input, {signal, toolUseID, requestId, title?})`. Nothing
 * else is mocked: every assertion below is made against session rows, `questions`
 * rows, transcript lines and bus events the real chain wrote.
 *
 * The default fixture wires the **degraded fallback** of §5.2 (no orchestrator
 * on the registry), because that is the path the acceptance says must be
 * "verified, not assumed"; the orchestrator-present path is a hand-written
 * `QuestionBridgeView` a test resolves by hand, which is what lets an answer land
 * inside the hold on demand.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';

import type { QuestionRecord } from '../../storage/index.js';

import type {
  AskQuestionRequest,
  QuestionBridgeView,
  QuestionOutcomeView,
  SdkOptions,
} from './contracts.js';
import { makeTempDir, type TempDir } from './__tests__/helpers.js';
import {
  controllableQuery,
  fakeAssistant,
  fakeResult,
  fakeSessionStateChanged,
  fakeToolResult,
  type ControllableQuery,
} from './__tests__/fakeQuery.js';
import { makeLaunchHarness, type LaunchHarness } from './__tests__/launchHarness.js';
import type { RunnerConfig } from './config.js';
import {
  ALLOW_ONCE_OPTION,
  createQuestionCanUseTool,
  DENY_OPTION,
  readAskUserQuestion,
} from './canUseTool.js';
import {
  createQuestionSessions,
  installShadowWarningFilter,
  questionBridgeStatus,
  SHADOW_WARNING_CODE,
} from './questionBridge.js';

type CompiledCanUseTool = NonNullable<SdkOptions['canUseTool']>;

let temp: TempDir;

beforeEach(() => {
  temp = makeTempDir('agentmanager-runner-question-');
});

afterEach(() => {
  temp.cleanup();
});

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

/** A bridge a test resolves by hand — orchestrator's half, without orchestrator. */
interface ManualBridge extends QuestionBridgeView {
  readonly asks: AskQuestionRequest[];
  readonly cancels: { questionId: string; reason: string }[];
  /** Resolves the pending ask as though a human had answered the card. */
  answer(outcome: Omit<Extract<QuestionOutcomeView, { status: 'answered' }>, 'status'>): void;
  settle(outcome: QuestionOutcomeView): void;
}

function manualBridge(questionId = 'q-1'): ManualBridge {
  const asks: AskQuestionRequest[] = [];
  const cancels: { questionId: string; reason: string }[] = [];
  let resolve: ((outcome: QuestionOutcomeView) => void) | undefined;

  return {
    asks,
    cancels,
    ask(request) {
      asks.push(request);
      // The id reaches runner at *raise* time, which is what `session.question
      // .raised` and §5.4's park message need.
      request.onRaised?.(questionId);
      return new Promise<QuestionOutcomeView>((settle) => {
        resolve = settle;
      });
    },
    cancel(id, reason) {
      cancels.push({ questionId: id, reason });
      return Promise.resolve();
    },
    answer(outcome) {
      resolve?.({ status: 'answered', ...outcome });
    },
    settle(outcome) {
      resolve?.(outcome);
    },
  };
}

interface Fixture {
  readonly harness: LaunchHarness;
  readonly query: ControllableQuery;
  readonly seed: { projectId: string; assignmentId: string; agentId: string };
  readonly sessionId: string;
  /** The callback the launch chain compiled onto `options.canUseTool`. */
  readonly canUseTool: CompiledCanUseTool;
  close(): void;
}

interface FixtureOptions {
  readonly config?: Partial<RunnerConfig>;
  readonly bridge?: QuestionBridgeView;
  readonly humanMayApprove?: boolean;
  readonly allowedTools?: readonly string[];
  readonly permissionMode?: NonNullable<SdkOptions['permissionMode']>;
}

/** Launches one session and hands back its compiled callback. */
async function launch(options: FixtureOptions = {}): Promise<Fixture> {
  const captured: CompiledCanUseTool[] = [];
  const query = controllableQuery({
    onCall: (args) => {
      if (args.options.canUseTool !== undefined) captured.push(args.options.canUseTool);
    },
  });

  const harness = makeLaunchHarness({
    dataRoot: `${temp.path}\\data`,
    query: query.query,
    config: {
      gracefulInterruptMs: 60,
      question: { holdMs: 900_000, expireHours: 24 },
      ...options.config,
    },
    ...(options.bridge === undefined ? {} : { questionBridge: options.bridge }),
    roster: rosterWith(options),
  });
  const seed = harness.seed();
  const started = await harness.service.startSession({
    assignmentId: seed.assignmentId,
    agentId: seed.agentId,
    projectId: seed.projectId,
    prompt: 'Do the thing.',
  });
  await query.started(1);

  const canUseTool = captured[0];
  if (canUseTool === undefined) throw new Error('the launch chain compiled no canUseTool');

  return {
    harness,
    query,
    seed,
    sessionId: started.sessionId,
    canUseTool,
    close() {
      query.endAll();
      harness.close();
    },
  };
}

/** A roster whose compiled output carries the permission facts a test needs. */
function rosterWith(options: FixtureOptions): ReturnType<typeof makeLaunchHarness>['roster'] {
  // Imported lazily through the harness's own factory so the fake stays the one
  // in `launchHarness.ts` — this only overrides what a test varies.
  const { fakeRoster } = harnessFakes;
  const mode = options.permissionMode;
  const allowedTools = options.allowedTools;
  return fakeRoster({
    ...(options.humanMayApprove === undefined ? {} : { humanMayApprove: options.humanMayApprove }),
    compile: (_input, base) => {
      const compiledOptions: SdkOptions = { ...base.options };
      if (allowedTools !== undefined) compiledOptions.allowedTools = [...allowedTools];
      if (mode !== undefined) compiledOptions.permissionMode = mode;
      return { ...base, options: compiledOptions };
    },
  });
}

const harnessFakes = await import('./__tests__/launchHarness.js');

/** The options object the engine passes as `canUseTool`'s third argument. */
function callOptions(
  overrides: Partial<Parameters<CompiledCanUseTool>[2]> = {},
): Parameters<CompiledCanUseTool>[2] {
  return {
    signal: new AbortController().signal,
    toolUseID: 'toolu_01',
    requestId: 'req_01',
    ...overrides,
  };
}

const ASK_INPUT = {
  questions: [
    {
      question: 'Postgres or SQLite?',
      header: 'Storage',
      options: [
        { label: 'SQLite on disk', description: 'One file, no service' },
        { label: 'Postgres', description: 'A service dependency' },
      ],
      multiSelect: false,
    },
  ],
};

function openQuestionRow(fix: Fixture): QuestionRecord {
  const rows = fix.harness.storage.store.questions.listOpen({
    assignmentId: fix.seed.assignmentId,
  });
  const row = rows[0];
  if (row === undefined) throw new Error('no open question row');
  return row;
}

function eventsOfType(harness: LaunchHarness, type: string): unknown[] {
  return harness.events.filter((event) => event.type === type).map((event) => event.payload);
}

/** Lets every pending microtask and timer-free continuation run. */
async function settle(times = 6): Promise<void> {
  for (let index = 0; index < times; index += 1) await Promise.resolve();
}

// ---------------------------------------------------------------------------
// Acceptance 1 — AskUserQuestion, answered inside the hold
// ---------------------------------------------------------------------------

describe('AskUserQuestion answered inside the hold (M7 acceptance 1)', () => {
  it('raises one card and one questions row, and resolves allow with {questions, answers}', async () => {
    const bridge = manualBridge('q-ask');
    const fix = await launch({ bridge });
    try {
      const pending = fix.canUseTool('AskUserQuestion', ASK_INPUT, callOptions());
      await settle();

      // One event, one card — not two.
      const raised = eventsOfType(fix.harness, 'session.question.raised');
      expect(raised).toHaveLength(1);
      expect(raised[0]).toMatchObject({
        questionId: 'q-ask',
        kind: 'question',
        prompt: 'Postgres or SQLite?',
        toolName: 'AskUserQuestion',
      });
      // The card's options are the tool's own, keyed by label — which is what
      // the SDK's `answers` map is valued by.
      expect(bridge.asks[0]?.options?.map((option) => option.label)).toEqual([
        'SQLite on disk',
        'Postgres',
      ]);

      bridge.answer({
        questionId: 'q-ask',
        answer: { optionIds: ['SQLite on disk'], labels: ['SQLite on disk'] },
        answeredVia: 'local',
        answeredAt: new Date().toISOString(),
      });

      const result = (await pending) as PermissionResult;
      expect(result).toMatchObject({
        behavior: 'allow',
        updatedInput: {
          // §5.3: "`questions` must be echoed back".
          questions: ASK_INPUT.questions,
          answers: { 'Postgres or SQLite?': 'SQLite on disk' },
        },
      });
    } finally {
      fix.close();
    }
  });

  it('joins a multi-select answer into ONE comma-separated string (SDK-NOTES §5.4)', async () => {
    const bridge = manualBridge('q-multi');
    const fix = await launch({ bridge });
    try {
      const input = {
        questions: [
          {
            question: 'Which docs?',
            header: 'Docs',
            options: [{ label: 'design' }, { label: 'implementation' }],
            multiSelect: true,
          },
        ],
      };
      const pending = fix.canUseTool('AskUserQuestion', input, callOptions());
      await settle();
      expect(bridge.asks[0]?.multiSelect).toBe(true);

      bridge.answer({
        questionId: 'q-multi',
        answer: { labels: ['design', 'implementation'] },
        answeredVia: 'local',
        answeredAt: new Date().toISOString(),
      });

      const result = (await pending) as Extract<PermissionResult, { behavior: 'allow' }>;
      const answers = result.updatedInput?.['answers'] as Record<string, string>;
      expect(answers['Which docs?']).toBe('design, implementation');
      expect(Array.isArray(answers['Which docs?'])).toBe(false);
    } finally {
      fix.close();
    }
  });

  it('continues in the SAME turn: the session stays running and no result intervenes', async () => {
    const bridge = manualBridge('q-inline');
    const fix = await launch({ bridge });
    try {
      const session = fix.query.sessions[0];
      await session?.emit(
        fakeAssistant({ toolUse: { id: 'toolu_01', name: 'AskUserQuestion', input: ASK_INPUT } }),
      );

      const pending = fix.canUseTool('AskUserQuestion', ASK_INPUT, callOptions());
      await settle();
      // The agent has not left the tool call: the row is still `running` and the
      // turn has produced no `result`.
      expect(fix.harness.sessions.require(fix.sessionId).status).toBe('running');

      bridge.answer({
        questionId: 'q-inline',
        answer: { labels: ['Postgres'] },
        answeredVia: 'remote',
        answeredAt: new Date().toISOString(),
      });
      await pending;

      await session?.emit(
        fakeToolResult({ toolUseId: 'toolu_01', content: 'Postgres' }),
        fakeResult({ text: 'Done.' }),
        fakeSessionStateChanged('idle'),
      );
      session?.end();
      const settled_ = await fix.harness.service.awaitSettled(fix.sessionId);

      // One turn from prompt to answer to result: the agent never left the tool
      // call, so there is no "the agent moved on" window at all (§5.3).
      expect(settled_.turns).toBe(1);

      const types = fix.harness.transcriptLines(fix.sessionId).map((line) => String(line['type']));
      const question = types.indexOf('question');
      const toolResult = types.indexOf('tool_result');
      expect(question).toBeGreaterThanOrEqual(0);
      expect(toolResult).toBeGreaterThan(question);
      // Nothing that ends a turn sits between the question and its result.
      expect(types.slice(question, toolResult)).not.toContain('session.end');

      const answered = eventsOfType(fix.harness, 'session.question.answered');
      expect(answered[0]).toMatchObject({
        questionId: 'q-inline',
        answeredVia: 'remote',
        delivery: 'inline',
      });
    } finally {
      fix.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Acceptance 2 and 3 — the tool gate
// ---------------------------------------------------------------------------

describe('a tool call the rules did not decide (M7 acceptance 2 and 3)', () => {
  it('Allow-once continues with the input echoed unchanged', async () => {
    const bridge = manualBridge('q-gate');
    const fix = await launch({ bridge });
    try {
      const input = { file_path: 'C:\\workspace\\notes.md', content: 'hello' };
      const pending = fix.canUseTool(
        'Write',
        input,
        callOptions({
          // SDK-NOTES §5.1: use the engine's own sentence when it offers one.
          title: 'Claude wants to write notes.md',
          matchedAskRule: { source: 'project', toolName: 'Write' },
        }),
      );
      await settle();

      expect(bridge.asks[0]?.prompt).toBe('Claude wants to write notes.md');
      expect(bridge.asks[0]?.context).toMatchObject({ toolName: 'Write', toolInput: input });

      bridge.answer({
        questionId: 'q-gate',
        answer: { optionIds: ['allow'] },
        answeredVia: 'local',
        answeredAt: new Date().toISOString(),
      });
      const result = (await pending) as PermissionResult;
      expect(result).toMatchObject({ behavior: 'allow', updatedInput: input });
    } finally {
      fix.close();
    }
  });

  it('Deny returns the user’s own reason to the agent', async () => {
    const bridge = manualBridge('q-deny');
    const fix = await launch({ bridge });
    try {
      const pending = fix.canUseTool('Bash', { command: 'rm -rf .' }, callOptions());
      await settle();
      bridge.answer({
        questionId: 'q-deny',
        answer: { optionIds: ['deny'], text: 'Not on this branch.' },
        answeredVia: 'local',
        answeredAt: new Date().toISOString(),
      });

      const result = (await pending) as Extract<PermissionResult, { behavior: 'deny' }>;
      expect(result.behavior).toBe('deny');
      expect(result.message).toBe('Not on this branch.');
      // An ordinary denial does not end the turn — the agent reports what it
      // could not do. Only §5.4's park interrupts.
      expect(result.interrupt).toBeUndefined();
    } finally {
      fix.close();
    }
  });

  it('a Deny with no reason still says something the agent can act on', async () => {
    const bridge = manualBridge('q-deny2');
    const fix = await launch({ bridge });
    try {
      const pending = fix.canUseTool('Bash', { command: 'ls' }, callOptions());
      await settle();
      bridge.answer({
        questionId: 'q-deny2',
        answer: { optionIds: ['deny'] },
        answeredVia: 'local',
        answeredAt: new Date().toISOString(),
      });
      const result = (await pending) as Extract<PermissionResult, { behavior: 'deny' }>;
      expect(result.message).toBe('Denied by the user.');
    } finally {
      fix.close();
    }
  });

  it('offers exactly Allow-once and Deny, and NO code path sets updatedPermissions', async () => {
    const bridge = manualBridge('q-two');
    const fix = await launch({ bridge });
    try {
      const pending = fix.canUseTool('Write', { file_path: 'x' }, callOptions());
      await settle();
      expect(bridge.asks[0]?.options).toEqual([ALLOW_ONCE_OPTION, DENY_OPTION]);

      bridge.answer({
        questionId: 'q-two',
        answer: { optionIds: ['allow'] },
        answeredVia: 'local',
        answeredAt: new Date().toISOString(),
      });
      const result = (await pending) as Record<string, unknown>;
      expect(result['updatedPermissions']).toBeUndefined();
      // The whole module, not just this result: "always allow" is a roster or
      // project edit, never a runtime widening (§5.1).
      const source = await import('node:fs').then((fs) =>
        fs.readFileSync(new URL('./canUseTool.ts', import.meta.url), 'utf8'),
      );
      expect(source).not.toMatch(/updatedPermissions\s*:/);
    } finally {
      fix.close();
    }
  });

  it('is redelivery-safe: a second call with the same requestId joins the first decision', async () => {
    const bridge = manualBridge('q-once');
    const fix = await launch({ bridge });
    try {
      const first = fix.canUseTool('Write', { file_path: 'x' }, callOptions());
      const second = fix.canUseTool('Write', { file_path: 'x' }, callOptions());
      await settle();
      expect(bridge.asks).toHaveLength(1);

      bridge.answer({
        questionId: 'q-once',
        answer: { optionIds: ['allow'] },
        answeredVia: 'local',
        answeredAt: new Date().toISOString(),
      });
      expect(await first).toEqual(await second);
    } finally {
      fix.close();
    }
  });
});

// ---------------------------------------------------------------------------
// G5 — the callback is total
// ---------------------------------------------------------------------------

describe('the callback is total (SDK-NOTES G5)', () => {
  it('never returns null and never rejects, even when the bridge throws', async () => {
    const throwing: QuestionBridgeView = {
      ask: () => {
        throw new Error('the bridge exploded');
      },
      cancel: () => Promise.resolve(),
    };
    const fix = await launch({ bridge: throwing });
    try {
      const result = await fix.canUseTool('Write', {}, callOptions());
      expect(result).not.toBeNull();
      expect(result).toMatchObject({ behavior: 'deny' });
    } finally {
      fix.close();
    }
  });

  it('denies rather than hanging when the bridge rejects', async () => {
    const rejecting: QuestionBridgeView = {
      ask: () => Promise.reject(new Error('no inbox')),
      cancel: () => Promise.resolve(),
    };
    const fix = await launch({ bridge: rejecting });
    try {
      const result = await fix.canUseTool('Write', {}, callOptions());
      expect(result).toMatchObject({ behavior: 'deny' });
    } finally {
      fix.close();
    }
  });

  it('denies when the compiled policy says no human may approve', async () => {
    const bridge = manualBridge();
    const fix = await launch({ bridge, humanMayApprove: false });
    try {
      const result = (await fix.canUseTool('Write', {}, callOptions())) as Extract<
        PermissionResult,
        { behavior: 'deny' }
      >;
      expect(result.behavior).toBe('deny');
      expect(result.message).toContain('not in the effective allow set');
      expect(bridge.asks).toHaveLength(0);
    } finally {
      fix.close();
    }
  });

  it('cancels the card and denies when the SDK aborts the call', async () => {
    const bridge = manualBridge('q-abort');
    const fix = await launch({ bridge });
    try {
      const controller = new AbortController();
      const pending = fix.canUseTool('Write', {}, callOptions({ signal: controller.signal }));
      await settle();
      controller.abort();

      const result = (await pending) as PermissionResult;
      expect(result).toMatchObject({ behavior: 'deny' });
      expect(bridge.cancels).toEqual([
        { questionId: 'q-abort', reason: 'the tool call was cancelled before it was answered' },
      ]);
    } finally {
      fix.close();
    }
  });

  it('denies when the question expires under it', async () => {
    const bridge = manualBridge('q-x');
    const fix = await launch({ bridge });
    try {
      const pending = fix.canUseTool('Write', {}, callOptions());
      await settle();
      bridge.settle({ status: 'expired', questionId: 'q-x' });
      const result = (await pending) as Extract<PermissionResult, { behavior: 'deny' }>;
      expect(result.behavior).toBe('deny');
      expect(result.message).toContain('expired');
    } finally {
      fix.close();
    }
  });

  it('denies when the question is cancelled under it — a closed assignment, say', async () => {
    const bridge = manualBridge('q-y');
    const fix = await launch({ bridge });
    try {
      const pending = fix.canUseTool('Write', {}, callOptions());
      await settle();
      bridge.settle({ status: 'cancelled', questionId: 'q-y', reason: 'assignment closed' });
      const result = (await pending) as Extract<PermissionResult, { behavior: 'deny' }>;
      expect(result.behavior).toBe('deny');
      expect(result.message).toContain('assignment closed');
    } finally {
      fix.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Acceptance 4 — the hold expires and the session parks
// ---------------------------------------------------------------------------

describe('the hold expires and the session parks (M7 acceptance 4)', () => {
  it('denies with the stop instruction and settles paused / awaiting_answer', async () => {
    const bridge = manualBridge('q-park');
    const fix = await launch({ bridge, config: { question: { holdMs: 5, expireHours: 24 } } });
    try {
      const result = (await fix.canUseTool('Write', {}, callOptions())) as Extract<
        PermissionResult,
        { behavior: 'deny' }
      >;

      expect(result.behavior).toBe('deny');
      // §5.4: the message tells the agent to STOP rather than leaving it to
      // invent a workaround — which is the "gave up and moved on" failure.
      expect(result.message).toContain('q-park');
      expect(result.message).toContain('do not work around it');
      expect(result.interrupt).toBe(true);

      const record = await fix.harness.service.awaitSettled(fix.sessionId);
      expect(record.status).toBe('paused');
      expect(record.exitReason).toBe('awaiting_answer');

      // The slot is released, the lease is kept, and the card stays open.
      expect(fix.harness.launch.liveSessionIds()).toEqual([]);
      expect(fix.harness.projects.releases).toEqual([]);
      expect(bridge.cancels).toEqual([]);

      const paused = eventsOfType(fix.harness, 'session.paused');
      expect(paused[0]).toMatchObject({ reason: 'awaiting_answer', questionId: 'q-park' });
    } finally {
      fix.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Acceptance 5 — auto-resume when the answer eventually arrives
// ---------------------------------------------------------------------------

describe('answering a parked question auto-resumes it (M7 acceptance 5)', () => {
  /** Parks a session on a real `questions` row through the degraded fallback. */
  async function park(): Promise<Fixture> {
    const fix = await launch({ config: { question: { holdMs: 5, expireHours: 24 } } });
    await fix.canUseTool('Write', { file_path: 'x' }, callOptions());
    const record = await fix.harness.service.awaitSettled(fix.sessionId);
    expect(record.status).toBe('paused');
    return fix;
  }

  it('re-queues at interactive priority, resumes with resume, and injects the answer', async () => {
    const fix = await park();
    const unsubscribe = fix.harness.subscribeQuestions();
    try {
      const row = openQuestionRow(fix);
      const sdkSessionId = fix.harness.sessions.require(fix.sessionId).sdkSessionId;

      // The answer arrives — through the one path §16-3 pins, and over the
      // tailnet at that.
      fix.harness.storage.store.questions.answer(row.id, {
        answer: { optionIds: ['allow'], labels: ['Allow once'] },
        answeredVia: 'remote',
      });
      fix.harness.bus.emit({
        type: 'question.answered',
        ids: { assignmentId: fix.seed.assignmentId, sessionId: fix.sessionId },
        persist: false,
        payload: { questionId: row.id },
      });

      await fix.query.started(2);
      const resumed = fix.query.sessions[1];
      // §9.4 path 1: the same row, resumed with the recorded SDK session id.
      expect(resumed?.resume).toBe(sdkSessionId);
      await resumed?.awaitInput(1);
      const firstMessage = String(resumed?.log[0]);
      expect(firstMessage).toContain('You asked');
      expect(firstMessage).toContain('Allow once');
      expect(firstMessage).toContain('Continue from where you stopped');

      expect(fix.harness.sessions.require(fix.sessionId).priority).toBe('interactive');
      const answered = eventsOfType(fix.harness, 'session.question.answered');
      expect(answered.at(-1)).toMatchObject({
        questionId: row.id,
        answeredVia: 'remote',
        delivery: 'after-park',
      });
    } finally {
      unsubscribe();
      fix.close();
    }
  });

  it('does not run the work twice when the answered event arrives more than once', async () => {
    const fix = await park();
    const unsubscribe = fix.harness.subscribeQuestions();
    try {
      const row = openQuestionRow(fix);
      fix.harness.storage.store.questions.answer(row.id, {
        answer: { optionIds: ['allow'] },
        answeredVia: 'local',
      });
      for (const type of ['question.answered', 'assignment.question.answered']) {
        fix.harness.bus.emit({
          type,
          ids: { assignmentId: fix.seed.assignmentId },
          persist: false,
          payload: { questionId: row.id },
        });
      }
      await fix.query.started(2);
      await settle(10);

      expect(fix.query.sessions).toHaveLength(2);
    } finally {
      unsubscribe();
      fix.close();
    }
  });

  it('never resumes a session runner did not park itself (§15.1-7)', async () => {
    const fix = await launch({ bridge: manualBridge() });
    const unsubscribe = fix.harness.subscribeQuestions();
    try {
      // A running session with a question row: the answer lands inline through
      // `canUseTool`, and the resumer must not touch it.
      const row = fix.harness.storage.store.questions.open({
        assignmentId: fix.seed.assignmentId,
        sessionId: fix.sessionId,
        prompt: 'inline',
      });
      fix.harness.storage.store.questions.answer(row.id, {
        answer: { optionIds: ['allow'] },
        answeredVia: 'local',
      });
      fix.harness.bus.emit({
        type: 'question.answered',
        ids: {},
        persist: false,
        payload: { questionId: row.id },
      });
      await settle(10);

      expect(fix.query.sessions).toHaveLength(1);
      expect(fix.harness.sessions.require(fix.sessionId).status).toBe('running');
    } finally {
      unsubscribe();
      fix.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Acceptance 6 — expiry
// ---------------------------------------------------------------------------

describe('an expired question ends the parked session (M7 acceptance 6)', () => {
  it('moves it to interrupted / question_expired and leaves the card as the record', async () => {
    const fix = await launch({ config: { question: { holdMs: 5, expireHours: 24 } } });
    const unsubscribe = fix.harness.subscribeQuestions();
    try {
      await fix.canUseTool('Write', {}, callOptions());
      await fix.harness.service.awaitSettled(fix.sessionId);
      const row = openQuestionRow(fix);

      // Orchestrator owns the row's flip (orchestrator §6.5, proven in
      // `orchestrator/questions.test.ts`); runner owns only the session half and
      // reacts to the event.
      fix.harness.storage.store.questions.expire(row.id);
      fix.harness.bus.emit({
        type: 'question.expired',
        ids: { assignmentId: fix.seed.assignmentId },
        persist: true,
        payload: { questionId: row.id },
      });
      await settle(10);

      const record = fix.harness.sessions.require(fix.sessionId);
      expect(record.status).toBe('interrupted');
      expect(record.exitReason).toBe('question_expired');
      expect(fix.harness.storage.store.questions.get(row.id)?.status).toBe('expired');
    } finally {
      unsubscribe();
      fix.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Acceptance 7 — dontAsk, and C2's degraded twin
// ---------------------------------------------------------------------------

describe('a session that cannot ask reports it (M7 acceptance 7, §5.6, C2)', () => {
  it('reports questionBridge: disabled and emits a diagnostic without altering the mode', async () => {
    const fix = await launch({ bridge: manualBridge(), permissionMode: 'dontAsk' });
    try {
      const started = eventsOfType(fix.harness, 'session.started');
      expect(started[0]).toMatchObject({ questionBridge: 'disabled' });

      const diagnostics = eventsOfType(fix.harness, 'session.diagnostic') as Record<
        string,
        unknown
      >[];
      expect(diagnostics.some((one) => one['code'] === 'question_bridge_disabled')).toBe(true);

      // Runner does not silently change the mode to compensate — that would be
      // recomputing permissions (§5.6).
      const compiled = fix.harness.roster.outputs[0];
      expect(compiled?.options.permissionMode).toBe('dontAsk');
      expect(fix.harness.transcriptLines(fix.sessionId)[0]).toMatchObject({
        questionBridge: 'disabled',
      });
    } finally {
      fix.close();
    }
  });

  it('reports questionBridge: degraded when AskUserQuestion is allowed by bare name (C2)', async () => {
    const fix = await launch({
      bridge: manualBridge(),
      allowedTools: ['Read', 'AskUserQuestion'],
    });
    try {
      expect(eventsOfType(fix.harness, 'session.started')[0]).toMatchObject({
        questionBridge: 'degraded',
      });
      const diagnostics = eventsOfType(fix.harness, 'session.diagnostic') as Record<
        string,
        unknown
      >[];
      expect(diagnostics.some((one) => one['code'] === 'question_bridge_degraded')).toBe(true);
    } finally {
      fix.close();
    }
  });

  it('is enabled for an ordinary session, and says so', async () => {
    const fix = await launch({ bridge: manualBridge() });
    try {
      expect(eventsOfType(fix.harness, 'session.started')[0]).toMatchObject({
        questionBridge: 'enabled',
      });
      expect(eventsOfType(fix.harness, 'session.diagnostic')).toEqual([]);
    } finally {
      fix.close();
    }
  });

  it('classifies each case as a pure read of the compiled options', () => {
    const base = {
      options: { allowedTools: ['Read'] } as SdkOptions,
      policy: { default: 'deny' as const, humanMayApprove: true, ask: [], denyMessage: 'no' },
    };
    expect(questionBridgeStatus(base).status).toBe('enabled');
    expect(
      questionBridgeStatus({ ...base, options: { ...base.options, permissionMode: 'dontAsk' } })
        .status,
    ).toBe('disabled');
    expect(
      questionBridgeStatus({
        ...base,
        options: { ...base.options, permissionMode: 'bypassPermissions' },
      }).status,
    ).toBe('disabled');
    expect(
      questionBridgeStatus({
        ...base,
        options: { ...base.options, allowedTools: ['AskUserQuestion(x)'] },
      }).status,
      // A rule *with* a specifier is not a bare entry and does not shadow.
    ).toBe('enabled');
  });
});

// ---------------------------------------------------------------------------
// Acceptance 8 — the degraded fallback, and a restart between raise and answer
// ---------------------------------------------------------------------------

describe('the degraded fallback with no orchestrator (M7 acceptance 8, §5.2)', () => {
  it('writes the questions row through foundation’s repository and resolves on the event', async () => {
    const fix = await launch();
    try {
      expect(fix.harness.questionBridge.mode()).toBe('fallback');

      const pending = fix.canUseTool('Write', { file_path: 'x' }, callOptions());
      await settle();

      const row = openQuestionRow(fix);
      expect(row).toMatchObject({
        assignmentId: fix.seed.assignmentId,
        sessionId: fix.sessionId,
        kind: 'question',
        status: 'open',
      });

      fix.harness.storage.store.questions.answer(row.id, {
        answer: { optionIds: ['allow'] },
        answeredVia: 'local',
      });
      fix.harness.bus.emit({
        type: 'question.answered',
        ids: {},
        persist: false,
        payload: { questionId: row.id },
      });

      expect(await pending).toMatchObject({ behavior: 'allow' });
    } finally {
      fix.close();
    }
  });

  it('a restart between raise and answer still delivers, from the row (§9.2)', async () => {
    const fix = await launch({ config: { question: { holdMs: 5, expireHours: 24 } } });
    try {
      // Raise, let the hold expire, park. This is the state a crash would find.
      await fix.canUseTool('Write', {}, callOptions());
      await fix.harness.service.awaitSettled(fix.sessionId);
      const row = openQuestionRow(fix);

      // The core goes down and comes back: a **new** reconciler over the same
      // rows, with no subscription and no memory of the `ask()` promise.
      const answeredAt = new Date().toISOString();
      fix.harness.storage.store.questions.answer(row.id, {
        answer: { optionIds: ['allow'], labels: ['Allow once'] },
        answeredVia: 'remote',
        at: answeredAt,
      });

      const rebooted = createQuestionSessions({
        sessions: fix.harness.sessions,
        questions: fix.harness.storage.store.questions,
        control: fix.harness.launch,
        bus: fix.harness.bus,
        clock: () => new Date(),
      });
      const reconciled = await rebooted.reconcileOnBoot();

      expect(reconciled.resumed).toEqual([fix.sessionId]);
      await fix.query.started(2);
      expect(fix.query.sessions[1]?.resume).toBeTruthy();
    } finally {
      fix.close();
    }
  });

  it('parks a session the restart found mid-question rather than orphaning it (§9.2 item 3)', async () => {
    const fix = await launch({ bridge: manualBridge() });
    try {
      // A row left `running` by a previous life, with a card still open: the
      // process that was serving it is gone, so there is no live handle
      // anywhere. This is the state a crash mid-question leaves behind.
      const previous = fix.harness.sessions.enqueue({
        assignmentId: fix.seed.assignmentId,
        agentId: fix.seed.agentId,
        projectId: fix.seed.projectId,
        prompt: 'Do the thing.',
      });
      fix.harness.sessions.transition(previous.id, 'running', {
        sdkSessionId: '9f2a2b64-1f3e-4a6b-9a41-0000000000ff',
      });
      const row = fix.harness.storage.store.questions.open({
        assignmentId: fix.seed.assignmentId,
        sessionId: previous.id,
        prompt: 'Postgres or SQLite?',
      });

      const rebooted = createQuestionSessions({
        sessions: fix.harness.sessions,
        questions: fix.harness.storage.store.questions,
        control: fix.harness.launch,
        bus: fix.harness.bus,
        clock: () => new Date(),
      });
      const reconciled = await rebooted.reconcileOnBoot();

      expect(reconciled.parked).toEqual([previous.id]);
      const record = fix.harness.sessions.require(previous.id);
      // `paused` / `awaiting_answer`, **not** `orphaned` — a session waiting on
      // a human is not a session that died.
      expect(record.status).toBe('paused');
      expect(record.exitReason).toBe('awaiting_answer');
      // The card is untouched, so the answer still has something to resume.
      expect(fix.harness.storage.store.questions.get(row.id)?.status).toBe('open');
    } finally {
      fix.close();
    }
  });

  it('ends a parked session whose question expired while the core was down', async () => {
    const fix = await launch({ config: { question: { holdMs: 5, expireHours: 24 } } });
    try {
      await fix.canUseTool('Write', {}, callOptions());
      await fix.harness.service.awaitSettled(fix.sessionId);
      const row = openQuestionRow(fix);
      fix.harness.storage.store.questions.expire(row.id);

      const rebooted = createQuestionSessions({
        sessions: fix.harness.sessions,
        questions: fix.harness.storage.store.questions,
        control: fix.harness.launch,
        bus: fix.harness.bus,
        clock: () => new Date(),
      });
      expect((await rebooted.reconcileOnBoot()).ended).toEqual([fix.sessionId]);
      expect(fix.harness.sessions.require(fix.sessionId).exitReason).toBe('question_expired');
    } finally {
      fix.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Acceptance 9 — SDK-NOTES G6
// ---------------------------------------------------------------------------

describe('the shadow warning is filtered into the log (M7 acceptance 9, G6)', () => {
  it('swallows CLAUDE_SDK_CAN_USE_TOOL_SHADOWED and passes every other warning through', () => {
    const seen: { level: string; message: string }[] = [];
    const others: string[] = [];
    const spy = (warning: Error): void => {
      others.push(warning.message);
    };
    // Node's own printer is a `warning` listener too; standing it down keeps the
    // pass-through half of this test from writing to the suite's stderr.
    const original = process.listeners('warning');
    process.removeAllListeners('warning');
    process.on('warning', spy);

    const restore = installShadowWarningFilter((level, message) => seen.push({ level, message }));
    try {
      const shadowed = Object.assign(new Error('canUseTool will not be invoked for: Read'), {
        code: SHADOW_WARNING_CODE,
      });
      process.emit('warning', shadowed);
      process.emit('warning', new Error('something else entirely'));

      expect(others).toEqual(['something else entirely']);
      expect(seen).toHaveLength(1);
      expect(seen[0]?.level).toBe('debug');
    } finally {
      restore();
      process.removeListener('warning', spy);
      for (const listener of original) process.on('warning', listener);
    }
  });

  it('restores the listeners it displaced, so the filter cannot leak between suites', () => {
    const before = process.listenerCount('warning');
    const restore = installShadowWarningFilter(() => undefined);
    restore();
    expect(process.listenerCount('warning')).toBe(before);
  });

  it('emits no shadow warning during this suite', () => {
    // The suite runs hundreds of `query()` calls through the fake, which never
    // emits one; the assertion that matters is that nothing in runner's own code
    // re-raises it after the filter has swallowed it.
    expect(process.listenerCount('warning')).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// The AskUserQuestion reader
// ---------------------------------------------------------------------------

describe('reading the AskUserQuestion input (§5.1)', () => {
  it('reads the first question, its labels and its multiSelect flag', () => {
    expect(readAskUserQuestion(ASK_INPUT)).toEqual({
      question: 'Postgres or SQLite?',
      header: 'Storage',
      multiSelect: false,
      options: [
        { id: 'SQLite on disk', label: 'SQLite on disk', description: 'One file, no service' },
        { id: 'Postgres', label: 'Postgres', description: 'A service dependency' },
      ],
    });
  });

  it('returns undefined for anything that is not a question, rather than throwing', () => {
    expect(readAskUserQuestion({})).toBeUndefined();
    expect(readAskUserQuestion({ questions: [] })).toBeUndefined();
    expect(readAskUserQuestion({ questions: [{ header: 'no question here' }] })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The callback in isolation — no launch chain at all
// ---------------------------------------------------------------------------

describe('createQuestionCanUseTool in isolation', () => {
  it('carries holdUntil and expiresAt derived from runner.question.* onto the ask', async () => {
    const bridge = manualBridge('q-iso');
    const at = new Date('2026-08-16T10:00:00.000Z');
    const callback = createQuestionCanUseTool({
      sessionId: 's1',
      assignmentId: 'a1',
      agentId: 'ada',
      policy: { default: 'deny', humanMayApprove: true, ask: [], denyMessage: 'no' },
      bridge,
      holdMs: 900_000,
      expireHours: 24,
      clock: () => at,
      timer: () => () => undefined,
    });

    const pending = callback('Write', {}, callOptions());
    await settle();
    expect(bridge.asks[0]).toMatchObject({
      sessionId: 's1',
      assignmentId: 'a1',
      agentId: 'ada',
      kind: 'question',
      holdUntil: '2026-08-16T10:15:00.000Z',
      expiresAt: '2026-08-17T10:00:00.000Z',
    });

    bridge.answer({
      questionId: 'q-iso',
      answer: { optionIds: ['deny'] },
      answeredVia: 'local',
      answeredAt: at.toISOString(),
    });
    await pending;
  });
});
