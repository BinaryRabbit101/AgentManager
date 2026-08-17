/**
 * Runner's HTTP surface as far as M2, M4 and M5 take it (runner DESIGN §11.1).
 * The rest of §11.1's table — the control verbs, the event stream, the listing —
 * arrives with M6, M9 and M10.
 *
 * ```
 * GET /api/sessions/:id             record + usage + queue position   (M4/M5)
 * GET /api/sessions/:id/transcript  ?from=&limit= | ?tail=            (M2)
 * GET /api/runner/queue             the queue panel's state and rows  (M5)
 * PUT /api/runner/capacity          { maxConcurrent }, 1..8, settings (M5)
 * ```
 *
 * `GET /api/sessions/:id` is where §7.3's rule becomes visible: the estimate is
 * called `costUsdEstimate` and nothing on the payload can be read as spend.
 *
 * ## `GET /api/sessions/:id/transcript` — the peer of `getTranscriptTail`
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

import { InvalidRequestError, RunnerError, SessionNotFoundError } from './errors.js';
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

  const session = async (req: RequestContext, res: ResponseTools): Promise<HttpResult> => {
    const sessionId = req.params['id'] ?? '';
    const detail = await service.getSessionDetail(sessionId);
    if (detail === undefined) throw new SessionNotFoundError(sessionId);
    return res.json({
      session: detail.session,
      // §7.3: "rendered as 'estimated model cost' and never as spend". The field
      // name is the first line of that defence — a client cannot accidentally
      // print `usage.costUsd` as a total because there is no such field.
      usage: detail.usage,
      queuePosition: detail.queuePosition,
    });
  };

  const queue = (_req: RequestContext, res: ResponseTools): Promise<HttpResult> =>
    Promise.resolve(res.json({ ...service.queueState(), entries: service.queueEntries() }));

  const capacity = (req: RequestContext, res: ResponseTools): Promise<HttpResult> => {
    const body = req.body;
    const requested =
      typeof body === 'object' && body !== null
        ? (body as Record<string, unknown>)['maxConcurrent']
        : undefined;
    if (typeof requested !== 'number' || !Number.isFinite(requested)) {
      throw new InvalidRequestError(
        '"maxConcurrent" must be a number. It is clamped to 1..8 (§6.1) and stored in settings, ' +
          'so it survives a restart without editing config.',
        'maxConcurrent',
      );
    }
    return Promise.resolve(res.json({ maxConcurrent: service.setCapacity(requested) }));
  };

  return [
    {
      method: 'GET',
      path: '/api/sessions/:id',
      description: 'One session: the record, its usage rollup and its queue position (§11.1).',
      handler: (req, res) => guard(() => session(req, res), res, logger),
    },
    {
      method: 'GET',
      path: '/api/sessions/:id/transcript',
      description: 'Tail a session transcript by byte offset or from the end (§11.1).',
      handler: (req, res) => guard(() => transcript(req, res), res, logger),
    },
    {
      method: 'GET',
      path: '/api/runner/queue',
      description: 'The scheduler: capacity, cool-down, and every queued or running session (§6).',
      handler: (req, res) => guard(() => queue(req, res), res, logger),
    },
    {
      // §15.3 leaves "a remote client may lower the cap but not raise it" to
      // remote's own policy layer; runner's route is the same route on both
      // listeners, per §11.1's "no route is runner-specific".
      method: 'PUT',
      path: '/api/runner/capacity',
      description: 'Set the runtime concurrency cap (1..8), stored in settings (§6.1).',
      handler: (req, res) => guard(() => capacity(req, res), res, logger),
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
