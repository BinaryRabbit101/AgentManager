/**
 * The board's status pill, and the one accessor it comes through
 * (DESIGN §5.2, IMPLEMENTATION §2).
 *
 * The source of truth for an agent's state is `GET /api/orchestrator/status`,
 * which returns orchestrator §16.6's **six-word vocabulary verbatim**. That
 * endpoint is orchestrator **M9** and lands *after* ui M2, so until it does the
 * same six words are derived here from the `session.*` lifecycle events the
 * global feed already carries.
 *
 * This is a deliberate degrade, not a fallback for an unresolved contract, and
 * the shape of the degrade is the important part: **the rendering, the words and
 * the tests do not change — only where the value is read.** Everything on the
 * board goes through {@link useAgentFleetStatus}; swapping to the endpoint means
 * changing what that one accessor calls and deleting {@link applySessionEvent}.
 *
 * Nothing here *derives* a vocabulary the server owns: the six words are
 * orchestrator's, quoted, and the mapping below is from runner's own closed
 * status/`exit_reason` sets (runner §2.2, §2.3) onto them.
 */

import type { AgentFleetStatus, EventFrame, FleetState } from '../api/types';

export type FleetStatusMap = Readonly<Record<string, AgentFleetStatus>>;

export const EMPTY_FLEET_STATUS: FleetStatusMap = Object.freeze({});

/** The states that mean "this agent is waiting on a human" (§5.1's filter). */
export const NEEDS_ATTENTION_STATES: readonly FleetState[] = ['awaiting_user', 'halted'];

/** The states that mean "this agent is busy right now" (§5.1's filter). */
export const WORKING_STATES: readonly FleetState[] = ['queued', 'working'];

interface SessionPayload {
  readonly summary?: unknown;
  readonly exitReason?: unknown;
  readonly reason?: unknown;
  readonly status?: unknown;
}

/**
 * Folds one lifecycle event into the map.
 *
 * Pure, and keyed by agent id rather than session id, because the card asks
 * "what is Priya doing" and not "what is session 01J… doing". An agent with two
 * sessions shows the most recent event, which is what the pill means.
 */
export function applySessionEvent(current: FleetStatusMap, frame: EventFrame): FleetStatusMap {
  const agentId = frame.ids['agentId'];
  if (agentId === undefined || agentId === '') return current;

  const derived = deriveState(frame);
  if (derived === undefined) return current;

  const next: AgentFleetStatus = {
    agentId,
    state: derived.state,
    headline: derived.headline,
    since: frame.ts,
    projectId: frame.ids['projectId'] ?? null,
    sessionId: frame.ids['sessionId'] ?? null,
  };
  return { ...current, [agentId]: next };
}

function deriveState(
  frame: EventFrame,
): { readonly state: FleetState; readonly headline: string | null } | undefined {
  const payload: SessionPayload =
    typeof frame.payload === 'object' && frame.payload !== null ? frame.payload : {};
  const summary = typeof payload.summary === 'string' ? payload.summary : null;
  const exitReason =
    typeof payload.exitReason === 'string'
      ? payload.exitReason
      : typeof payload.reason === 'string'
        ? payload.reason
        : null;

  switch (frame.type) {
    case 'session.queued':
      return { state: 'queued', headline: summary };
    case 'session.started':
    case 'session.resumed':
      return { state: 'working', headline: summary };
    case 'session.paused':
      // runner §11.1: a park on a question is `paused` with
      // `exit_reason: awaiting_answer`, and it is the one pause the user has to
      // do something about — so it reads as `awaiting_user`, not `paused`.
      if (exitReason === 'awaiting_answer') return { state: 'awaiting_user', headline: summary };
      if (exitReason === 'budget_halt') return { state: 'halted', headline: summary };
      return { state: 'paused', headline: summary };
    case 'session.ended':
      if (exitReason === 'budget_halt') return { state: 'halted', headline: summary };
      return { state: 'idle', headline: summary };
    case 'session.orphaned':
      // A session that died mid-flight is not idle: something has to be done
      // about it, and `halted` is the word orchestrator uses for that.
      return { state: 'halted', headline: summary };
    default:
      return undefined;
  }
}

/** The default when nothing has been heard about an agent at all. */
export function statusFor(map: FleetStatusMap, agentId: string): AgentFleetStatus {
  return (
    map[agentId] ?? {
      agentId,
      state: 'idle',
      headline: null,
      since: null,
      projectId: null,
      sessionId: null,
    }
  );
}

/** The pill's words, exactly as orchestrator §16.6 spells them. */
export const FLEET_STATE_LABELS: Readonly<Record<FleetState, string>> = Object.freeze({
  idle: 'idle',
  queued: 'queued',
  working: 'working',
  awaiting_user: 'awaiting user',
  paused: 'paused',
  halted: 'halted',
});
