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
import { durableAllowRule } from './permissionRules.js';
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

/** The choice §5.1 pins for every tool gate, whatever else the card offers. */
export const ALLOW_ONCE_OPTION: QuestionOptionView = {
  id: 'allow',
  label: 'Allow once',
  description: 'Run this call. The permission is not widened for the rest of the session.',
};

/**
 * §5.1's third choice, added by owner decision on **2026-08-18**.
 *
 * The original §5.1 offered only *Allow once* and *Deny*, on the reasoning that
 * the SDK's `updatedPermissions` would widen the session's permissions at
 * runtime and that widening is the composition roster owns. **That reasoning is
 * intact and it is why this option is built the way it is.** Nothing here sets
 * `updatedPermissions`, and nothing here changes the live session:
 *
 * - the pending call resolves as an ordinary allow, byte for byte the same
 *   `PermissionResult` *Allow once* produces;
 * - the durable half is a **roster edit**, made by the client against
 *   `POST /api/roster/agents/:id/permissions/allow`, which appends the derived
 *   rule to the agent's `permissions.allow` through the same write path the
 *   agent editor uses. Roster stays the only composer (roster DESIGN §6).
 *
 * The consequence is honest and the description says it out loud: the standing
 * permission is compiled into the agent's options at *launch*, so it takes
 * effect from the agent's **next** session, not from the rest of this one.
 */
export const ALLOW_ALWAYS_OPTION: QuestionOptionView = {
  id: 'allow-always',
  label: 'Always allow',
  description:
    'Run this call now, and add a standing permission to this agent. The rule is saved on the ' +
    'agent and applies from its next session — not to the rest of this one.',
};

export const DENY_OPTION: QuestionOptionView = {
  id: 'deny',
  label: 'Deny',
  description: 'Refuse this call. Any text you add is given to the agent as the reason.',
};

/**
 * The two ids that mean "run it". Both resolve to the *same* allow (§5.3's
 * tool-gate row); the difference between them is entirely a roster edit the
 * client makes afterwards, which is why runner treats them identically here.
 */
const ALLOWING_OPTIONS: readonly QuestionOptionView[] = [ALLOW_ONCE_OPTION, ALLOW_ALWAYS_OPTION];

/** What a raised card told runner, for the `session.question.raised` event (§10). */
export interface RaisedQuestion {
  readonly questionId: string;
  readonly kind: 'question';
  readonly prompt: string;
  readonly options: readonly QuestionOptionView[];
  readonly toolName: string;
  readonly holdUntil: string;
  readonly expiresAt: string;
  /**
   * The rule {@link ALLOW_ALWAYS_OPTION} would add, when the card offers it.
   *
   * Carried rather than left to be re-derived: the client that answers the card
   * is the client that makes the roster edit, and two implementations of the
   * derivation would eventually disagree about what the user approved.
   */
  readonly durableRule?: string | undefined;
}

