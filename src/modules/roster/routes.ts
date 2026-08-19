/**
 * The HTTP surface of DESIGN §9.1, minus the endpoints that belong to later
 * milestones (IMPLEMENTATION M3).
 *
 * ```
 * GET    /api/roster/agents                 list + uiState + diagnostics
 * POST   /api/roster/agents                 create; id derived from name
 * GET    /api/roster/agents/:id             definition + resolved persona
 * PATCH  /api/roster/agents/:id             partial update; id immutable
 * POST   /api/roster/agents/:id/permissions/allow  append one rule to permissions.allow (§6)
 * DELETE /api/roster/agents/:id[?purge]     archive, or purge when nothing refers to it
 * POST   /api/roster/agents/:id/duplicate   deep copy + new id
 * GET    /api/roster/agents/:id/avatar      image, or a generated placeholder
 * PUT    /api/roster/agents/:id/avatar      upload → avatar.png
 * DELETE /api/roster/agents/:id/avatar      back to initials
 * PATCH  /api/roster/agents/:id/ui-state    { pinned }
 * PUT    /api/roster/board-order            { order: string[] }
 * POST   /api/roster/draft                  draft-from-description (§12, M8)
 * POST   /api/roster/agents/:id/validate    dry-run compile (§9.1)
 * GET    /api/roster/agents/:id/export      .agentpack download (§9.4, M9)
 * POST   /api/roster/import[?commit=true]   preview, then write (§9.4, M9)
 * ```
 *
 * That is §9.1's table, plus one route §9.1 does not list.
 *
 * `/permissions/allow` is the durable half of the question card's **Always
 * allow** (runner DESIGN §5.1, owner decision 2026-08-18). It is a route rather
 * than a `PATCH` from the card because the card knows one rule and nothing else
 * about the agent, and a `PATCH` carrying a whole `permissions` block assembled
 * from a stale read is how one client's answer silently reverts another's edit.
 * Underneath it *is* the `PATCH` — see {@link RosterService.allowRule} — so
 * there is still exactly one write path.
 *
 * `/import` is **two-phase and the phases share a route**, which is §9.4's
 * shape: the same bytes are read twice, once to describe what would happen and
 * once to do it, and a separate `/import/preview` endpoint would let the two
 * answers drift. The preview is a 200 and the commit a 201, so a caller can tell
 * from the status alone whether anything was written.
 *
 * `/validate` is listed in §9.1 beside them but landed with M3 rather than with
 * the pack format: the ui's launch flow was already written against it and
 * degraded by *probing for a 404* (`web/src/launch/permissionPreview.ts`), which
 * is the one shape of feature detection that element's own rules forbid — so the
 * route existing is what retired the exception. Its body is `{ effective,
 * diagnostics, … }`, and the first two are what that accessor reads.
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

import { firstFilePart, multipartBoundary, readAvatarUpload } from './avatar.js';
import { RosterValidationError } from './errors.js';
import { PACK_CONTENT_TYPE } from './pack.js';
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

/**
 * {@link answering} for the two endpoints that resolve credential references.
 *
 * Separate rather than making every handler async: only the reads that carry
 * §10's `{ secretRef, resolved }` block have anything to await, and a route
 * table where every handler returns a promise would hide which ones actually
 * touch the secret store.
 */
async function answeringAsync(
  logger: Logger,
  req: RequestContext,
  res: ResponseTools,
  handler: () => Promise<HttpResult>,
): Promise<HttpResult> {
  try {
    return await handler();
  } catch (error) {
    return answering(logger, req, res, () => {
      throw error;
    });
  }
}

