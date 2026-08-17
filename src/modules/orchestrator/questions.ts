/**
 * The question inbox and `QuestionBridge` (orchestrator DESIGN §6, runner §5.2)
 * — IMPLEMENTATION M2.
 *
 * ## Two halves, and only one of them survives a restart
 *
 * A question is **a durable row plus an in-memory promise**, and the design is
 * explicit about which is load-bearing:
 *
 * - the `questions` row is the trigger. It survives the process, it is what the
 *   inbox lists, what the tailnet answers, and what runner's boot sweep reads;
 * - the promise `ask()` returned is a convenience for the *caller that is still
 *   running*. It dies with the process, and nothing in the resume path may
 *   depend on it (runner §9.2: "the trigger is the persisted `questions` row,
 *   never an in-memory promise").
 *
 * So {@link QuestionBridge.ask} resolves from the answer path when this process
 * is the one that raised it, and the `question.answered` **event** is what makes
 * the same answer work after a restart. Both are emitted from one place below,
 * which is what keeps them from drifting.
 *
 * ## Orchestrator is the only writer of `questions`
 *
 * §6.5: "orchestrator is the only writer of the `questions` table, so it is the
 * only thing that may expire a row". Runner's degraded fallback (runner §5.2)
 * is the sanctioned exception and applies only when this module is absent
 * altogether — at which point there is nothing to be the only writer *of*.
 *
 * ## The consolidation rule is exact equality, deliberately
 *
 * §6.3 joins an incoming ask onto an open card when the normalised prompt is
 * equal, the option id sets are equal, and the card is younger than
 * `joinWindowMs`. Exact normalised equality rather than fuzzy similarity,
 * because "a merged question answered once is a wrong answer delivered twice".
 */
import type { EventBus } from '../types.js';
import type {
  AnsweredVia,
  Clock,
  QuestionKind,
  QuestionRecord,
  QuestionsRepository,
  QuestionStatus,
} from '../../storage/index.js';

import { InvalidRequestError, OrchestratorError } from './errors.js';
import type { AssignmentRepository } from './repository.js';

export type { AnsweredVia, QuestionKind, QuestionStatus };

// ---------------------------------------------------------------------------
// The stance ladder (§6.2)
// ---------------------------------------------------------------------------

/**
 * §6.2's four-value ordinal ladder, in rank order.
 *
 * "The weight is a **forced choice** from a four-value ordinal ladder […]
 * rendered as words and never as a number." The array order *is* the sort order
 * on the card, so a renderer never has to know a numeric rank.
 */
export const QUESTION_STRENGTHS = ['blocking', 'strong', 'lean', 'defer'] as const;

export type QuestionStrength = (typeof QUESTION_STRENGTHS)[number];

export function isQuestionStrength(value: unknown): value is QuestionStrength {
  return typeof value === 'string' && (QUESTION_STRENGTHS as readonly string[]).includes(value);
}

/** Rank for §6.2's "strength rank first, then the pattern's declared seat order". */
export function strengthRank(strength: string | null): number {
  const index = (QUESTION_STRENGTHS as readonly string[]).indexOf(strength ?? '');
  return index === -1 ? QUESTION_STRENGTHS.length : index;
}

/**
 * One seat's recommendation, as `ask()` and the stance-solicitation path supply
 * it.
 *
 * `stance` is the recommended option id, free text, or `null` for `defer` —
 * §6.2's "no preference; this is the other seat's call". The column is
 * `NOT NULL`, so `null` is stored as the empty string and read back as `null`;
 * that mapping lives in this file and nowhere else.
 */
export interface RecommendationInput {
  readonly agentId: string;
  readonly stance: string | null;
  readonly strength: QuestionStrength;
  readonly rationale?: string | undefined;
}

export interface RecommendationView {
  readonly agentId: string;
  /** The seat this agent held in the assignment (§16-2: attribution is always present). */
  readonly role: string | null;
  readonly stance: string | null;
  readonly strength: QuestionStrength | null;
  readonly rationale: string | null;
}

