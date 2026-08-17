/**
 * Runner's HTTP surface — §11.1's table, complete but for `GET
 * /api/runner/usage`, which needs M11's rolling `usage_events` windows.
 *
 * ```
 * POST /api/sessions                 { assignmentId, agentId, projectId, … }  (M10)
 * GET  /api/sessions                 ?status=&projectId=&…&limit=&before=     (M10)
 * GET  /api/sessions/:id             record + usage + queue position + affordances
 * GET  /api/sessions/:id/transcript  ?from=&limit= | ?tail=            (M2)
 * GET  /api/sessions/:id/stream      the live per-session event feed   (M10)
 * POST /api/sessions/:id/steer       { text, interrupt? }              (M6)
 * POST /api/sessions/:id/pause       { reason? }                       (M6)
 * POST /api/sessions/:id/resume                                        (M6)
 * POST /api/sessions/:id/continue    { prompt? } → new session         (M9)
 * POST /api/sessions/:id/stop        { reason? }                       (M6)
 * POST /api/sessions/:id/pin         { pinned }                        (M6)
 * GET  /api/runner/queue             the queue panel's state and rows  (M5)
 * PUT  /api/runner/capacity          { maxConcurrent }, 1..8, settings (M5)
 * ```
 *
 * ## `GET /api/sessions/:id/stream` — one socket, one session
 *
 * §3.3 of the ui design allows two sockets: the always-open global feed, and
 * this one "only while a session view is open", so "a phone watching one session
 * does not receive token deltas for every other running session". It is
 * therefore a *filter*, not a second event system: the same bus, the same frame
 * shape `/api/events` sends, narrowed to §10's session types **and** to this
 * session's id.
 *
 * There is deliberately **no `since=` replay here.** Every event that only this
 * route carries is non-persisted by §10, so there is nothing to replay; §15.2's
 * replay contract is "persisted events from `/api/events?since=` plus a
 * byte-offset tail of the transcript", and duplicating half of it here would
 * give a reconnecting client two sources for the same lifecycle event and no
 * rule for which wins.
 *
 * ## The control verbs are idempotent, and that is a route-level promise
 *
 * §11.1: "pausing a paused session, stopping a stopped one, or resuming a
 * running one returns the current state with 200, not an error. Remote clients
 * on flaky links retry, and a retry that 409s is a retry that produces a support
 * ticket." So all four answer `200 { sessionId, status, exitReason, changed }`
 * and the `changed` flag — not the status code — is what says whether this call
 * was the one that did it. `steer` is the deliberate exception (§4.3): a message
 * that silently went nowhere is worse than a 409.
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
import type { AppEvent, EventBus, RouteDefinition } from '../types.js';
import type { SessionStatus } from '../../storage/index.js';

import { InvalidRequestError, RunnerError, SessionNotFoundError } from './errors.js';
import { SESSION_EVENT_TYPES } from './events.js';
import type { RunnerService } from './service.js';
import { isExitReason, SESSION_STATUSES } from './status.js';

export interface RunnerRoutesDeps {
  readonly service: RunnerService;
  readonly logger: Logger;
  /**
   * Foundation's bus, for `GET /api/sessions/:id/stream`.
   *
   * Optional so the M2–M6 route tests, which never open a socket, keep building
   * the table without one — the stream route then reports the capability as
   * absent rather than throwing on a null subscribe.
   */
  readonly bus?: Pick<EventBus, 'subscribe'> | undefined;
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

function readBody(req: RequestContext): Record<string, unknown> {
  const body = req.body;
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
}

/** A body field that must be a non-empty string. */
function readRequiredString(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidRequestError(`"${name}" is required and must be a non-empty string.`, name);
  }
  return value;
}

