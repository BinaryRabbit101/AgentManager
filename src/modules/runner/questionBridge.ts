/**
 * Runner's half of the question bridge (runner DESIGN §5) — milestone M7.
 *
 * Three things live here, because they are the three things that are true of a
 * question *outside* the `canUseTool` callback:
 *
 * 1. {@link createQuestionBridgeClient} — the bridge runner awaits. Orchestrator's
 *    when it is on the registry (§5.2); otherwise the **degraded fallback**,
 *    which writes the `questions` row through foundation's repository and
 *    resolves on the `question.answered` bus event. "A degradation, not a
 *    failure."
 * 2. {@link questionBridgeStatus} — §5.6's launch-time detection, extended by
 *    SDK-NOTES **C2**: as well as `dontAsk`, a session whose compiled
 *    `allowedTools` carries a **bare** `AskUserQuestion` has its bridge silently
 *    shadowed for its own questions, and reports `questionBridge: 'degraded'`.
 *    It is a *read* of the compiled options, never a recomputation, so §1's
 *    boundary holds: runner matches no rule patterns and composes nothing.
 * 3. {@link createQuestionSessions} — stages 2 and 3 of §5.4 seen from outside
 *    the callback: the parked session, the answer that arrives hours later, the
 *    expiry that never gets one, and the boot sweep that makes all of it survive
 *    a restart.
 *
 * ## The one invariant the whole file exists to protect
 *
 * §9.2: "the trigger is the **persisted `questions` row**, never an in-memory
 * promise — the promise `QuestionBridge.ask()` returned died with the previous
 * process, and nothing in the resume path may depend on it." So stage 3 is
 * driven entirely by the `question.answered` **event plus the row**, and
 * {@link QuestionSessions.reconcileOnBoot} re-derives everything from rows. The
 * promise is a convenience for the process that is still running, and it is
 * never load-bearing.
 */
import type { EventBus, Unsubscribe } from '../types.js';
import type {
  Clock,
  QuestionRecord,
  QuestionsRepository,
  SessionRecord,
} from '../../storage/index.js';

import type {
  AskQuestionRequest,
  CanUseToolPolicyView,
  QuestionAnswerView,
  QuestionBridgeProvider,
  QuestionBridgeView,
  QuestionOptionView,
  QuestionOutcomeView,
  SdkOptions,
} from './contracts.js';
import { hasQuestionBridge } from './contracts.js';
import type { LogSink } from './launch.js';
import type { SessionRepository } from './repository.js';
import type { ExitReason } from './status.js';

/** The built-in tool §5.1 names as the bridge's first source. */
export const ASK_USER_QUESTION_TOOL = 'AskUserQuestion';

/** SDK-NOTES **G6**: the warning code every AgentManager session would print. */
export const SHADOW_WARNING_CODE = 'CLAUDE_SDK_CAN_USE_TOOL_SHADOWED';

// ---------------------------------------------------------------------------
// §5.6 + C2 — the launch diagnostic
// ---------------------------------------------------------------------------

/** What `session.started` and the transcript header report (§10). */
export type QuestionBridgeStatus = 'enabled' | 'degraded' | 'disabled';

export interface QuestionBridgeDiagnosis {
  readonly status: QuestionBridgeStatus;
  /** A non-fatal `session.diagnostic` (§10), or `undefined` when healthy. */
  readonly diagnostic?: { readonly code: string; readonly message: string };
}

/**
 * §5.6 and SDK-NOTES C2, as a pure read of what roster compiled.
 *
 * - `disabled` — the session cannot ask **anything**: `dontAsk` skips
 *   `canUseTool` and denies, and `bypassPermissions` auto-approves before the
 *   callback is consulted. Either way there is no bridge, and runner does not
 *   silently change the mode to compensate — that would be recomputing
 *   permissions.
 * - `degraded` — the callback still runs for ordinary tool gates, but a **bare**
 *   `AskUserQuestion` in `allowedTools` auto-approves the agent's own questions
 *   before the callback is consulted (C2). Roster now routes the tool into the
 *   `ask` bucket, so this should only ever arise from a repo- or user-level
 *   allow rule loaded through `settingSources` — which is exactly why it is
 *   detected rather than assumed impossible.
 */
