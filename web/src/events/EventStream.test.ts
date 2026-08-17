/**
 * The `EventStream` singleton (DESIGN §3.3, IMPLEMENTATION §1).
 *
 * Every clause of §3.3 that the transport owns is asserted here: the `types=`
 * subscription filter, the `localStorage` watermark, `?since=` replay on
 * reconnect with the *same* filter, exponential backoff, heartbeat handling, and
 * the three-valued connection state with its `reconnecting`-within-2s /
 * `offline`-within-5s timing.
 *
 * Time is injected rather than faked globally, so the assertions are about the
 * ladder the stream actually schedules and not about how a mock library rounds.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { ApiClient } from '../api/client';
import type { EventFrame } from '../api/types';

import {
  BACKOFF_MS,
  EventStream,
  GLOBAL_EVENT_TYPES,
  HEARTBEAT_TIMEOUT_MS,
  WATERMARK_STORAGE_KEY,
  type ConnectionState,
} from './EventStream';
import type { SseConnection, SseHandlers, SseTransport } from './sse';

// ---------------------------------------------------------------------------
// A controllable clock, and a transport that can be opened, fed and dropped
// ---------------------------------------------------------------------------

/**
 * The platform's timer handle.
 *
 * `number` in a browser, `NodeJS.Timeout` wherever `@types/node` is ambient. The
 * stream treats it as opaque and never looks inside one, so the fake hands back
 * a counter wearing whichever type is in scope.
 */
type Timer = ReturnType<typeof setTimeout>;

const asTimer = (id: number): Timer => id as unknown as Timer;
const asId = (timer: Timer): number => timer as unknown as number;

interface Clock {
  readonly now: () => number;
  readonly set: (fn: () => void, ms: number) => Timer;
  readonly clear: (timer: Timer) => void;
  advance(ms: number): Promise<void>;
  /** Milliseconds until the next scheduled timer, for the backoff assertions. */
  nextDelay(): number | undefined;
}

function makeClock(): Clock {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();

  const flush = async (): Promise<void> => {
    // Real timers, so promise continuations inside the stream settle before the
    // next assertion. Only the *stream's* clock is injected.
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  return {
    now: () => now,
    set: (fn, ms) => {
      const id = nextId;
      nextId += 1;
      timers.set(id, { at: now + ms, fn });
      return asTimer(id);
    },
    clear: (timer) => {
      timers.delete(asId(timer));
    },
    nextDelay: () => {
      const due = [...timers.values()].map((timer) => timer.at - now).sort((a, b) => a - b);
      return due[0];
    },
    advance: async (ms) => {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (due === undefined) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
        await flush();
      }
      now = target;
      await flush();
    },
  };
}

interface Wire {
  readonly transport: SseTransport;
  readonly urls: string[];
  open(): Promise<void>;
  event(frame: {
    readonly id?: string;
    readonly type: string;
    readonly ids?: Record<string, string>;
  }): void;
  replayComplete(): void;
  replayError(): void;
  heartbeat(): void;
  /** An `event: event` frame whose data is whatever the server actually sent. */
  raw(data: string): void;
  drop(): Promise<void>;
}

