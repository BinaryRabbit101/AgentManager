/**
 * `GET /api/events` — replay then live, over one SSE connection (DESIGN §6.5).
 *
 * > "This gives the UI one mechanism for both 'what happened while I was
 * > disconnected' (replay from `events` by id watermark) and 'what is happening
 * > now' (live stream), which is the difference between a session view that
 * > recovers from a dropped tailnet connection and one that does not."
 *
 * ## No gap, no duplicate
 *
 * The order of operations is the whole design, and it is deliberately
 * subscribe-first:
 *
 * 1. **Subscribe** to the bus with the caller's `types=` filter, buffering
 *    everything it delivers instead of sending it.
 * 2. **Replay** `events` rows with `id > since`, sending each and remembering
 *    its id. Anything emitted while this runs is safely in the buffer.
 * 3. **Flush** the buffer, skipping ids the replay already sent, then keep
 *    sending live.
 *
 * Subscribing *before* the query is what closes the gap: an event emitted
 * between the two lands in the buffer even if the query missed it. Remembering
 * the replayed ids is what closes the duplicate: an event caught by both is sent
 * once. A non-persisted event has no id and can never have been replayed, so it
 * always passes.
 *
 * `types=` is applied identically to both halves — the bus's matcher for live
 * delivery, the repository's `type LIKE 'prefix.%'` for replay — because "a
 * reconnect returns the same subset it was streaming" (§6.5, ui §19 R4).
 */
import type { AppEvent, RouteDefinition } from '../../modules/types.js';
import type { EventRecord } from '../../storage/index.js';
import type { HttpDeps } from '../deps.js';
import type { HttpResult, SseStream } from '../types.js';

/** Rows replayed in one connect. Beyond this the client is told to re-ask. */
export const MAX_REPLAY = 2000;

/** `types=session.started,question.*` → `['session.started', 'question.*']`. */
export function parseTypes(raw: string | null): string[] | undefined {
  if (raw === null) return undefined;
  const types = raw
    .split(',')
    .map((type) => type.trim())
    .filter((type) => type.length > 0);
  return types.length === 0 ? undefined : types;
}

/** The wire shape of an event, identical for a replayed row and a live emit. */
export interface EventFrame {
  readonly id: string | undefined;
  readonly ts: string;
  readonly type: string;
  readonly ids: Record<string, string>;
  readonly payload: unknown;
  readonly persist: boolean;
}

function fromRow(row: EventRecord): EventFrame {
  const ids: Record<string, string> = {};
  if (row.sessionId !== null) ids['sessionId'] = row.sessionId;
  if (row.assignmentId !== null) ids['assignmentId'] = row.assignmentId;
  if (row.projectId !== null) ids['projectId'] = row.projectId;
  if (row.agentId !== null) ids['agentId'] = row.agentId;
  return {
    id: row.id,
    ts: row.ts,
    type: row.type,
    ids,
    payload: row.payloadJson === null ? undefined : safeParse(row.payloadJson),
    persist: true,
  };
}

function fromEvent(event: AppEvent): EventFrame {
  const ids: Record<string, string> = {};
  for (const [key, value] of Object.entries(event.ids)) {
    if (typeof value === 'string') ids[key] = value;
  }
  return {
    id: event.id,
    ts: event.ts,
    type: event.type,
    ids,
    payload: event.payload,
    persist: event.persist,
  };
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    // A payload that will not parse is still evidence; hand it on verbatim.
    return json;
  }
}

function send(stream: SseStream, frame: EventFrame): void {
  stream.send({
    event: 'event',
    // The SSE `id:` field is what a browser sends back as `Last-Event-ID`, which
    // is exactly the `since=` watermark — so an EventSource reconnect resumes
    // correctly with no client code at all.
    ...(frame.id === undefined ? {} : { id: frame.id }),
    data: frame,
  });
}

export function createEventRoutes(deps: HttpDeps): RouteDefinition[] {
  return [
    {
      method: 'GET',
      path: '/api/events',
      description: 'Event replay from a since= watermark, then the live stream (SSE).',
      handler: (req, res): HttpResult | void => {
        const types = parseTypes(req.query.get('types'));
        // `Last-Event-ID` is the browser's automatic reconnect watermark; an
        // explicit `since=` wins, because a caller that names one means it.
        const header = req.headers['last-event-id'];
        const since =
          req.query.get('since') ?? (typeof header === 'string' && header !== '' ? header : null);

        const stream = res.sse();
        const buffered: AppEvent[] = [];
        let replaying = true;

        const unsubscribe = deps.bus.subscribe(types, (event) => {
          if (replaying) {
            buffered.push(event);
            return;
          }
          send(stream, fromEvent(event));
        });
        stream.onClose(unsubscribe);
        req.signal.addEventListener('abort', () => stream.close(), { once: true });

        const replayed = new Set<string>();
        try {
          const rows = deps.events.list({
            ...(since === null ? {} : { since }),
            ...(types === undefined ? {} : { types }),
            limit: MAX_REPLAY,
          });
          for (const row of rows) {
            replayed.add(row.id);
            send(stream, fromRow(row));
          }
          stream.send({
            event: 'replay-complete',
            data: {
              count: rows.length,
              since,
              types: types ?? null,
              truncated: rows.length === MAX_REPLAY,
            },
          });
        } catch (cause) {
          deps.logger.error({ err: cause, requestId: req.requestId }, 'event replay failed');
          stream.send({
            event: 'error',
            data: { error: 'replay_failed', message: 'The event replay could not be read.' },
          });
        }

        // Everything the subscription caught while the replay ran, minus what
        // the replay already sent.
        replaying = false;
        for (const event of buffered) {
          if (event.id !== undefined && replayed.has(event.id)) continue;
          send(stream, fromEvent(event));
        }
        buffered.length = 0;
      },
    },
  ];
}
