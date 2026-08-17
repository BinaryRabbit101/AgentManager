/**
 * The runner's typed failures (runner DESIGN §3.2: "a typed failure that becomes
 * an `exit_reason` and a human-readable message on the session row, never a
 * stack trace to the UI").
 *
 * Each carries the HTTP status its route should answer with, so the handler
 * translates rather than decides — the same arrangement the projects element
 * uses, for the same reason: a status chosen at the throw site is a status the
 * reader can check against the design.
 */

/** Base class: every runner failure a caller is expected to handle. */
export class RunnerError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: string,
    message: string,
    status = 400,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export class SessionNotFoundError extends RunnerError {
  constructor(sessionId: string) {
    super('session_not_found', `No session "${sessionId}".`, 404, { sessionId });
  }
}

/** A malformed request parameter. The route's 400, named. */
export class InvalidRequestError extends RunnerError {
  constructor(message: string, ...fields: string[]) {
    super('invalid_request', message, 400, fields.length === 0 ? {} : { fields });
  }
}

/** An arrow §2.2 does not have. 409 because the row's state is the reason. */
export class InvalidTransitionError extends RunnerError {
  constructor(from: string, to: string, why: string) {
    super('invalid_transition', `A session cannot move from "${from}" to "${to}": ${why}`, 409, {
      from,
      to,
    });
  }
}

/** §2.3: "a write without one throws". */
export class MissingExitReasonError extends RunnerError {
  constructor(status: string) {
    super(
      'missing_exit_reason',
      `Moving a session to "${status}" requires an exit_reason from the closed set of §2.3: ` +
        'the UI and the assignment timeline both render it, and a row without one cannot be explained.',
      500,
      { status },
    );
  }
}

export class InvalidExitReasonError extends RunnerError {
  constructor(reason: string) {
    super(
      'invalid_exit_reason',
      `"${reason}" is not an exit_reason: §2.3's set is closed, so a new one is a design change ` +
        'rather than a string.',
      500,
      { reason },
    );
  }
}

/** A session already carries a launch request; `session_inputs` is write-once. */
export class DuplicateSessionInputError extends RunnerError {
  constructor(sessionId: string) {
    super(
      'duplicate_session_input',
      `Session "${sessionId}" already has a launch request; session_inputs is written once, at admission.`,
      409,
      { sessionId },
    );
  }
}

/**
 * SDK-NOTES **C1**'s assertion firing: a reconciliation delta came out negative.
 *
 * `result.modelUsage` and `result.total_cost_usd` are cumulative **per `query()`
 * call** and restart at zero on a resume, so runner meters against a per-run
 * baseline (§7.1 as amended). A negative delta can therefore mean only one
 * thing: the run boundary was missed and the baseline belongs to a different
 * run. Clamping it to zero would look like it worked and would quietly shrink
 * `session_usage` — and with it `assignments.tokens_used`, which the budget halt
 * reads — so it throws instead. A parked-and-resumed session earning its budget
 * back is the bug this refuses to hide.
 */
export class NegativeUsageDeltaError extends RunnerError {
  constructor(
    sessionId: string,
    runId: string,
    model: string,
    tokens: { input: number; output: number; cacheRead: number; cacheCreation: number },
    costDelta?: number,
  ) {
    super(
      'negative_usage_delta',
      `Usage for session "${sessionId}" went backwards for "${model}" within run "${runId}". ` +
        'modelUsage and total_cost_usd are cumulative per query() call and reset on resume ' +
        '(SDK-NOTES C1), so a negative delta means the per-run baseline was taken from the ' +
        'wrong run rather than that tokens were refunded.',
      500,
      {
        sessionId,
        runId,
        model,
        delta: { ...tokens },
        ...(costDelta === undefined ? {} : { costDelta }),
      },
    );
  }
}

// ---------------------------------------------------------------------------
// The launch chain (§3.1, §3.2)
// ---------------------------------------------------------------------------

/**
 * A failure that is also a session `exit_reason` (§3.2).
 *
 * The chain writes `exit_reason` off this field rather than off the error's
 * class, so a new failure adds one line here instead of a branch at the call
 * site — and so §2.3's closed set is the only vocabulary in play.
 */