function makeWire(): Wire {
  const urls: string[] = [];
  let handlers: SseHandlers | undefined;
  let reject: ((error: Error) => void) | undefined;

  const flush = async (): Promise<void> => {
    await new Promise((done) => setTimeout(done, 0));
  };

  const transport: SseTransport = (url, _headers, signal, incoming): SseConnection => {
    urls.push(url);
    handlers = incoming;
    let settle: (() => void) | undefined;
    let broke: ((error: Error) => void) | undefined;
    const done = new Promise<void>((ok, bad) => {
      settle = ok;
      broke = bad;
    });
    reject = broke;
    signal.addEventListener('abort', () => settle?.(), { once: true });
    return { done, close: () => settle?.() };
  };

  return {
    transport,
    urls,
    open: async () => {
      handlers?.onOpen();
      await flush();
    },
    event: ({ id, type, ids }) => {
      handlers?.onActivity();
      handlers?.onFrame({
        kind: 'event',
        event: 'event',
        ...(id === undefined ? {} : { id }),
        data: JSON.stringify({
          ...(id === undefined ? {} : { id }),
          ts: '2026-08-17T09:00:00.000Z',
          type,
          ids: ids ?? {},
          payload: {},
          persist: id !== undefined,
        }),
      });
    },
    replayComplete: () => {
      handlers?.onActivity();
      handlers?.onFrame({ kind: 'event', event: 'replay-complete', data: '{"count":0}' });
    },
    replayError: () => {
      handlers?.onActivity();
      handlers?.onFrame({
        kind: 'event',
        event: 'error',
        data: '{"error":"replay_failed","message":"The event replay could not be read."}',
      });
    },
    raw: (data) => {
      handlers?.onActivity();
      handlers?.onFrame({ kind: 'event', event: 'event', data });
    },
    heartbeat: () => {
      handlers?.onActivity();
      handlers?.onFrame({ kind: 'comment' });
    },
    drop: async () => {
      reject?.(new Error('the core stopped answering'));
      await flush();
    },
  };
}

interface Harness {
  readonly stream: EventStream;
  readonly wire: Wire;
  readonly clock: Clock;
  readonly frames: EventFrame[];
  readonly states: ConnectionState[];
}

function harness(
  options: { since?: string; offlineAfterMs?: number; heartbeatTimeoutMs?: number } = {},
): Harness {
  const clock = makeClock();
  const wire = makeWire();
  const frames: EventFrame[] = [];
  const states: ConnectionState[] = [];
  if (options.since !== undefined) {
    window.localStorage.setItem(WATERMARK_STORAGE_KEY, options.since);
  }
  const stream = new EventStream({
    client: new ApiClient({
      fetch: (() => Promise.reject(new Error('unused'))) as unknown as typeof globalThis.fetch,
      tokens: { get: () => null, set: () => undefined },
    }),
    transport: wire.transport,
    storage: window.localStorage,
    setTimeoutImpl: clock.set,
    clearTimeoutImpl: clock.clear,
    now: clock.now,
    ...(options.offlineAfterMs === undefined ? {} : { offlineAfterMs: options.offlineAfterMs }),
    ...(options.heartbeatTimeoutMs === undefined
      ? {}
      : { heartbeatTimeoutMs: options.heartbeatTimeoutMs }),
  });
  stream.on((frame) => frames.push(frame));
  stream.onStateChange((state) => states.push(state));
  return { stream, wire, clock, frames, states };
}

let live: EventStream | undefined;
afterEach(() => {
  live?.stop();
  live = undefined;
});

// ---------------------------------------------------------------------------

describe('the types= subscription filter (§3.3)', () => {
  it('never subscribes to another session’s deltas, messages, tools or usage', () => {
    // "the global feed subscribes to lifecycle, question, assignment, project,
    // roster and remote types and is never sent another session's
    // session.delta/session.message/session.tool.*/session.usage at all".
    expect(GLOBAL_EVENT_TYPES).not.toContain('session.*');
    expect(GLOBAL_EVENT_TYPES).not.toContain('session.delta');
    expect(GLOBAL_EVENT_TYPES).not.toContain('session.message');
    expect(GLOBAL_EVENT_TYPES).not.toContain('session.usage');
    expect(GLOBAL_EVENT_TYPES.some((type) => type.startsWith('session.tool'))).toBe(false);
    // Lifecycle is named one by one, because the board needs it.
    for (const type of ['session.queued', 'session.started', 'session.ended']) {
      expect(GLOBAL_EVENT_TYPES).toContain(type);
    }
  });

  it('puts the filter on the connect URL, relative and same-origin', () => {
    const { stream } = harness();
    live = stream;
    stream.start();
    const url = stream.streamUrl();
    expect(url.startsWith('/api/events?')).toBe(true);
    expect(url).not.toMatch(/^https?:/u);
    const types = new URL(url, 'http://127.0.0.1:7477').searchParams.get('types');
    expect(types?.split(',')).toEqual(GLOBAL_EVENT_TYPES);
  });
});

