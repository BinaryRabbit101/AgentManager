/**
 * The assignment engine's HTTP surface as far as M1 takes it (DESIGN §11.1).
 *
 * ```
 * POST   /api/assignments          create from a pattern → { id, warnings, gate? }
 * POST   /api/assignments/solo     { projectId, agentId, prompt, … } → { assignmentId, sessionId }
 * GET    /api/assignments          ?projectId=&status=&phase=&agentId=&limit=
 * GET    /api/assignments/:id      record + members + budget
 * PATCH  /api/assignments/:id      tokenBudget, roundCap, goal   (never members or pattern)
 * POST   /api/assignments/:id/close { reason }
 * ```
 *
 * The rest of §11.1 — `/advance`, `/conversation`, the questions inbox, fleet
 * status, `GET /api/patterns` — belongs to later milestones and is deliberately
 * absent rather than stubbed.
 *
 * Every route registers with the default `remote: 'allow'`. That is the point of
 * D3 and D5 together: `POST /api/assignments/solo` **is** the drag-and-drop
 * launch, and "start an agent from my phone over the tailnet" is the product.
 * Nothing here reads or returns a file's contents, a secret, or a token.
 *
 * Every failure is an {@link OrchestratorError}: the handler turns its `code`,
 * `status` and `details` into foundation's one error shape and never lets a
 * stack reach the client. An error that is *not* one of ours is genuinely
 * unexpected, so it is logged with its stack and answered as a flat 500.
 */
import type { Logger } from 'pino';

import type { HttpResult, RequestContext, ResponseTools } from '../../http/types.js';
import type { RouteDefinition } from '../types.js';

import { InvalidRequestError, OrchestratorError } from './errors.js';
import {
  ASSIGNMENT_PHASES,
  isAssignmentPattern,
  isAssignmentRole,
  isCloseReason,
  type AssignmentMemberRequest,
  type AssignmentPhase,
  type AssignmentScope,
  type AssignmentService,
  type CreateAssignmentRequest,
  type CreateSoloRequest,
  type ListAssignmentsQuery,
  type PreGrant,
} from './types.js';

export interface AssignmentRoutesDeps {
  readonly service: AssignmentService;
  readonly logger: Logger;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function requiredString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InvalidRequestError(`"${field}" is required.`, field);
  }
  return value;
}

function optionalString(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string')
    throw new InvalidRequestError(`"${field}" must be a string.`, field);
  return value;
}

function optionalBoolean(record: Record<string, unknown>, field: string): boolean | undefined {
  const value = record[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') {
    throw new InvalidRequestError(`"${field}" must be true or false.`, field);
  }
  return value;
}

/** `null` is meaningful here — it is how a caller *removes* a budget or a cap. */
function optionalNumberOrNull(
  record: Record<string, unknown>,
  field: string,
): number | null | undefined {
  const value = record[field];
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new InvalidRequestError(`"${field}" must be a positive number or null.`, field);
  }
  return value;
}

function optionalStringArray(
  record: Record<string, unknown>,
  field: string,
): readonly string[] | undefined {
  const value = record[field];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new InvalidRequestError(`"${field}" must be an array of strings.`, field);
  }
  return value as readonly string[];
}

function readScope(record: Record<string, unknown>): AssignmentScope | undefined {
  const raw = asRecord(record['scope']);
  if (raw === undefined) {
    if (record['scope'] === undefined || record['scope'] === null) return undefined;
    throw new InvalidRequestError('"scope" must be an object.', 'scope');
  }
  const paths = optionalStringArray(raw, 'paths') ?? [];
  return {
    paths,
    ...(optionalString(raw, 'description') === undefined
      ? {}
      : { description: optionalString(raw, 'description') as string }),
    ...(optionalString(raw, 'artifactPath') === undefined
      ? {}
      : { artifactPath: optionalString(raw, 'artifactPath') as string }),
  };
}

/**
 * §2.3's `preGrants` — a body-shape read, not a rule check.
 *
 * Whether the named agent actually holds a seat is §9-12's rule and lives in the
 * validator, for the same reason `members[].role` is checked in both places: one
 * answers "that is not a shape I recognise", the other "that is not allowed
 * here", and collapsing them would give one code to two different mistakes.
 */
function readPreGrants(record: Record<string, unknown>): readonly PreGrant[] | undefined {
  const raw = record['preGrants'];
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    throw new InvalidRequestError(
      '"preGrants" must be an array of { agentId, tool }.',
      'preGrants',
    );
  }
  return raw.map((entry, index) => {
    const grant = asRecord(entry);
    if (grant === undefined) {
      throw new InvalidRequestError(`preGrants[${String(index)}] must be an object.`, 'preGrants');
    }
    return {
      agentId: requiredString(grant, 'agentId'),
      tool: requiredString(grant, 'tool'),
    };
  });
}

