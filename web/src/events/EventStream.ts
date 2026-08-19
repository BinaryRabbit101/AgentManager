/**
 * The `EventStream` singleton (DESIGN §3.3).
 *
 * One always-open connection to `/api/events`, and everything §3.3 asks of it:
 *
 * - a **`types=` subscription filter** (foundation §6.5) so the global feed
 *   never carries another session's `session.delta` / `.message` / `.tool.*` /
 *   `.usage` — per-session detail rides its own socket (§16);
 * - a **watermark** (the last persisted event id) in `localStorage`, and
 *   **`?since=` replay** on every reconnect with the *same* filter, so a tailnet
 *   drop costs neither a gap nor a duplicate and never a full refetch (§12.10);
 * - **exponential backoff** with a ceiling;
 * - **heartbeat handling** — foundation sends `: keep-alive` every 15s, and a
 *   feed that goes quiet for longer than the watchdog window is a dead socket
 *   wearing a live one's clothes;
 * - **connection state** as a first-class object with exactly three values,
 *   `live | reconnecting | offline` (§3.3).
 *
 * What it deliberately does **not** do: interpret events. Mapping a type onto a
 * cache operation is §3.4's job and lives in `invalidation.ts`, so the transport
 * can be tested without a query client and the map without a socket.
 */

import type { ApiClient } from '../api/client';
import type { EventFrame } from '../api/types';

import { fetchTransport, type SseTransport } from './sse';

export type ConnectionState = 'live' | 'reconnecting' | 'offline';

/**
 * The global feed's subscription (§3.3).
 *
 * Session **lifecycle** types are named one by one rather than taken as
 * `session.*`, and that is the whole point: `session.delta`, `session.message`,
 * `session.tool.*` and `session.usage` are high-volume, per-session, and not
 * persisted (runner §15.2 #12), so a phone watching one session must not pay
 * radio for every other session's tokens. Their durable record is the transcript.
 */
export const GLOBAL_EVENT_TYPES: readonly string[] = [
  'service.*',
  'roster.*',
  'project.*',
  'workspace.*',
  'assignment.*',
  'question.*',
  // §2.8's background triggers: without this the Triggers section could only
  // follow an unattended run by polling, which §16 forbids.
  'trigger.*',
  'runner.*',
  'remote.*',
  'diagnostic.*',
  'session.queued',
  'session.started',
  'session.paused',
  'session.resumed',
  'session.ended',
  'session.orphaned',
];

/** Where the last persisted event id is kept between loads (§3.3). */
export const WATERMARK_STORAGE_KEY = 'agentmanager.events.watermark';

/** Backoff ladder in milliseconds, then the last entry forever. */
export const BACKOFF_MS: readonly number[] = [500, 1000, 2000, 4000, 8000, 15_000];

/**
 * How long a silent feed may stay `live`.
 *
 * Foundation heartbeats at 15s, so three missed beats is the smallest window
 * that cannot fire on one slow one.
 */
export const HEARTBEAT_TIMEOUT_MS = 45_000;

/** How long a broken feed stays `reconnecting` before it admits to `offline`. */
export const OFFLINE_AFTER_MS = 5_000;

type Timer = ReturnType<typeof setTimeout>;

export interface EventStreamOptions {
  readonly client: ApiClient;
  readonly types?: readonly string[];
  readonly transport?: SseTransport;
  readonly storage?: Pick<Storage, 'getItem' | 'setItem'> | undefined;
  readonly setTimeoutImpl?: (fn: () => void, ms: number) => Timer;
  readonly clearTimeoutImpl?: (timer: Timer) => void;
  readonly now?: () => number;
  readonly backoffMs?: readonly number[];
  readonly heartbeatTimeoutMs?: number;
  readonly offlineAfterMs?: number;
}

export type EventListener = (frame: EventFrame) => void;
export type StateListener = (state: ConnectionState) => void;

export class EventStream {
  readonly #client: ApiClient;
  readonly #types: readonly string[];
  readonly #transport: SseTransport;
  readonly #storage: Pick<Storage, 'getItem' | 'setItem'> | undefined;
  readonly #setTimeout: (fn: () => void, ms: number) => Timer;
  readonly #clearTimeout: (timer: Timer) => void;
  readonly #now: () => number;
  readonly #backoff: readonly number[];
  readonly #heartbeatTimeoutMs: number;
  readonly #offlineAfterMs: number;

  readonly #listeners = new Set<EventListener>();
  readonly #stateListeners = new Set<StateListener>();

  #state: ConnectionState = 'reconnecting';
  #watermark: string | null = null;
  #attempt = 0;
  #started = false;
  #abort: AbortController | undefined;
  #retryTimer: Timer | undefined;
  #watchdog: Timer | undefined;
  #offlineTimer: Timer | undefined;
  /** Replay counts across reconnects, for the "no duplicate, no gap" assertion. */
  #replays = 0;