// ---------------------------------------------------------------------------
// The bridge's pinned shapes (runner §5.2, verbatim)
// ---------------------------------------------------------------------------

export interface QuestionOption {
  readonly id: string;
  readonly label: string;
  readonly description?: string | undefined;
}

export interface AskRequest {
  readonly sessionId: string;
  readonly assignmentId: string;
  readonly agentId: string;
  readonly kind: QuestionKind;
  readonly prompt: string;
  readonly options?: readonly QuestionOption[] | undefined;
  readonly multiSelect?: boolean | undefined;
  readonly allowFreeText?: boolean | undefined;
  readonly context?: { toolName?: string; toolInput?: unknown } | undefined;
  /** ISO deadline for the inline hold. Recorded; the hold itself is runner's. */
  readonly holdUntil: string;
  /** ISO deadline for the question itself. */
  readonly expiresAt: string;
  /** §6.2: the asking seat's own stance, when it has one. */
  readonly recommendation?: RecommendationInput | undefined;
  /**
   * §6.4's stance solicitation: the join window is **waived**, "because the card
   * is explicitly waiting for it".
   */
  readonly solicited?: boolean | undefined;
  /**
   * Called with the question id the moment the row exists — **additive to
   * runner §5.2's shape, and optional**.
   *
   * §5.2 hands the id back only at settle time, but runner needs it at *raise*
   * time for its `session.question.raised` event (runner §10) and for §5.4's
   * park message, which names the card the parked session is waiting on. A
   * caller that does not pass one is unaffected; a joined ask (§6.3) receives
   * the id of the card it joined, which is the id its answer will arrive under.
   */
  readonly onRaised?: ((questionId: string) => void) | undefined;
}

export interface QuestionAnswer {
  readonly optionIds?: readonly string[];
  readonly labels?: readonly string[];
  readonly text?: string;
}

export type QuestionOutcome =
  | {
      readonly status: 'answered';
      readonly questionId: string;
      readonly answer: QuestionAnswer;
      readonly answeredVia: AnsweredVia;
      readonly answeredAt: string;
    }
  | { readonly status: 'expired'; readonly questionId: string }
  | { readonly status: 'cancelled'; readonly questionId: string; readonly reason: string };