function readMembers(record: Record<string, unknown>): readonly AssignmentMemberRequest[] {
  const raw = record['members'];
  if (!Array.isArray(raw)) {
    throw new InvalidRequestError('"members" must be an array of { agentId, role }.', 'members');
  }
  return raw.map((entry, index) => {
    const member = asRecord(entry);
    if (member === undefined) {
      throw new InvalidRequestError(`members[${String(index)}] must be an object.`, 'members');
    }
    const role = member['role'];
    // The role vocabulary is checked here *and* in the validator on purpose:
    // this is a body-shape check ("that is not a string I recognise"), while
    // §9-5's is a rule ("that agent did not declare it"). They answer different
    // questions and produce different codes.
    if (!isAssignmentRole(role)) {
      throw new InvalidRequestError(
        `members[${String(index)}].role must be one of the five roles.`,
        'members',
      );
    }
    return { agentId: requiredString(member, 'agentId'), role };
  });
}

function readCreateRequest(body: unknown): CreateAssignmentRequest {
  const record = asRecord(body);
  if (record === undefined) throw new InvalidRequestError('A JSON body is required.');

  const pattern = record['pattern'];
  if (!isAssignmentPattern(pattern)) {
    throw new InvalidRequestError(
      '"pattern" must be one of solo, pair, review, overseer.',
      'pattern',
    );
  }

  const goal = optionalString(record, 'goal');
  const scope = readScope(record);
  const write = optionalBoolean(record, 'write');
  const tokenBudget = optionalNumberOrNull(record, 'tokenBudget');
  const roundCap = optionalNumberOrNull(record, 'roundCap');
  const workItemIds = optionalStringArray(record, 'workItemIds');
  const preGrants = readPreGrants(record);
  // A body-shape read and nothing more (WO5): the id is recorded, never resolved
  // against the library, so a template the owner has since deleted still leaves
  // an honest trace rather than turning into a refusal.
  const templateId = optionalString(record, 'templateId');
  const autoStart = optionalBoolean(record, 'autoStart');

  return {
    projectId: requiredString(record, 'projectId'),
    pattern,
    members: readMembers(record),
    ...(goal === undefined ? {} : { goal }),
    ...(scope === undefined ? {} : { scope }),
    ...(write === undefined ? {} : { write }),
    ...(tokenBudget === undefined ? {} : { tokenBudget }),
    ...(roundCap === undefined ? {} : { roundCap }),
    ...(workItemIds === undefined ? {} : { workItemIds }),
    ...(preGrants === undefined ? {} : { preGrants }),
    ...(templateId === undefined ? {} : { templateId }),
    ...(autoStart === undefined ? {} : { autoStart }),
    // `createdBy` and `parentAssignmentId` are deliberately **not** readable
    // from the body: an HTTP caller that could claim `overseer:<id>` would be
    // choosing which half of §9's rules applies to it.
  };
}

function readSoloRequest(body: unknown): CreateSoloRequest {
  const record = asRecord(body);
  if (record === undefined) throw new InvalidRequestError('A JSON body is required.');

  const role = record['role'];
  if (role !== undefined && role !== null && !isAssignmentRole(role)) {
    throw new InvalidRequestError('"role" must be one of the five roles.', 'role');
  }
  const priority = record['priority'];
  if (priority !== undefined && priority !== 'interactive' && priority !== 'normal') {
    throw new InvalidRequestError('"priority" must be "interactive" or "normal".', 'priority');
  }

  const scope = readScope(record);
  const write = optionalBoolean(record, 'write');
  const workItemIds = optionalStringArray(record, 'workItemIds');
  const preGrants = readPreGrants(record);
  const templateId = optionalString(record, 'templateId');
  const goal = optionalString(record, 'goal');

  return {
    projectId: requiredString(record, 'projectId'),
    agentId: requiredString(record, 'agentId'),
    prompt: requiredString(record, 'prompt'),
    ...(role === undefined || role === null ? {} : { role }),
    ...(priority === undefined ? {} : { priority }),
    ...(scope === undefined ? {} : { scope }),
    ...(write === undefined ? {} : { write }),
    ...(workItemIds === undefined ? {} : { workItemIds }),
    ...(preGrants === undefined ? {} : { preGrants }),
    ...(templateId === undefined ? {} : { templateId }),
    ...(goal === undefined ? {} : { goal }),
  };
}

