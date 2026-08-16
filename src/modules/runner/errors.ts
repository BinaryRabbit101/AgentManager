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
