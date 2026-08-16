/**
 * `GET /api/sessions/:id/transcript` (runner DESIGN §11.1) — the only route M2
 * ships, and the peer of `RunnerService.getTranscriptTail`.
 *
 * ```
 * ?from=<byteOffset>&limit=<lines>   read forward, whole lines, plus `next`
 * ?tail=<bytes>                      read backward, snapped to a line boundary
 * ```
 *
 * `from` and `tail` are mutually exclusive; supplying both is a 400 that names
 * both parameters, rather than a silent precedence rule the caller has to learn
 * from the source. A pruned transcript is `200 { pruned: true }` — projects'
 * retention removing a file is a normal outcome, and a 500 would make the UI
 * render an error where it should render "transcript pruned".
 *
 * `remote: 'allow'` by default (§15.3: "no route is runner-specific"), because
 * reading a transcript from the tailnet browser is the same act as reading it in
 * Electron and D3 requires them to be the same surface.
 */
import type { Logger } from 'pino';

import type { HttpResult, RequestContext, ResponseTools } from '../../http/types.js';
import type { RouteDefinition } from '../types.js';

import { InvalidRequestError, RunnerError } from './errors.js';
import type { RunnerService } from './service.js';

export interface RunnerRoutesDeps {
  readonly service: RunnerService;
  readonly logger: Logger;
}

/** A query parameter that must be a non-negative integer when present. */
function readInteger(req: RequestContext, name: string): number | undefined {
  const raw = req.query.get(name);
  if (raw === null) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new InvalidRequestError(`"${name}" must be a non-negative integer.`, name);
  }
  return value;
}

export function createRunnerRoutes(deps: RunnerRoutesDeps): readonly RouteDefinition[] {
  const { service, logger } = deps;

  const transcript = async (req: RequestContext, res: ResponseTools): Promise<HttpResult> => {
    const sessionId = req.params['id'] ?? '';
    const from = readInteger(req, 'from');
    const limit = readInteger(req, 'limit');
    const tail = readInteger(req, 'tail');

    if (from !== undefined && tail !== undefined) {
      throw new InvalidRequestError(
        '"from" and "tail" are mutually exclusive: "from" reads forward from a byte offset, ' +
          '"tail" reads backward from the end. Supply one.',
        'from',
        'tail',
      );
    }

    const page =
      tail === undefined
        ? await service.readTranscript(sessionId, {
            ...(from === undefined ? {} : { from }),
            ...(limit === undefined ? {} : { limit }),
          })
        : await service.getTranscriptTail(sessionId, { maxBytes: tail });

    return res.json({
      sessionId,
      lines: page.lines,
      from: page.from,
      next: page.next,
      size: page.size,
      pruned: page.pruned,
    });
  };

  return [
    {
      method: 'GET',
      path: '/api/sessions/:id/transcript',
      description: 'Tail a session transcript by byte offset or from the end (§11.1).',
      handler: (req, res) => guard(() => transcript(req, res), res, logger),
    },
  ];
}

/**
 * Turns a {@link RunnerError} into foundation's one error shape and anything
 * else into a flat 500 with its stack in `core.log` — §3.2's "never a stack
 * trace to the UI".
 */
async function guard(
  run: () => Promise<HttpResult>,
  res: ResponseTools,
  logger: Logger,
): Promise<HttpResult> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof RunnerError) {
      return res.error(error.status, error.code, error.message, { ...error.details });
    }
    logger.error({ err: error }, 'unhandled error in a runner route');
    return res.error(500, 'internal_error', 'The request could not be completed.');
  }
}