  constructor(options: EventStreamOptions) {
    this.#client = options.client;
    this.#types = options.types ?? GLOBAL_EVENT_TYPES;
    this.#transport = options.transport ?? fetchTransport(globalThis.fetch.bind(globalThis));
    this.#storage = options.storage === undefined ? safeStorage() : options.storage;
    this.#setTimeout = options.setTimeoutImpl ?? ((fn, ms) => setTimeout(fn, ms));
    this.#clearTimeout = options.clearTimeoutImpl ?? ((timer) => clearTimeout(timer));
    this.#now = options.now ?? (() => Date.now());
    this.#backoff = options.backoffMs ?? BACKOFF_MS;
    this.#heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS;
    this.#offlineAfterMs = options.offlineAfterMs ?? OFFLINE_AFTER_MS;
    this.#watermark = this.#storage?.getItem(WATERMARK_STORAGE_KEY) ?? null;
  }

  get state(): ConnectionState {
    return this.#state;
  }

  get watermark(): string | null {
    return this.#watermark;
  }

  get replayCount(): number {
    return this.#replays;
  }

  /** The exact URL the next connect will use — the assertion surface of §3.3. */
  streamUrl(): string {
    return this.#client.url('/events', {
      types: this.#types.join(','),
      ...(this.#watermark === null ? {} : { since: this.#watermark }),
    });
  }

  on(listener: EventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  onStateChange(listener: StateListener): () => void {
    this.#stateListeners.add(listener);
    return () => this.#stateListeners.delete(listener);
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#connect();
  }

  stop(): void {
    this.#started = false;
    this.#clearTimers();
    this.#abort?.abort();
    this.#abort = undefined;
  }

  #connect(): void {
    if (!this.#started) return;
    const controller = new AbortController();
    this.#abort = controller;

    const connection = this.#transport(
      this.streamUrl(),
      this.#client.headers(),
      controller.signal,
      {
        onOpen: () => {
          this.#armWatchdog();
        },
        onActivity: () => {
          this.#armWatchdog();
        },
        onFrame: (frame) => {
          if (frame.kind === 'comment') return;
          if (frame.event === 'replay-complete') {
            // The server has finished the `since=` catch-up. Only now is the
            // client genuinely caught up, so this — not the socket opening — is
            // what makes the indicator `live`.
            this.#replays += 1;
            this.#attempt = 0;
            this.#setState('live');
            return;
          }
          if (frame.event === 'error') return;
          const parsed = parseFrame(frame.data);
          if (parsed === undefined) return;
          // Only a persisted event has an id, and only an id can be a watermark:
          // a `session.delta` replayed from a watermark would be a lie, because
          // it was never stored (runner §15.2 #12).
          if (parsed.id !== undefined && parsed.id !== '') this.#setWatermark(parsed.id);
          for (const listener of this.#listeners) listener(parsed);
        },
      },
    );

    connection.done.then(
      () => this.#scheduleRetry(),
      () => this.#scheduleRetry(),
    );
  }

  #scheduleRetry(): void {
    if (!this.#started) return;
    if (this.#state === 'live') {
      // First failure of this outage. §3.3: `reconnecting` immediately, and
      // `offline` only once it has actually lasted.
      this.#setState('reconnecting');
    }
    this.#armOfflineTimer();
    const delay = this.#backoff[Math.min(this.#attempt, this.#backoff.length - 1)] ?? 1000;
    this.#attempt += 1;
    this.#clear(this.#retryTimer);
    this.#retryTimer = this.#setTimeout(() => {
      this.#retryTimer = undefined;
      this.#connect();
    }, delay);
  }

  #armWatchdog(): void {
    this.#clear(this.#watchdog);
    this.#watchdog = this.#setTimeout(() => {
      // Silence past three heartbeats: the socket is open but nothing is on the
      // other end. Dropping it turns a permanently stale board into a reconnect.
      this.#abort?.abort();
    }, this.#heartbeatTimeoutMs);
  }

  #armOfflineTimer(): void {
    if (this.#offlineTimer !== undefined || this.#state === 'offline') return;
    const startedAt = this.#now();
    this.#offlineTimer = this.#setTimeout(() => {
      this.#offlineTimer = undefined;
      if (this.#state !== 'live' && this.#now() - startedAt >= 0) this.#setState('offline');
    }, this.#offlineAfterMs);
  }

  #setState(next: ConnectionState): void {
    if (next === 'live') {
      this.#clear(this.#offlineTimer);
      this.#offlineTimer = undefined;
    }
    if (this.#state === next) return;
    this.#state = next;
    for (const listener of this.#stateListeners) listener(next);
  }

  #setWatermark(id: string): void {
    this.#watermark = id;
    try {
      this.#storage?.setItem(WATERMARK_STORAGE_KEY, id);
    } catch {
      // A watermark that cannot be persisted still works for this page's
      // lifetime; losing it on reload costs a wider replay, not correctness.
    }
  }

  #clearTimers(): void {
    this.#clear(this.#retryTimer);
    this.#clear(this.#watchdog);
    this.#clear(this.#offlineTimer);
    this.#retryTimer = undefined;
    this.#watchdog = undefined;
    this.#offlineTimer = undefined;
  }

  #clear(timer: Timer | undefined): void {
    if (timer !== undefined) this.#clearTimeout(timer);
  }
}

function parseFrame(data: string | undefined): EventFrame | undefined {
  if (data === undefined || data === '') return undefined;
  try {
    const parsed: unknown = JSON.parse(data);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const frame = parsed as EventFrame;
    return typeof frame.type === 'string' ? frame : undefined;
  } catch {
    return undefined;
  }
}

function safeStorage(): Pick<Storage, 'getItem' | 'setItem'> | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}