export function questionBridgeStatus(compiled: {
  readonly options: SdkOptions;
  readonly policy: CanUseToolPolicyView;
}): QuestionBridgeDiagnosis {
  const mode = compiled.options.permissionMode;
  if (mode === 'bypassPermissions') {
    return {
      status: 'disabled',
      diagnostic: {
        code: 'question_bridge_disabled',
        message:
          "permissionMode 'bypassPermissions' auto-approves every tool call before canUseTool is " +
          'consulted, so this session has no question bridge: it can neither raise a permission ' +
          'card nor ask the user a question.',
      },
    };
  }
  if (mode === 'dontAsk' || !compiled.policy.humanMayApprove) {
    return {
      status: 'disabled',
      diagnostic: {
        code: 'question_bridge_disabled',
        message:
          "This session's compiled permission mode never prompts (§5.6), so it has no question " +
          'bridge: an undecided tool call is denied and AskUserQuestion is refused without ' +
          'reaching the user. Budget halts still work — they are raised by runner, not by the ' +
          'agent.',
      },
    };
  }

  // A bare entry is the SDK's own syntactic test: no specifier in parentheses.
  const bare = (compiled.options.allowedTools ?? []).some(
    (entry) => entry === ASK_USER_QUESTION_TOOL,
  );
  if (bare) {
    return {
      status: 'degraded',
      diagnostic: {
        code: 'question_bridge_degraded',
        message:
          `"${ASK_USER_QUESTION_TOOL}" is allowed by bare name, so the SDK auto-approves it ` +
          "before canUseTool is consulted and the agent's own questions never reach the inbox " +
          '(SDK-NOTES C2). Tool-permission cards still work. Move the tool into the "ask" bucket ' +
          'or remove the grant.',
      },
    };
  }

  return { status: 'enabled' };
}

// ---------------------------------------------------------------------------
// SDK-NOTES G6 — the process warning filter
// ---------------------------------------------------------------------------

/**
 * Swallows the SDK's `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` warning into `core.log`.
 *
 * Roster emits the effective allow set as `allowedTools` and runner sets
 * `canUseTool` on every session, so the SDK's shadow check fires at **every**
 * `query()`. Left alone, Node prints a multi-line warning to stderr per launch —
 * for a condition that is expected, not actionable, and already reported through
 * `session.diagnostic` when it matters (C2).
 *
 * Node's default warning printer is itself a `process.on('warning')` listener,
 * so filtering means taking the listeners off, installing one that decides, and
 * handing everything else back to them unchanged. The returned function restores
 * exactly what was there — which is what keeps a test suite from leaking the
 * filter into the next file.
 */
export function installShadowWarningFilter(log: LogSink): () => void {
  const existing = process.listeners('warning');
  process.removeAllListeners('warning');

  const filter = (warning: Error & { code?: string }): void => {
    if (warning.code === SHADOW_WARNING_CODE) {
      log('debug', 'the SDK reported canUseTool as shadowed for some tools (expected)', {
        code: SHADOW_WARNING_CODE,
        detail: warning.message,
      });
      return;
    }
    for (const listener of existing) listener(warning);
  };

  process.on('warning', filter);

  return () => {
    process.removeListener('warning', filter);
    for (const listener of existing) process.on('warning', listener);
  };
}

// ---------------------------------------------------------------------------
// The bridge client (§5.2)
// ---------------------------------------------------------------------------

export type QuestionBridgeMode = 'orchestrator' | 'fallback';

export interface QuestionBridgeClient extends QuestionBridgeView {
  /** Which path the **next** ask would take. Diagnostics and tests only. */
  mode(): QuestionBridgeMode;
}

export interface QuestionBridgeClientDeps {
  /** `ctx.require('orchestrator')`, resolved per ask — never captured at init. */
  readonly orchestrator: () => QuestionBridgeProvider | undefined;
  /** Foundation's repository — §5.2's sanctioned cross-element path. */
  readonly questions: QuestionsRepository;
  readonly bus: Pick<EventBus, 'subscribe'>;
  readonly clock: Clock;
  readonly log?: LogSink | undefined;
}

/**
 * The envelope the fallback writes into `options_json`.
 *
 * Deliberately the same keys orchestrator's inbox writes, so a card raised while
 * orchestrator was absent still renders once it is back. Feature modules never
 * import each other (foundation §6.1), so the shape is restated rather than
 * shared — and this comment is the reason a change to one has to change both.
 */
interface FallbackEnvelope {
  readonly options?: readonly QuestionOptionView[];
  readonly multiSelect?: boolean;
  readonly allowFreeText?: boolean;
  readonly holdUntil?: string;
  readonly expiresAt?: string;
  readonly context?: { toolName?: string; toolInput?: unknown };
  readonly agentId?: string;
}

