import { describe, expect, it } from 'vitest';

import { LogRing } from './ring.js';
import type { LogLevel, LogRecord } from './types.js';

function record(
  index: number,
  overrides: Partial<LogRecord> & { level?: LogLevel } = {},
): LogRecord {
  return {
    ts: new Date(Date.UTC(2026, 7, 16, 10, 0, index)).toISOString(),
    level: 'info',
    component: 'core',
    msg: `record ${index}`,
    ...overrides,
  };
}

describe('LogRing', () => {
  it('rejects a non-positive capacity', () => {
    expect(() => new LogRing(0)).toThrow(RangeError);
  });

  it('keeps records in order until it is full', () => {
    const ring = new LogRing(4);
    for (let i = 0; i < 3; i += 1) ring.push(record(i));
    expect(ring.size).toBe(3);
    expect(ring.toArray().map((r) => r.msg)).toEqual(['record 0', 'record 1', 'record 2']);
  });

  it('overwrites the oldest record once full', () => {
    const ring = new LogRing(3);
    for (let i = 0; i < 5; i += 1) ring.push(record(i));
    expect(ring.size).toBe(3);
    expect(ring.toArray().map((r) => r.msg)).toEqual(['record 2', 'record 3', 'record 4']);
  });

  it('holds the 2000 records the log API serves', () => {
    const ring = new LogRing(2000);
    for (let i = 0; i < 2500; i += 1) ring.push(record(i));
    expect(ring.size).toBe(2000);
    expect(ring.toArray()[0]?.msg).toBe('record 500');
  });

  it('filters by minimum severity', () => {
    const ring = new LogRing(10);
    ring.push(record(0, { level: 'debug' }));
    ring.push(record(1, { level: 'info' }));
    ring.push(record(2, { level: 'error' }));
    expect(ring.query({ level: 'info' }).map((r) => r.level)).toEqual(['info', 'error']);
    expect(ring.query({ level: 'error' }).map((r) => r.level)).toEqual(['error']);
  });

  it('filters by component and sessionId', () => {
    const ring = new LogRing(10);
    ring.push(record(0, { component: 'runner', sessionId: 'S1' }));
    ring.push(record(1, { component: 'runner', sessionId: 'S2' }));
    ring.push(record(2, { component: 'storage', sessionId: 'S1' }));
    expect(ring.query({ component: 'runner' })).toHaveLength(2);
    expect(ring.query({ sessionId: 'S1' })).toHaveLength(2);
    expect(ring.query({ component: 'runner', sessionId: 'S1' })).toHaveLength(1);
  });

  it('treats since as an exclusive lower bound and accepts a Date', () => {
    const ring = new LogRing(10);
    for (let i = 0; i < 4; i += 1) ring.push(record(i));
    const cutoff = record(1).ts;
    expect(ring.query({ since: cutoff }).map((r) => r.msg)).toEqual(['record 2', 'record 3']);
    expect(ring.query({ since: new Date(cutoff) })).toHaveLength(2);
  });

  it('limits to the most recent matches, still in order', () => {
    const ring = new LogRing(10);
    for (let i = 0; i < 5; i += 1) ring.push(record(i));
    expect(ring.query({ limit: 2 }).map((r) => r.msg)).toEqual(['record 3', 'record 4']);
    expect(ring.query({ limit: 0 })).toEqual([]);
  });

  it('clears back to empty', () => {
    const ring = new LogRing(3);
    ring.push(record(0));
    ring.clear();
    expect(ring.size).toBe(0);
    expect(ring.toArray()).toEqual([]);
  });
});

describe('subscription', () => {
  it('notifies subscribers on every push, and stops on unsubscribe', () => {
    const ring = new LogRing(3);
    const seen: string[] = [];
    const cancel = ring.subscribe((entry) => void seen.push(entry.msg ?? ''));

    ring.push(record(0));
    ring.push(record(1));
    expect(seen).toEqual(['record 0', 'record 1']);
    expect(ring.subscriberCount).toBe(1);

    cancel();
    cancel();
    ring.push(record(2));
    expect(seen).toEqual(['record 0', 'record 1']);
    expect(ring.subscriberCount).toBe(0);
  });

  it('does not let a throwing subscriber break the logger or the others', () => {
    const ring = new LogRing(3);
    const seen: string[] = [];
    ring.subscribe(() => {
      throw new Error('subscriber is broken');
    });
    ring.subscribe((entry) => void seen.push(entry.msg ?? ''));

    expect(() => ring.push(record(0))).not.toThrow();
    expect(seen).toEqual(['record 0']);
    expect(ring.size).toBe(1);
  });
});
