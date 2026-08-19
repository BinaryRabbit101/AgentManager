/**
 * The collaboration view, as data (DESIGN §10.2; IMPLEMENTATION §9).
 *
 * Everything the assignment screen *decides* lives here — the words for a
 * phase, a delivery state and a turn status, the seat a turn belongs to, the
 * round pips, and the budget line. The React half renders it.
 *
 * The rule this file exists to keep: **nothing is derived that the server
 * computes** (§4, §18 decision 10). `phase`, `roundsUsed`, `tokensUsed`,
 * `disagreement`, `contested` and the entry order are all read. What is
 * computed here is only *presentation*: which word stands for a value, and how
 * a count reads in English.
 */

import type {
  AssignmentPhase,
  AssignmentView,
  ConversationEntry,
  ConversationTurnEntry,
  ConversationView,
  MessageDelivery,
  TurnStatus,
} from '../api/types';

/**
 * §10.2: the phase is "rendered as words with a matching colour".
 *
 * The colour is a `data-phase` attribute in the stylesheet; the word is here,
 * and it is the only carrier of meaning (§15: "colour is never the only
 * signal").
 */
export const PHASE_WORDS: Readonly<Record<AssignmentPhase, string>> = Object.freeze({
  planned: 'planned',
  running: 'running',
  awaiting_user: 'waiting for you',
  halted: 'halted',
  converged: 'converged',
  closed: 'closed',
});

export function phaseWord(phase: AssignmentPhase): string {
  return PHASE_WORDS[phase] ?? phase;
}

/**
 * §10.2's delivery ladder, spelled out — and the one word that depends on more
 * than the value.
 *
 * > "Message entries show `inlined`, `read` and **`undelivered`** distinctly;
 * > the undelivered case is labelled as never seen by the recipient."
 *
 * That last clause is only true once there is no next turn left. orchestrator
 * §5.1 delivers mail at the recipient's *launch*, so on an **open** assignment
 * `undelivered` means "not yet, and here is who has to take a turn first" —
 * calling it "never seen" while the pair is still running says a working
 * mechanism is broken, which is exactly how it read in the field.
 *
 * So the words below are the **settled** ones, for a message whose fate is
 * decided, and `deliveryWord` swaps in the waiting sentence while a turn can
 * still deliver it. orchestrator's fourth value, `undeliverable` — an
 * `undelivered` message on an assignment that has since closed — is the same
 * failure with the finality said out loud. "I sent it and they ignored me" and
 * "I sent it and they never saw it" are different failures (orchestrator §16.5),
 * and now so is "I sent it and they have not had their turn yet".
 */
export const DELIVERY_WORDS: Readonly<Record<MessageDelivery, string>> = Object.freeze({
  inlined: 'inlined into their next turn',
  read: 'read by the recipient',
  undelivered: 'never seen by the recipient',
  undeliverable: 'never seen by the recipient — the assignment closed first',
});

/**
 * What the view knows about a message beyond its delivery value.
 *
 * Both fields are already on the screen — the assignment header carries the
 * status and the message row names its recipient — so nothing here is derived
 * from anything the server did not send (§4, §18 decision 10), and there is no
 * new API surface behind this label.
 */
export interface DeliveryContext {
  /** `true` while the assignment is `open`: another turn can still deliver it. */
  readonly assignmentOpen: boolean;
  /** The recipient's name as the row shows it; `null` for a broadcast. */
  readonly recipientName: string | null;
}

export function deliveryWord(delivery: MessageDelivery, context: DeliveryContext): string {
  if (delivery === 'undelivered' && context.assignmentOpen)
    return waitingWord(context.recipientName);
  return DELIVERY_WORDS[delivery] ?? delivery;
}

/**
 * The pending label, which names *whose* turn the message is waiting on.
 *
 * The name is what makes it actionable: "waiting" alone leaves the user
 * wondering what has to happen, and the answer is always "that seat's next
 * launch". A broadcast has no single recipient, so it waits on all of them.
 */
function waitingWord(recipientName: string | null): string {
  const whose = recipientName === null ? 'each recipient’s' : `${recipientName}’s`;
  return `waiting — delivered at ${whose} next turn`;
}