export interface LaunchFailure {
  readonly exitReason: ExitReasonName;
}

/** §2.3's vocabulary, referenced without importing `status.ts` (which imports this file). */
type ExitReasonName = string;

export function isLaunchFailure(error: unknown): error is RunnerError & LaunchFailure {
  return (
    error instanceof RunnerError && typeof (error as Partial<LaunchFailure>).exitReason === 'string'
  );
}

/**
 * §6.2: "A `startSession` past the limit is refused with a typed `queue_full`
 * and **no session row**".
 */
export class QueueFullError extends RunnerError {
  constructor(queued: number, limit: number) {
    super(
      'queue_full',
      `The launch queue is full (${String(queued)} of ${String(limit)} waiting). ` +
        'Nothing was recorded — start this session again when the queue drains.',
      429,
      { queued, limit },
    );
  }
}

/** Admission (§3.1 step 0): the assignment must exist. Runner never mints one (D9). */
export class AssignmentNotFoundError extends RunnerError {
  constructor(assignmentId: string) {
    super(
      'assignment_not_found',
      `No assignment "${assignmentId}". Runner never creates one — orchestrator mints ` +
        'assignments, including the trivial solo assignment behind a drag-and-drop launch (D9).',
      404,
      { assignmentId },
    );
  }
}

/** Admission (§3.2 row 3): "assignment closed or missing → refused before the row exists". */
export class AssignmentClosedError extends RunnerError {
  constructor(assignmentId: string) {
    super(
      'assignment_closed',
      `Assignment "${assignmentId}" is closed; no new session can start on it. ` +
        'Continuing this work means a new assignment.',
      409,
      { assignmentId },
    );
  }
}

/** Admission: the agent must be in the roster and not archived (§3.1 step 0). */
export class AgentUnavailableError extends RunnerError {
  constructor(agentId: string, why: 'unknown' | 'archived') {
    super(
      why === 'unknown' ? 'agent_unknown' : 'agent_archived',
      why === 'unknown'
        ? `No agent "${agentId}" in the roster.`
        : `Agent "${agentId}" is archived and cannot be launched. Restore it first.`,
      why === 'unknown' ? 404 : 409,
      { agentId },
    );
  }
}

/** Admission: a `provisioning` or `archived` project cannot be launched against. */
export class ProjectNotLaunchableError extends RunnerError {
  constructor(projectId: string, reason: string) {
    super('project_not_launchable', reason, 409, { projectId });
  }
}

/**
 * §3.2 row 4, terminal half: "UNC path, mid-rebase, setup command failed" —
 * carrying projects' reason string **verbatim**, because projects wrote it for
 * a human and re-phrasing it here would lose the detail that makes it fixable.
 */
export class WorkspaceUnavailableError extends RunnerError implements LaunchFailure {
  readonly exitReason = 'workspace_unavailable';

  constructor(code: string, reason: string) {
    super('workspace_unavailable', reason, 409, { refusalCode: code });
  }
}

/**
 * §3.2 row 6: an unresolved `secretRef`, including runner's own
 * `claude.oauthToken` (§3.4).
 */
export class SecretUnresolvedError extends RunnerError implements LaunchFailure {
  readonly exitReason = 'secret_unresolved';

  constructor(key: string, detail?: string) {
    super(
      'secret_unresolved',
      key === 'claude.oauthToken'
        ? 'No Claude subscription token is stored, so no session can authenticate. ' +
            'Run Setup-Auth.ps1 (it wraps `claude setup-token`) and start the session again.'
        : `The secret "${key}" could not be resolved${detail === undefined ? '' : `: ${detail}`}.`,
      503,
      { key },
    );
  }
}

/**
 * §3.2 row 7: a compile diagnostic marked fatal, or roster refusing the compile
 * outright.
 */
export class LaunchCompileError extends RunnerError implements LaunchFailure {
  readonly exitReason = 'launch_failed';

  constructor(message: string, detail: Readonly<Record<string, unknown>> = {}) {
    super('launch_failed', message, 500, detail);
  }
}

