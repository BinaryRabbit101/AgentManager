/**
 * The event → cache invalidation map (DESIGN §3.4).
 *
 * This is the whole state architecture in one function: **the server is the
 * source of truth, the event feed is the invalidation signal, and no screen
 * polls.** An event arrives, this decides which query keys stopped being true,
 * and TanStack Query does the rest.
 *
 * It is a pure function of the frame — `plan(frame)` returns descriptions, not
 * effects — so the map is testable without a query client and the transport is
 * testable without the map.
 */

import { queryKeys } from '../api/queries';
import type { EventFrame } from '../api/types';

/** What an event does to the client's caches. */
export interface InvalidationPlan {
  /** Query key prefixes to invalidate. */
  readonly invalidate: readonly (readonly unknown[])[];
  /** Agent ids whose memoised avatar object URL is now stale. */
  readonly avatars: readonly string[];
  /** True when the frame carries a session lifecycle fact for the board (§5.2). */
  readonly sessionLifecycle: boolean;
  /** True when the frame is per-session detail the global feed must never see. */
  readonly perSessionDetail: boolean;
  /**
   * `+1` when a question was raised, `-1` when one was answered, `0` otherwise.
   *
   * §2.2's badge count is `GET /api/orchestrator/status`'s `questions.open`,
   * which is **orchestrator M9** and lands after ui M5 — so until it does the
   * count is the inbox's own length, kept live by `assignment.question.raised` /
   * `.answered` exactly as §11.1 describes. The same deliberate degrade the board
   * made for the status pill (M2): the rendering and the words do not change,
   * only where the number is read.
   */
  readonly questionDelta: -1 | 0 | 1;
}

const EMPTY: InvalidationPlan = {
  invalidate: [],
  avatars: [],
  sessionLifecycle: false,
  perSessionDetail: false,
  questionDelta: 0,
};

/**
 * §3.3's "never on the global feed" set.
 *
 * If one of these ever arrives it means the `types=` filter was not applied, and
 * the plan says so rather than silently appending to a ring buffer that no open
 * session view owns.
 */
export const PER_SESSION_DETAIL_TYPES: readonly string[] = [
  'session.delta',
  'session.message',
  'session.usage',
];

export const SESSION_LIFECYCLE_TYPES: readonly string[] = [
  'session.queued',
  'session.started',
  'session.paused',
  'session.resumed',
  'session.ended',
  'session.orphaned',
];

export function plan(frame: EventFrame): InvalidationPlan {
  const { type } = frame;

  if (PER_SESSION_DETAIL_TYPES.includes(type) || type.startsWith('session.tool.')) {
    return { ...EMPTY, perSessionDetail: true };
  }

  if (SESSION_LIFECYCLE_TYPES.includes(type)) {
    // §3.4: "patch the session record, invalidate the fleet status and the
    // project timeline". The fleet status is derived client-side until
    // orchestrator M9 (see board/fleetStatus.ts), so what needs refetching here
    // is the project list, whose `lastActivityAt` and health both moved.
    return {
      ...EMPTY,
      sessionLifecycle: true,
      invalidate: [['projects']],
    };
  }

  if (type.startsWith('roster.')) {
    // "refetch the roster list (covers external file edits and `git pull`)".
    const reason = reasonOf(frame);
    const agentId = frame.ids['agentId'];
    return {
      ...EMPTY,
      invalidate: [queryKeys.roster],
      avatars: reason === 'avatar' && agentId !== undefined ? [agentId] : [],
    };
  }

  if (type.startsWith('project.') || type.startsWith('workspace.')) {
    return { ...EMPTY, invalidate: [['projects']] };
  }

  if (type.startsWith('assignment.') || type.startsWith('question.')) {
    return {
      ...EMPTY,
      invalidate: [['questions'], ['assignments']],
      questionDelta:
        type === 'assignment.question.raised'
          ? 1
          : type === 'assignment.question.answered'
            ? -1
            : 0,
    };
  }

  if (type.startsWith('runner.')) {
    return { ...EMPTY, invalidate: [['runner']] };
  }

  if (type.startsWith('remote.')) {
    return { ...EMPTY, invalidate: [['remote'], queryKeys.roster] };
  }

  if (type.startsWith('service.')) {
    // A module restarting changes the feature-detection facts of §3.5, and both
    // are explicitly "refetched on reconnect".
    return { ...EMPTY, invalidate: [queryKeys.health, queryKeys.config] };
  }

  return EMPTY;
}

function reasonOf(frame: EventFrame): string | undefined {
  const payload = frame.payload;
  if (typeof payload !== 'object' || payload === null) return undefined;
  const reason = (payload as Record<string, unknown>)['reason'];
  return typeof reason === 'string' ? reason : undefined;
}
