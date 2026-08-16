/**
 * The session status machine (runner DESIGN §2.2) and the `exit_reason`
 * vocabulary (§2.3), as data rather than as scattered `if` statements.
 *
 * The table below is the design's table, arrow for arrow, and it is the only
 * place a status change is authorised. Three of its properties are load-bearing
 * enough that they are encoded rather than commented:
 *
 * - **`paused` never becomes `orphaned`.** A pause is a deliberate state that
 *   survives a restart unchanged; boot's `running → orphaned` sweep must not be
 *   able to reach it.
 * - **`orphaned` is terminal**, so that projects' derived `failed` assignment
 *   outcome stays truthful — "a session that really did die mid-flight should
 *   not be able to quietly become a success later". So is every other terminal
 *   status.
 * - **`orphaned` is only ever assigned by the boot task.** A live process
 *   observing its own session cannot conclude the process is dead, so the
 *   transition requires {@link TransitionOptions.boot} and is otherwise refused.
 *
 * Every terminal or paused transition carries an `exit_reason` from §2.3's
 * closed set; a transition that omits one throws rather than writing a row the
 * UI cannot explain.
 */
import type { SessionStatus } from '../../storage/index.js';

import {
  InvalidExitReasonError,
  InvalidTransitionError,
  MissingExitReasonError,
} from './errors.js';

export type { SessionStatus };

/** §2.2's vocabulary, "verbatim and closed". */
export const SESSION_STATUSES: readonly SessionStatus[] = [
  'queued',
  'running',
  'paused',
  'done',
  'failed',
  'interrupted',
  'orphaned',
];

/** Statuses nothing leaves (§2.2). `paused` is deliberately not among them. */
export const TERMINAL_STATUSES: ReadonlySet<SessionStatus> = new Set<SessionStatus>([
  'done',
  'failed',
  'interrupted',
  'orphaned',
]);

/** §2.3's closed set, written on every terminal or paused transition. */
export const EXIT_REASONS = [
  'completed',
  'user_stopped',
  'user_cancelled',
  'max_turns',
  'max_budget_usd',
  'error_during_execution',
  'error_structured_output',
  'launch_failed',
  'secret_unresolved',
  'workspace_unavailable',
  'start_timeout',
  'idle_timeout',
  'wall_clock_timeout',
  'question_expired',
  'awaiting_answer',
  'budget_halt',
  'service_shutdown',
  'shutdown_forced',
  'stale_queue',
  'core_restart',
  'transcript_cap',
] as const;

export type ExitReason = (typeof EXIT_REASONS)[number];

const EXIT_REASON_SET: ReadonlySet<string> = new Set<string>(EXIT_REASONS);

export function isExitReason(value: unknown): value is ExitReason {
  return typeof value === 'string' && EXIT_REASON_SET.has(value);
}

/** One row of §2.2's table, kept whole so a test can drive every arrow by name. */
export interface SessionTransition {
  readonly from: SessionStatus;
  readonly to: SessionStatus;
  /** The design's "Trigger" column, for diagnostics and for the table test. */
  readonly trigger: string;
  /** `running → orphaned` only. Refused unless the boot task asks for it. */
  readonly bootOnly?: true;
}

/**
 * §2.2's transition table, in the design's order.
 *
 * `— → queued` (admission) is not here: it creates the row rather than moving
 * one, and lives in {@link SessionRepository.enqueue}.
 */
export const SESSION_TRANSITIONS: readonly SessionTransition[] = [
  { from: 'queued', to: 'running', trigger: 'scheduler admits; launch chain succeeds' },
  { from: 'queued', to: 'queued', trigger: 'retryable workspace refusal; blocked_reason set' },
  { from: 'queued', to: 'failed', trigger: 'launch chain error' },
  { from: 'queued', to: 'interrupted', trigger: 'user cancels a queued session; stale on boot' },
  { from: 'running', to: 'done', trigger: 'result subtype success; generator completed' },
  { from: 'running', to: 'failed', trigger: 'error result subtype, stream error, or a guard' },
  { from: 'running', to: 'interrupted', trigger: 'user presses Stop' },
  { from: 'running', to: 'paused', trigger: 'pause, question park, budget halt, shutdown' },
  {
    from: 'running',
    to: 'orphaned',
    trigger: 'boot found it running with no live process',
    bootOnly: true,
  },
  { from: 'paused', to: 'queued', trigger: 'resume requested, or a parked question is answered' },
  { from: 'paused', to: 'interrupted', trigger: 'user discards a pause; question expired' },
];

const ALLOWED: ReadonlyMap<SessionStatus, ReadonlyMap<SessionStatus, SessionTransition>> = (() => {
  const table = new Map<SessionStatus, Map<SessionStatus, SessionTransition>>();
  for (const transition of SESSION_TRANSITIONS) {
    const row = table.get(transition.from) ?? new Map<SessionStatus, SessionTransition>();
    row.set(transition.to, transition);
    table.set(transition.from, row);
  }
  return table;
})();

/** The table row for an arrow, or `undefined` when §2.2 has no such arrow. */
export function findTransition(
  from: SessionStatus,
  to: SessionStatus,
): SessionTransition | undefined {
  return ALLOWED.get(from)?.get(to);
}

export function isTransitionAllowed(from: SessionStatus, to: SessionStatus): boolean {
  return findTransition(from, to) !== undefined;
}

/**
 * True when a move to `status` must carry an `exit_reason`.
 *
 * §2.3: "written on every terminal or paused transition, and carried in
 * `session.ended` / `session.paused` events".
 */
export function requiresExitReason(status: SessionStatus): boolean {
  return TERMINAL_STATUSES.has(status) || status === 'paused';
}

export interface TransitionOptions {
  readonly exitReason?: string | null;
  /** Set only by the §9.2 boot task, which is the only author of `orphaned`. */
  readonly boot?: boolean;
}

/**
 * Checks one arrow against §2.2 and §2.3, throwing the typed refusal.
 *
 * Separate from the repository so the rules can be tested — and reasoned about —
 * without a database, and so nothing can reach the `UPDATE` without passing
 * through here.
 */
export function assertTransition(
  from: SessionStatus,
  to: SessionStatus,
  options: TransitionOptions = {},
): SessionTransition {
  const transition = findTransition(from, to);
  if (transition === undefined) {
    throw new InvalidTransitionError(from, to, describeRefusal(from, to));
  }
  if (transition.bootOnly === true && options.boot !== true) {
    throw new InvalidTransitionError(
      from,
      to,
      'only the boot reconciliation task may orphan a session: a live process cannot ' +
        'conclude that its own session has no live process (§2.2).',
    );
  }
  if (requiresExitReason(to)) {
    const reason = options.exitReason;
    if (reason === undefined || reason === null || reason === '') {
      throw new MissingExitReasonError(to);
    }
    if (!isExitReason(reason)) throw new InvalidExitReasonError(reason);
  }
  return transition;
}

/** Why this particular arrow is missing, in the words §2.2 uses for it. */
function describeRefusal(from: SessionStatus, to: SessionStatus): string {
  if (TERMINAL_STATUSES.has(from)) {
    return `"${from}" is terminal (§2.2); continuing this work is a new session with resumed_from.`;
  }
  if (from === 'paused' && to === 'orphaned') {
    return 'a paused session is a deliberate state and survives restarts unchanged (§2.2).';
  }
  return `§2.2 has no "${from}" → "${to}" arrow.`;
}
