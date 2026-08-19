/**
 * The trigger surface (DESIGN §11.1, §2.8; WO8).
 *
 * ```
 * GET    /api/triggers            ?projectId=&enabled=
 * POST   /api/triggers            { projectId, templateId, agentIds, everyMinutes, … }
 * GET    /api/triggers/:id
 * PATCH  /api/triggers/:id        everything but projectId
 * DELETE /api/triggers/:id
 * POST   /api/triggers/:id/run    fire now — the same path as the timer, preflight included
 * ```
 *
 * On foundation's one route table with the default `remote: 'allow'`, and that
 * is the point: "the phone can fire one later" (§2.8). Nothing here returns a
 * file's contents, a secret or a token — a trigger row is a template id, a
 * project id, some agent ids and a schedule.
 *
 * Body reads are shape checks only, exactly as `routes.ts` does them; the rules
 * (a window that neither opens nor closes, an interval of zero, an empty seat
 * list) live in the service, because they are the same rules a `PATCH` has to
 * satisfy and one implementation of them is one too few.
 */
import type { Logger } from 'pino';

import type { HttpResult, RequestContext, ResponseTools } from '../../http/types.js';
import type { RouteDefinition } from '../types.js';

import { InvalidRequestError, OrchestratorError } from './errors.js';
import type { ActiveHours, TriggerPatch } from './triggers.js';
import type { CreateTriggerRequest, TriggerService } from './triggerScheduler.js';

export interface TriggerRoutesDeps {
  readonly triggers: TriggerService;
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

function requiredNumber(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new InvalidRequestError(`"${field}" must be a number.`, field);
  }
  return value;
}

function optionalNumberOrNull(
  record: Record<string, unknown>,
  field: string,
): number | null | undefined {
  const value = record[field];
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new InvalidRequestError(`"${field}" must be a number or null.`, field);
  }
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

function readAgentIds(
  record: Record<string, unknown>,
  required: boolean,
): readonly string[] | undefined {
  const value = record['agentIds'];
  if (value === undefined || value === null) {
    if (!required) return undefined;
    throw new InvalidRequestError('"agentIds" must be an array of agent ids.', 'agentIds');
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new InvalidRequestError('"agentIds" must be an array of agent ids.', 'agentIds');
  }
  return value as readonly string[];
}

/** `null` is meaningful: it is how a caller says "no window — always". */
function readActiveHours(record: Record<string, unknown>): ActiveHours | null | undefined {
  const value = record['activeHours'];
  if (value === undefined) return undefined;
  if (value === null) return null;
  const raw = asRecord(value);
  if (raw === undefined) {
    throw new InvalidRequestError('"activeHours" must be { from, to } or null.', 'activeHours');
  }
  return { from: requiredNumber(raw, 'from'), to: requiredNumber(raw, 'to') };
}

function readVariables(
  record: Record<string, unknown>,
): Readonly<Record<string, string>> | undefined {
  const value = record['variables'];
  if (value === undefined || value === null) return undefined;
  const raw = asRecord(value);
  if (raw === undefined) {
    throw new InvalidRequestError('"variables" must be an object of strings.', 'variables');
  }
  const values: Record<string, string> = {};
  for (const [key, entry] of Object.entries(raw)) {
    if (typeof entry !== 'string') {
      throw new InvalidRequestError(`"variables.${key}" must be a string.`, 'variables');
    }
    values[key] = entry;
  }
  return values;
}

function readCreate(body: unknown): CreateTriggerRequest {
  const record = asRecord(body);
  if (record === undefined) throw new InvalidRequestError('A JSON body is required.');
  const activeHours = readActiveHours(record);
  const enabled = optionalBoolean(record, 'enabled');
  const variables = readVariables(record);
  const maxRunsPerDay = optionalNumberOrNull(record, 'maxRunsPerDay');
  return {
    projectId: requiredString(record, 'projectId'),
    templateId: requiredString(record, 'templateId'),
    agentIds: readAgentIds(record, true) ?? [],
    everyMinutes: requiredNumber(record, 'everyMinutes'),
    ...(activeHours === undefined ? {} : { activeHours }),
    ...(enabled === undefined ? {} : { enabled }),
    ...(variables === undefined ? {} : { variables }),
    ...(maxRunsPerDay === undefined ? {} : { maxRunsPerDay }),
  };
}