export function createRosterRoutes(deps: RosterRoutesDeps): RouteDefinition[] {
  const { service, logger } = deps;
  const id = (req: RequestContext): string => req.params['id'] ?? '';

  return [
    {
      method: 'GET',
      path: `${ROSTER_API_PREFIX}/agents`,
      description: 'Lists the roster with board state, diagnostics and credential status.',
      handler: (req, res) =>
        answeringAsync(logger, req, res, async () => res.json(await service.listWithCredentials())),
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
      description:
        'One agent: the full definition, its resolved persona text, and { secretRef, resolved } per credential.',
      handler: (req, res) =>
        answeringAsync(logger, req, res, async () =>
          res.json(await service.getWithCredentials(id(req))),
        ),
    },

    {
      method: 'GET',
      path: `${ROSTER_API_PREFIX}/agents/:id/integrations`,
      description:
        'Per-integration preflight: ready / needs-auth / missing-secret / not-attached (§10).',
      handler: (req, res) =>
        answeringAsync(logger, req, res, async () => {
          // `?required=a,b` is the task's `requiredIntegrations`. It is the only
          // input that can produce `not-attached`, because "this task needs the
          // todo connector" is a fact about the task and the agent definition
          // cannot be asked it.
          const raw = req.query.get('required');
          const required = (raw === null ? [] : raw.split(','))
            .map((name) => name.trim())
            .filter((name) => name !== '');
          return res.json({
            integrations: await service.integrations(id(req), {
              ...(required.length === 0 ? {} : { required }),
            }),
          });
        }),
    },

    {
      method: 'PATCH',
      path: `${ROSTER_API_PREFIX}/agents/:id`,
      description: 'Partially updates an agent. The id and meta.createdAt are immutable.',
      handler: (req, res) =>
        answering(logger, req, res, () => res.json(service.patch(id(req), req.body))),
    },

    {
      method: 'POST',
      path: `${ROSTER_API_PREFIX}/agents/:id/permissions/allow`,
      description:
        'Appends one rule to permissions.allow. Idempotent; the write path is PATCH’s (§6).',
      handler: (req, res) =>
        answering(logger, req, res, () => {
          const result = service.allowRule(id(req), req.body);
          // 200 either way, and `added` says which happened. A 201 for the write
          // and a 200 for the no-op would make an idempotent call look like two
          // different outcomes to a client that only reads the status — and the
          // whole point is that answering the same card twice is harmless.
          return res.json(result);
        }),
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
      method: 'POST',
      path: `${ROSTER_API_PREFIX}/draft`,
      description:
        'Drafts an agent definition from a description (§12). Stateless: nothing is stored.',
      handler: (req, res) =>
        answeringAsync(logger, req, res, async () => res.json(await service.draft(req.body))),
    },

    {
      method: 'POST',
      path: `${ROSTER_API_PREFIX}/agents/:id/validate`,
      description:
        'Dry-run compile against a project id: the effective permissions this pair would launch with.',
      handler: (req, res) =>
        answeringAsync(logger, req, res, async () =>
          res.json(await service.validate(id(req), req.body ?? {})),
        ),
    },

    {
      method: 'GET',
      path: `${ROSTER_API_PREFIX}/agents/:id/export`,
      description: 'Downloads the agent folder as a .agentpack (zip). Secret refs only, no values.',
      handler: (req, res) =>
        answering(logger, req, res, () => {
          const pack = service.exportPack(id(req));
          return res.bytes(pack.bytes, PACK_CONTENT_TYPE, {
            headers: {
              'content-disposition': `attachment; filename="${pack.filename}"`,
              // The pack is a snapshot of a folder that changes under a fixed
              // URL; a cached one would hand out yesterday's persona.
              'cache-control': 'no-store',
            },
          });
        }),
    },

    {
      method: 'POST',
      path: `${ROSTER_API_PREFIX}/import`,
      description:
        'Reads a .agentpack: a preview by default, a write with ?commit=true (two-phase, §9.4).',
      handler: (req, res) =>
        answeringAsync(logger, req, res, async () => {
          const boundary = multipartBoundary(req.headers['content-type']);
          const bytes =
            boundary !== undefined && Buffer.isBuffer(req.body)
              ? firstFilePart(req.body, boundary)
              : req.body;
          // `?commit` with no value is the shell-friendly spelling of
          // `?commit=true`, matching how `?purge` reads on DELETE.
          const raw = req.query.get('commit');
          const commit = raw !== null && raw !== 'false' && raw !== '0';
          const result = await service.importPack(bytes, { commit });
          // 201 only when something was created: a preview is a read, and a UI
          // that keyed off the status would otherwise think it had committed.
          return res.json(result, result.committed ? { status: 201 } : {});
        }),
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
