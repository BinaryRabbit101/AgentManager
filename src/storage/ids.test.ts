import { describe, expect, it } from 'vitest';
import { decodeTime } from 'ulid';

import { ULID_LENGTH, isId, newId, newIdAt } from './ids.js';

describe('newId', () => {
  it('produces canonical 26-character ULIDs', () => {
    const id = newId();
    expect(id).toHaveLength(ULID_LENGTH);
    expect(isId(id)).toBe(true);
  });

  it('is unique across a tight loop', () => {
    const ids = new Set(Array.from({ length: 2000 }, () => newId()));
    expect(ids.size).toBe(2000);
  });

  it('sorts lexicographically in creation order, even within one millisecond', () => {
    const ids = Array.from({ length: 500 }, () => newId());
    expect([...ids].sort()).toEqual(ids);
  });

  it('is filename- and URL-safe (Crockford base32 only)', () => {
    expect(newId()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});

describe('newIdAt', () => {
  it('encodes the supplied instant', () => {
    const at = new Date('2026-08-16T10:35:00.000Z');
    expect(decodeTime(newIdAt(at))).toBe(at.getTime());
  });

  it('rejects an invalid date rather than encoding NaN', () => {
    expect(() => newIdAt(new Date('nonsense'))).toThrow(RangeError);
  });
});

describe('isId', () => {
  it('rejects anything that is not a canonical ULID', () => {
    expect(isId('')).toBe(false);
    expect(isId('not-a-ulid')).toBe(false);
    // Right alphabet, wrong length.
    expect(isId(newId().slice(0, 25))).toBe(false);
    // Right length, excluded letters (I, L, O, U are not Crockford base32).
    expect(isId('I'.repeat(26))).toBe(false);
  });
});
