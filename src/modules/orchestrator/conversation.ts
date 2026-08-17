/**
 * `GET /api/assignments/:id/conversation` — DESIGN §11.2, IMPLEMENTATION M6-6.
 *
 * "The single read the UI's 'collaborations render as a readable conversation'
 * requirement needs: an ordered merge of turns and messages for one assignment."
 * It exists before the UI does because the M6 acceptance is stated in terms of
 * it — "the conversation endpoint renders six turns and the handoffs in order" —
 * and because a human reading a pair through the API is how the slice is judged
 * without a screen.
 *
 * Two rules keep it honest:
 *
 * - **Excerpts, never a second copy of the transcript.** Every turn carries its
 *   `sessionId`; the full record is runner's
 *   `GET /api/sessions/:id/transcript`. What is inlined here is bounded by
 *   `orchestrator.prompt.excerptBytes`.
 * - **Messages carry `delivery`,** because "I sent it and they ignored me" and
 *   "I sent it and they never saw it" are different failures and only one of them
 *   is the agent's fault (§5.1).
 *
 * Ordering inside a round is by timestamp with a deterministic tie-break, so two
 * reads of the same assignment always produce the same document — a conversation
 * view that reshuffles under a refresh is unreadable.
 */
import type { OrchestratorConfig } from './config.js';
import { AssignmentNotFoundError } from './errors.js';
import type { Delivery, MailboxRepository, MessageView } from './messages.js';
import { sliceUtf8 } from './prompt.js';
import type { QuestionCard, QuestionInbox, RecommendationView } from './questions.js';
import type { AssignmentRepository } from './repository.js';
import type { TurnReport, TurnRepository, TurnStatus } from './turns.js';

export interface ConversationTurnEntry {
  readonly type: 'turn';
  readonly seat: string;
  readonly agentId: string;
  readonly role: string | null;
  readonly sessionId: string | null;
  readonly status: TurnStatus;
  readonly report: TurnReport | null;
  readonly excerpt: string | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  /** Present when this turn re-ran a seat that produced no report (§3.3). */
  readonly retryOfTurnId: string | null;
  readonly turnId: string;
}

export interface ConversationMessageEntry {
  readonly type: 'message';
  readonly messageId: string;
  readonly from: string | null;
  readonly to: string | null;
  readonly kind: string;
  readonly body: string | null;
  readonly delivery: Delivery;
  readonly createdAt: string;
}

export interface ConversationQuestionEntry {
  readonly type: 'question';
  readonly questionId: string;
  readonly kind: string;
  readonly prompt: string;
  readonly recommendations: readonly RecommendationView[];
  readonly disagreement: boolean;
  readonly contested: boolean;
  readonly answer: QuestionCard['answer'];
  readonly createdAt: string;
}

export type ConversationEntry =
  ConversationTurnEntry | ConversationMessageEntry | ConversationQuestionEntry;

export interface ConversationRound {
  readonly round: number;
  readonly entries: readonly ConversationEntry[];
}

export interface ConversationView {
  readonly assignmentId: string;
  readonly pattern: string;
  readonly phase: string;
  readonly status: string;
  readonly artifactPath: string | null;
  readonly roundsUsed: number;
  readonly roundCap: number | null;
  readonly tokensUsed: number;
  readonly tokenBudget: number | null;
  readonly closeReason: string | null;
  readonly haltReason: string | null;
  readonly rounds: readonly ConversationRound[];
}

export interface ConversationReaderOptions {
  readonly repository: AssignmentRepository;
  readonly turns: TurnRepository;
  readonly mailbox: MailboxRepository;
  readonly inbox: () => QuestionInbox | undefined;
  readonly config: OrchestratorConfig;
}

