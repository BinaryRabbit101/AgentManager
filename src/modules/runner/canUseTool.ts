/**
 * Runner's `canUseTool` callback (runner DESIGN §5.1, D10) — M3's default-deny
 * and M7's question bridge, in that order.
 *
 * Roster composes permissions and deliberately does **not** set
 * `options.canUseTool` (roster §6.1: "the callback itself is installed by the
 * runner"); it hands over a `CanUseToolPolicy` instead. By the verified
 * evaluation order, anything reaching this callback has already survived the
 * deny rules and already failed to be auto-approved — so the callback is the
 * escalation point for an *undecided* call, never a place where a rule is
 * evaluated. **Runner matches no rule patterns and consults no rule set.**
 *
 * M7 turns the escalation into the question bridge: raise a card, hold for
 * `runner.question.holdMs`, deliver the answer inside the pending tool call.
 * {@link createDefaultDenyCanUseTool} remains as the terminal fallback — *deny*,
 * with roster's own message — which is exactly what "default-deny is the outcome
 * whenever no human answers" means, and it is what
 * {@link createQuestionCanUseTool} itself falls back to on every path that
 * cannot reach a human.
 *
 * ## SDK-NOTES G5, which is why this function has no branches that fall off the
 * end
 *
 * > "Return `null` ONLY after the consumer has already sent the control_response
 * > out-of-band… **an accidental null means no control_response is sent and the
 * > tool stays blocked indefinitely — permission prompts have no park
 * > deadline.**"
 *
 * The adapter is therefore **total**: every path returns an allow or a deny, and
 * the type below cannot express `null`. The one place a `null` could ever be
 * correct — an out-of-band response — is not a thing runner does.
 */
import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';

import type { Clock } from '../../storage/index.js';

import type {
  AskQuestionRequest,
  CanUseToolPolicyView,
  QuestionAnswerView,
  QuestionBridgeView,
  QuestionOptionView,
  QuestionOutcomeView,
} from './contracts.js';
import { ASK_USER_QUESTION_TOOL, describeAnswer, parkMessage } from './questionBridge.js';

export interface DefaultDenyDeps {
  /** roster's compiled policy, read rather than re-derived (roster §6.1). */
  readonly policy: CanUseToolPolicyView;
  /** Observability only: which calls reached the callback, and were denied. */
  readonly onDenied?: (toolName: string, detail: { readonly toolUseId: string }) => void;
}

/**
 * The default-deny callback M3 installs.
 *
 * Returns a `PermissionResult`, never `null`, and never a promise that can
 * reject: a throw out of `canUseTool` would leave the control request
 * unanswered, which is G5's failure in a different costume.
 */
export function createDefaultDenyCanUseTool(deps: DefaultDenyDeps): CanUseTool {
  return (toolName, _input, options) => {
    const denial: PermissionResult = {
      behavior: 'deny',
      message: deps.policy.denyMessage,
      // No `interrupt`: an ordinary denial lets the turn continue and lets the
      // agent report what it could not do. §5.4's parking denial is the one that
      // interrupts, and it belongs to M7.
      toolUseID: options.toolUseID,
    };
    try {
      deps.onDenied?.(toolName, { toolUseId: options.toolUseID });
    } catch {
      // An observer that throws must not wedge a tool call (G5).
    }
    return Promise.resolve(denial);
  };
}

// ---------------------------------------------------------------------------
// M7 — the question bridge (§5.1 → §5.4)
// ---------------------------------------------------------------------------

/** The two choices §5.1 pins for a tool gate. "Always allow" is not offered. */
export const ALLOW_ONCE_OPTION: QuestionOptionView = {
  id: 'allow',
  label: 'Allow once',
  description: 'Run this call. The permission is not widened for the rest of the session.',
};

export const DENY_OPTION: QuestionOptionView = {
  id: 'deny',
  label: 'Deny',
  description: 'Refuse this call. Any text you add is given to the agent as the reason.',
};

/** What a raised card told runner, for the `session.question.raised` event (§10). */
export interface RaisedQuestion {
  readonly questionId: string;
  readonly kind: 'question';
  readonly prompt: string;
  readonly options: readonly QuestionOptionView[];
  readonly toolName: string;
  readonly holdUntil: string;
  readonly expiresAt: string;
}

/** How a pending call was resolved, for `session.question.answered` (§10). */
export interface SettledQuestion {
  readonly questionId: string;
  readonly answeredVia: 'local' | 'remote';
  readonly latencyMs: number;
  readonly delivery: 'inline';
  readonly decision: QuestionAnswerView;
  readonly behavior: 'allow' | 'deny';
}