/** Bus types the fallback resolves on — the answered/expired/cancelled trio. */
const OUTCOME_EVENTS = [
  'question.answered',
  'assignment.question.answered',
  'question.expired',
  'question.cancelled',
] as const;

export function createQuestionBridgeClient(deps: QuestionBridgeClientDeps): QuestionBridgeClient {
  const log: LogSink = deps.log ?? ((): void => {});

  function mode(): QuestionBridgeMode {
    return hasQuestionBridge(deps.orchestrator()) ? 'orchestrator' : 'fallback';
  }

  /**
   * The degraded path: the row is written here and the answer arrives as an
   * event. There is no aggregation and there are no recommendations — exactly
   * what §5.2 calls a degradation rather than a failure.
   */
  function fallbackAsk(request: AskQuestionRequest): Promise<QuestionOutcomeView> {
    const envelope: FallbackEnvelope = {
      ...(request.options === undefined ? {} : { options: request.options }),
      multiSelect: request.multiSelect ?? false,
      allowFreeText: request.allowFreeText ?? true,
      holdUntil: request.holdUntil,
      expiresAt: request.expiresAt,
      ...(request.context === undefined ? {} : { context: request.context }),
      agentId: request.agentId,
    };
    const record = deps.questions.open({
      assignmentId: request.assignmentId,
      sessionId: request.sessionId,
      kind: request.kind,
      prompt: request.prompt,
      options: envelope,
      createdAt: deps.clock().toISOString(),
    });
    log('warn', 'the orchestrator question bridge is absent; the card is unaggregated', {
      sessionId: request.sessionId,
      questionId: record.id,
    });
    try {
      request.onRaised?.(record.id);
    } catch {
      // The hook is a convenience; a caller that throws in it must not lose the
      // question it just raised.
    }

    return new Promise<QuestionOutcomeView>((resolve) => {
      const unsubscribe = deps.bus.subscribe([...OUTCOME_EVENTS], (event) => {
        const payload = event.payload as { questionId?: unknown } | undefined;
        if (payload?.questionId !== record.id) return;
        // Read the **row**, not the payload: the row is the durable record and
        // the two answered events carry the decision under different keys.
        const outcome = outcomeOf(deps.questions, record.id);
        if (outcome === undefined) return;
        unsubscribe();
        resolve(outcome);
      });
    });
  }

  return {
    mode,

    ask(request) {
      const provider = deps.orchestrator();
      if (hasQuestionBridge(provider)) return provider.questionBridge.ask(request);
      return Promise.resolve().then(() => fallbackAsk(request));
    },

    cancel(questionId, reason) {
      const provider = deps.orchestrator();
      if (hasQuestionBridge(provider)) return provider.questionBridge.cancel(questionId, reason);
      return Promise.resolve().then(() => {
        // The one place runner writes a `questions` row's status. Sanctioned
        // only because orchestrator — the table's sole writer (§6.5) — is not
        // in this build at all.
        const record = deps.questions.get(questionId);
        if (record?.status === 'open') deps.questions.cancel(questionId);
      });
    },
  };
}

