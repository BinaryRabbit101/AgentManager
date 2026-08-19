/**
 * Raising an engine-authored card — DESIGN §8.2, §16-2.
 *
 * Halts, round-cap choices, approval gates and budget-raise gates are all the
 * same act: write one `questions` row, attributed to **AgentManager** rather
 * than to an agent, and never wait for the answer. Three callers need it — the
 * pattern engine, the assignment service (§9-10's create gate) and the budget
 * policy (§7.3's raise gate) — so it lives here rather than being a private
 * function of whichever one needed it first.
 *
 * Two properties are load-bearing and easy to lose in a re-implementation:
 *
 * - **Exactly one card per reason** (§8.1: "raises exactly one card"). An
 *   assignment that halts, is advanced and halts again must not accumulate
 *   identical rows in an inbox a human is trying to read, so an open card with
 *   the same marker is reused.
 * - **Never awaited.** `ask()` resolves when the *user* answers, which may be
 *   hours away. The id comes back through the additive `onRaised` hook at raise
 *   time, and the promise is deliberately dropped.
 */
import type { Clock } from '../../storage/index.js';

import type { QuestionInbox, QuestionKind, QuestionOption } from './questions.js';

/**
 * §8.2's approval gates, which block a *first turn* rather than a next one.
 *
 * One prefix for all of them because the answer path is identical whatever
 * raised it: approve → the loop is re-entered; deny → the assignment closes
 * `gate_denied`; expire → `gate_expired`, because "fail closed is the only
 * defensible default for something whose whole purpose is a human check" (§6.5).
 *
 * It lives here rather than in the engine because the *raiser* is the assignment
 * service (§9-10's create gate) and the *reader* is the engine, and a constant
 * two modules share belongs to neither of them.
 */
export const GATE_CARD_PREFIX = 'orchestrator.gate.';

/**
 * Stamps the round a tool gate belongs to onto its card — WO4 addendum §6's
 * "which seat/turn is asking", the turn half.
 *
 * The *seat* half is runner's: it holds the role at gate time and puts it on
 * the request. The *turn* is not — runner has no turn rows and orchestrator's
 * are the only place the number exists — so it is stamped here, on the way
 * through, from the session the card was raised against.
 *
 * Written as a `cardPolicy` rather than inside the inbox because that hook is
 * already "last chance to shape a card before its row is written" (§7.3), and a
 * second interception point for the same job is a second thing to keep in step.
 * Silent for a card with no session (every engine-raised one) and for a session
 * with no turn (a solo, which has no driver and therefore no turn rows).
 */
export function withAskingTurn<
  T extends { readonly sessionId: string | null; readonly context?: unknown },
>(
  turns: { findBySession(sessionId: string): { readonly round: number } | undefined } | undefined,
  request: T,
): T {
  const sessionId = request.sessionId;
  if (turns === undefined || sessionId === null || sessionId === '') return request;
  const turn = turns.findBySession(sessionId);
  if (turn === undefined) return request;
  const context = (request.context ?? {}) as Record<string, unknown>;
  return { ...request, context: { ...context, round: turn.round } };
}

/** The two answers every gate offers. There is deliberately no third. */
export const GATE_OPTIONS: readonly QuestionOption[] = [
  { id: 'approve', label: 'Approve' },
  { id: 'deny', label: 'Deny' },
];

export interface CardSpec {
  readonly kind: QuestionKind;
  readonly prompt: string;
  readonly options: readonly QuestionOption[];
  /**
   * The card's identity, carried in the envelope's `context.toolName`.
   *
   * Orchestrator's own shape rather than a new column: the engine needs to
   * recognise *its own* cards on the answer path, and a card's identity is not a
   * fact any other element reads.
   */
  readonly marker: string;
  readonly toolInput?: unknown;
}

export interface RaiseCardDeps {
  readonly inbox: QuestionInbox | undefined;
  readonly clock: Clock;
  /** `runner.question.expireHours`, read from runner's config (§12). */
  readonly expireHours: number;
  readonly log?: (message: string, detail?: Record<string, unknown>) => void;
}

/**
 * @returns the question id, or `''` when this build has no inbox to raise into.
 */
export async function raiseCard(
  deps: RaiseCardDeps,
  subject: { readonly id: string; readonly leadAgentId: string | null },
  card: CardSpec,
): Promise<string> {
  const { inbox } = deps;
  if (inbox === undefined) return '';

  const existing = inbox
    .list({ assignmentId: subject.id, status: 'open' })
    .find((open) => open.context?.toolName === card.marker);
  if (existing !== undefined) return existing.id;

  const now = deps.clock().getTime();
  let raised = '';
  void inbox
    .ask({
      // §16-2: an engine-raised card is attributed to "AgentManager", never to
      // an agent — the engine is not a session and has no seat.
      sessionId: null,
      assignmentId: subject.id,
      agentId: subject.leadAgentId ?? '',
      kind: card.kind,
      prompt: card.prompt,
      options: card.options.map((option) => ({ id: option.id, label: option.label })),
      multiSelect: false,
      allowFreeText: true,
      holdUntil: new Date(now).toISOString(),
      expiresAt: new Date(now + deps.expireHours * 3_600_000).toISOString(),
      context: {
        toolName: card.marker,
        toolInput: card.toolInput ?? { assignmentId: subject.id },
      },
      onRaised: (questionId) => {
        raised = questionId;
      },
    })
    .catch((error: unknown) => {
      deps.log?.('a card could not be raised', { assignmentId: subject.id, error: String(error) });
    });

  // `ask()` writes the row on its first microtask; one turn of the queue is all
  // that is needed to have the id, and waiting for the *answer* would hang.
  await Promise.resolve();
  await Promise.resolve();
  return raised;
}