export function createRunnerRoutes(deps: RunnerRoutesDeps): readonly RouteDefinition[] {
  const { service, logger } = deps;

  const create = async (req: RequestContext, res: ResponseTools): Promise<HttpResult> => {
    const body = readBody(req);
    const priority: unknown = body['priority'];
    if (priority !== undefined && priority !== 'interactive' && priority !== 'normal') {
      throw new InvalidRequestError(
        '"priority" must be "interactive" or "normal" — §6.2\'s two bands, and nothing richer.',
        'priority',
      );
    }
    const role: unknown = body['role'];
    if (role !== undefined && typeof role !== 'string') {
      throw new InvalidRequestError('"role" must be a string when present.', 'role');
    }
    const started = await service.startSession({
      assignmentId: readRequiredString(body, 'assignmentId'),
      agentId: readRequiredString(body, 'agentId'),
      projectId: readRequiredString(body, 'projectId'),
      prompt: readRequiredString(body, 'prompt'),
      ...(role === undefined ? {} : { role }),
      ...(priority === undefined ? {} : { priority }),
      // §11.1: "`origin` is taken from foundation's request context"; runner
      // records it and adds no remote-specific behaviour of its own (§15.3).
      origin: req.origin === 'remote' ? 'remote' : 'local',
    });
    return res.json(started, { status: 201 });
  };

  const list = (req: RequestContext, res: ResponseTools): Promise<HttpResult> => {
    const status = req.query.get('status');
    if (status !== null && !(SESSION_STATUSES as readonly string[]).includes(status)) {
      throw new InvalidRequestError(
        `"status" must be one of ${SESSION_STATUSES.join(', ')} (§2.2's closed vocabulary).`,
        'status',
      );
    }
    const before = req.query.get('before');
    const limit = readInteger(req, 'limit');
    const sessions = service.listSessions({
      ...(status === null ? {} : { status: status as SessionStatus }),
      ...(req.query.get('projectId') === null
        ? {}
        : { projectId: req.query.get('projectId') as string }),
      ...(req.query.get('assignmentId') === null
        ? {}
        : { assignmentId: req.query.get('assignmentId') as string }),
      ...(req.query.get('agentId') === null ? {} : { agentId: req.query.get('agentId') as string }),
      ...(limit === undefined ? {} : { limit }),
      ...(before === null ? {} : { before }),
    });
    return Promise.resolve(
      res.json({
        sessions,
        // The cursor for the next page, so a client never has to know that ids
        // are ULIDs to page with them.
        next: sessions.length === 0 ? null : (sessions[sessions.length - 1]?.id ?? null),
      }),
    );
  };

  const continueSession = async (req: RequestContext, res: ResponseTools): Promise<HttpResult> => {
    const prompt: unknown = readBody(req)['prompt'];
    if (prompt !== undefined && typeof prompt !== 'string') {
      throw new InvalidRequestError(
        '"prompt" must be a string when present. Omit it to continue with only the statement of ' +
          'what happened to the previous session (§9.4).',
        'prompt',
      );
    }
    const started = await service.continueFrom(req.params['id'] ?? '', prompt ?? '', {
      // §6.2: a human pressed Continue and is watching for the result.
      priority: 'interactive',
      origin: req.origin === 'remote' ? 'remote' : 'local',
    });
    return res.json(started, { status: 201 });
  };

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
      // §11.1's "resume affordances" — §9.3's honest answer, computed here so a
      // client never has to guess whether Continue would actually continue.
      affordances: detail.affordances,
    });
  };

  /**
   * `GET /api/sessions/:id/stream` — §10's session events for one session.
   *
   * Handled the way foundation handles `/api/events`: `res.sse()` takes over the
   * response, the handler returns nothing, and the subscription is torn down on
   * close **and** on request abort. Filtering by `ids.sessionId` is what makes
   * this route worth having over the global feed with a `types=` filter — a
   * phone on a tailnet stops paying for every other running session's deltas.
   */
  const stream = async (req: RequestContext, res: ResponseTools): Promise<HttpResult | void> => {
    const sessionId = req.params['id'] ?? '';
    const bus = deps.bus;
    if (bus === undefined) {
      return res.error(
        503,
        'stream_unavailable',
        'This runner was built without an event bus, so it cannot stream a session.',
      );
    }
    // A 404 *before* the socket opens, rather than an SSE stream that will never
    // carry a frame: a typo'd id must fail loudly rather than look idle for ever.
    if ((await service.getSession(sessionId)) === undefined) {
      throw new SessionNotFoundError(sessionId);
    }

    const sse = res.sse();
    const unsubscribe = bus.subscribe([...SESSION_EVENT_TYPES], (event: AppEvent) => {
      if (event.ids.sessionId !== sessionId) return;
      sse.send({
        event: 'event',
        ...(event.id === undefined ? {} : { id: event.id }),
        data: {
          id: event.id,
          ts: event.ts,
          type: event.type,
          ids: event.ids,
          payload: event.payload,
          persist: event.persist,
        },
      });
    });
    sse.onClose(unsubscribe);
    req.signal.addEventListener('abort', () => sse.close(), { once: true });
    // The client's cue that it is attached and may now tail the transcript from
    // its byte offset without racing the live feed (§15.2's replay contract).
    sse.send({ event: 'attached', data: { sessionId, types: SESSION_EVENT_TYPES } });
    return undefined;
  };

  const steer = async (req: RequestContext, res: ResponseTools): Promise<HttpResult> => {
    const sessionId = req.params['id'] ?? '';
    const body = readBody(req);
    const text = body['text'];
    if (typeof text !== 'string' || text.trim() === '') {
      throw new InvalidRequestError('"text" is required and must be a non-empty string.', 'text');
    }
    const interrupt = body['interrupt'];
    if (interrupt !== undefined && typeof interrupt !== 'boolean') {
      throw new InvalidRequestError(
        '"interrupt" must be a boolean. False (the default) delivers at the next turn boundary; ' +
          'true stops the turn in flight first (§4.3).',
        'interrupt',
      );
    }
    return res.json(await service.steer(sessionId, text, { interrupt: interrupt === true }));
  };

  const pause = async (req: RequestContext, res: ResponseTools): Promise<HttpResult> => {
    const sessionId = req.params['id'] ?? '';
    // §2.3's set is closed, so a caller may only name a reason that is in it.
    // Omitting it is the ordinary case: a human pressed Pause.
    const reason: unknown = readBody(req)['reason'];
    if (reason !== undefined && !isExitReason(reason)) {
      throw new InvalidRequestError(
        '"reason" must be one of the exit_reason values of §2.3, or be omitted.',
        'reason',
      );
    }
    return res.json(await service.pause(sessionId, reason));
  };

  const resume = async (req: RequestContext, res: ResponseTools): Promise<HttpResult> =>
    res.json(await service.resume(req.params['id'] ?? ''));

  const stop = async (req: RequestContext, res: ResponseTools): Promise<HttpResult> => {
    const reason = readBody(req)['reason'];
    if (reason !== undefined && typeof reason !== 'string') {
      throw new InvalidRequestError('"reason" must be a string when present.', 'reason');
    }
    return res.json(await service.stop(req.params['id'] ?? '', reason));
  };

  const pin = (req: RequestContext, res: ResponseTools): Promise<HttpResult> => {
    const pinned = readBody(req)['pinned'];
    if (typeof pinned !== 'boolean') {
      throw new InvalidRequestError(
        '"pinned" must be a boolean. A pinned session is exempt from projects’ transcript ' +
          'retention sweep (§11.1).',
        'pinned',
      );
    }
    return Promise.resolve(res.json(service.setPinned(req.params['id'] ?? '', pinned)));
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
      method: 'POST',
      path: '/api/sessions',
      description: 'Start a session against an existing, open assignment (§3.1, §11.1).',
      handler: (req, res) => guard(() => create(req, res), res, logger),
    },
    {
      method: 'GET',
      path: '/api/sessions',
      description: 'List sessions, newest first, filtered and paged by id cursor (§11.1).',
      handler: (req, res) => guard(() => list(req, res), res, logger),
    },
    {
      method: 'GET',
      path: '/api/sessions/:id',
      description:
        'One session: the record, its usage, its queue position and its controls (§11.1).',
      handler: (req, res) => guard(() => session(req, res), res, logger),
    },
    {
      method: 'GET',
      path: '/api/sessions/:id/stream',
      description: 'The live event feed for one session, filtered to its id (§10, §11.1).',
      handler: (req, res) => guard(() => stream(req, res), res, logger),
    },
    {
      method: 'POST',
      path: '/api/sessions/:id/continue',
      description: 'Continue a finished session as a new one with resumed_from (§9.4).',
      handler: (req, res) => guard(() => continueSession(req, res), res, logger),
    },
    {
      method: 'GET',
      path: '/api/sessions/:id/transcript',
      description: 'Tail a session transcript by byte offset or from the end (§11.1).',
      handler: (req, res) => guard(() => transcript(req, res), res, logger),
    },
    {
      method: 'POST',
      path: '/api/sessions/:id/steer',
      description: 'Deliver a message into a running session, with or without an interrupt (§4.3).',
      handler: (req, res) => guard(() => steer(req, res), res, logger),
    },
    {
      method: 'POST',
      path: '/api/sessions/:id/pause',
      description: 'Pause a running session: the slot is freed, the lease and context kept (§2.2).',
      handler: (req, res) => guard(() => pause(req, res), res, logger),
    },
    {
      method: 'POST',
      path: '/api/sessions/:id/resume',
      description: 'Resume a paused session on the same row and transcript (§9.4).',
      handler: (req, res) => guard(() => resume(req, res), res, logger),
    },
    {
      method: 'POST',
      path: '/api/sessions/:id/stop',
      description: 'Stop a session: interrupted / user_stopped, with no subprocess left (§9.1).',
      handler: (req, res) => guard(() => stop(req, res), res, logger),
    },
    {
      method: 'POST',
      path: '/api/sessions/:id/pin',
      description: 'Pin or unpin a session against projects’ transcript retention (§11.1).',
      handler: (req, res) => guard(() => pin(req, res), res, logger),
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
  run: () => Promise<HttpResult | void>,
  res: ResponseTools,
  logger: Logger,
): Promise<HttpResult | void> {
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
