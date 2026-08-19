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
  /** True for `project.clone.*` — §8.1's progress row, folded in the store. */
  readonly cloneProgress: boolean;
  /**
   * True for `runner.ratelimited` and `runner.queue.changed` — §12's cool-down.
   *
   * Folded into the store as well as invalidating the queue, because
   * `runner.ratelimited` is the **only** carrier of the cool-down's `source` and
   * `hint`: the queue route knows the deadline but not where it came from, so a
   * refetch alone would lose half the sentence §12 requires.
   */
  readonly schedulerState: boolean;
  /**
   * `+1` when a question was raised, `-1` when one was answered, `0` otherwise.
   *
   * §2.2's badge count is `GET /api/orchestrator/status`'s `questions.open`, and
   * since ui M6 that is where it is read from (`app/useOpenQuestions.ts`). This
   * delta is not a substitute for it — it is §11.1's "bump/clear the badge",
   * which has to happen inside a second of a card arriving, faster than the
   * invalidated query can come back. The query then settles the number.
   */
  readonly questionDelta: -1 | 0 | 1;
}

const EMPTY: InvalidationPlan = {
  invalidate: [],
  avatars: [],
  sessionLifecycle: false,
  perSessionDetail: false,
  cloneProgress: false,
  schedulerState: false,
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
    // project timeline". The fleet status is orchestrator's own since ui M6, and
    // the project list's `lastActivityAt` and health both moved.
    //
    // `['sessions']` joined them when home and the sessions index landed: both
    // *list* sessions by status (§2.4's "Running now" and "Recently finished",
    // §9.5's tabs), and a session that starts, ends or is orphaned changes which
    // list it belongs to. Without this the only way those screens could follow a
    // run would be a poll, which §16 forbids. The prefix covers the detail key
    // (`['sessions', id]`) too, which is right for the same reason: its `status`
    // and `exitReason` are exactly what the frame just changed.
    return {
      ...EMPTY,
      sessionLifecycle: true,
      invalidate: [['sessions'], ['projects'], queryKeys.orchestratorStatus],
    };
  }

  if (type.startsWith('roster.')) {
    // "refetch the roster list (covers external file edits and `git pull`)".
    const reason = reasonOf(frame);
    const agentId = frame.ids['agentId'];
    return {
      ...EMPTY,
      // Both halves of the library: `reason: 'templates'` is a `template.json`
      // that changed on disk, and it arrives on the same event type precisely so
      // one rule covers it (roster §2.4, WO5).
      invalidate: [queryKeys.roster, queryKeys.taskTemplates],
      avatars: reason === 'avatar' && agentId !== undefined ? [agentId] : [],
    };
  }

  if (type.startsWith('project.clone.')) {
    // §8.1's progress row is folded into the store (see `projects/clone.ts`);
    // the project list is invalidated too, because `completed` and `failed` both
    // change what is in it.
    return { ...EMPTY, cloneProgress: true, invalidate: [['projects']] };
  }

  if (type.startsWith('project.') || type.startsWith('workspace.')) {
    return { ...EMPTY, invalidate: [['projects']] };
  }

  if (type.startsWith('assignment.') || type.startsWith('question.')) {
    return {
      ...EMPTY,
      invalidate: [['questions'], ['assignments'], queryKeys.orchestratorStatus],
      questionDelta:
        type === 'assignment.question.raised'
          ? 1
          : type === 'assignment.question.answered'
            ? -1
            : 0,
    };
  }

  if (type.startsWith('trigger.')) {
    // §2.8's four events — `fired`, `skipped`, `blocked`, `disabled`. Every one
    // of them changes a trigger row's last outcome, its next fire, or both, and
    // a `fired` also puts a new assignment on the project. Nothing polls the
    // Triggers section: this is how it follows an unattended run (§3.4).
    return { ...EMPTY, invalidate: [['triggers'], ['assignments']] };
  }

  if (type.startsWith('runner.')) {
    return {
      ...EMPTY,
      invalidate: [['runner']],
      schedulerState: type === 'runner.ratelimited' || type === 'runner.queue.changed',
    };
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
