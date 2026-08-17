/**
 * The registry's HTTP surface (projects DESIGN §5).
 *
 * ```
 * POST   /api/projects/inspect                      { localPath } | { repoUrl }      (M2, M3)
 * POST   /api/projects                              register an existing folder      (M2)
 * POST   /api/projects/clone                        clone + register, returns the id (M3)
 * GET    /api/projects                              list (+ health)                  (M4)
 * GET    /api/projects/:id                          full record + defaults + health  (M4)
 * PATCH  /api/projects/:id                          name, notes, defaults, policy    (M4)
 * DELETE /api/projects/:id                          ?pruneTranscripts=true|false     (M9)
 * POST   /api/projects/:id/archive|restore|relocate lifecycle (§2.3)                 (M9)
 * GET    /api/projects/:id/health                   the derived payload of §2.3      (M4, M9)
 * GET    /api/projects/:id/activity                 §3.1's timeline, paged           (M5)
 * GET    /api/projects/:id/workspaces               leases + "review needed" (§4.4)  (M6)
 * POST   /api/projects/:id/workspaces/:lid/cleanup  the confirmed removal (§4.4)     (M6)
 * GET    /api/projects/:id/work-items               ?status=                         (M8)
 * POST   /api/projects/:id/work-items               create one                       (M8)
 * PATCH  /api/work-items/:id                        title, body, kind, status, rank  (M8)
 * ```
 *
 * `GET /api/projects/:id` carries `defaults.permissionElevation` in full,
 * including its reason, because §5 requires the UI to be able to warn *before* a
 * launch rather than after.
 *
 * Every route is registered with the default `remote: 'allow'`. Registering a
 * project from the tailnet browser is the D3 requirement that the UI works
 * identically in Electron and remotely, and no route reads or returns file
 * *contents* — the filesystem-exposure surface §2.1 worries about is
 * `GET /api/fs/browse`, which carries its own containment rules.
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
import type { CloneProjectRequest } from './clone.js';
import { InvalidRequestError, ProjectsError } from './errors.js';
import type { CreateProjectRequest, ProjectsService } from './service.js';
import { isWorkItemKind, isWorkItemStatus, isWorkspacePolicy } from './types.js';
import type { CreateWorkItemInput, UpdateWorkItemPatch } from './workItems.js';

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

/** `{ repoUrl, targetPath?, name?, slug?, … }` — §2.2's clone form. */
function readCloneRequest(body: unknown): CloneProjectRequest {
  const record = asRecord(body) ?? {};
  const repoUrl = record['repoUrl'];
  if (typeof repoUrl !== 'string' || repoUrl.trim().length === 0) {
    throw new InvalidRequestError(
      'A repository URL is required, as {"repoUrl": "https://github.com/owner/repo.git"}.',
      'repoUrl',
    );
  }

  const targetPath = record['targetPath'];
  const name = record['name'];
  const slug = record['slug'];
  const notes = record['notes'];
  const workspacePolicy = record['workspacePolicy'];

  if (targetPath !== undefined && typeof targetPath !== 'string') {
    throw new InvalidRequestError('"targetPath" must be a string.', 'targetPath');
  }
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
    repoUrl,
    ...(targetPath === undefined ? {} : { targetPath }),
    ...(name === undefined ? {} : { name }),
    ...(slug === undefined ? {} : { slug }),
    ...(notes === undefined ? {} : { notes }),
    ...(workspacePolicy === undefined ? {} : { workspacePolicy }),
  };
}

/** A repo-relative scope-path hint on a work item (§1.5). Shape-checked only. */
function readScopePaths(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new InvalidRequestError(`"${field}" must be an array of repo-relative paths.`, field);
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      throw new InvalidRequestError(
        `"${field}[${String(index)}]" must be a non-empty string.`,
        field,
      );
    }
    return entry;
  });
}

function readCreateWorkItem(body: unknown): Omit<CreateWorkItemInput, 'projectId'> {
  const record = asRecord(body) ?? {};
  const title = record['title'];
  if (typeof title !== 'string' || title.trim().length === 0) {
    throw new InvalidRequestError('"title" is required and must be one non-empty line.', 'title');
  }
  const kind = record['kind'] ?? 'chore';
  if (!isWorkItemKind(kind)) {
    throw new InvalidRequestError('"kind" must be bug, feature, chore or question.', 'kind');
  }
  const body_ = record['body'];
  if (body_ !== undefined && typeof body_ !== 'string') {
    throw new InvalidRequestError('"body" must be a Markdown string.', 'body');
  }
  const rank = record['rank'];
  if (rank !== undefined && (typeof rank !== 'number' || !Number.isFinite(rank))) {
    throw new InvalidRequestError('"rank" must be a number.', 'rank');
  }
  const scopePaths =
    record['scopePaths'] === undefined
      ? undefined
      : readScopePaths(record['scopePaths'], 'scopePaths');

  return {
    kind,
    title: title.trim(),
    ...(body_ === undefined ? {} : { body: body_ }),
    ...(rank === undefined ? {} : { rank }),
    ...(scopePaths === undefined ? {} : { scopePaths }),
    // §1.5: `source` is `user` from this endpoint by definition — an overseer
    // creates items through the internal surface, not over HTTP.
    source: 'user' as const,
  };
}