/**
 * `true` only when the recipient will never read it.
 *
 * The screen marks this state as a problem, so a message that is merely waiting
 * for its recipient's next turn must not carry the mark — a warning on the
 * happy path is a warning nobody reads.
 */
export function isUnseen(delivery: MessageDelivery, context: DeliveryContext): boolean {
  if (delivery === 'undelivered') return !context.assignmentOpen;
  return delivery === 'undeliverable';
}

/**
 * §10.2: "Turn status is shown when it is **not** the happy path."
 *
 * `reported` and `running` return `undefined` — a chip saying "this went fine"
 * on every row is noise that hides the one row that did not.
 */
export function turnStatusNote(turn: ConversationTurnEntry): string | undefined {
  const status: TurnStatus = turn.status;
  switch (status) {
    case 'unstructured':
      return 'finished without a structured report';
    case 'blocked':
      return 'waiting on a decision';
    case 'failed':
      return 'failed';
    case 'orphaned':
      return 'orphaned — the core stopped while it was running';
    case 'planned':
      return 'not started yet';
    default:
      return undefined;
  }
}

/**
 * Who spoke, as §10.2 renders it: *"Sam · skeptic"*.
 *
 * The seat is included because in a pair the same agent could in principle hold
 * either seat across assignments, and the seat is what the conversation is
 * about. `agentName` is looked up by the caller from the roster; when the agent
 * has been deleted the id stands in, exactly as the board does for a session
 * referencing a deleted agent (§5.2).
 */
export function attribution(
  turn: ConversationTurnEntry,
  agentName: string | undefined,
): { readonly name: string; readonly seat: string; readonly line: string } {
  const name = agentName ?? turn.agentId;
  // The seat is the structural fact; the role is the agent's own word for it.
  const seat = turn.role ?? turn.seat;
  return { name, seat, line: `${name} · ${seat}` };
}

/**
 * §10.2's round pips: `Round 2 of 3` as discrete marks.
 *
 * `done` counts the rounds the server says are used; `cap` is its cap. With no
 * cap (a solo assignment, or a pattern that declares none) there is nothing to
 * pip — a progress bar with no end is a lie about progress — and the caller
 * renders the plain count instead.
 */
export function roundPips(
  roundsUsed: number,
  roundCap: number | null,
): readonly { readonly index: number; readonly done: boolean }[] {
  if (roundCap === null || roundCap <= 0) return [];
  return Array.from({ length: roundCap }, (_unused, index) => ({
    index: index + 1,
    done: index < roundsUsed,
  }));
}

/**
 * The budget line, in **tokens** (§10.2, orchestrator §16.8).
 *
 * There is no currency in this view at all, and IMPLEMENTATION §9 asserts it
 * over the rendered output — so this function returns tokens or it returns
 * nothing, and there is no second formatter to reach for.
 */
export function budgetLine(
  tokensUsed: number,
  tokenBudget: number | null,
): { readonly text: string; readonly fraction: number | null } {
  const used = formatTokens(tokensUsed);
  if (tokenBudget === null || tokenBudget <= 0) {
    return { text: `${used} tokens used · no budget set`, fraction: null };
  }
  const remaining = Math.max(0, tokenBudget - tokensUsed);
  return {
    text: `${used} of ${formatTokens(tokenBudget)} tokens · ${formatTokens(remaining)} left`,
    fraction: Math.min(1, tokensUsed / tokenBudget),
  };
}

/** Thousands separated, never abbreviated: a token count is a number, not a size. */
export function formatTokens(value: number): string {
  return new Intl.NumberFormat('en-GB').format(Math.max(0, Math.round(value)));
}

/**
 * §10.3: "A solo assignment is not a special case."
 *
 * One member, no rounds, no convergence — the same view, with the round strip
 * absent because there is nothing for it to say. This is a rendering question
 * only; there is no second code path.
 */
export function isSolo(assignment: Pick<AssignmentView, 'pattern' | 'members'>): boolean {
  return assignment.pattern === 'solo' || assignment.members.length <= 1;
}

/**
 * Which seats to show in the header, in the server's `seatOrder`.
 *
 * Sorted by `seatOrder` rather than by array position because §10.2 puts the
 * lead seat first and orchestrator is what decides which that is.
 */
export function seatsOf(assignment: AssignmentView): readonly AssignmentView['members'][number][] {
  return [...assignment.members].sort((left, right) => left.seatOrder - right.seatOrder);
}