describe('the watermark and ?since= replay (§3.3)', () => {
  it('advances the watermark only on persisted events, and persists it', async () => {
    const { stream, wire, frames } = harness();
    live = stream;
    stream.start();
    await wire.open();

    wire.event({ id: '01AAA', type: 'roster.changed' });
    expect(stream.watermark).toBe('01AAA');
    expect(window.localStorage.getItem(WATERMARK_STORAGE_KEY)).toBe('01AAA');

    // A non-persisted event has no id and can never have been replayed
    // (runner §15.2 #12), so it must not move the watermark.
    wire.event({ type: 'runner.queue.changed' });
    expect(stream.watermark).toBe('01AAA');

    wire.event({ id: '01BBB', type: 'project.created' });
    expect(stream.watermark).toBe('01BBB');
    expect(frames.map((frame) => frame.type)).toEqual([
      'roster.changed',
      'runner.queue.changed',
      'project.created',
    ]);
  });

  it('reconnects with ?since=<watermark> and the identical filter', async () => {
    const { stream, wire, clock } = harness();
    live = stream;
    stream.start();
    await wire.open();
    wire.replayComplete();
    wire.event({ id: '01AAA', type: 'roster.changed' });

    await wire.drop();
    await clock.advance(BACKOFF_MS[0] ?? 500);

    expect(wire.urls).toHaveLength(2);
    const first = new URL(wire.urls[0] ?? '', 'http://127.0.0.1:7477');
    const second = new URL(wire.urls[1] ?? '', 'http://127.0.0.1:7477');
    expect(first.searchParams.get('since')).toBeNull();
    expect(second.searchParams.get('since')).toBe('01AAA');
    // "same filter, same subset" — a reconnect that widened it would deliver
    // events the client never subscribed to.
    expect(second.searchParams.get('types')).toBe(first.searchParams.get('types'));
  });

  it('starts from a watermark left by a previous page load', () => {
    const { stream } = harness({ since: '01OLD' });
    live = stream;
    expect(stream.watermark).toBe('01OLD');
    expect(stream.streamUrl()).toContain('since=01OLD');
  });

  it('delivers a replayed event exactly once and moves the watermark past it', async () => {
    const { stream, wire, clock, frames } = harness();
    live = stream;
    stream.start();
    await wire.open();
    wire.replayComplete();
    wire.event({ id: '01AAA', type: 'roster.changed' });

    // The core is restarted. What was emitted while the socket was down arrives
    // in the replay — and only in the replay, because the server skips ids it
    // already sent (http/routes/events.ts).
    await wire.drop();
    await clock.advance(BACKOFF_MS[0] ?? 500);
    await wire.open();
    wire.event({ id: '01BBB', type: 'project.created' });
    wire.replayComplete();

    expect(frames.filter((frame) => frame.id === '01BBB')).toHaveLength(1);
    expect(stream.watermark).toBe('01BBB');
    expect(stream.replayCount).toBe(2);
  });
});

