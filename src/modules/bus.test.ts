/**
 * The event bus (DESIGN §6.5, IMPLEMENTATION §7).
 *
 * Acceptance: "Emitting a `persist: true` event writes exactly one `events` row
 * and fans out to subscribers; a subscriber that throws does not break other
 * subscribers."
 *
 * The persistence tests run against a real database in a temp data root, so
 * "exactly one row" is counted in SQLite rather than in a mock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openStorage, type Storage } from '../storage/index.js';

import { createEventBus, createEventTypeFilter, matchesEventType } from './bus.js';
import type { AppEvent } from './types.js';
import { makeTempDir, type TempDir } from './__tests__/helpers.js';

let root: TempDir;
let storage: Storage;

beforeEach(() => {
  root = makeTempDir('agentmanager-bus-');
  storage = openStorage({ dataRoot: root.path, tightenAcl: false });
});

afterEach(() => {
  storage.close();
  root.cleanup();
});

const fixedClock = (): Date => new Date('2026-08-16T10:35:00.000Z');

describe('matchesEventType', () => {
  it('matches an exact type', () => {
    expect(matchesEventType('session.started', 'session.started')).toBe(true);
    expect(matchesEventType('session.started', 'session.ended')).toBe(false);
  });

  it('matches a prefix.* pattern, including deeper namespaces', () => {
    expect(matchesEventType('session.*', 'session.started')).toBe(true);
    expect(matchesEventType('session.*', 'session.tool.use')).toBe(true);
    expect(matchesEventType('session.*', 'question.opened')).toBe(false);
    // The prefix must be a whole segment: `session.*` is not `session*`.
    expect(matchesEventType('session.*', 'sessionish.started')).toBe(false);
  });

  it('treats no filter as everything', () => {
    expect(createEventTypeFilter(undefined)('anything')).toBe(true);
    expect(createEventTypeFilter([])('anything')).toBe(true);
  });
});

describe('emit', () => {
  it('writes exactly one events row for persist:true and fans out', () => {
    const seen: AppEvent[] = [];
    const bus = createEventBus({ clock: fixedClock, events: storage.store.events });
    bus.subscribe((event) => void seen.push(event));

    const emitted = bus.emit({
      type: 'session.started',
      ids: { sessionId: 'S1', projectId: 'P1' },
      payload: { model: 'sonnet' },
      persist: true,
    });

    expect(storage.store.events.count()).toBe(1);
    const rows = storage.store.events.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe('session.started');
    expect(rows[0]?.sessionId).toBe('S1');
    expect(rows[0]?.projectId).toBe('P1');
    expect(rows[0]?.payloadJson).toBe(JSON.stringify({ model: 'sonnet' }));

    // The subscriber saw the same event, carrying the row's id as a watermark.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.id).toBe(rows[0]?.id);
    expect(emitted.id).toBe(rows[0]?.id);
    expect(emitted.ts).toBe('2026-08-16T10:35:00.000Z');
  });

  it('writes no row without persist, but still fans out', () => {
    const seen: AppEvent[] = [];
    const bus = createEventBus({ clock: fixedClock, events: storage.store.events });
    bus.subscribe((event) => void seen.push(event));

    bus.emit({ type: 'session.delta', payload: { text: 'hi' } });

    expect(storage.store.events.count()).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.persist).toBe(false);
    expect(seen[0]?.id).toBeUndefined();
  });

  it('does not let one throwing subscriber break the others', () => {
    const calls: string[] = [];
    const onListenerError = vi.fn();
    const bus = createEventBus({
      clock: fixedClock,
      events: storage.store.events,
      onListenerError,
    });

    bus.subscribe(() => void calls.push('first'));
    bus.subscribe(() => {
      calls.push('second');
      throw new Error('subscriber exploded');
    });
    bus.subscribe(() => void calls.push('third'));

    expect(() => bus.emit({ type: 'question.opened', persist: true })).not.toThrow();

    expect(calls).toEqual(['first', 'second', 'third']);
    expect(onListenerError).toHaveBeenCalledTimes(1);
    // And the row was still written: persistence happens before fan-out.
    expect(storage.store.events.count()).toBe(1);
  });

  it('keeps fanning out when the events table cannot be written', () => {
    const onPersistError = vi.fn();
    const seen: AppEvent[] = [];
    const bus = createEventBus({
      clock: fixedClock,
      events: {
        append: () => {
          throw new Error('database is locked');
        },
      },
      onPersistError,
    });
    bus.subscribe((event) => void seen.push(event));

    expect(() => bus.emit({ type: 'session.started', persist: true })).not.toThrow();
    expect(onPersistError).toHaveBeenCalledTimes(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.id).toBeUndefined();
  });
});

describe('subscriptions', () => {
  it('filters by exact type and prefix.* pattern', () => {
    const bus = createEventBus({ clock: fixedClock });
    const seen: string[] = [];
    bus.subscribe(['session.*', 'question.opened'], (event) => void seen.push(event.type));

    for (const type of [
      'session.started',
      'session.tool.use',
      'question.opened',
      'question.answered',
      'usage.recorded',
    ]) {
      bus.emit({ type });
    }

    expect(seen).toEqual(['session.started', 'session.tool.use', 'question.opened']);
  });

  it('selects the same subset the events repository does for the same types', () => {
    // §6.5: the filter is "applied identically to the live fan-out and to the
    // `since=` replay, so a reconnect returns the same subset it was
    // streaming". Both sides are checked against each other here.
    const types = ['session.*', 'question.opened'];
    const bus = createEventBus({ clock: fixedClock, events: storage.store.events });
    const live: string[] = [];
    bus.subscribe(types, (event) => void live.push(`${event.type}:${String(event.id)}`));

    for (const type of [
      'session.started',
      'session.tool.use',
      'question.opened',
      'question.answered',
      'usage.recorded',
    ]) {
      bus.emit({ type, persist: true });
    }

    const replayed = storage.store.events.list({ types }).map((row) => `${row.type}:${row.id}`);

    expect(live).toEqual(replayed);
  });

  it('stops delivering after unsubscribe', () => {
    const bus = createEventBus({ clock: fixedClock });
    const seen: string[] = [];
    const unsubscribe = bus.subscribe((event) => void seen.push(event.type));

    bus.emit({ type: 'one' });
    expect(bus.subscriberCount()).toBe(1);
    unsubscribe();
    unsubscribe();
    bus.emit({ type: 'two' });

    expect(seen).toEqual(['one']);
    expect(bus.subscriberCount()).toBe(0);
  });

  it('delivers the in-flight event to the subscriber list as it was at emit', () => {
    const bus = createEventBus({ clock: fixedClock });
    const seen: string[] = [];
    let unsubscribeLate: (() => void) | undefined = undefined;

    bus.subscribe(() => {
      // A listener that tears another one down during fan-out must not change
      // who receives the event currently being delivered.
      unsubscribeLate?.();
      seen.push('early');
    });
    unsubscribeLate = bus.subscribe(() => void seen.push('late'));

    bus.emit({ type: 'session.started' });
    expect(seen).toEqual(['early', 'late']);

    seen.length = 0;
    bus.emit({ type: 'session.started' });
    expect(seen).toEqual(['early']);
  });
});
