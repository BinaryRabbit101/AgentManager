/**
 * The three regions of the home screen, as pure functions (DESIGN §2.4).
 *
 * Everything here is a **selection over what the server already sent** — a
 * filter, a slice, a phrasing of a timestamp. Nothing sorts, because §4's rule
 * that the UI renders the server's order applies to home exactly as it applies
 * to the inbox and the sessions index: `GET /api/sessions` is newest first
 * (runner §11.1) and `GET /api/assignments` is the orchestrator's order.
 *
 * They live in a `.ts` beside the screen rather than inside it so the rules —
 * *which* statuses count as finished, *how many* rows "a handful" is, what
 * "needs you" means for an assignment — can be asserted without a DOM.
 */

import type { AssignmentView, SessionRecord, SessionStatus } from '../api/types';

/**
 * The statuses that mean "this run is over" (runner §2.2's vocabulary).
 *
 * `orphaned` is included deliberately: a session whose process vanished has
 * finished as far as the user is concerned, and leaving it out would make the
 * one outcome most worth noticing the one outcome home never shows.
 */
export const FINISHED_STATUSES: readonly SessionStatus[] = [
  'done',
  'failed',
  'interrupted',
  'orphaned',
];

/** §2.4: "the last handful". Five rows — enough to recognise, short enough to scan. */
export const RECENT_LIMIT = 5;

/**
 * The finished sessions at the head of the unfiltered list.
 *
 * Filtered client-side out of the one `status`-less request rather than by
 * three status queries, because the three would each be newest-first *within a
 * status* and interleaving them here would be this file sorting — which is the
 * thing §4 forbids. The server's single order is kept and simply thinned.
 */
export function recentlyFinished(
  sessions: readonly SessionRecord[],
  limit: number = RECENT_LIMIT,
): readonly SessionRecord[] {
  return sessions.filter((session) => FINISHED_STATUSES.includes(session.status)).slice(0, limit);
}

/**
 * The open assignments that have stopped and are waiting on a person.
 *
 * `halted` and `awaiting_user` are orchestrator's own phases (§10.2's
 * vocabulary), read and never derived: an assignment is waiting on the user
 * because the server says so, not because the UI noticed nothing had moved.
 */
export function attentionAssignments(
  assignments: readonly AssignmentView[],
): readonly AssignmentView[] {
  return assignments.filter(
    (assignment) => assignment.phase === 'halted' || assignment.phase === 'awaiting_user',
  );
}

/**
 * How long a session has been going, phrased rather than formatted.
 *
 * `null` when there is no start yet (a queued session has none) or when the
 * stamp does not parse — the caller says "queued" or "not started yet" in words
 * instead, because a blank cell reads as a bug and `NaN` reads as a worse one.
 */
export function elapsedLabel(startedAt: string | null, now: number): string | null {
  if (startedAt === null) return null;
  const started = new Date(startedAt).getTime();
  if (Number.isNaN(started)) return null;

  const minutes = Math.floor(Math.max(0, now - started) / 60_000);
  if (minutes < 1) return 'just started';
  if (minutes < 60) return `${String(minutes)} min`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)}h ${String(minutes % 60)}m`;
  return `${String(Math.floor(hours / 24))}d ${String(hours % 24)}h`;
}
