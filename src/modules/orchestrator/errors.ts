/**
 * The refusal vocabulary of DESIGN §9 and §4.2.
 *
 * > "Every refusal names a rule, so the agent learns instead of retrying."
 *
 * That sentence is written about an overseer calling `create_assignment`, but it
 * is equally the contract for the HTTP caller and for the UI: a create that
 * fails must say *which rule* refused it, because the remedy differs completely
 * between "that agent does not declare that role" and "that agent is already on
 * two assignments".
 *
 * Each error carries a stable {@link OrchestratorError.code}, the HTTP status the
 * API answers with, and a `details` bag naming the offending values. `routes.ts`
 * turns exactly those three into foundation's one error shape; no handler here
 * ever surfaces a stack.
 *
 * Statuses: `400` for "the request cannot be satisfied as written", `404` for a
 * row that is not there, `409` for "the world is in a state that forbids it"
 * (a closed assignment, an agent at its cap, an archived project).
 */

/** Base class, so a route — or a test — can recognise an expected refusal. */
export class OrchestratorError extends Error {
  override readonly name: string = 'OrchestratorError';

  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details: Readonly<Record<string, unknown>> = {},
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** The request body was malformed — a missing field, or a value outside its union. */
export class InvalidRequestError extends OrchestratorError {
  override readonly name = 'InvalidRequestError';

  constructor(message: string, field?: string) {
    super('invalid_request', message, 400, field === undefined ? {} : { field });
  }
}

export class AssignmentNotFoundError extends OrchestratorError {
  override readonly name = 'AssignmentNotFoundError';

  constructor(readonly assignmentId: string) {
    super('assignment_not_found', `No assignment ${assignmentId} exists.`, 404, { assignmentId });
  }
}

/**
 * §4.2's invariant, reached from every write path: a call against an assignment
 * that closed while it was in flight is refused, not queued.
 */
export class AssignmentClosedError extends OrchestratorError {
  override readonly name = 'AssignmentClosedError';

  constructor(readonly assignmentId: string) {
    super(
      'assignment_closed',
      `Assignment ${assignmentId} is closed. Closed assignments admit no new sessions.`,
      409,
      { assignmentId },
    );
  }
}

/**
 * Roster or projects is not on the registry.
 *
 * Orchestrator cannot validate a member's declared roles (§9-5) without roster's
 * registry, and it will not create work it could not validate — an unvalidated
 * assignment is exactly the "model's worst turn is an incident" case §9 exists
 * to prevent.
 */
export class DependencyUnavailableError extends OrchestratorError {
  override readonly name = 'DependencyUnavailableError';

  constructor(readonly dependency: string) {
    super(
      'dependency_unavailable',
      `The "${dependency}" service is not available, so this assignment cannot be validated. ` +
        'Check /api/health.',
      503,
      { dependency },
    );
  }
}

/** No launch path: `RunnerService.startSession` is not published (runner §11.3). */
export class RunnerUnavailableError extends OrchestratorError {
  override readonly name = 'RunnerUnavailableError';

  constructor() {
    super(
      'runner_unavailable',
      'The runner cannot start sessions in this build, so the assignment was not created. ' +
        'Nothing was written.',
      503,
    );
  }
}

// ---------------------------------------------------------------------------
// The §9 validator's refusals
// ---------------------------------------------------------------------------

/**
 * §9's rule set, as a closed vocabulary.
 *
 * The mapping onto §9's numbered rules is one-to-one except where a single rule
 * has genuinely distinct remedies — rule 7 covers three unrelated situations
 * ("that agent is gone", "that agent is busy", "you named it twice") and a
 * caller fixes each differently, so each gets its own code.
 */
export const REFUSAL_CODES = [
  /** §9-1 */ 'module_disabled',
  /** §9-1 */ 'project_not_active',
  /** §9-1 */ 'project_not_found',
  /** §9-2 */ 'project_mismatch',
  /** §9-3 */ 'nesting_depth',
  /** §9-4 */ 'unsupported_pattern',
  /** §9-5 */ 'invalid_role',
  /** §9-5 */ 'role_not_declared',
  /** §9-6 */ 'lead_not_overseer',
  /** §9-7 */ 'agent_not_found',
  /** §9-7 */ 'member_archived',
  /** §9-7 */ 'member_at_capacity',
  /** §9-7 */ 'duplicate_member',
  /** §9-8 */ 'budget_required',
  /** §9-8 */ 'budget_exceeds_parent',
  /** §9-9 */ 'projection_exceeds_budget',
  /** §9-11 */ 'scope_path_invalid',
  /** §2.3 */ 'no_members',
  /** §2.3 */ 'work_item_not_found',
  /** §2.3 */ 'work_item_cross_project',
] as const;

export type RefusalCode = (typeof REFUSAL_CODES)[number];

/**
 * The non-fatal counterpart: things the create dialog shows before the user
 * confirms (§2.3, §2.6, §7.2).
 *
 * Declared alongside the refusals because the *same* condition is a warning for
 * a human and a refusal for a machine — §9-9's projection check is exactly that
 * — and having the two vocabularies in one file is what makes that visible.
 */
export const WARNING_CODES = [
  /** §7.2 / §9-9, for a user-created assignment. */ 'projection_exceeds_budget',
  /** §2.6 */ 'scope_overlap',
] as const;

export type WarningCode = (typeof WARNING_CODES)[number];

/** One named refusal from the pure validator (§9). */
export interface Refusal {
  readonly code: RefusalCode;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

/**
 * What `createAssignment` throws when the validator refused.
 *
 * It carries **every** refusal, not the first: a create dialog that fixes one
 * problem and is then told about the next is the interaction the validator's
 * purity exists to avoid.
 */
export class AssignmentRefusedError extends OrchestratorError {
  override readonly name = 'AssignmentRefusedError';

  constructor(readonly refusals: readonly Refusal[]) {
    super(
      refusals[0]?.code ?? 'invalid_request',
      refusals.map((refusal) => refusal.message).join(' '),
      statusFor(refusals[0]?.code),
      { refusals: refusals.map((r) => ({ code: r.code, message: r.message, ...r.details })) },
    );
  }
}

/**
 * `409` for "the world forbids it", `404` for a missing row, `400` otherwise.
 *
 * The distinction the UI needs is whether to fix the input or to change
 * something else first, which is exactly the 400/409 split.
 */
function statusFor(code: RefusalCode | undefined): number {
  switch (code) {
    case 'project_not_found':
    case 'agent_not_found':
      return 404;
    case 'module_disabled':
    case 'project_not_active':
    case 'member_archived':
    case 'member_at_capacity':
      return 409;
    default:
      return 400;
  }
}
