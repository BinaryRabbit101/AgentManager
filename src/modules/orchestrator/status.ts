/**
 * Fleet status — DESIGN §11.3, §16-6, IMPLEMENTATION M9-1.
 *
 * `GET /api/orchestrator/status` answers "what is every agent doing", "derived
 * from `assignments` + `assignment_turns` joined to runner's sessions through
 * foundation's repositories". Nothing here calls runner, and nothing here
 * recomputes a fact another element owns: the session's status is runner's, the
 * assignment's phase is this element's, and the join is all this file adds.
 *
 * ## The six words are a contract, not a rendering
 *
 * §16-6 pins the vocabulary `idle | queued | working | awaiting_user | paused |
 * halted`, and ui reads exactly these (`web/src/board/fleetStatus.ts` derives
 * the same six from `session.*` events until this endpoint lands, and its own
 * header says the swap is "changing what that one accessor calls"). So the
 * mapping below is stated once, in rank order, and the rank matters:
 *
 * 1. **The assignment's phase wins over the session's status** where they
 *    disagree. A `halted` assignment whose last session is still finishing is
 *    `halted` — the human has something to do about it, and that is what the
 *    pill is for. A session that is *running* under an assignment awaiting a
 *    budget answer is likewise `awaiting_user`.
 * 2. Otherwise the live session decides: `queued` → queued, `running` →
 *    working, `paused` → `awaiting_user` when runner parked it on a question or
 *    a budget halt (its `exit_reason` says which), `paused` otherwise.
 * 3. Otherwise `idle`. An agent with no open assignment and no live session is
 *    not doing anything, and saying so is the honest answer.
 *
 * An agent holding seats in two assignments reports the *busiest* one by that
 * same rank, because the card asks "what is this agent doing" and the answer a
 * human needs is the one that might need them.
 */
import type { SessionRecord, SessionsRepository, SessionStatus } from '../../storage/index.js';

import { hasOverseerRoster, type RosterPort } from './ports.js';
import type { QuestionInbox } from './questions.js';
import type { AssignmentRepository, AssignmentRow } from './repository.js';
import type { TurnRepository } from './turns.js';

/** §16-6's vocabulary, in the rank order the join resolves ties by. */
export const FLEET_STATES = [
  'halted',
  'awaiting_user',
  'working',
  'queued',
  'paused',
  'idle',
] as const;

export type FleetState = (typeof FLEET_STATES)[number];

export interface AgentStatus {
  readonly agentId: string;
  readonly state: FleetState;
  readonly assignmentId: string | null;
  readonly sessionId: string | null;
  /**
   * Additive to §11.3's shape, and deliberate: ui's `AgentFleetStatus`
   * (`web/src/api/types.ts`) carries `projectId` on every entry, and the board
   * links the pill to the project. Omitting it would mean the endpoint the UI
   * was told to swap to serves less than the degraded derivation it replaces.
   */
  readonly projectId: string | null;
  readonly role: string | null;
  readonly headline: string | null;
  readonly since: string | null;
}

export interface FleetStatus {
  readonly agents: readonly AgentStatus[];
  readonly assignments: {
    readonly open: number;
    readonly halted: number;
    readonly awaitingUser: number;
  };
  readonly questions: { readonly open: number; readonly oldestOpenedAt: string | null };
}

export interface FleetStatusOptions {
  readonly repository: AssignmentRepository;
  readonly turns: TurnRepository;
  readonly sessions: SessionsRepository;
  readonly inbox: () => QuestionInbox | undefined;
  /**
   * Roster, so an agent that is doing *nothing* still appears as `idle`.
   *
   * Probed: without it the reply carries only agents with work, which the UI's
   * accessor already reads as idle by default — a smaller answer, never a wrong
   * one.
   */
  readonly roster?: (() => RosterPort | undefined) | undefined;
}

/** Statuses that mean the session is still alive (§11.3's join). */
const LIVE: readonly SessionStatus[] = ['queued', 'running', 'paused'];

export function createFleetStatusReader(options: FleetStatusOptions): () => FleetStatus {
  const { repository, turns, sessions } = options;

  return function fleetStatus(): FleetStatus {
    const open = repository.list({ status: 'open' });
    const byAgent = new Map<string, AgentStatus>();

    for (const row of open) {
      for (const member of repository.listMembers(row.id)) {
        const candidate = statusFor(row, member.agentId, member.role);
        const held = byAgent.get(member.agentId);
        if (held === undefined || rankOf(candidate.state) < rankOf(held.state)) {
          byAgent.set(member.agentId, candidate);
        }
      }
    }

    // Every other agent the roster knows: present, and plainly idle.
    const roster = options.roster?.();
    if (hasOverseerRoster(roster)) {
      for (const entry of roster.overseerRoster()) {
        if (byAgent.has(entry.id)) continue;
        byAgent.set(entry.id, {
          agentId: entry.id,
          state: 'idle',
          assignmentId: null,
          sessionId: null,
          projectId: null,
          role: null,
          headline: null,
          since: null,
        });
      }
    }

    const cards = options.inbox()?.list({ status: 'open' }) ?? [];
    const oldest = cards.reduce<string | null>(
      (earliest, card) =>
        earliest === null || card.createdAt < earliest ? card.createdAt : earliest,
      null,
    );

    return {
      agents: [...byAgent.values()].sort((a, b) => a.agentId.localeCompare(b.agentId)),
      assignments: {
        open: open.length,
        halted: open.filter((row) => row.phase === 'halted').length,
        awaitingUser: open.filter((row) => row.phase === 'awaiting_user').length,
      },
      questions: { open: cards.length, oldestOpenedAt: oldest },
    };
  };

  function statusFor(row: AssignmentRow, agentId: string, role: string): AgentStatus {
    const live = sessions
      .list({ assignmentId: row.id, agentId })
      .find((session) => (LIVE as readonly string[]).includes(session.status));
    const turn = turns
      .list(row.id)
      .filter((one) => one.agentId === agentId)
      .at(-1);
    const headline = turn?.report?.headline ?? live?.summary ?? null;

    return {
      agentId,
      state: stateOf(row, live),
      assignmentId: row.id,
      sessionId: live?.id ?? turn?.sessionId ?? null,
      projectId: row.projectId,
      role,
      headline,
      since: live?.startedAt ?? turn?.startedAt ?? row.updatedAt ?? row.createdAt,
    };
  }
}

/** Rule 1 then rule 2 of the header's rank, in that order and nowhere else. */
function stateOf(row: AssignmentRow, live: SessionRecord | undefined): FleetState {
  if (row.phase === 'halted') return 'halted';
  if (row.phase === 'awaiting_user') return 'awaiting_user';
  if (live === undefined) return 'idle';
  switch (live.status) {
    case 'queued':
      return 'queued';
    case 'running':
      return 'working';
    case 'paused':
      // runner §11.1: a park on a question is `paused` with
      // `exit_reason: awaiting_answer`, and it is the one pause the user has to
      // do something about — so it reads as `awaiting_user`, not `paused`.
      return live.exitReason === 'awaiting_answer' || live.exitReason === 'budget_halt'
        ? 'awaiting_user'
        : 'paused';
    default:
      return 'idle';
  }
}

function rankOf(state: FleetState): number {
  return FLEET_STATES.indexOf(state);
}
