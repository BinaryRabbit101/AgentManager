/**
 * The two routes of M2 (projects DESIGN §5).
 *
 * ```
 * POST /api/projects/inspect   { localPath } → prefilled form
 * POST /api/projects           register an existing folder
 * ```
 *
 * The rest of §5's surface — list, get, patch, archive, activity, health,
 * workspaces, work items, browse — belongs to later milestones and is
 * deliberately absent rather than stubbed.
 *
 * Both routes are registered with the default `remote: 'allow'`. Registering a
 * project from the tailnet browser is the D3 requirement that the UI works
 * identically in Electron and remotely, and neither route reads or returns file
 * *contents* — the filesystem-exposure surface §2.1 worries about is
 * `GET /api/fs/browse`, which lands in M9 with its own containment rules.
 *
 * Every failure here is a {@link ProjectsError}: the handler translates its
 * `code`, `status` and `details` into foundation's one error shape and never
 * lets a stack reach the client (M2's acceptance). An error that is *not* one of
 * ours is genuinely unexpected, so it is logged with its stack and answered as a
 * flat 500.
 */
import type { Logger } from 'pino';

import type { HttpResult, RequestContext, ResponseTools } from '../../http/types.js';
import type { RouteDefinition } from '../types.js';

import { InvalidRequestError, ProjectsError } from './errors.js';
import type { CreateProjectRequest, ProjectsService } from './service.js';
import { isWorkspacePolicy } from './types.js';

export interface ProjectRoutesDeps {
  readonly service: ProjectsService;
  readonly logger: Logger;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** `{ localPath }` — the one genuinely required input of the whole flow (§7.8). */
function readLocalPath(body: unknown): string {
  const record = asRecord(body);
  const value = record?.['localPath'];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InvalidRequestError(
      'A local folder path is required, as {"localPath": "C:\\\\Code\\\\App"}.',
      'localPath',
    );
  }
  return value;
}

function readCreateRequest(body: unknown): CreateProjectRequest {
  const localPath = readLocalPath(body);
  const record = asRecord(body) ?? {};

  const name = record['name'];
  const slug = record['slug'];
  const notes = record['notes'];
  const workspacePolicy = record['workspacePolicy'];

  if (name !== undefined && typeof name !== 'string') {
    throw new InvalidRequestError('"name" must be a string.', 'name');
  }
  if (slug !== undefined && typeof slug !== 'string') {
    throw new InvalidRequestError('"slug" must be a string.', 'slug');
  }
  if (notes !== undefined && typeof notes !== 'string') {
    throw new InvalidRequestError('"notes" must be a Markdown string.', 'notes');
  }
  if (workspacePolicy !== undefined && !isWorkspacePolicy(workspacePolicy)) {
    throw new InvalidRequestError(
      '"workspacePolicy" must be auto, shared or worktree.',
      'workspacePolicy',
    );
  }

  return {
    localPath,
    ...(name === undefined ? {} : { name }),
    ...(slug === undefined ? {} : { slug }),
    ...(notes === undefined ? {} : { notes }),
    ...(workspacePolicy === undefined ? {} : { workspacePolicy }),
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
    if (error instanceof ProjectsError) {
      req.logger.debug(
        { code: error.code, status: error.status, ...error.details },
        `project request refused: ${error.message}`,
      );
      return res.error(error.status, error.code, error.message, { ...error.details });
    }
    logger.error({ err: error, path: req.path }, 'unexpected failure in a projects route');
    return res.error(
      500,
      'internal_error',
      'The project registry could not complete the request. See the core log for detail.',
    );
  }
}

export function createProjectRoutes(deps: ProjectRoutesDeps): RouteDefinition[] {
  const { service, logger } = deps;

  return [
    {
      method: 'POST',
      path: '/api/projects/inspect',
      description: 'Inspects a local folder and returns a pre-filled registration form.',
      handler: (req, res) =>
        answering(logger, req, res, async () => {
          const inspection = await service.inspect(readLocalPath(req.body));
          return res.json(inspection);
        }),
    },

    {
      method: 'POST',
      path: '/api/projects',
      description: 'Registers an existing folder as a project.',
      handler: (req, res) =>
        answering(logger, req, res, async () => {
          const project = await service.create(readCreateRequest(req.body));
          return res.json(project, {
            status: 201,
            // The UI follows this rather than reassembling the URL from the id.
            headers: { location: `/api/projects/${project.id}` },
          });
        }),
    },
  ];
}