/** How a pending call was resolved, for `session.question.answered` (§10). */
export interface SettledQuestion {
  readonly questionId: string;
  readonly answeredVia: 'local' | 'remote';
  readonly latencyMs: number;
  readonly delivery: 'inline';
  readonly decision: QuestionAnswerView;
  readonly behavior: 'allow' | 'deny';
  /** The rule the answer asked to be remembered, when it asked (§5.1). */
  readonly durableRule?: string | undefined;
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
  /**
   * Tool gates the user pre-answered for this seat, from the assignment context
   * (orchestrator §2.3, WO4 §2).
   *
   * Bare tool names, already scoped to `(assignment, agent)` by orchestrator.
   * Matching is `===` on the name and nothing else, which is why the file
   * header's "runner matches no rule patterns and consults no rule set" is
   * still true: this is a set of **answers**, not of rules. It cannot widen
   * anything — a call only reaches here after surviving the deny rules and
   * failing to be auto-approved, so the most a pre-grant can do is stand in for
   * the card that call was already going to raise.
   */
  readonly preGrantedTools?: readonly string[] | undefined;
  /**
   * The seat this session holds, for the card's "which of them is asking" line
   * (WO4 addendum §6). Absent when the assignment could not name one.
   */
  readonly seat?:
    { readonly role?: string | undefined; readonly pattern?: string | undefined } | undefined;
  /**
   * `scope.artifactPath` for this assignment, so a deny can say what it costs
   * (WO4 addendum §6). Absent when the assignment declares none.
   */
  readonly artifactPath?: string | undefined;
  readonly onRaised?: ((raised: RaisedQuestion) => void) | undefined;
  readonly onSettled?: ((settled: SettledQuestion) => void) | undefined;
  /**
   * A gate that was answered before it was asked. Called instead of raising a
   * card, so the decision is still on the record (WO4 §2's "recorded in the
   * transcript/timeline as pre-allowed") — a permission that leaves no trace is
   * a permission nobody can audit.
   */
  readonly onPreAllowed?: ((preAllowed: { readonly toolName: string }) => void) | undefined;
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

    // WO4 §2: a gate the user answered in the Start-work dialog does not get
    // asked again. It sits here, after roster's policy refusal and before any
    // card-building, because a pre-grant is an *answer* and an answer belongs
    // exactly where the answer would have arrived.
    //
    // `AskUserQuestion` is excluded unconditionally: it is not a tool gate
    // (§5.1, §5.3) — it is the agent asking the user something, and
    // pre-answering it would silently discard a question rather than a
    // permission prompt. Roster refuses an allow rule on it for the same
    // reason (SDK-NOTES C2).
    if (toolName !== ASK_USER_QUESTION_TOOL && deps.preGrantedTools?.includes(toolName) === true) {
      deps.onPreAllowed?.({ toolName });
      log('info', 'a tool call was pre-allowed for this assignment; no card was raised', {
        sessionId: deps.sessionId,
        assignmentId: deps.assignmentId,
        agentId: deps.agentId,
        toolName,
      });
      // Byte for byte the *Allow once* result (§5.3's tool-gate row): the input
      // is echoed unchanged and there is no `updatedPermissions`, because
      // widening the live session's permissions is the composition roster owns.
      return {
        behavior: 'allow',
        updatedInput: input,
        toolUseID: options.toolUseID,
        decisionClassification: 'user_temporary',
      };
    }

    const spec = toolName === ASK_USER_QUESTION_TOOL ? readAskUserQuestion(input) : undefined;
    const askedAt = deps.clock().getTime();
    const holdUntil = new Date(askedAt + deps.holdMs).toISOString();
    const expiresAt = new Date(askedAt + deps.expireHours * 3_600_000).toISOString();
    /**
     * §5.1's owner decision, applied to **tool gates only**.
     *
     * An `AskUserQuestion` card carries the agent's own options verbatim (§5.3),
     * and `budget_halt` / `approval_gate` cards are raised elsewhere entirely —
     * by runner's budget path and by orchestrator (§15.1-8) — so neither can
     * reach this line. Within tool gates the option appears only when a rule can
     * be written that honestly describes the call: `durableAllowRule` returns
     * `undefined` for a compound shell command, for a file edit with no usable
     * path, and for anything else it cannot describe without over-granting, and
     * the card then keeps the original two options.
     */
    const durableRule = spec === undefined ? durableAllowRule(toolName, input) : undefined;
    const cardOptions =
      spec?.options ??
      (durableRule === undefined
        ? [ALLOW_ONCE_OPTION, DENY_OPTION]
        : [ALLOW_ONCE_OPTION, ALLOW_ALWAYS_OPTION, DENY_OPTION]);

