/**
 * The per-session feed, and the **one** accessor its URL comes through
 * (DESIGN §3.3, §9.4).
 *
 * §3.3 allows two sockets: the always-open global feed, plus
 * `/api/sessions/:id/stream` "only while a session view is open", so that "a
 * phone watching one session does not receive token deltas for every other
 * running session".
 *
 * ## The gap this file exists to hold open
 *
 * `GET /api/sessions/:id/stream` is **runner M10** — runner's route file says so
 * in as many words ("the rest of §11.1's table — `/continue`, the event stream,
 * the listing — arrives with M9 and M10") — and the four events it would carry,
 * `session.delta` / `.message` / `.tool.start` / `.tool.end`, are not emitted by
 * this build at all yet. So until it lands the same subscription is taken on
 * **foundation's `/api/events` with a `types=` filter** (foundation §6.5), which
 * exists today, fans out non-persisted events live, and needs no server change:
 *
 * - the filter is the per-session detail set, so the *global* feed still never
 *   carries it — §3.3's actual requirement is about the global feed's bytes;
 * - frames for other sessions are dropped by `ids.sessionId`, which costs radio
 *   on a phone and is the only thing the dedicated route buys back.
 *
 * **TODO(runner M10)**: point {@link sessionStreamUrl} at
 * `/api/sessions/:id/stream` and delete the id filter in {@link isForSession}.
 * Nothing else in the session view changes: the merge is on `seq` either way, and
 * the tests drive frames through this class rather than through a URL.
 */

import type { ApiClient } from '../api/client';
import type { EventFrame } from '../api/types';
import { fetchTransport, type SseTransport } from '../events/sse';

/** Exactly the four non-persisted per-session types, plus the question pair. */
export const SESSION_EVENT_TYPES: readonly string[] = [
  'session.delta',
  'session.message',
  'session.tool.*',
  'session.usage',
  'session.question.raised',
  'session.question.answered',
  'session.diagnostic',
  'session.started',
  'session.paused',
  'session.resumed',
  'session.ended',
  'session.steered',
  'session.orphaned',
];

/** TODO(runner M10): `/sessions/:id/stream`. See the header. */
export function sessionStreamUrl(client: ApiClient, sessionId: string): string {
  return client.url('/events', { types: SESSION_EVENT_TYPES.join(','), sessionId });
}

/** TODO(runner M10): the dedicated route makes this always true. */
export function isForSession(frame: EventFrame, sessionId: string): boolean {
  const id = frame.ids['sessionId'];
  return id === undefined || id === sessionId;
}

export interface SessionStreamOptions {
  readonly client: ApiClient;
  readonly sessionId: string;
  readonly transport?: SseTransport;
  readonly onFrame: (frame: EventFrame) => void;
  readonly onStateChange?: (open: boolean) => void;
}

/**
 * One connection, opened while the view is mounted and closed with it.
 *
 * Deliberately thinner than `EventStream`: no watermark and no `since=` replay,
 * because none of these events is persisted (runner §15.2 #12) and their durable
 * record is the transcript. §9.4's reconnect is therefore "reopen the socket and
 * re-tail from the byte offset", which is the session view's job, not this
 * class's — and is why this class only reports that it reconnected.
 */
export class SessionStream {
  readonly #options: SessionStreamOptions;
  readonly #transport: SseTransport;
  #abort: AbortController | undefined;
  #retry: ReturnType<typeof setTimeout> | undefined;
  #started = false;
  /** How many times the socket has (re)opened — the reconnect assertion. */
  #opens = 0;

  constructor(options: SessionStreamOptions) {
    this.#options = options;
    this.#transport = options.transport ?? fetchTransport(globalThis.fetch.bind(globalThis));
  }

  get opens(): number {
    return this.#opens;
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#connect();
  }

  stop(): void {
    this.#started = false;
    if (this.#retry !== undefined) clearTimeout(this.#retry);
    this.#retry = undefined;
    this.#abort?.abort();
    this.#abort = undefined;
  }

  #connect(): void {
    if (!this.#started) return;
    const controller = new AbortController();
    this.#abort = controller;
    const { client, sessionId, onFrame, onStateChange } = this.#options;

    const connection = this.#transport(
      sessionStreamUrl(client, sessionId),
      client.headers(),
      controller.signal,
      {
        onOpen: () => {
          this.#opens += 1;
          onStateChange?.(true);
        },
        onActivity: () => undefined,
        onFrame: (frame) => {
          if (frame.kind === 'comment' || frame.event === 'error') return;
          if (frame.event === 'replay-complete') return;
          const parsed = parse(frame.data);
          if (parsed === undefined) return;
          if (!isForSession(parsed, sessionId)) return;
          onFrame(parsed);
        },
      },
    );

    const reopen = (): void => {
      onStateChange?.(false);
      if (!this.#started) return;
      this.#retry = setTimeout(() => this.#connect(), 1000);
    };
    connection.done.then(reopen, reopen);
  }
}

function parse(data: string | undefined): EventFrame | undefined {
  if (data === undefined || data === '') return undefined;
  try {
    const parsed: unknown = JSON.parse(data);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const frame = parsed as EventFrame;
    return typeof frame.type === 'string' ? { ...frame, ids: frame.ids ?? {} } : undefined;
  } catch {
    return undefined;
  }
}