function readWorkItemPatch(body: unknown): UpdateWorkItemPatch {
  const record = asRecord(body);
  if (record === undefined) throw new InvalidRequestError('The body must be an object.', 'body');
  const known = new Set(['kind', 'title', 'body', 'status', 'rank', 'scopePaths']);
  for (const key of Object.keys(record)) {
    if (!known.has(key)) {
      throw new InvalidRequestError(
        `"${key}" is not patchable on a work item. PATCH accepts title, body, kind, status, rank and scopePaths (DESIGN §5).`,
        key,
      );
    }
  }

  let patch: UpdateWorkItemPatch = {};

  if (record['kind'] !== undefined) {
    if (!isWorkItemKind(record['kind'])) {
      throw new InvalidRequestError('"kind" must be bug, feature, chore or question.', 'kind');
    }
    patch = { ...patch, kind: record['kind'] };
  }
  if (record['title'] !== undefined) {
    const title = record['title'];
    if (typeof title !== 'string' || title.trim().length === 0) {
      throw new InvalidRequestError('"title" must be one non-empty line.', 'title');
    }
    patch = { ...patch, title: title.trim() };
  }
  if (record['body'] !== undefined) {
    if (typeof record['body'] !== 'string') {
      throw new InvalidRequestError('"body" must be a Markdown string.', 'body');
    }
    patch = { ...patch, body: record['body'] };
  }
  if (record['status'] !== undefined) {
    if (!isWorkItemStatus(record['status'])) {
      throw new InvalidRequestError(
        '"status" must be open, in_progress, done or dropped.',
        'status',
      );
    }
    patch = { ...patch, status: record['status'] };
  }
  if (record['rank'] !== undefined) {
    const rank = record['rank'];
    if (typeof rank !== 'number' || !Number.isFinite(rank)) {
      throw new InvalidRequestError('"rank" must be a number.', 'rank');
    }
    patch = { ...patch, rank };
  }
  if (record['scopePaths'] !== undefined) {
    patch = { ...patch, scopePaths: readScopePaths(record['scopePaths'], 'scopePaths') };
  }

  return patch;
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
      description: 'Inspects a local folder, or a repository URL, into a pre-filled form.',
      handler: (req, res) =>
        answering(logger, req, res, async () => {
          // One endpoint, two flows (§2.1 and §2.2): the body says which by
          // carrying `repoUrl` or `localPath`. A single route keeps the UI's
          // quick-add dialog from having to know which server call belongs to
          // which tab.
          const repoUrl = asRecord(req.body)?.['repoUrl'];
          if (repoUrl !== undefined) {
            return res.json(service.inspectRepoUrl(repoUrl, asRecord(req.body)?.['targetPath']));
          }
          const inspection = await service.inspect(readLocalPath(req.body));
          return res.json(inspection);
        }),
    },

    {
      method: 'POST',
      path: '/api/projects/clone',
      description: 'Clones a repository and registers it; returns the id immediately (§2.2).',
      handler: (req, res) =>
        answering(logger, req, res, () => {
          const started = service.clone(readCloneRequest(req.body));
          // The job outlives the request by design (§2.2 step 3): failures reach
          // the client on the event bus, not on this response, so the promise is
          // deliberately not awaited — only its rejection is neutralised, since
          // nothing else is listening for one.
          started.completed.catch(() => undefined);
          return Promise.resolve(
            res.json(started.project, {
              // 202: the row exists, the checkout does not yet.
              status: 202,
              headers: { location: `/api/projects/${started.project.id}` },
            }),
          );
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
        answering(logger, req, res, async () => {
          // §2.3: archived projects are excluded from the default list. The
          // query parameter is what the archive view sends.
          const includeArchived = req.query.get('includeArchived') === 'true';
          const projects = await Promise.all(
            service.list(includeArchived ? { includeArchived: true } : {}).map(async (project) => ({
              ...project,
              health: (await service.health(project.id)).conditions,
            })),
          );
          return res.json({ projects });
        }),
    },

    {
      method: 'GET',
      path: '/api/projects/:id',
      description: 'One project: full record, defaults (elevation included) and health.',
      handler: (req, res) =>
        answering(logger, req, res, async () => {
          const project = service.get(readId(req.params));
          return res.json({
            ...project,
            health: (await service.health(project.id)).conditions,
          });
        }),
    },

    {
      method: 'PATCH',
      path: '/api/projects/:id',
      description: 'Updates name, notes, defaults, workspace policy or retention.',
      handler: (req, res) =>
        answering(logger, req, res, async () => {
          const project = service.update(readId(req.params), req.body);
          return res.json({
            ...project,
            health: (await service.health(project.id)).conditions,
          });
        }),
    },

    {
      method: 'DELETE',
      path: '/api/projects/:id',
      description: 'Removes the registry rows. Never deletes the project folder (§7.10).',
      handler: (req, res) =>
        answering(logger, req, res, async () =>
          res.json(
            await service.remove(readId(req.params), {
              pruneTranscripts: req.query.get('pruneTranscripts') === 'true',
              cleanupWorktrees: req.query.get('cleanupWorktrees') === 'true',
            }),
          ),
        ),
    },

    {
      method: 'POST',
      path: '/api/projects/:id/archive',
      description: 'Hides the project from the board and blocks new assignments (§2.3).',
      handler: (req, res) =>
        answering(logger, req, res, () =>
          Promise.resolve(res.json(service.archive(readId(req.params)))),
        ),
    },

    {
      method: 'POST',
      path: '/api/projects/:id/restore',
      description: 'Puts an archived project back, with its history intact (§2.3).',
      handler: (req, res) =>
        answering(logger, req, res, () =>
          Promise.resolve(res.json(service.restore(readId(req.params)))),
        ),
    },

    {
      method: 'POST',
      path: '/api/projects/:id/relocate',
      description: 'Re-canonicalises a moved folder onto the same project id (§2.3).',
      handler: (req, res) =>
        answering(logger, req, res, async () =>
          res.json(await service.relocate(readId(req.params), readLocalPath(req.body))),
        ),
    },

    {
      method: 'GET',
      path: '/api/projects/:id/health',
      description: 'The derived health payload (§2.3): never stored, always computed.',
      handler: (req, res) =>
        answering(logger, req, res, async () => res.json(await service.health(readId(req.params)))),
    },

    {
      method: 'GET',
      path: '/api/projects/:id/activity',
      description: "§3.1's timeline, grouped by assignment, newest first, paged.",
      handler: (req, res) =>
        answering(logger, req, res, () => {
          const limit = readPositiveInt(req.query.get('limit'), 'limit');
          const offset = readPositiveInt(req.query.get('offset'), 'offset');
          return Promise.resolve(
            res.json(
              service.activity(readId(req.params), {
                ...(limit === undefined ? {} : { limit }),
                ...(offset === undefined ? {} : { offset }),
              }),
            ),
          );
        }),
    },

    {
      method: 'GET',
      path: '/api/projects/:id/work-items',
      description: "The project's backlog, in manual rank order (§1.5).",
      handler: (req, res) =>
        answering(logger, req, res, () => {
          const status = req.query.get('status');
          if (status !== null && !isWorkItemStatus(status)) {
            throw new InvalidRequestError(
              '"status" must be open, in_progress, done or dropped.',
              'status',
            );
          }
          return Promise.resolve(
            res.json({
              workItems: service.listWorkItems(
                readId(req.params),
                status === null ? {} : { status },
              ),
            }),
          );
        }),
    },

    {
      method: 'POST',
      path: '/api/projects/:id/work-items',
      description: 'Adds one backlog item (§1.5).',
      handler: (req, res) =>
        answering(logger, req, res, () => {
          const item = service.createWorkItem(readId(req.params), readCreateWorkItem(req.body));
          return Promise.resolve(
            res.json(item, { status: 201, headers: { location: `/api/work-items/${item.id}` } }),
          );
        }),
    },

    {
      method: 'PATCH',
      path: '/api/work-items/:id',
      description: 'Updates title, body, kind, status, rank or scope paths (§5).',
      handler: (req, res) =>
        answering(logger, req, res, () =>
          Promise.resolve(
            res.json(service.updateWorkItem(readId(req.params), readWorkItemPatch(req.body))),
          ),
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

/** A `?limit=`/`?offset=` value, or `undefined` when the caller omitted it. */
function readPositiveInt(raw: string | null, field: string): number | undefined {
  if (raw === null || raw.trim().length === 0) return undefined;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0) {
    throw new InvalidRequestError(`"${field}" must be a non-negative integer.`, field);
  }
  return value;
}