    // Resolved once: the answer is "does *this* input name the artifact", and
    // asking twice would let the condition and the value disagree.
    const artifactAtRisk = artifactWriteTarget(deps.artifactPath, input);

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
        // The two facts a client needs to act on ALLOW_ALWAYS_OPTION, carried on
        // the card so it can show the rule *before* the click: the user approves
        // a rule, not a vibe. `agentId` is already on the request, but the card
        // projection does not surface it and the roster edit is addressed to it.
        ...(durableRule === undefined ? {} : { durableRule, agentId: deps.agentId }),
        // WO4 addendum §6, the non-speculative half: *which* of them is asking.
        // "Allow the agent to use Bash?" from an unnamed seat in a two-seat pair
        // is a decision the user makes without knowing whose work they are
        // stopping.
        ...(deps.seat?.role === undefined ? {} : { seatRole: deps.seat.role }),
        ...(deps.seat?.pattern === undefined ? {} : { pattern: deps.seat.pattern }),
        // The other half, and it is a *fact* rather than a guess: this call
        // names the artifact the assignment is judged on, so denying it stops
        // that file being written. Set only when the gated input itself carries
        // the path — the broader "this agent might have used Bash to write it"
        // is exactly the speculation the addendum told us not to build.
        ...(artifactAtRisk === undefined ? {} : { artifactPath: artifactAtRisk }),
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
          ...(durableRule === undefined ? {} : { durableRule }),
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
      // Only when the answer actually chose it: the event records what the user
      // asked to be remembered, not what they could have.
      ...(durableRule !== undefined && chose(outcome.answer, ALLOW_ALWAYS_OPTION)
        ? { durableRule }
        : {}),
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

    // Both allowing options resolve identically. "Always allow" adds nothing to
    // *this* result — its durable half is the client's roster edit (§5.1's
    // 2026-08-18 decision), which is what keeps roster the only composer.
    const allowed = ALLOWING_OPTIONS.some((option) => chose(answer, option));
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
 * Whether *this* gated call is the one that writes the assignment's artifact —
 * WO4 addendum §6, and deliberately the narrow reading of it.
 *
 * The addendum asks for "a note when the denied tool is the one the artifact
 * write depends on", and adds: "if wiring the artifact-dependency hint proves
 * speculative, ship the seat/turn context alone". So the hint is set only when
 * the *input in front of the user* names the artifact path — a `Write`/`Edit`
 * whose `file_path` is that file, or a shell command with the path in it. That
 * is a fact about the call being approved, not a prediction about the agent.
 *
 * What is deliberately **not** inferred: that a drafter which loses `Bash` will
 * therefore fail to write its artifact by some other route. It might use `Write`
 * instead, and a card that said otherwise would be wrong in the direction that
 * scares a user out of a correct deny.
 *
 * Path comparison is slash-normalised and case-insensitive, matching
 * `permissionRules.ts`'s treatment of Windows paths; a substring test is enough
 * for the shell case because the alternative — parsing a command line to find
 * its redirection target — is the speculation this function exists to avoid.
 */
function artifactWriteTarget(
  artifactPath: string | undefined,
  input: Record<string, unknown>,
): string | undefined {
  if (artifactPath === undefined || artifactPath.trim() === '') return undefined;
  const wanted = normaliseForCompare(artifactPath);
  if (wanted === '') return undefined;

  for (const field of ['file_path', 'path', 'notebook_path', 'command']) {
    const value = input[field];
    if (typeof value !== 'string') continue;
    if (normaliseForCompare(value).includes(wanted)) return artifactPath;
  }
  return undefined;
}

function normaliseForCompare(value: string): string {
  return value.replaceAll('\\', '/').trim().toLowerCase();
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

/**
 * Did this answer pick that option?
 *
 * By id *or* by label, because the two answer channels disagree about which one
 * they carry: a client posting `optionIds` gives the id, while an answer that
 * came back through the SDK's own label-keyed map (§5.3) gives the label.
 */
function chose(answer: QuestionAnswerView, option: QuestionOptionView): boolean {
  return (
    (answer.optionIds ?? []).includes(option.id) ||
    (answer.labels ?? []).some((label) => label === option.label)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
