/**
 * The HTTP surface of DESIGN §9.1, minus the endpoints that belong to later
 * milestones (IMPLEMENTATION M3).
 *
 * ```
 * GET    /api/roster/agents                 list + uiState + diagnostics
 * POST   /api/roster/agents                 create; id derived from name
 * GET    /api/roster/agents/:id             definition + resolved persona
 * PATCH  /api/roster/agents/:id             partial update; id immutable
 * DELETE /api/roster/agents/:id[?purge]     archive, or purge when nothing refers to it
 * POST   /api/roster/agents/:id/duplicate   deep copy + new id
 * GET    /api/roster/agents/:id/avatar      image, or a generated placeholder
 * PUT    /api/roster/agents/:id/avatar      upload → avatar.png
 * DELETE /api/roster/agents/:id/avatar      back to initials
 * PATCH  /api/roster/agents/:id/ui-state    { pinned }
 * PUT    /api/roster/board-order            { order: string[] }
 * ```
 *
 * `/draft`, `/export`, `/import` and `/validate` are deliberately absent rather
 * than stubbed — they are M8, M9 and M9 respectively, and a route that answers
 * 501 is a promise this milestone did not make.
 *
 * Every failure is a typed refusal translated in one place: a
 * {@link RosterServiceError} carries its own status and code, a
 * {@link RosterValidationError} is always a 400 whose body names the offending
 * field paths, and anything else is genuinely unexpected and answers as a flat
 * 500 with the stack in the log rather than in the response.
 *
 * All routes are registered with the default `remote: 'allow'`. Editing the
 * roster from the tailnet browser is the point of D3 — "one UI codebase", two
 * delivery modes — and nothing here reads or writes anywhere but the library.
 */
import type { Logger } from 'pino';

import type { HttpResult, RequestContext, ResponseTools } from '../../http/types.js';
import type { RouteDefinition } from '../types.js';

import { readAvatarUpload } from './avatar.js';
import { RosterValidationError } from './errors.js';
import type { RosterService } from './service.js';
import { RosterServiceError } from './serviceErrors.js';

export interface RosterRoutesDeps {
  readonly service: RosterService;
  readonly logger: Logger;
}

/** The path prefix every roster route hangs off (§9.1). */
export const ROSTER_API_PREFIX = '/api/roster';

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Runs a handler, turning a typed refusal into its declared status and code.
 *
 * One place, so every route answers refusals the same way and no handler has to
 * remember which of them can throw what.
 */
function answering(
  logger: Logger,
  req: RequestContext,
  res: ResponseTools,
  handler: () => HttpResult,
): HttpResult {
  try {
    return handler();
  } catch (error) {
    if (error instanceof RosterServiceError) {
      req.logger.debug(
        { code: error.code, status: error.status, ...error.details },
        `roster request refused: ${error.message}`,
      );
      return res.error(error.status, error.code, error.message, { ...error.details });
    }
    if (error instanceof RosterValidationError) {
      req.logger.debug({ issues: error.issues }, `roster definition rejected: ${error.message}`);
      return res.error(400, 'invalid_definition', error.message, {
        issues: error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
      });
    }
    logger.error({ err: error, path: req.path }, 'unexpected failure in a roster route');
    return res.error(
      500,
      'internal_error',
      'The roster could not complete the request. See the core log for detail.',
    );
  }
}