/** Runner §5.2's interface, implemented verbatim. */
export interface QuestionBridge {
  ask(request: AskRequest): Promise<QuestionOutcome>;
  cancel(questionId: string, reason: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// The card (§11.1's pinned list projection, ui R5)
// ---------------------------------------------------------------------------

export interface QuestionCard {
  readonly id: string;
  readonly kind: QuestionKind;
  readonly status: QuestionStatus;
  readonly prompt: string;
  readonly options: readonly QuestionOption[];
  readonly multiSelect: boolean;
  readonly allowFreeText: boolean;
  readonly context: { toolName?: string; toolInput?: unknown } | null;
  readonly createdAt: string;
  readonly holdUntil: string | null;
  readonly expiresAt: string | null;
  readonly assignmentId: string;
  readonly projectId: string | null;
  readonly sessionId: string | null;
  readonly recommendations: readonly RecommendationView[];
  /** §6.3, computed server-side: distinct non-null stances > 1. */
  readonly disagreement: boolean;
  /** §6.3: `disagreement` **and** any `blocking`. */
  readonly contested: boolean;
  readonly answeredVia: AnsweredVia | null;
  readonly answeredAt: string | null;
  readonly answer: QuestionAnswer | null;
}

export interface AnswerQuestionInput {
  readonly optionIds?: readonly string[] | undefined;
  readonly labels?: readonly string[] | undefined;
  readonly text?: string | undefined;
  /** Foundation's request origin, recorded as `answered_via` (§6.1). */
  readonly answeredVia: AnsweredVia;
  readonly at?: string | undefined;
}

export interface ListQuestionsQuery {
  readonly status?: QuestionStatus | undefined;
  readonly assignmentId?: string | undefined;
  readonly limit?: number | undefined;
}

/** What one expiry sweep did — returned so a boot task can log it (M2-5). */
export interface ExpirySweepResult {
  readonly expired: readonly string[];
  readonly closedAssignments: readonly { assignmentId: string; reason: string }[];
  readonly haltedAssignments: readonly string[];
}

export interface QuestionInbox extends QuestionBridge {
  answer(questionId: string, input: AnswerQuestionInput): QuestionCard;
  get(questionId: string): QuestionCard;
  list(query?: ListQuestionsQuery): readonly QuestionCard[];
  /** §6.4's stance solicitation, and M6's counterpart seat. */
  addRecommendation(questionId: string, recommendation: RecommendationInput): QuestionCard;
  /** §6.5's sweep. Run at boot and whenever a caller wants it. */
  sweepExpired(): ExpirySweepResult;
  /** Cancels every open question of an assignment — `closeAssignment`'s path. */
  cancelForAssignment(assignmentId: string, reason: string): void;
  /** How many `ask()` promises this process is still holding. Diagnostics only. */
  pendingCount(): number;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class QuestionNotFoundError extends OrchestratorError {
  override readonly name = 'QuestionNotFoundError';

  constructor(readonly questionId: string) {
    super('question_not_found', `No question ${questionId} exists.`, 404, { questionId });
  }
}

export class QuestionNotOpenError extends OrchestratorError {
  override readonly name = 'QuestionNotOpenError';

  constructor(questionId: string, status: QuestionStatus) {
    super(
      'question_not_open',
      `Question ${questionId} is ${status}; only an open question can be answered.`,
      409,
      { questionId, status },
    );
  }
}

// ---------------------------------------------------------------------------
// The envelope stored in `options_json`
// ---------------------------------------------------------------------------

/**
 * Everything the card needs that `questions` has no column for.
 *
 * Foundation deliberately gave the table one free JSON column and left its shape
 * to this element (§1.4). Putting the deadlines and the tool context in it — as
 * opposed to adding columns in orchestrator's migration — keeps the row's shape
 * foundation's and the *card's* shape orchestrator's, which is the same split
 * §6.1 already draws between the row and the recommendations.
 */
interface QuestionEnvelope {
  readonly options?: readonly QuestionOption[];
  readonly multiSelect?: boolean;
  readonly allowFreeText?: boolean;
  readonly holdUntil?: string;
  readonly expiresAt?: string;
  readonly context?: { toolName?: string; toolInput?: unknown };
  /** The seat that raised it, for attribution when it carries no recommendation. */
  readonly agentId?: string;
}

export interface QuestionInboxOptions {
  readonly questions: QuestionsRepository;
  readonly assignments: AssignmentRepository;
  readonly bus: EventBus;
  readonly clock: Clock;
  /** §6.3's window. */
  readonly joinWindowMs: number;
  /** `runner.question.expireHours` — **read** from runner's config, not copied (§12). */
  readonly expireHours: number;
  /**
   * §6.5's per-kind consequences. Injected rather than imported so the inbox does
   * not depend on the whole assignment service (which depends on *it*, through
   * `closeAssignment`).
   */
  readonly onExpiredGate?: (assignmentId: string, reason: 'gate_expired') => void;
  readonly onExpiredBudget?: (assignmentId: string) => void;
  readonly log?: (message: string, detail?: Record<string, unknown>) => void;
}

interface Waiter {
  readonly settle: (outcome: QuestionOutcome) => void;
}

export function createQuestionInbox(options: QuestionInboxOptions): QuestionInbox {
  const { questions, assignments, bus, clock } = options;

  /**
   * One question id → every caller still awaiting it.
   *
   * A **set**, not a single waiter, because §6.3's join means two sessions can
   * be blocked on one card and "both askers get the same answer".
   */
  const pending = new Map<string, Set<Waiter>>();

  function log(message: string, detail?: Record<string, unknown>): void {
    options.log?.(message, detail);
  }

  function now(): string {
    return clock().toISOString();
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  function envelopeOf(record: QuestionRecord): QuestionEnvelope {
    if (record.optionsJson === null) return {};
    try {
      const parsed: unknown = JSON.parse(record.optionsJson);
      if (Array.isArray(parsed)) return { options: parsed as readonly QuestionOption[] };
      if (typeof parsed === 'object' && parsed !== null) return parsed;
      return {};
    } catch {
      // A card whose envelope will not parse is still answerable as free text,
      // which is strictly better than a card that cannot be rendered at all.
      log('question options_json did not parse; the card is rendered without options', {
        questionId: record.id,
      });
      return {};
    }
  }

  function answerOf(record: QuestionRecord): QuestionAnswer | null {
    if (record.answerJson === null) return null;
    try {
      const parsed: unknown = JSON.parse(record.answerJson);
      return typeof parsed === 'object' && parsed !== null ? parsed : null;
    } catch {
      return null;
    }
  }

  /** §6.5: the deadline is `created_at + runner.question.expireHours`. */
  function expiryOf(record: QuestionRecord): string {
    const declared = envelopeOf(record).expiresAt;
    if (declared !== undefined) return declared;
    return new Date(
      new Date(record.createdAt).getTime() + options.expireHours * 3_600_000,
    ).toISOString();
  }

  function cardOf(record: QuestionRecord): QuestionCard {
    const envelope = envelopeOf(record);
    const assignment = assignments.get(record.assignmentId);
    const seats = new Map(assignments.listMembers(record.assignmentId).map((m) => [m.agentId, m]));

    const recommendations = [...questions.listRecommendations(record.id)]
      .map((row) => ({
        agentId: row.agentId,
        role: seats.get(row.agentId)?.role ?? null,
        // The `defer` mapping, in the one place that knows about it.
        stance: row.stance === '' ? null : row.stance,
        strength: isQuestionStrength(row.strength) ? row.strength : null,
        rationale: row.rationale,
      }))
      .sort((a, b) => {
        const rank = strengthRank(a.strength) - strengthRank(b.strength);
        if (rank !== 0) return rank;
        const seatA = seats.get(a.agentId)?.seatOrder ?? Number.MAX_SAFE_INTEGER;
        const seatB = seats.get(b.agentId)?.seatOrder ?? Number.MAX_SAFE_INTEGER;
        if (seatA !== seatB) return seatA - seatB;
        return a.agentId.localeCompare(b.agentId);
      });

    // §6.3, computed here rather than by the UI (§16-1).
    const stances = new Set(
      recommendations
        .map((one) => one.stance)
        .filter((stance): stance is string => stance !== null),
    );
    const disagreement = stances.size > 1;

    return {
      id: record.id,
      kind: record.kind,
      status: record.status,
      prompt: record.prompt,
      options: envelope.options ?? [],
      multiSelect: envelope.multiSelect ?? false,
      allowFreeText: envelope.allowFreeText ?? true,
      context: envelope.context ?? null,
      createdAt: record.createdAt,
      holdUntil: envelope.holdUntil ?? null,
      expiresAt: expiryOf(record),
      assignmentId: record.assignmentId,
      projectId: assignment?.projectId ?? null,
      sessionId: record.sessionId,
      recommendations,
      disagreement,
      contested: disagreement && recommendations.some((one) => one.strength === 'blocking'),
      answeredVia: record.answeredVia,
      answeredAt: record.answeredAt,
      answer: answerOf(record),
    };
  }

  function requireRecord(questionId: string): QuestionRecord {
    const record = questions.get(questionId);
    if (record === undefined) throw new QuestionNotFoundError(questionId);
    return record;
  }

  // -------------------------------------------------------------------------
  // §6.3 — consolidation
  // -------------------------------------------------------------------------

  function findJoinTarget(request: AskRequest): QuestionRecord | undefined {
    const wanted = normalisePrompt(request.prompt);
    const wantedOptions = optionKey(request.options);
    const cutoff = clock().getTime() - options.joinWindowMs;

    for (const record of questions.listOpen({ assignmentId: request.assignmentId })) {
      if (record.kind !== request.kind) continue;
      if (normalisePrompt(record.prompt) !== wanted) continue;
      if (optionKey(envelopeOf(record).options) !== wantedOptions) continue;
      // §6.4: the window is waived for a solicited stance, because the card is
      // explicitly waiting for it.
      if (request.solicited !== true && new Date(record.createdAt).getTime() < cutoff) continue;
      return record;
    }
    return undefined;
  }

  // -------------------------------------------------------------------------
  // The bridge
  // -------------------------------------------------------------------------

  function register(questionId: string): Promise<QuestionOutcome> {
    return new Promise<QuestionOutcome>((resolve) => {
      const waiter: Waiter = { settle: resolve };
      const waiters = pending.get(questionId) ?? new Set<Waiter>();
      waiters.add(waiter);
      pending.set(questionId, waiters);
    });
  }

  function settle(questionId: string, outcome: QuestionOutcome): void {
    const waiters = pending.get(questionId);
    if (waiters === undefined) return;
    pending.delete(questionId);
    for (const waiter of waiters) waiter.settle(outcome);
  }

  function writeRecommendation(questionId: string, recommendation: RecommendationInput): void {
    if (!isQuestionStrength(recommendation.strength)) {
      throw new InvalidRequestError(
        `"strength" must be one of ${QUESTION_STRENGTHS.join(', ')} — never a number or a ` +
          'percentage (§6.2).',
        'strength',
      );
    }
    questions.addRecommendation(questionId, {
      agentId: recommendation.agentId,
      stance: recommendation.stance ?? '',
      rationale: recommendation.rationale ?? null,
      strength: recommendation.strength,
    });
  }

  /** The additive `onRaised` hook, which may never break the ask that used it. */
  function notifyRaised(request: AskRequest, questionId: string): void {
    try {
      request.onRaised?.(questionId);
    } catch (error) {
      log('a question asker’s onRaised callback threw and was ignored', {
        questionId,
        error: String(error),
      });
    }
  }

  function ask(request: AskRequest): Promise<QuestionOutcome> {
    return Promise.resolve().then(() => {
      if (typeof request.prompt !== 'string' || request.prompt.trim() === '') {
        throw new InvalidRequestError('A question needs a prompt.', 'prompt');
      }

      const joined = findJoinTarget(request);
      if (joined !== undefined) {
        // §6.3: "A joined ask adds a `question_recommendations` row and resolves
        // against the *same* answer when it lands."
        if (request.recommendation !== undefined) {
          writeRecommendation(joined.id, request.recommendation);
        }
        log('an ask joined an open question card', {
          questionId: joined.id,
          assignmentId: request.assignmentId,
          sessionId: request.sessionId,
        });
        notifyRaised(request, joined.id);
        return register(joined.id);
      }

      const envelope: QuestionEnvelope = {
        ...(request.options === undefined ? {} : { options: request.options }),
        multiSelect: request.multiSelect ?? false,
        allowFreeText: request.allowFreeText ?? true,
        holdUntil: request.holdUntil,
        expiresAt: request.expiresAt,
        ...(request.context === undefined ? {} : { context: request.context }),
        agentId: request.agentId,
      };

      const record = questions.open({
        assignmentId: request.assignmentId,
        sessionId: request.sessionId,
        kind: request.kind,
        prompt: request.prompt,
        options: envelope,
        createdAt: now(),
      });

      if (request.recommendation !== undefined) {
        writeRecommendation(record.id, request.recommendation);
      }

      notifyRaised(request, record.id);

      const card = cardOf(record);
      bus.emit({
        type: 'assignment.question.raised',
        ids: {
          assignmentId: record.assignmentId,
          ...(card.projectId === null ? {} : { projectId: card.projectId }),
          ...(record.sessionId === null ? {} : { sessionId: record.sessionId }),
          agentId: request.agentId,
        },
        persist: true,
        payload: {
          questionId: record.id,
          kind: record.kind,
          prompt: record.prompt,
          options: card.options,
          recommendationCount: card.recommendations.length,
          disagreement: card.disagreement,
          contested: card.contested,
          holdUntil: card.holdUntil,
          expiresAt: card.expiresAt,
        },
      });

      return register(record.id);
    });
  }

  function cancel(questionId: string, reason: string): Promise<void> {
    return Promise.resolve().then(() => {
      const record = questions.get(questionId);
      if (record === undefined) return;
      if (record.status === 'open') questions.cancel(questionId, now());
      settle(questionId, { status: 'cancelled', questionId, reason });
      bus.emit({
        type: 'question.cancelled',
        ids: {
          assignmentId: record.assignmentId,
          ...(record.sessionId === null ? {} : { sessionId: record.sessionId }),
        },
        // Not persisted: a cancelled card's durable record is its own row, and
        // the only live consumer is a session that is still waiting.
        persist: false,
        payload: { questionId, reason },
      });
    });
  }

  // -------------------------------------------------------------------------
  // The answer path (§6.1) — the one door, local and remote alike
  // -------------------------------------------------------------------------

  function answer(questionId: string, input: AnswerQuestionInput): QuestionCard {
    const before = requireRecord(questionId);
    if (before.status !== 'open') throw new QuestionNotOpenError(questionId, before.status);

    const value: QuestionAnswer = {
      ...(input.optionIds === undefined ? {} : { optionIds: [...input.optionIds] }),
      ...(input.labels === undefined ? {} : { labels: [...input.labels] }),
      ...(input.text === undefined ? {} : { text: input.text }),
    };
    if (
      value.optionIds === undefined &&
      value.labels === undefined &&
      (value.text === undefined || value.text.trim() === '')
    ) {
      throw new InvalidRequestError(
        'An answer needs at least one option id or some text.',
        'optionIds',
      );
    }

    const at = input.at ?? now();
    const record = questions.answer(questionId, {
      answer: value,
      answeredVia: input.answeredVia,
      at,
    });
    const card = cardOf(record);

    const latencyMs = Math.max(0, new Date(at).getTime() - new Date(record.createdAt).getTime());
    const ids = {
      assignmentId: record.assignmentId,
      ...(card.projectId === null ? {} : { projectId: card.projectId }),
      ...(record.sessionId === null ? {} : { sessionId: record.sessionId }),
    };

    // §11.4's persisted lifecycle event — what the UI replays.
    bus.emit({
      type: 'assignment.question.answered',
      ids,
      persist: true,
      payload: {
        questionId,
        answeredVia: input.answeredVia,
        latencyMs,
        decision: value,
        kind: record.kind,
      },
    });
    // The cross-element trigger runner keys on, both inline (§5.2) and after a
    // restart (§9.2). Not persisted: the row is its durable record, and the
    // persisted twin above already carries the same facts for replay.
    bus.emit({
      type: 'question.answered',
      ids,
      persist: false,
      payload: {
        questionId,
        assignmentId: record.assignmentId,
        sessionId: record.sessionId,
        kind: record.kind,
        answer: value,
        answeredVia: input.answeredVia,
        answeredAt: at,
      },
    });

    // Resolve the in-process promise **after** the events, so a subscriber that
    // reads the row sees the answer already committed either way round.
    settle(questionId, {
      status: 'answered',
      questionId,
      answer: value,
      answeredVia: input.answeredVia,
      answeredAt: at,
    });

    return card;
  }

  // -------------------------------------------------------------------------
  // §6.5 — expiry
  // -------------------------------------------------------------------------

  function sweepExpired(): ExpirySweepResult {
    const expired: string[] = [];
    const closedAssignments: { assignmentId: string; reason: string }[] = [];
    const haltedAssignments: string[] = [];
    const at = now();
    const nowMs = clock().getTime();

    for (const record of questions.listOpen()) {
      if (new Date(expiryOf(record)).getTime() > nowMs) continue;

      questions.expire(record.id, at);
      expired.push(record.id);
      settle(record.id, { status: 'expired', questionId: record.id });

      bus.emit({
        type: 'question.expired',
        ids: {
          assignmentId: record.assignmentId,
          ...(record.sessionId === null ? {} : { sessionId: record.sessionId }),
        },
        // Persisted: runner reacts to it, and a restart between the flip and the
        // reaction must still be able to replay what happened.
        persist: true,
        payload: {
          questionId: record.id,
          kind: record.kind,
          assignmentId: record.assignmentId,
          sessionId: record.sessionId,
        },
      });

      // §6.5's per-kind consequences. Fail closed is the only defensible default
      // for something whose whole purpose is a human check.
      if (record.kind === 'approval_gate') {
        options.onExpiredGate?.(record.assignmentId, 'gate_expired');
        closedAssignments.push({ assignmentId: record.assignmentId, reason: 'gate_expired' });
      } else if (record.kind === 'budget_halt') {
        options.onExpiredBudget?.(record.assignmentId);
        closedAssignments.push({ assignmentId: record.assignmentId, reason: 'budget_exhausted' });
      } else if (assignments.get(record.assignmentId)?.status === 'open') {
        // "An expired plain `question` leaves the assignment `halted` with
        // `haltReason: question_expired`, so the user can still revive it."
        assignments.setPhase(record.assignmentId, 'halted', 'question_expired');
        haltedAssignments.push(record.assignmentId);
      }
    }

    if (expired.length > 0) {
      log('questions aged out and were expired', { count: expired.length });
    }
    return { expired, closedAssignments, haltedAssignments };
  }

  // -------------------------------------------------------------------------

  return {
    ask,
    cancel,

    answer,

    get: (questionId) => cardOf(requireRecord(questionId)),

    list(query = {}) {
      const records =
        query.status === 'open'
          ? questions.listOpen({
              ...(query.assignmentId === undefined ? {} : { assignmentId: query.assignmentId }),
              ...(query.limit === undefined ? {} : { limit: query.limit }),
            })
          : query.assignmentId === undefined
            ? listAll(questions)
            : questions.listByAssignment(query.assignmentId);

      const filtered =
        query.status === undefined
          ? records
          : records.filter((record) => record.status === query.status);
      // §11.1: "ordering is newest first".
      const ordered = [...filtered].sort((a, b) =>
        a.createdAt === b.createdAt
          ? b.id.localeCompare(a.id)
          : b.createdAt.localeCompare(a.createdAt),
      );
      return (query.limit === undefined ? ordered : ordered.slice(0, query.limit)).map(cardOf);
    },

    addRecommendation(questionId, recommendation) {
      const record = requireRecord(questionId);
      writeRecommendation(record.id, recommendation);
      return cardOf(requireRecord(questionId));
    },

    sweepExpired,

    cancelForAssignment(assignmentId, reason) {
      for (const record of questions.listOpen({ assignmentId })) {
        void cancel(record.id, reason);
      }
    },

    pendingCount: () => pending.size,
  };

  /** Every question, when no assignment filter narrows the read. */
  function listAll(repository: QuestionsRepository): readonly QuestionRecord[] {
    const seen = new Map<string, QuestionRecord>();
    for (const record of repository.listOpen()) seen.set(record.id, record);
    for (const assignment of assignments.list()) {
      for (const record of repository.listByAssignment(assignment.id)) seen.set(record.id, record);
    }
    return [...seen.values()];
  }
}

/**
 * §6.3's normalisation: "case-folded, whitespace-collapsed, punctuation-stripped,
 * first 200 chars".
 *
 * Exported because the join rule is the one place a *silent* wrong answer could
 * be produced, so it is tested directly rather than only through `ask()`.
 */
export function normalisePrompt(prompt: string): string {
  return prompt
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 200);
}

/** The option **id set**, order-insensitive — §6.3's "option id sets are equal". */
function optionKey(options: readonly QuestionOption[] | undefined): string {
  return [...new Set((options ?? []).map((option) => option.id))].sort().join(' ');
}