/** A settled question row, read back as §5.2's outcome. `undefined` while open. */
export function outcomeOf(
  questions: Pick<QuestionsRepository, 'get' | 'answerOf'>,
  questionId: string,
): QuestionOutcomeView | undefined {
  const record = questions.get(questionId);
  if (record === undefined) return undefined;
  switch (record.status) {
    case 'answered':
      return {
        status: 'answered',
        questionId,
        answer: questions.answerOf<QuestionAnswerView>(questionId) ?? {},
        answeredVia: record.answeredVia ?? 'local',
        answeredAt: record.answeredAt ?? record.createdAt,
      };
    case 'expired':
      return { status: 'expired', questionId };
    case 'cancelled':
      return { status: 'cancelled', questionId, reason: 'cancelled' };
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// §5.4 stages 2 and 3, and §9.2's question half
// ---------------------------------------------------------------------------

/**
 * The launch-chain surface the parked-session machinery needs.
 *
 * Narrow on purpose: everything here is a *session* verb, and the reconciler has
 * no business reaching any further into the chain than that.
 */
export interface QuestionSessionControl {
  resume(
    sessionId: string,
    options?: { readonly message?: string; readonly priority?: 'interactive' | 'normal' },
  ): Promise<{ readonly changed: boolean }>;
  endParked(sessionId: string, exitReason: ExitReason, message: string): void;
  parkForQuestion(sessionId: string, questionId: string): Promise<unknown>;
}

export interface BootQuestionReconciliation {
  /** Sessions found `running` with an open question and parked (§9.2 item 3). */
  readonly parked: readonly string[];
  /** Parked sessions whose answer landed while the core was down. */
  readonly resumed: readonly string[];
  /** Parked sessions whose question expired or was cancelled meanwhile. */
  readonly ended: readonly string[];
}

export interface QuestionSessionsDeps {
  readonly sessions: SessionRepository;
  readonly questions: QuestionsRepository;
  readonly control: QuestionSessionControl;
  readonly bus: Pick<EventBus, 'emit' | 'subscribe'>;
  readonly clock: Clock;
  readonly log?: LogSink | undefined;
}

export interface QuestionSessions {
  /** Stage 3: an answer arrived for a parked session (§5.4). */
  onQuestionAnswered(questionId: string): Promise<void>;
  /** §5.4's expiry half: runner owns the *session*, never the row. */
  onQuestionExpired(questionId: string): void;
  /** §9.2 item 3, from rows rather than from a replayed event. */
  reconcileOnBoot(): Promise<BootQuestionReconciliation>;
  /** Wires both handlers onto the bus. */
  subscribe(): Unsubscribe;
}

/** §5.4 stage 2's denial. Written to *stop* the agent rather than let it invent. */
export function parkMessage(questionId: string): string {
  return (
    `Paused: this needs a decision from the user (question ${questionId}). ` +
    'Stop here and do not work around it; the session will be resumed with the answer.'
  );
}

/** §5.4 stage 3's first message on the resumed turn. */
export function answerMessage(prompt: string, answer: QuestionAnswerView): string {
  return (
    `You asked: «${prompt}». The user answered: «${describeAnswer(answer)}». ` +
    'Continue from where you stopped.'
  );
}

/** The answer as one line of prose — labels if there are any, else the text. */
export function describeAnswer(answer: QuestionAnswerView): string {
  const labels = answer.labels ?? [];
  // SDK-NOTES §5.4: multi-select answers are a **comma-separated string**, not
  // an array — the same rendering the SDK's own output documents.
  if (labels.length > 0) {
    return answer.text === undefined ? labels.join(', ') : `${labels.join(', ')} — ${answer.text}`;
  }
  if (answer.text !== undefined && answer.text.trim() !== '') return answer.text;
  return (answer.optionIds ?? []).join(', ');
}

export function createQuestionSessions(deps: QuestionSessionsDeps): QuestionSessions {
  const log: LogSink = deps.log ?? ((): void => {});
  /** Sessions a resume is already in flight for — §5.4's "not run twice". */
  const resuming = new Set<string>();

  function parkedSessionFor(record: QuestionRecord): SessionRecord | undefined {
    if (record.sessionId === null) return undefined;
    const session = deps.sessions.get(record.sessionId);
    if (session === undefined) return undefined;
    // Only sessions **runner itself parked** on a question auto-resume
    // (§15.1-7). A running session got its answer inline through `canUseTool`
    // and must not be touched.
    if (session.status !== 'paused' || session.exitReason !== 'awaiting_answer') return undefined;
    return session;
  }

  function emit(session: SessionRecord, type: string, payload: Record<string, unknown>): void {
    deps.bus.emit({
      type,
      ids: {
        sessionId: session.id,
        assignmentId: session.assignmentId,
        projectId: session.projectId,
        agentId: session.agentId,
      },
      payload,
      persist: true,
    });
  }

  async function deliverAnswer(record: QuestionRecord): Promise<boolean> {
    const session = parkedSessionFor(record);
    if (session === undefined) return false;
    if (resuming.has(session.id)) return false;
    resuming.add(session.id);
    try {
      const answer = deps.questions.answerOf<QuestionAnswerView>(record.id) ?? {};
      const latencyMs = Math.max(
        0,
        new Date(record.answeredAt ?? record.createdAt).getTime() -
          new Date(record.createdAt).getTime(),
      );

      emit(session, 'session.question.answered', {
        questionId: record.id,
        answeredVia: record.answeredVia ?? 'local',
        latencyMs,
        // §5.4 stage 2's honest cost: one re-decided tool call and one extra
        // turn, reported rather than hidden.
        delivery: 'after-park',
        decision: answer,
      });

      // §5.4 stage 3: re-queued at `interactive` priority, resumed with
      // `resume: <sdk_session_id>`, and the answer is the first message of the
      // new turn.
      await deps.control.resume(session.id, {
        message: answerMessage(record.prompt, answer),
        priority: 'interactive',
      });
      log('info', 'a parked session was resumed with the user answer', {
        sessionId: session.id,
        questionId: record.id,
      });
      return true;
    } finally {
      resuming.delete(session.id);
    }
  }

  function endExpired(record: QuestionRecord): boolean {
    const session = parkedSessionFor(record);
    if (session === undefined) return false;
    // §5.4: `interrupted` rather than `failed`, "because nothing errored — the
    // system deliberately stopped waiting".
    deps.control.endParked(
      session.id,
      'question_expired',
      `The question this session was waiting on (${record.id}) was not answered in time.`,
    );
    log('info', 'a parked session ended because its question expired', {
      sessionId: session.id,
      questionId: record.id,
    });
    return true;
  }

  async function onQuestionAnswered(questionId: string): Promise<void> {
    const record = deps.questions.get(questionId);
    if (record === undefined || record.status !== 'answered') return;
    await deliverAnswer(record);
  }

  function onQuestionExpired(questionId: string): void {
    const record = deps.questions.get(questionId);
    if (record === undefined) return;
    if (record.status !== 'expired' && record.status !== 'cancelled') return;
    endExpired(record);
  }

  return {
    onQuestionAnswered,
    onQuestionExpired,

    async reconcileOnBoot(): Promise<BootQuestionReconciliation> {
      const parked: string[] = [];
      const resumed: string[] = [];
      const ended: string[] = [];

      // (a) A session that was *mid-question* when the core died. §5.4 already
      // decided what such a session is: one that is waiting for a human, not one
      // that failed. Parking it `awaiting_answer` — rather than letting the
      // generic `running → orphaned` sweep have it — is what makes the answer,
      // whenever it comes, still resume real work.
      for (const session of deps.sessions.list({ status: 'running' })) {
        const open = openQuestionFor(deps.questions, session);
        if (open === undefined) continue;
        await deps.control.parkForQuestion(session.id, open.id);
        parked.push(session.id);
      }

      // (b) Parked sessions, judged from the **row** rather than from an event
      // that will never be emitted again (§9.2).
      for (const session of deps.sessions.list({ status: 'paused' })) {
        if (session.exitReason !== 'awaiting_answer') continue;
        const record = questionFor(deps.questions, session);
        if (record === undefined) continue;
        if (record.status === 'answered') {
          if (await deliverAnswer(record)) resumed.push(session.id);
        } else if (record.status === 'expired' || record.status === 'cancelled') {
          if (endExpired(record)) ended.push(session.id);
        }
      }

      return { parked, resumed, ended };
    },

    subscribe(): Unsubscribe {
      const unsubscribeAnswered = deps.bus.subscribe(
        ['question.answered', 'assignment.question.answered'],
        (event) => {
          const questionId = (event.payload as { questionId?: unknown } | undefined)?.questionId;
          if (typeof questionId !== 'string') return;
          onQuestionAnswered(questionId).catch((error: unknown) => {
            log('error', 'a parked session could not be resumed with its answer', {
              questionId,
              error: error instanceof Error ? error.message : String(error),
            });
          });
        },
      );
      const unsubscribeExpired = deps.bus.subscribe(
        ['question.expired', 'question.cancelled'],
        (event) => {
          const questionId = (event.payload as { questionId?: unknown } | undefined)?.questionId;
          if (typeof questionId !== 'string') return;
          onQuestionExpired(questionId);
        },
      );
      return () => {
        unsubscribeAnswered();
        unsubscribeExpired();
      };
    },
  };
}

/** The newest question raised against a session, whatever its status. */
export function questionFor(
  questions: Pick<QuestionsRepository, 'listByAssignment'>,
  session: Pick<SessionRecord, 'id' | 'assignmentId'>,
): QuestionRecord | undefined {
  let found: QuestionRecord | undefined;
  for (const record of questions.listByAssignment(session.assignmentId)) {
    if (record.sessionId !== session.id) continue;
    if (found === undefined || record.createdAt >= found.createdAt) found = record;
  }
  return found;
}

/** The same read, narrowed to a card still waiting for a human. */
export function openQuestionFor(
  questions: Pick<QuestionsRepository, 'listByAssignment'>,
  session: Pick<SessionRecord, 'id' | 'assignmentId'>,
): QuestionRecord | undefined {
  const record = questionFor(questions, session);
  return record?.status === 'open' ? record : undefined;
}
