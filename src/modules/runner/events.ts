/**
 * The structured session events of runner DESIGN §10 — **as data, in one place**
 * (milestone M10).
 *
 * §10's table is not decoration: its `persist` column is a load decision the
 * design spells out.
 *
 * > "`session.delta`, `session.message`, `session.tool.*`, and `session.usage`
 * > are the high-volume events; persisting them would blow through foundation's
 * > 200k-row `events` cap in a handful of sessions and turn the UI's replay
 * > query into a scan. Their durable record is the transcript, which is a file
 * > built for exactly that."
 *
 * A boolean passed at each `bus.emit` call site is a boolean that can be typed
 * wrongly at one of eighteen call sites, and the failure — a `session.delta`
 * flagged `persist: true` — is invisible until the `events` table has been
 * scanned by a user's UI. So the flag is looked up from {@link EVENT_PERSIST}
 * by type instead, {@link emitRunnerEvent} is the only emitter runner uses, and
 * an unknown type is a loud failure rather than a silently unpersisted event.
 *
 * ## `ids` is populated from the session row, never from the payload
 *
 * §10: "envelope `{ type, ts, ids, payload, persist }` with
 * `ids = { sessionId, assignmentId, projectId, agentId }` **always populated**".
 * Every session-scoped event therefore takes a session *record* rather than
 * four loose strings, so a call site cannot forget one.
 *
 * The two exceptions are `runner.queue.changed` and `runner.ratelimited`, which
 * describe the scheduler rather than a session and have no ids to populate —
 * raised in the milestone report rather than papered over with an empty string.
 */
import type { EventBus, EventIds } from '../types.js';

/** The ids §10 requires on every session-scoped event. */
export interface SessionEventSubject {
  readonly id: string;
  readonly assignmentId: string;
  readonly projectId: string;
  readonly agentId: string;
}

/**
 * §10's table, type for type, plus the one event §7.2 adds for orchestrator.
 *
 * `true` is the ✔ column. Anything not here cannot be emitted through
 * {@link emitRunnerEvent}, which is what stops a new event type from quietly
 * defaulting to one behaviour or the other.
 */
export const EVENT_PERSIST: Readonly<Record<string, boolean>> = {
  'session.queued': true,
  'session.started': true,
  'session.message': false,
  'session.delta': false,
  'session.tool.start': false,
  'session.tool.end': false,
  'session.usage': false,
  'session.steered': true,
  'session.question.raised': true,
  'session.question.answered': true,
  'session.paused': true,
  'session.resumed': true,
  'session.ended': true,
  'session.orphaned': true,
  'session.diagnostic': true,
  'runner.queue.changed': false,
  'runner.ratelimited': true,
  'runner.mcp.status': false,
  /**
   * §7.2 step 3 and §15.1-6. Not in §10's table because §10 lists *session*
   * events and this one is about the assignment; orchestrator consumes it to
   * put the assignment into `awaiting_user` (orchestrator §6.3), so it must
   * survive a UI that was not connected when it fired.
   */
  'assignment.budget.exceeded': true,
};

/** Every event type runner is allowed to emit. */
export const RUNNER_EVENT_TYPES: readonly string[] = Object.keys(EVENT_PERSIST);

/** The §10 subset a per-session stream carries (`GET /api/sessions/:id/stream`). */
export const SESSION_EVENT_TYPES: readonly string[] = RUNNER_EVENT_TYPES.filter((type) =>
  type.startsWith('session.'),
).concat('runner.mcp.status');

/**
 * Whether §10 marks this type ✔.
 *
 * @throws when the type is not in §10's table — an event runner cannot classify
 * is a design change, not a string.
 */
export function persistsEvent(type: string): boolean {
  const persist = EVENT_PERSIST[type];
  if (persist === undefined) {
    throw new Error(
      `"${type}" is not in runner DESIGN §10's event table, so its persist flag is undefined. ` +
        'Adding an event means adding a row there and here, together.',
    );
  }
  return persist;
}

export interface EmitRunnerEventOptions {
  readonly bus: Pick<EventBus, 'emit'> | undefined;
  readonly type: string;
  /** The session the event is about; omitted only for the two scheduler events. */
  readonly subject?: SessionEventSubject | undefined;
  readonly payload: Record<string, unknown>;
}

/** The one emitter. Applies §10's persist flag and §10's `ids` rule. */
export function emitRunnerEvent(options: EmitRunnerEventOptions): void {
  const persist = persistsEvent(options.type);
  const subject = options.subject;
  const ids: EventIds =
    subject === undefined
      ? {}
      : {
          sessionId: subject.id,
          assignmentId: subject.assignmentId,
          projectId: subject.projectId,
          agentId: subject.agentId,
        };
  options.bus?.emit({ type: options.type, ids, payload: options.payload, persist });
}

/**
 * How much of a tool input or result reaches `session.tool.*` (§10:
 * `inputPreview`, `resultPreview`).
 *
 * A preview rather than the value: `session.tool.*` is a live UI event fanned
 * out to every connected client, and a 2 MB file read would be sent to a phone
 * on a tailnet for a row that renders as one line. The whole value is in the
 * transcript, which is where a client that wants it looks.
 */
export const PREVIEW_MAX_LENGTH = 200;

export function preview(value: unknown, maxLength = PREVIEW_MAX_LENGTH): string {
  const text = typeof value === 'string' ? value : value === undefined ? '' : safeStringify(value);
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    // A circular or unserialisable tool input must cost a preview, not a turn.
    return String(value);
  }
}