describe('connection state, exponential backoff and the heartbeat (§3.3)', () => {
  it('is not live until the replay finishes, not merely when the socket opens', async () => {
    const { stream, wire, states } = harness();
    live = stream;
    expect(stream.state).toBe('reconnecting');
    stream.start();
    await wire.open();
    // Open, but still catching up: claiming `live` here would be a lie.
    expect(stream.state).toBe('reconnecting');
    wire.replayComplete();
    expect(stream.state).toBe('live');
    expect(states).toEqual(['live']);
  });

  it('flips to reconnecting at once and to offline after five seconds', async () => {
    const { stream, wire, clock } = harness();
    live = stream;
    stream.start();
    await wire.open();
    wire.replayComplete();
    expect(stream.state).toBe('live');

    await wire.drop();
    // "within 2s" — immediately, in fact: the socket breaking *is* the signal.
    expect(stream.state).toBe('reconnecting');

    await clock.advance(4_000);
    expect(stream.state).toBe('reconnecting');
    await clock.advance(1_100);
    expect(stream.state).toBe('offline');
  });

  it('backs off exponentially, then holds at the ceiling', async () => {
    // The offline and heartbeat timers are pushed out of the way so the only
    // thing pending at any moment is the retry — otherwise `nextDelay` reports
    // whichever of the three happens to be nearest, which is not the ladder.
    const { stream, wire, clock } = harness({
      offlineAfterMs: 600_000,
      heartbeatTimeoutMs: 600_000,
    });
    live = stream;
    stream.start();
    await wire.open();
    wire.replayComplete();

    const observed: number[] = [];
    await wire.drop();
    for (let attempt = 0; attempt < BACKOFF_MS.length + 2; attempt += 1) {
      const delay = clock.nextDelay();
      if (delay !== undefined) observed.push(delay);
      await clock.advance(delay ?? 0);
      await wire.drop();
    }

    const ceiling = BACKOFF_MS[BACKOFF_MS.length - 1] ?? 0;
    // The ladder, in order, and then the ceiling forever.
    expect(observed.slice(0, BACKOFF_MS.length)).toEqual([...BACKOFF_MS]);
    expect(observed[observed.length - 1]).toBe(ceiling);
  });

  it('resets the ladder once a reconnect actually catches up', async () => {
    const { stream, wire, clock } = harness();
    live = stream;
    stream.start();
    await wire.open();
    wire.replayComplete();

    await wire.drop();
    await clock.advance(BACKOFF_MS[0] ?? 500);
    await wire.open();
    wire.replayComplete();
    expect(stream.state).toBe('live');

    await wire.drop();
    // Back to the first rung, not the second: the outage ended.
    expect(clock.nextDelay()).toBe(BACKOFF_MS[0]);
  });

  it('treats a silent feed past three heartbeats as a dead socket', async () => {
    const { stream, wire, clock } = harness();
    live = stream;
    stream.start();
    await wire.open();
    wire.replayComplete();

    // Foundation beats every 15s. Two beats keep it live…
    await clock.advance(15_000);
    wire.heartbeat();
    await clock.advance(15_000);
    wire.heartbeat();
    await clock.advance(15_000);
    expect(stream.state).toBe('live');
    expect(wire.urls).toHaveLength(1);

    // …and then nothing at all. The socket is open and the far end is gone.
    await clock.advance(HEARTBEAT_TIMEOUT_MS + 1);
    expect(stream.state).not.toBe('live');
    await clock.advance(BACKOFF_MS[0] ?? 500);
    expect(wire.urls.length).toBeGreaterThan(1);
  });

  it('stop() ends the retry loop rather than leaving a timer behind', async () => {
    const { stream, wire, clock } = harness();
    live = stream;
    stream.start();
    await wire.open();
    await wire.drop();
    stream.stop();
    await clock.advance(60_000);
    expect(wire.urls).toHaveLength(1);
  });
});

describe('frames that are not events', () => {
  it('never dispatches a heartbeat comment as an event', async () => {
    const { stream, wire, frames } = harness();
    live = stream;
    stream.start();
    await wire.open();
    wire.heartbeat();
    expect(frames).toHaveLength(0);
  });

  it('drops a malformed frame and keeps the connection, rather than throwing', async () => {
    const { stream, wire, frames } = harness();
    live = stream;
    stream.start();
    await wire.open();

    expect(() => wire.raw('not json at all')).not.toThrow();
    expect(() => wire.raw('{"ts":"x"}')).not.toThrow(); // no `type`
    expect(frames).toHaveLength(0);

    // The stream is still usable afterwards, which is the point.
    wire.event({ id: '01AAA', type: 'roster.changed' });
    expect(frames.map((frame) => frame.type)).toEqual(['roster.changed']);
  });

  it('surfaces the server’s replay error without treating it as an event', async () => {
    const { stream, wire, frames } = harness();
    live = stream;
    stream.start();
    await wire.open();
    wire.replayError();
    expect(frames).toHaveLength(0);
  });
});