/**
 * §3.2 row 9: subprocess spawn failure, or no `system/init` within
 * `runner.startTimeoutMs` — with the captured `stderr` tail.
 */
export class SessionStartTimeoutError extends RunnerError implements LaunchFailure {
  readonly exitReason = 'start_timeout';

  constructor(message: string, detail: Readonly<Record<string, unknown>> = {}) {
    super('start_timeout', message, 504, detail);
  }
}

/** A stream error after `init`, or a session that ended without a `result` (§2.2). */
export class SessionExecutionError extends RunnerError implements LaunchFailure {
  readonly exitReason = 'error_during_execution';

  constructor(message: string, detail: Readonly<Record<string, unknown>> = {}) {
    super('error_during_execution', message, 500, detail);
  }
}

/**
 * A registry provider runner cannot start a session without (§11.3: `roster`
 * and `projects` are "fatal").
 *
 * A 503 rather than a 500: the service is up and the request was well-formed —
 * the capability is missing, which is an install or configuration fact the
 * owner can act on.
 */
export class ProviderUnavailableError extends RunnerError implements LaunchFailure {
  readonly exitReason = 'launch_failed';

  constructor(provider: string, what: string) {
    super(
      'provider_unavailable',
      `The "${provider}" service does not provide ${what}, so no session can be launched. ` +
        'Runner consumes it through the service registry (DESIGN §11.3) and invents no substitute.',
      503,
      { provider },
    );
  }
}

/**
 * The service was built without a launch chain (M1/M2's read-only shape).
 *
 * A 503 for the same reason {@link ProviderUnavailableError} is one: the
 * request was fine, the capability is not wired.
 */
export class LaunchUnavailableError extends RunnerError {
  constructor() {
    super(
      'launch_unavailable',
      'This runner was built without the launch chain, so it can read sessions and transcripts ' +
        'but cannot start one.',
      503,
    );
  }
}

// ---------------------------------------------------------------------------
// Session control (§4.3, §11.1) — M6
// ---------------------------------------------------------------------------

/**
 * A control verb aimed at a session whose status has no such arrow (§2.2).
 *
 * A 409 rather than a 400, for the reason §11.1 gives the whole verb family:
 * "the row's state is the reason". Note what this is **not** used for —
 * pausing a paused session, stopping a stopped one, resuming a running one are
 * all `200` with the current state, because "a retry that 409s is a retry that
 * produces a support ticket".
 */
export class SessionControlRefusedError extends RunnerError {
  constructor(verb: string, sessionId: string, status: string, why: string) {
    super('session_control_refused', `Cannot ${verb} session "${sessionId}": ${why}`, 409, {
      sessionId,
      verb,
      status,
    });
  }
}

/**
 * §9.3's honesty, as a refusal: a paused session with no `sdk_session_id` has
 * no conversation to replay, so there is nothing for `resume` to continue.
 *
 * Unreachable in practice — a session only reaches `running`, and therefore
 * `paused`, once `system/init` has been read — which is exactly why it is a
 * named error rather than a silent relaunch of a different conversation.
 */
export class SessionNotResumableError extends RunnerError {
  constructor(sessionId: string, why: string) {
    super('session_not_resumable', `Session "${sessionId}" cannot be resumed: ${why}`, 409, {
      sessionId,
    });
  }
}

/**
 * §3.3's assertion firing: runner changed a compiled option it does not own.
 *
 * A 500, and deliberately loud. "A permission bug introduced by the runner would
 * be invisible in review and obvious in that assertion."
 */
export class OptionWhitelistError extends RunnerError implements LaunchFailure {
  readonly exitReason = 'launch_failed';

  constructor(paths: readonly string[]) {
    super(
      'option_whitelist',
      `The launch changed compiled session options runner does not own: ${paths.join(', ')}. ` +
        'DESIGN §3.3 whitelists env.CLAUDE_CODE_OAUTH_TOKEN, canUseTool, abortController, ' +
        'includePartialMessages, resume/sessionId and stderr, and nothing else.',
      500,
      { paths: [...paths] },
    );
  }
}