/**
 * The banner a halted or awaiting-user assignment carries (§10.2).
 *
 * Both name the reason and both link to a card, because both are resolved by
 * answering something in the inbox. A converged one gets the completion summary
 * instead. Anything else gets nothing — a banner on the happy path is a banner
 * nobody reads.
 */
export interface AssignmentBanner {
  readonly tone: 'warn' | 'danger' | 'ok';
  readonly heading: string;
  readonly detail: string;
  /** `true` when the inbox is where this is resolved (§10.2). */
  readonly linkToQuestions: boolean;
}

export function bannerFor(assignment: AssignmentView): AssignmentBanner | undefined {
  if (assignment.phase === 'halted') {
    return {
      tone: 'danger',
      heading: `Halted — ${haltWord(assignment.haltReason)}`,
      detail: 'Answer the card that resolves it, or close the assignment.',
      linkToQuestions: true,
    };
  }
  if (assignment.phase === 'awaiting_user') {
    return {
      tone: 'warn',
      heading: 'Waiting for your answer',
      detail: 'Nothing moves until the card in the inbox is answered.',
      linkToQuestions: true,
    };
  }
  if (assignment.phase === 'converged') {
    return {
      tone: 'ok',
      heading: 'Converged',
      detail:
        assignment.artifactPath === null
          ? 'The seats agreed and the assignment closed.'
          : `The seats agreed. The artifact is ${assignment.artifactPath}.`,
      linkToQuestions: false,
    };
  }
  return undefined;
}

/** orchestrator's halt reasons, as sentences. The code is never shown alone. */
export function haltWord(reason: string | null): string {
  switch (reason) {
    case 'turn_failures':
      return 'too many turns failed in a row';
    case 'no_report':
      return 'a turn finished without a report';
    case 'no_progress':
      return 'the rounds stopped making progress';
    case 'permission_fight':
      return 'the same permission was refused repeatedly';
    case 'tool_flood':
      return 'a turn made an implausible number of tool calls';
    case 'stale':
      return 'nothing has happened for too long';
    case 'question_expired':
      return 'a question expired unanswered';
    case null:
      return 'no reason recorded';
    default:
      return reason;
  }
}

/** orchestrator's close reasons, as sentences, for the closed-assignment line. */
export function closeWord(reason: string | null): string {
  switch (reason) {
    case 'converged':
      return 'the seats agreed';
    case 'round_cap':
      return 'the round cap was reached';
    case 'budget_exhausted':
      return 'the token budget ran out';
    case 'user_closed':
      return 'you closed it';
    case 'gate_denied':
      return 'an approval gate was denied';
    case 'gate_expired':
      return 'an approval gate expired, which is a denial';
    case 'breaker':
      return 'the circuit breaker tripped';
    case 'failed':
      return 'it failed';
    case 'project_archived':
      return 'the project was archived';
    case null:
      return 'no reason recorded';
    default:
      return reason;
  }
}

/** Every turn in the conversation, flattened — the "View full session" links. */
export function turnsOf(conversation: ConversationView): readonly ConversationTurnEntry[] {
  return conversation.rounds.flatMap((round) =>
    round.entries.filter((entry): entry is ConversationTurnEntry => entry.type === 'turn'),
  );
}

/** A stable React key for an entry, without inventing an id the server lacks. */
export function entryKey(entry: ConversationEntry): string {
  switch (entry.type) {
    case 'turn':
      return `turn-${entry.turnId}`;
    case 'message':
      return `message-${entry.messageId}`;
    case 'question':
      return `question-${entry.questionId}`;
  }
}

/**
 * Which column a turn sits in on desktop (§10.2's alternating dialogue).
 *
 * **A visual affordance only** — "the order is always the server's order". The
 * column is decided by seat so the same seat always sits on the same side; it
 * is never decided by position in the list, which would make the layout shuffle
 * when a message lands between two turns.
 */
export function seatColumn(seat: string, cardSeatOrder: readonly string[]): 'left' | 'right' {
  const index = cardSeatOrder.indexOf(seat);
  if (index >= 0) return index % 2 === 0 ? 'left' : 'right';
  return seat === 'critic' ? 'right' : 'left';
}
