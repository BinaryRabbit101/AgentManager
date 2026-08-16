import { describe, expect, it } from 'vitest';

import { filenameTimestamp, isIsoTimestamp, isoTimestamp, systemClock } from './time.js';

const instant = new Date('2026-08-16T10:35:00.000Z');

describe('isoTimestamp', () => {
  it('produces exactly the shape DESIGN §1.3 specifies', () => {
    expect(isoTimestamp(instant)).toBe('2026-08-16T10:35:00.000Z');
  });

  it('normalises a non-UTC instant to UTC', () => {
    expect(isoTimestamp(new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 5)))).toBe(
      '2026-01-01T00:00:00.005Z',
    );
  });

  it('defaults to now, and now is a valid timestamp', () => {
    expect(isIsoTimestamp(isoTimestamp())).toBe(true);
  });

  it('refuses an invalid Date instead of writing "Invalid Date"', () => {
    expect(() => isoTimestamp(new Date('nonsense'))).toThrow(RangeError);
  });

  it('sorts lexicographically in chronological order', () => {
    const earlier = isoTimestamp(new Date('2026-08-16T10:35:00.000Z'));
    const later = isoTimestamp(new Date('2026-08-16T10:35:00.001Z'));
    expect(earlier < later).toBe(true);
  });
});

describe('isIsoTimestamp', () => {
  it('accepts the stored shape and rejects near-misses', () => {
    expect(isIsoTimestamp('2026-08-16T10:35:00.000Z')).toBe(true);
    expect(isIsoTimestamp('2026-08-16T10:35:00Z')).toBe(false); // no milliseconds
    expect(isIsoTimestamp('2026-08-16T10:35:00.000+01:00')).toBe(false); // not UTC
    expect(isIsoTimestamp('2026-08-16 10:35:00.000Z')).toBe(false); // no T
    expect(isIsoTimestamp('')).toBe(false);
  });
});

describe('filenameTimestamp', () => {
  it('contains no character Windows forbids in a path component', () => {
    const stamp = filenameTimestamp(instant);
    expect(stamp).toBe('2026-08-16T10-35-00-000Z');
    expect(stamp).not.toMatch(/[<>:"/\\|?*]/);
  });

  it('keeps chronological order under lexicographic sort', () => {
    const a = filenameTimestamp(new Date('2026-08-16T10:35:00.000Z'));
    const b = filenameTimestamp(new Date('2026-08-16T10:35:00.001Z'));
    expect(a < b).toBe(true);
  });
});

describe('systemClock', () => {
  it('returns the current instant', () => {
    const before = Date.now();
    const now = systemClock().getTime();
    expect(now).toBeGreaterThanOrEqual(before);
  });
});