export function createConversationReader(
  options: ConversationReaderOptions,
): (assignmentId: string) => ConversationView {
  const { repository, turns, mailbox, config } = options;

  return function conversation(assignmentId: string): ConversationView {
    const row = repository.get(assignmentId);
    if (row === undefined) throw new AssignmentNotFoundError(assignmentId);

    const roles = new Map(
      repository.listMembers(assignmentId).map((member) => [member.agentId, member.role]),
    );
    const turnRows = turns.list(assignmentId);
    const messages = mailbox.listByAssignment(assignmentId);
    const cards = options.inbox()?.list({ assignmentId }) ?? [];

    // A round is the unit the pair is read in; entries with no round of their own
    // — mail and cards — are filed against the round that was in flight when they
    // were created, which is the last turn started at or before them.
    const rounds = new Map<number, ConversationEntry[]>();
    const roundOf = (at: string): number => {
      let round = turnRows[0]?.round ?? 1;
      for (const turn of turnRows) {
        if (turn.startedAt !== null && turn.startedAt <= at) round = turn.round;
      }
      return round;
    };
    const push = (round: number, entry: ConversationEntry): void => {
      const list = rounds.get(round) ?? [];
      list.push(entry);
      rounds.set(round, list);
    };

    for (const turn of turnRows) {
      push(turn.round, {
        type: 'turn',
        turnId: turn.id,
        seat: turn.seat,
        agentId: turn.agentId,
        role: roles.get(turn.agentId) ?? null,
        sessionId: turn.sessionId,
        status: turn.status,
        report: turn.report,
        excerpt:
          turn.outputText === null ? null : sliceUtf8(turn.outputText, config.prompt.excerptBytes),
        startedAt: turn.startedAt,
        endedAt: turn.endedAt,
        retryOfTurnId: turn.retryOfTurnId,
      });
    }

    for (const message of messages) push(roundOf(message.createdAt), messageEntry(message));

    for (const card of cards) {
      push(roundOf(card.createdAt), {
        type: 'question',
        questionId: card.id,
        kind: card.kind,
        prompt: card.prompt,
        recommendations: card.recommendations,
        disagreement: card.disagreement,
        contested: card.contested,
        answer: card.answer,
        createdAt: card.createdAt,
      });
    }

    return {
      assignmentId: row.id,
      pattern: row.pattern,
      phase: row.phase,
      status: row.status,
      artifactPath: row.artifactPath,
      roundsUsed: row.roundsUsed,
      roundCap: row.roundCap,
      tokensUsed: row.tokensUsed,
      tokenBudget: row.tokenBudget,
      closeReason: row.closeReason,
      haltReason: row.haltReason,
      rounds: [...rounds.entries()]
        .sort(([a], [b]) => a - b)
        .map(([round, entries]) => ({ round, entries: [...entries].sort(byTime) })),
    };
  };
}

function messageEntry(message: MessageView): ConversationMessageEntry {
  return {
    type: 'message',
    messageId: message.id,
    from: message.fromAgentId,
    to: message.toAgentId,
    kind: message.kind,
    body: message.body,
    delivery: message.delivery,
    createdAt: message.createdAt,
  };
}

/**
 * Chronological, with a stable tie-break.
 *
 * Turns sort by `startedAt` and everything else by `createdAt`; equal timestamps
 * fall back to the entry kind and then the id, so a turn and the handoff it
 * produced in the same millisecond come out in the same order every time.
 */
function byTime(a: ConversationEntry, b: ConversationEntry): number {
  const at = timeOf(a);
  const bt = timeOf(b);
  if (at !== bt) return at < bt ? -1 : 1;
  if (a.type !== b.type) return a.type.localeCompare(b.type);
  return idOf(a).localeCompare(idOf(b));
}

function timeOf(entry: ConversationEntry): string {
  return entry.type === 'turn' ? (entry.startedAt ?? '') : entry.createdAt;
}

function idOf(entry: ConversationEntry): string {
  switch (entry.type) {
    case 'turn':
      return entry.turnId;
    case 'message':
      return entry.messageId;
    case 'question':
      return entry.questionId;
  }
}
