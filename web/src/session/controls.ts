/**
 * The session controls, as a table (DESIGN §9.3; runner §11.1).
 *
 * > "A control that does not apply is **shown disabled with the reason**, not
 * > hidden — 'paused sessions can't be steered; resume first'."
 *
 * So availability is data, not JSX: one function from the session's status and
 * `exit_reason` to the seven controls with, for each, whether it applies and why
 * it does not. That makes the two rules that are easy to get wrong assertable in
 * isolation:
 *
 * - **Resume is absent, not disabled, on an `awaiting_answer` park.** §9.3: "a
 *   `paused` session whose `exit_reason` is `awaiting_answer` shows 'waiting for
 *   your answer' with a link to the card, and **no Resume button**, because
 *   runner auto-resumes on the answer and a second resumer is the bug runner
 *   §15.1 #7 warns about." Every other inapplicable control is shown disabled;
 *   this one is the single exception, and it is an exception because a disabled
 *   Resume still invites the click that the shape exists to prevent.
 * - **Everything is idempotent.** Runner answers `200 { status, changed }` for
 *   pause/resume/stop/pin whatever the current state, so the UI never refuses to
 *   send a control it is unsure about (§3.3: "a retry that the UI refuses to send
 *   is worse than one the server absorbs"). Only `steer` is a typed 409, which is
 *   runner's deliberate exception, and the reason is shown before the click.
 */

import type { SessionStatus } from '../api/types';

export const SESSION_CONTROLS = [
  'steer',
  'pause',
  'resume',
  'stop',
  'continue',
  'relaunch',
  'pin',
] as const;
export type SessionControl = (typeof SESSION_CONTROLS)[number];

export interface ControlState {
  readonly control: SessionControl;
  readonly label: string;
  readonly enabled: boolean;
  /** Present exactly when `enabled` is false — never a bare disabled button. */
  readonly reason: string | undefined;
  /** The one control §9.3 hides rather than disables. */
  readonly hidden: boolean;
}

const LIVE: readonly SessionStatus[] = ['queued', 'running', 'paused'];
const FINISHED: readonly SessionStatus[] = ['done', 'failed', 'interrupted'];

/**
 * `POST /api/sessions/:id/continue` is **runner M10** and is not mounted yet —
 * runner's route file says the rest of §11.1's table "arrives with M9 and M10".
 *
 * §9.3 says an inapplicable control is "shown disabled with the reason", and
 * that is exactly what this does: Continue stays visible, disabled, saying why,
 * rather than being hidden (which would make it look inapplicable) or enabled
 * (which would make it 404). **TODO(runner M10)**: flip this to `true` when the
 * route lands; nothing else changes.
 */
export const CONTINUE_ROUTE_AVAILABLE = false;
const CONTINUE_UNBUILT_REASON =
  'continuing a finished session needs runner’s /continue route, which isn’t in this build yet';

/** §9.3's "waiting for your answer" park — the state with no Resume. */
export function isAwaitingAnswer(status: SessionStatus, exitReason: string | null): boolean {
  return status === 'paused' && exitReason === 'awaiting_answer';
}

export function controlStates(
  status: SessionStatus,
  exitReason: string | null,
  pinned: boolean,
): readonly ControlState[] {
  const awaiting = isAwaitingAnswer(status, exitReason);

  const state = (
    control: SessionControl,
    label: string,
    enabled: boolean,
    reason?: string,
    hidden = false,
  ): ControlState => ({
    control,
    label,
    enabled,
    reason: enabled ? undefined : reason,
    hidden,
  });

  return [
    state(
      'steer',
      'Steer',
      status === 'running',
      status === 'paused'
        ? 'paused sessions can’t be steered; resume first'
        : status === 'queued'
          ? 'this session hasn’t started yet; a steer would go nowhere'
          : 'the session has finished; use Continue instead',
    ),
    state(
      'pause',
      'Pause',
      status === 'running',
      status === 'paused'
        ? 'already paused'
        : status === 'queued'
          ? 'nothing is running yet; stop it instead'
          : 'the session has finished',
    ),
    state(
      'resume',
      'Resume',
      status === 'paused' && !awaiting,
      status === 'running' ? 'already running' : 'only a paused session can be resumed',
      awaiting,
    ),
    state('stop', 'Stop', LIVE.includes(status), 'the session has already finished'),
    state(
      'continue',
      'Continue',
      CONTINUE_ROUTE_AVAILABLE && FINISHED.includes(status),
      LIVE.includes(status)
        ? 'the session is still live; steer it instead'
        : status === 'orphaned'
          ? 'this session was orphaned — relaunch it'
          : CONTINUE_UNBUILT_REASON,
    ),
    state(
      'relaunch',
      'Relaunch',
      status === 'orphaned',
      'relaunching is for a session whose run was lost',
    ),
    // §9.3: "always — the retention exemption, labelled 'keep this transcript'".
    state('pin', pinned ? 'Unpin transcript' : 'Keep this transcript', true),
  ];
}

/** The route each control posts to. `relaunch` opens the launch flow instead. */
export const CONTROL_PATHS: Readonly<Record<Exclude<SessionControl, 'relaunch'>, string>> =
  Object.freeze({
    steer: 'steer',
    pause: 'pause',
    resume: 'resume',
    stop: 'stop',
    continue: 'continue',
    pin: 'pin',
  });