function readPatch(body: unknown): TriggerPatch {
  const record = asRecord(body);
  if (record === undefined) throw new InvalidRequestError('A JSON body is required.');
  // `projectId` is deliberately not readable: a schedule moved to another
  // project is a different schedule, and the assignments carrying its id would
  // then describe work on a project it never ran against.
  const templateId = record['templateId'];
  if (templateId !== undefined && (typeof templateId !== 'string' || templateId.trim() === '')) {
    throw new InvalidRequestError('"templateId" must be a non-empty string.', 'templateId');
  }
  const everyMinutes = record['everyMinutes'];
  if (everyMinutes !== undefined && typeof everyMinutes !== 'number') {
    throw new InvalidRequestError('"everyMinutes" must be a number.', 'everyMinutes');
  }
  const agentIds = readAgentIds(record, false);
  const activeHours = readActiveHours(record);
  const enabled = optionalBoolean(record, 'enabled');
  const variables = readVariables(record);
  const maxRunsPerDay = optionalNumberOrNull(record, 'maxRunsPerDay');
  return {
    ...(templateId === undefined ? {} : { templateId }),
    ...(agentIds === undefined ? {} : { agentIds }),
    ...(everyMinutes === undefined ? {} : { everyMinutes }),
    ...(activeHours === undefined ? {} : { activeHours }),
    ...(enabled === undefined ? {} : { enabled }),
    ...(variables === undefined ? {} : { variables }),
    ...(maxRunsPerDay === undefined ? {} : { maxRunsPerDay }),
  };
}

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
        `trigger request refused: ${error.message}`,
      );
      return res.error(error.status, error.code, error.message, { ...error.details });
    }
    logger.error({ err: error, path: req.path }, 'unhandled error in a trigger route');
    return res.error(500, 'internal_error', 'The request could not be completed.');
  }
}

export function createTriggerRoutes(deps: TriggerRoutesDeps): readonly RouteDefinition[] {
  const { triggers, logger } = deps;

  return [
    {
      method: 'GET',
      path: '/api/triggers',
      description: 'List background triggers',
      handler: (req, res) =>
        answering(logger, req, res, () => {
          const enabled = req.query.get('enabled');
          if (enabled !== null && enabled !== 'true' && enabled !== 'false') {
            throw new InvalidRequestError('"enabled" must be true or false.', 'enabled');
          }
          return Promise.resolve(
            res.json({
              triggers: triggers.list({
                ...(req.query.get('projectId') === null
                  ? {}
                  : { projectId: req.query.get('projectId') as string }),
                ...(enabled === null ? {} : { enabled: enabled === 'true' }),
              }),
            }),
          );
        }),
    },
    {
      method: 'POST',
      path: '/api/triggers',
      description: 'Create a background trigger',
      handler: (req, res) =>
        answering(logger, req, res, () =>
          Promise.resolve(res.json(triggers.create(readCreate(req.body)), { status: 201 })),
        ),
    },
    {
      method: 'GET',
      path: '/api/triggers/:id',
      description: 'One background trigger',
      handler: (req, res) =>
        answering(logger, req, res, () =>
          Promise.resolve(res.json(triggers.get(req.params['id'] ?? ''))),
        ),
    },
    {
      method: 'PATCH',
      path: '/api/triggers/:id',
      description: 'Change a trigger schedule, seats, variables or enabled state',
      handler: (req, res) =>
        answering(logger, req, res, () =>
          Promise.resolve(res.json(triggers.update(req.params['id'] ?? '', readPatch(req.body)))),
        ),
    },
    {
      method: 'DELETE',
      path: '/api/triggers/:id',
      description: 'Delete a background trigger',
      handler: (req, res) =>
        answering(logger, req, res, () => {
          triggers.remove(req.params['id'] ?? '');
          return Promise.resolve(res.json({ deleted: true }));
        }),
    },
    {
      method: 'POST',
      path: '/api/triggers/:id/run',
      description: 'Fire a trigger now — the same path as the timer, preflight included',
      handler: (req, res) =>
        answering(logger, req, res, async () => {
          const id = req.params['id'] ?? '';
          const result = await triggers.fire(id);
          // 200 whatever the outcome: a skip and a block are *answers*, not
          // failures of the request, and the caller renders the reason. A 409
          // here would make "Run now" look broken on the one day it correctly
          // refused to launch into a dead connector.
          return res.json({ ...result, trigger: triggers.get(id) });
        }),
    },
  ];
}
