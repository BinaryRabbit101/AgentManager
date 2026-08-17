/**
 * The registry's HTTP surface as far as M4 and M6 take it (projects DESIGN §5).
 *
 * ```
 * POST   /api/projects/inspect                      { localPath } → prefilled form   (M2)
 * POST   /api/projects                              register an existing folder      (M2)
 * GET    /api/projects                              list (+ health)                  (M4)
 * GET    /api/projects/:id                          full record + defaults + health  (M4)
 * PATCH  /api/projects/:id                          name, notes, defaults, policy    (M4)
 * GET    /api/projects/:id/health                   the derived payload of §2.3      (M4)
 * GET    /api/projects/:id/workspaces               leases + "review needed" (§4.4)  (M6)
 * POST   /api/projects/:id/workspaces/:lid/cleanup  the confirmed removal (§4.4)     (M6)
 * ```
 *
 * The rest of §5's surface — clone, archive/restore, delete, activity, work
 * items, browse — belongs to later milestones and is deliberately absent rather
 * than stubbed.
 *
 * `GET /api/projects/:id` carries `defaults.permissionElevation` in full,
 * including its reason, because §5 requires the UI to be able to warn *before* a
 * launch rather than after.
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

import { browse, type BrowseDeps, type BrowseListing } from './browse.js';
import { InvalidRequestError, ProjectsError } from './errors.js';
import type { CreateProjectRequest, ProjectsService } from './service.js';
import { isWorkspacePolicy } from './types.js';

export interface ProjectRoutesDeps {
  readonly service: ProjectsService;
  readonly logger: Logger;
  /**
   * The folder picker's roots (§2.1). Absent leaves the route unregistered
   * rather than answering an empty listing, because "there is nowhere to browse"
   * and "browsing is not built" must not look the same to the client.
   */
  readonly browse?: BrowseDeps;
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
  const browseDeps = deps.browse;

  return [
    ...(browseDeps === undefined
      ? []
      : [
          {
            method: 'GET' as const,
            path: '/api/fs/browse',
            // remote §3.3 decided this one explicitly: allowed over the tailnet,
            // because "project registration is never stranded on the desktop"
            // (ui §8.1). Containment is the whole of its access control, and it
            // lives in `browse.ts`.
            remote: 'allow' as const,
            description: 'Directory-only listing inside the configured browse roots (§2.1).',
            handler: (req: RequestContext, res: ResponseTools): Promise<HttpResult> =>
              answering(logger, req, res, () => {
                const listing: BrowseListing = browse(browseDeps, req.query.get('path'));
                return Promise.resolve(res.json(listing));
              }),
          },
        ]),

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

    {
      method: 'GET',
      path: '/api/projects',
      description: 'Lists registered projects with their derived health.',
      handler: (req, res) =>
        answering(logger, req, res, () => {
          const includeArchived = req.query.get('includeArchived') === 'true';
          const projects = service
            .list(includeArchived ? { includeArchived: true } : {})
            .map((project) => ({ ...project, health: service.health(project.id).conditions }));
          return Promise.resolve(res.json({ projects }));
        }),
    },

    {
      method: 'GET',
      path: '/api/projects/:id',
      description: 'One project: full record, defaults (elevation included) and health.',
      handler: (req, res) =>
        answering(logger, req, res, () => {
          const project = service.get(readId(req.params));
          return Promise.resolve(
            res.json({ ...project, health: service.health(project.id).conditions }),
          );
        }),
    },

    {
      method: 'PATCH',
      path: '/api/projects/:id',
      description: 'Updates name, notes, defaults, workspace policy or retention.',
      handler: (req, res) =>
        answering(logger, req, res, () => {
          const project = service.update(readId(req.params), req.body);
          return Promise.resolve(
            res.json({ ...project, health: service.health(project.id).conditions }),
          );
        }),
    },

    {
      method: 'GET',
      path: '/api/projects/:id/health',
      description: 'The derived health payload (§2.3): never stored, always computed.',
      handler: (req, res) =>
        answering(logger, req, res, () =>
          Promise.resolve(res.json(service.health(readId(req.params)))),
        ),
    },

    {
      method: 'GET',
      path: '/api/projects/:id/workspaces',
      description: 'Workspace leases, with the "review needed" state of retained worktrees.',
      handler: (req, res) =>
        answering(logger, req, res, async () => {
          const id = readId(req.params);
          // Reads the project first, so an unknown id is a 404 rather than an
          // empty list that looks like "this project has no workspaces".
          service.get(id);
          return res.json({ workspaces: await service.listWorkspaces(id) });
        }),
    },

    {
      method: 'POST',
      path: '/api/projects/:id/workspaces/:leaseId/cleanup',
      description: 'Removes a retained worktree after the user has confirmed it (§4.4).',
      handler: (req, res) =>
        answering(logger, req, res, async () => {
          service.get(readId(req.params));
          const leaseId = req.params['leaseId'];
          if (leaseId === undefined || leaseId.length === 0) {
            throw new InvalidRequestError('A workspace lease id is required.', 'leaseId');
          }
          return res.json(await service.cleanupWorkspace(leaseId));
        }),
    },
  ];
}

/** The `:id` segment, which the router always supplies for a matched route. */
function readId(params: Readonly<Record<string, string>>): string {
  const id = params['id'];
  if (id === undefined || id.length === 0) {
    throw new InvalidRequestError('A project id is required.', 'id');
  }
  return id;
}