export interface QuestionCanUseToolDeps {
  readonly sessionId: string;
  readonly assignmentId: string;
  readonly agentId: string;
  /** roster's compiled policy, read rather than re-derived (roster §6.1). */
  readonly policy: CanUseToolPolicyView;
  /** Orchestrator's bridge, or runner's degraded fallback (§5.2). */
  readonly bridge: QuestionBridgeView;
  /** §5.4 stage 1: `runner.question.holdMs`. */
  readonly holdMs: number;
  /** `runner.question.expireHours`, carried on the request (§5.2). */
  readonly expireHours: number;
  readonly clock: Clock;
  readonly onRaised?: ((raised: RaisedQuestion) => void) | undefined;
  readonly onSettled?: ((settled: SettledQuestion) => void) | undefined;
  /**
   * §5.4 stage 2. Called **before** the denial is returned, with the question
   * still open — the caller closes the query and settles the row `paused` /
   * `awaiting_answer`.
   */
  readonly onPark?: ((questionId: string | null) => void) | undefined;
  /**
   * The question id at park time, for an orchestrator build that ignores
   * `onRaised`. Reads the `questions` row, exactly as §9.2's boot sweep does.
   */
  readonly resolveQuestionId?: (() => string | undefined) | undefined;
  readonly log?:
    | ((
        level: 'debug' | 'info' | 'warn' | 'error',
        message: string,
        detail?: Record<string, unknown>,
      ) => void)
    | undefined;
  /** Test seam for §5.4's hold timer. Returns a canceller. */
  readonly timer?: ((ms: number, fire: () => void) => () => void) | undefined;
}

/** The `AskUserQuestion` payload, read defensively out of a `Record`. */
interface AskUserQuestionSpec {
  readonly question: string;
  readonly header: string | undefined;
  readonly options: readonly QuestionOptionView[];
  readonly multiSelect: boolean;
}

/**
 * The M7 callback: every undecided call becomes a question, and every question
 * ends in an allow or a deny.
 *
 * ## Why this is written as one total function with no fall-through
 *
 * SDK-NOTES **G5**: returning `null` sends no control response and the tool
 * "stays blocked indefinitely — permission prompts have no park deadline". So
 * the promise this returns can neither reject nor resolve to `null`: every
 * branch, including a bridge that throws and an ask that never settles, ends at
 * an explicit `PermissionResult`. `runner.question.holdMs` is the only thing
 * standing between a bug and a wedged subprocess, and it is applied here rather
 * than trusted to anybody else.
 *
 * ## Idempotency per `requestId`
 *
 * SDK-NOTES §4.1: a `canUseTool` invocation can be **redelivered**. A second
 * delivery of the same `requestId` joins the first decision instead of raising a
 * second card — otherwise a reconnect would produce two questions for one tool
 * call, and answering one of them would leave the other open forever.
 */
