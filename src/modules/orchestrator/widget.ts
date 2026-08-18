/**
 * The glanceable projection — DESIGN §11.5.
 *
 * `GET /api/widget` answers "is anything waiting on me?" in one request, for the
 * client that can afford exactly one: an iOS Home Screen widget gets a few
 * seconds and a single round trip before it draws whatever it has.
 *
 * ## Everything here is read, nothing is derived
 *
 * §11.5: "a projection, not a fifteenth source of truth". The two inputs are
 * §11.3's {@link FleetStatus} and §6's inbox — the same readers
 * `GET /api/orchestrator/status` and `GET /api/questions` serve. `agents` is a
 * *tally* of the six words {@link stateOf} already assigned, which is what makes
 * "the widget and the board cannot disagree about whether an agent is working"
 * true by construction rather than by two implementations happening to match.
 * Runner is not consulted at all: every count this payload carries is already in
 * the fleet reader's answer.
 *
 * The three fields the feed adds are the three a phone cannot cheaply compute:
 *
 * - **`agentName`** — the card carries `assignmentId` and `sessionId`, never an
 *   agent, and never a display name. {@link askerOf} resolves it the only way
 *   the data supports: the session's `agent_id` when the question came from a
 *   session, otherwise the assignment's seat when there is exactly one. Two
 *   seats and no session is genuinely ambiguous, and `null` says so rather than
 *   naming whichever member sorted first.
 * - **`waitingSec`** — computed here against the service clock, because the
 *   alternative is a phone subtracting `createdAt` from its own clock, and that
 *   is the one number on the widget that can render negative.
 * - **`waitingTotal`** — taken *before* the slice, so a cap the client cannot
 *   see never reads as "all of them".
 */
import type { Clock, SessionsRepository } from '../../storage/index.js';

import type { RosterPort } from './ports.js';
import type { QuestionCard, QuestionInbox } from './questions.js';
import type { MemberRow } from './repository.js';
import type { FleetState, FleetStatus } from './status.js';

/** One row of §11.5's `waiting` — a question with a face and an age on it. */
export interface WaitingItem {
  readonly id: string;
  readonly kind: QuestionCard['kind'];
  /** The asking agent's display name; its id when roster cannot name it, `null` when it is ambiguous. */
  readonly agentName: string | null;
  readonly prompt: string;
  readonly createdAt: string;
  /** Whole seconds since `createdAt`, floored at 0 — never negative, whatever the clocks did. */
  readonly waitingSec: number;
  readonly contested: boolean;
}

export interface WidgetFeed {
  readonly generatedAt: string;
  readonly waiting: readonly WaitingItem[];
  /** How many were open before `maxWaiting` truncated the list. */
  readonly waitingTotal: number;
  readonly oldestWaitingSec: number | null;
  readonly agents: Readonly<Record<FleetStateKey, number>>;
  readonly assignments: FleetStatus['assignments'];
}

/** §16-6's six words, camel-cased for JSON. */
type FleetStateKey = 'working' | 'queued' | 'awaitingUser' | 'paused' | 'halted' | 'idle';

const STATE_KEYS: Readonly<Record<FleetState, FleetStateKey>> = {
  halted: 'halted',
  awaiting_user: 'awaitingUser',
  working: 'working',
  queued: 'queued',
  paused: 'paused',
  idle: 'idle',
};

export interface WidgetFeedOptions {
  /** §11.3's reader, called once per request — never re-implemented here. */
  readonly fleetStatus: () => FleetStatus;
  /** Probed the way every other orchestrator reader probes it: absent means no questions, not a throw. */
  readonly inbox: () => QuestionInbox | undefined;
  readonly sessions: SessionsRepository;
  readonly members: (assignmentId: string) => readonly MemberRow[];
  readonly roster?: (() => RosterPort | undefined) | undefined;
  readonly clock: Clock;
  readonly config: { readonly maxWaiting: number; readonly promptChars: number };
}

export function createWidgetFeedReader(options: WidgetFeedOptions): () => WidgetFeed {
  const { fleetStatus, inbox, sessions, members, clock, config } = options;

  return function widgetFeed(): WidgetFeed {
    const now = clock();
    const fleet = fleetStatus();

    const agents: Record<FleetStateKey, number> = {
      working: 0,
      queued: 0,
      awaitingUser: 0,
      paused: 0,
      halted: 0,
      idle: 0,
    };
    for (const agent of fleet.agents) agents[STATE_KEYS[agent.state]] += 1;

    // Oldest first: an agent parked on a question is doing nothing until it is
    // answered, so age is the ranking a human actually wants (§11.5). The inbox
    // orders newest first, which is the inbox screen's order, not this one's.
    const open = [...(inbox()?.list({ status: 'open' }) ?? [])].sort((a, b) =>
      a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0,
    );

    const waiting = open
      .slice(0, Math.max(0, config.maxWaiting))
      .map((card) => toWaitingItem(card, now, config.promptChars, askerOf(card)));

    return {
      generatedAt: now.toISOString(),
      waiting,
      waitingTotal: open.length,
      oldestWaitingSec: open.length === 0 ? null : secondsSince(open[0]!.createdAt, now),
      agents,
      assignments: fleet.assignments,
    };
  };

  /**
   * Who is asking. The session's agent when there is a session, the assignment's
   * lone seat when there is not, and `null` when neither answers — a budget halt
   * raised against a two-seat assignment has no single asker, and inventing one
   * would put a name on the widget that nothing in the data supports.
   */
  function askerOf(card: QuestionCard): string | null {
    const fromSession = card.sessionId === null ? undefined : sessions.get(card.sessionId)?.agentId;
    if (fromSession !== undefined) return nameOf(fromSession);

    const seats = members(card.assignmentId);
    return seats.length === 1 ? nameOf(seats[0]!.agentId) : null;
  }

  /** Roster's display name, falling back to the id — an id is a worse label, never a wrong one. */
  function nameOf(agentId: string): string {
    const roster = options.roster?.();
    const definition = roster?.registry.get(agentId) ?? roster?.registry.getArchived(agentId);
    return definition?.definition.name ?? agentId;
  }
}

function toWaitingItem(
  card: QuestionCard,
  now: Date,
  promptChars: number,
  agentName: string | null,
): WaitingItem {
  return {
    id: card.id,
    kind: card.kind,
    agentName,
    prompt: clip(card.prompt, promptChars),
    createdAt: card.createdAt,
    waitingSec: secondsSince(card.createdAt, now),
    contested: card.contested,
  };
}

/** Clipped on a character budget, with an ellipsis so a truncated prompt reads as truncated. */
function clip(text: string, limit: number): string {
  const max = Math.max(1, limit);
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function secondsSince(iso: string, now: Date): number {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 0;
  return Math.max(0, Math.floor((now.getTime() - then) / 1000));
}