export function createRosterRoutes(deps: RosterRoutesDeps): RouteDefinition[] {
  const { service, logger } = deps;
  const id = (req: RequestContext): string => req.params['id'] ?? '';

  return [
    {
      method: 'GET',
      path: `${ROSTER_API_PREFIX}/agents`,
      description: 'Lists the roster with board state and diagnostics.',
      handler: (req, res) => answering(logger, req, res, () => res.json(service.list())),
    },

    {
      method: 'POST',
      path: `${ROSTER_API_PREFIX}/agents`,
      description: 'Creates an agent; the id is derived from the name when absent.',
      handler: (req, res) =>
        answering(logger, req, res, () => {
          const view = service.create(req.body);
          return res.json(view, {
            status: 201,
            // The UI follows this rather than reassembling the URL from the id,
            // which matters here because the id it gets may be suffixed.
            headers: {
              location: `${ROSTER_API_PREFIX}/agents/${encodeURIComponent(view.definition.id)}`,
            },
          });
        }),
    },

    {
      method: 'GET',
      path: `${ROSTER_API_PREFIX}/agents/:id`,
      description: 'One agent: the full definition and its resolved persona text.',
      handler: (req, res) => answering(logger, req, res, () => res.json(service.get(id(req)))),
    },

    {
      method: 'PATCH',
      path: `${ROSTER_API_PREFIX}/agents/:id`,
      description: 'Partially updates an agent. The id and meta.createdAt are immutable.',
      handler: (req, res) =>
        answering(logger, req, res, () => res.json(service.patch(id(req), req.body))),
    },

    {
      method: 'DELETE',
      path: `${ROSTER_API_PREFIX}/agents/:id`,
      description: 'Archives an agent; ?purge=true removes it when no session refers to it.',
      handler: (req, res) =>
        answering(logger, req, res, () => {
          // `?purge` with no value is the shell-friendly spelling of `?purge=true`.
          const raw = req.query.get('purge');
          const purge = raw !== null && raw !== 'false' && raw !== '0';
          return res.json(service.remove(id(req), { purge }));
        }),
    },

    {
      method: 'POST',
      path: `${ROSTER_API_PREFIX}/agents/:id/duplicate`,
      description: 'Deep-copies an agent folder under a new id (persona, roles, skills, avatar).',
      handler: (req, res) =>
        answering(logger, req, res, () => {
          const view = service.duplicate(id(req), req.body ?? {});
          return res.json(view, {
            status: 201,
            headers: {
              location: `${ROSTER_API_PREFIX}/agents/${encodeURIComponent(view.definition.id)}`,
            },
          });
        }),
    },

    {
      method: 'GET',
      path: `${ROSTER_API_PREFIX}/agents/:id/avatar`,
      description: 'The agent’s image, or a generated placeholder for emoji and initials.',
      handler: (req, res) =>
        answering(logger, req, res, () => {
          const image = service.avatarImage(id(req));
          return res.bytes(image.bytes, image.contentType, {
            // The bytes change under a fixed URL whenever the owner uploads a
            // new avatar, and a cached stale face on the board looks like a bug.
            headers: { 'cache-control': 'no-cache' },
          });
        }),
    },

    {
      method: 'PUT',
      path: `${ROSTER_API_PREFIX}/agents/:id/avatar`,
      description: 'Uploads an image, stored in the agent folder as avatar.png.',
      handler: (req, res) =>
        answering(logger, req, res, () => {
          const upload = readAvatarUpload({
            body: req.body,
            contentType: req.headers['content-type'],
          });
          return res.json(service.putAvatar(id(req), upload));
        }),
    },

    {
      method: 'DELETE',
      path: `${ROSTER_API_PREFIX}/agents/:id/avatar`,
      description: 'Removes the uploaded image and reverts the agent to initials.',
      handler: (req, res) =>
        answering(logger, req, res, () => res.json(service.deleteAvatar(id(req)))),
    },

    {
      method: 'PATCH',
      path: `${ROSTER_API_PREFIX}/agents/:id/ui-state`,
      description: 'Sets the board-owned fields that are not definition fields ({ pinned }).',
      handler: (req, res) =>
        answering(logger, req, res, () => res.json(service.patchUiState(id(req), req.body))),
    },

    {
      method: 'PUT',
      path: `${ROSTER_API_PREFIX}/board-order`,
      description: 'Rewrites the whole board order in one transaction.',
      handler: (req, res) =>
        answering(logger, req, res, () =>
          res.json(service.setBoardOrder(asRecord(req.body)?.['order'])),
        ),
    },
  ];
}