export function createQuestionCanUseTool(deps: QuestionCanUseToolDeps): CanUseTool {
  const inFlight = new Map<string, Promise<PermissionResult>>();
  const log = deps.log ?? ((): void => {});

  const startTimer =
    deps.timer ??
    ((ms: number, fire: () => void): (() => void) => {
      const handle = setTimeout(fire, Math.max(ms, 0));
      handle.unref?.();
      return () => {
        clearTimeout(handle);
      };
    });

  return (toolName, input, options) => {
    const existing = inFlight.get(options.requestId);
    if (existing !== undefined) return existing;

    const decision = decide(toolName, input, options).catch((error: unknown) => {
      // G5 in its second costume: a throw out of here would leave the control
      // request unanswered just as surely as a `null` would.
      log('error', 'the question bridge failed; the tool call was denied', {
        sessionId: deps.sessionId,
        toolName,
        error: error instanceof Error ? error.message : String(error),
      });
      return deny(
        options.toolUseID,
        'This call could not be put to the user because the question bridge failed, so it was ' +
          'denied. Report the problem and continue without it.',
      );
    });

    inFlight.set(options.requestId, decision);
    void decision.finally(() => inFlight.delete(options.requestId));
    return decision;
  };

  async function decide(
    toolName: string,
    input: Record<string, unknown>,
    options: Parameters<CanUseTool>[2],
  ): Promise<PermissionResult> {
    // §5.6: a session with no bridge denies rather than hangs. `dontAsk` skips
    // the callback entirely, so this is belt and braces — and it is the branch
    // that keeps the function total when it is not.
    if (!deps.policy.humanMayApprove) {
      return deny(options.toolUseID, deps.policy.denyMessage);
    }

    const spec = toolName === ASK_USER_QUESTION_TOOL ? readAskUserQuestion(input) : undefined;
    const askedAt = deps.clock().getTime();
    const holdUntil = new Date(askedAt + deps.holdMs).toISOString();
    const expiresAt = new Date(askedAt + deps.expireHours * 3_600_000).toISOString();
    const cardOptions = spec?.options ?? [ALLOW_ONCE_OPTION, DENY_OPTION];

    let questionId: string | null = null;
    const request: AskQuestionRequest = {
      sessionId: deps.sessionId,
      assignmentId: deps.assignmentId,
      agentId: deps.agentId,
      // §15.1-8: runner raises `question` and `budget_halt`; never `approval_gate`.
      kind: 'question',
      prompt: promptFor(toolName, spec, options),
      options: cardOptions,
      multiSelect: spec?.multiSelect ?? false,
      // Free text is how a Deny carries the user's reason back to the agent.
      allowFreeText: true,
      context: {
        toolName,
        toolInput: input,
        ...(options.matchedAskRule === undefined ? {} : { matchedAskRule: options.matchedAskRule }),
        ...(options.description === undefined ? {} : { description: options.description }),
      },
      holdUntil,
      expiresAt,
      onRaised: (id) => {
        questionId = id;
        deps.onRaised?.({
          questionId: id,
          kind: 'question',
          prompt: request.prompt,
          options: cardOptions,
          toolName,
          holdUntil,
          expiresAt,
        });
      },
    };

    const asked = deps.bridge.ask(request);
    // A late resolution has nobody waiting once the hold has expired; without
    // this the park path would produce an unhandled rejection on a bridge that
    // eventually fails.
    asked.catch(() => undefined);

    const outcome = await raceHold(asked, options.signal);

    if (outcome === 'hold-expired') {
      const parkedId = questionId ?? deps.resolveQuestionId?.() ?? null;
      log('info', 'a question outlived the inline hold; the session is being parked', {
        sessionId: deps.sessionId,
        questionId: parkedId,
        toolName,
      });
      deps.onPark?.(parkedId);
      // §5.4 stage 2, verbatim — and `interrupt: true`, because "left to itself,
      // a denied agent invents a workaround".
      return {
        behavior: 'deny',
        interrupt: true,
        message: parkMessage(parkedId ?? 'pending'),
        toolUseID: options.toolUseID,
        decisionClassification: 'user_reject',
      };
    }

    if (outcome === 'aborted') {
      // The SDK cancelled the call (`control_cancel_request`). The card would
      // otherwise sit open with nobody behind it.
      if (questionId !== null) {
        void deps.bridge
          .cancel(questionId, 'the tool call was cancelled before it was answered')
          .catch(() => undefined);
      }
      return deny(options.toolUseID, 'The tool call was cancelled before it could be answered.');
    }

    if (outcome.status === 'expired') {
      return deny(
        options.toolUseID,
        'The question raised for this call expired without an answer, so the call was denied. ' +
          'Stop here rather than working around it.',
      );
    }
    if (outcome.status === 'cancelled') {
      return deny(
        options.toolUseID,
        `The question raised for this call was cancelled (${outcome.reason}), so the call was denied.`,
      );
    }

    const result = applyAnswer(toolName, input, spec, outcome.answer, options.toolUseID);
    deps.onSettled?.({
      questionId: outcome.questionId,
      answeredVia: outcome.answeredVia,
      latencyMs: Math.max(0, new Date(outcome.answeredAt).getTime() - askedAt),
      // §5.3: the agent never left the tool call, so there is no "moved on"
      // window at all.
      delivery: 'inline',
      decision: outcome.answer,
      behavior: result.behavior,
    });
    return result;
  }

  /** §5.4 stage 1: the ask, the hold, and the SDK's own cancellation. */
  function raceHold(
    asked: Promise<QuestionOutcomeView>,
    signal: AbortSignal,
  ): Promise<QuestionOutcomeView | 'hold-expired' | 'aborted'> {
    return new Promise<QuestionOutcomeView | 'hold-expired' | 'aborted'>((resolve) => {
      let done = false;
      const settle = (value: QuestionOutcomeView | 'hold-expired' | 'aborted'): void => {
        if (done) return;
        done = true;
        cancelTimer();
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      };
      function onAbort(): void {
        settle('aborted');
      }

      const cancelTimer = startTimer(deps.holdMs, () => {
        settle('hold-expired');
      });
      if (signal.aborted) {
        settle('aborted');
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      void asked.then(
        (outcome) => {
          settle(outcome);
        },
        () => {
          // A bridge that rejects is a bridge that cannot reach a human, which
          // is roster's default-deny case.
          settle({ status: 'cancelled', questionId: '', reason: 'the question bridge failed' });
        },
      );
    });
  }

  /** §5.3's delivery table, both rows. */
  function applyAnswer(
    toolName: string,
    input: Record<string, unknown>,
    spec: AskUserQuestionSpec | undefined,
    answer: QuestionAnswerView,
    toolUseID: string,
  ): PermissionResult {
    if (spec !== undefined) {
      // "`questions` must be echoed back, and `updatedInput` must always be
      // present on an allow." The answer is keyed by **question text**, and a
      // multi-select answer is a comma-separated string (SDK-NOTES §5.4).
      const answers: Record<string, string> = {
        ...(isRecord(input['answers']) ? (input['answers'] as Record<string, string>) : {}),
        [spec.question]: describeAnswer(answer),
      };
      return {
        behavior: 'allow',
        updatedInput: { questions: input['questions'], answers },
        toolUseID,
        decisionClassification: 'user_temporary',
      };
    }

    const allowed =
      (answer.optionIds ?? []).includes(ALLOW_ONCE_OPTION.id) ||
      (answer.labels ?? []).some((label) => label === ALLOW_ONCE_OPTION.label);
    if (allowed) {
      // Input echoed unchanged, and **no `updatedPermissions`**: widening the
      // session's permissions at runtime is the composition roster owns (§5.1).
      return {
        behavior: 'allow',
        updatedInput: input,
        toolUseID,
        decisionClassification: 'user_temporary',
      };
    }

    const reason = answer.text?.trim();
    log('debug', 'a tool call was denied by the user', {
      sessionId: deps.sessionId,
      toolName,
    });
    return deny(toolUseID, reason === undefined || reason === '' ? 'Denied by the user.' : reason);
  }

  function deny(toolUseID: string, message: string): PermissionResult {
    return {
      behavior: 'deny',
      message,
      // No `interrupt`: an ordinary denial lets the turn continue and lets the
      // agent report what it could not do. §5.4's parking denial is the one that
      // interrupts.
      toolUseID,
      decisionClassification: 'user_reject',
    };
  }
}

/**
 * §5.2's `prompt`, using the SDK's own sentence when it offers one.
 *
 * SDK-NOTES §5.1: `title` is the "full permission prompt sentence rendered by
 * the bridge… **use this as the primary prompt text when present** instead of
 * reconstructing from toolName+input". Reconstructing tool inputs into prose is
 * work the engine has already done better.
 */
function promptFor(
  toolName: string,
  spec: AskUserQuestionSpec | undefined,
  options: Parameters<CanUseTool>[2],
): string {
  if (spec !== undefined) return spec.question;
  if (options.title !== undefined && options.title.trim() !== '') return options.title;
  return `Allow the agent to use ${toolName}?`;
}

/** The `AskUserQuestion` input, read defensively — the tool lives in the engine. */
export function readAskUserQuestion(
  input: Record<string, unknown>,
): AskUserQuestionSpec | undefined {
  const questions = input['questions'];
  if (!Array.isArray(questions) || questions.length === 0) return undefined;
  const first: unknown = questions[0];
  if (!isRecord(first)) return undefined;
  const question = first['question'];
  if (typeof question !== 'string' || question.trim() === '') return undefined;

  const rawOptions = Array.isArray(first['options']) ? first['options'] : [];
  const options = rawOptions.flatMap((entry: unknown): QuestionOptionView[] => {
    if (!isRecord(entry)) return [];
    const label = entry['label'];
    if (typeof label !== 'string') return [];
    const description = entry['description'];
    return [
      {
        // The label is the id: the SDK's answer map is keyed by question text
        // and valued by **label**, so an id of our own invention would have to
        // be translated back on the way out — one more place to get it wrong.
        id: label,
        label,
        ...(typeof description === 'string' ? { description } : {}),
      },
    ];
  });

  return {
    question,
    header: typeof first['header'] === 'string' ? first['header'] : undefined,
    options,
    multiSelect: first['multiSelect'] === true,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