function readListQuery(req: RequestContext): ListAssignmentsQuery {
  const status = req.query.get('status');
  if (status !== null && status !== 'open' && status !== 'closed') {
    throw new InvalidRequestError('"status" must be open or closed.', 'status');
  }
  const phase = req.query.get('phase');
  if (phase !== null && !(ASSIGNMENT_PHASES as readonly string[]).includes(phase)) {
    throw new InvalidRequestError(
      `"phase" must be one of ${ASSIGNMENT_PHASES.join(', ')}.`,
      'phase',
    );
  }
  const limitRaw = req.query.get('limit');
  const limit = limitRaw === null ? undefined : Number.parseInt(limitRaw, 10);
  if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
    throw new InvalidRequestError('"limit" must be a positive integer.', 'limit');
  }

  return {
    ...(req.query.get('projectId') === null
      ? {}
      : { projectId: req.query.get('projectId') as string }),
    ...(status === null ? {} : { status }),
    ...(phase === null ? {} : { phase: phase as AssignmentPhase }),
    ...(req.query.get('agentId') === null ? {} : { agentId: req.query.get('agentId') as string }),
    ...(limit === undefined ? {} : { limit }),
  };
}

/**
 * Runs a handler, turning a typed refusal into its declared status and code.
 *
 * One place, so every route answers refusals the same way and no handler has to
 * remember which of them can throw what.
 */
async function answering(
  logger: Logger,
  req: RequestContext,
  res: ResponseTools,
  handler: () => Promise<HttpResult>,
): Promise<HttpResult> {
  try {
    return await handler();
  } catch (error) {
    if (error instanceof OrchestratorError) {
      req.logger.debug(
        { code: error.code, status: error.status },
        `assignment request refused: ${error.message}`,
      );
      return res.error(error.status, error.code, error.message, { ...error.details });
    }
    logger.error({ err: error, path: req.path }, 'unhandled error in an assignment route');
    return res.error(500, 'internal_error', 'The request could not be completed.');
  }
}

export function createAssignmentRoutes(deps: AssignmentRoutesDeps): readonly RouteDefinition[] {
  const { service, logger } = deps;

  return [
    {
      method: 'POST',
      path: '/api/assignments',
      description: 'Create an assignment from a pattern',
      handler: (req, res) =>
        answering(logger, req, res, async () => {
          const result = await service.createAssignment(readCreateRequest(req.body));
          return res.json(result, { status: 201 });
        }),
    },
    {
      method: 'POST',
      path: '/api/assignments/solo',
      description: 'Create a solo assignment and start its first session',
      handler: (req, res) =>
        answering(logger, req, res, async () => {
          const result = await service.createSolo(readSoloRequest(req.body));
          return res.json(result, { status: 201 });
        }),
    },
    {
      method: 'GET',
      path: '/api/assignments',
      description: 'List assignments',
      handler: (req, res) =>
        answering(logger, req, res, () =>
          Promise.resolve(res.json({ assignments: service.list(readListQuery(req)) })),
        ),
    },
    {
      method: 'GET',
      path: '/api/assignments/:id',
      description: 'One assignment with its members',
      handler: (req, res) =>
        answering(logger, req, res, () =>
          Promise.resolve(res.json(service.get(req.params['id'] ?? ''))),
        ),
    },
    {
      method: 'PATCH',
      path: '/api/assignments/:id',
      description: 'Change an assignment budget, round cap or goal',
      handler: (req, res) =>
        answering(logger, req, res, () => {
          const record = asRecord(req.body);
          if (record === undefined) throw new InvalidRequestError('A JSON body is required.');
          const tokenBudget = optionalNumberOrNull(record, 'tokenBudget');
          const roundCap = optionalNumberOrNull(record, 'roundCap');
          const goal = optionalString(record, 'goal');
          return Promise.resolve(
            res.json(
              service.update(req.params['id'] ?? '', {
                ...(tokenBudget === undefined ? {} : { tokenBudget }),
                ...(roundCap === undefined ? {} : { roundCap }),
                ...(goal === undefined ? {} : { goal }),
              }),
            ),
          );
        }),
    },
    {
      method: 'POST',
      path: '/api/assignments/:id/close',
      description: 'Close an assignment',
      handler: (req, res) =>
        answering(logger, req, res, async () => {
          const record = asRecord(req.body) ?? {};
          const reason = record['reason'] ?? 'user_closed';
          if (!isCloseReason(reason)) {
            throw new InvalidRequestError(
              `"reason" must be one of the closed set of close reasons.`,
              'reason',
            );
          }
          const id = req.params['id'] ?? '';
          await service.closeAssignment(id, reason);
          return res.json(service.get(id));
        }),
    },
  ];
}
