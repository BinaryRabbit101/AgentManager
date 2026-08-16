/**
 * Identifier generation.
 *
 * DESIGN §1.3: "IDs: application-generated `ULID` strings (sortable, opaque,
 * safe in filenames and URLs). No autoincrement integers in cross-element
 * contracts." Every element asks for an id here rather than reaching for the
 * `ulid` package itself, so the monotonic factory below is shared and two ids
 * minted in the same millisecond still sort in creation order.
 */
import { isValid, monotonicFactory, ulid } from 'ulid';

/** Canonical ULID length: 10 characters of timestamp + 16 of randomness. */
export const ULID_LENGTH = 26;

const nextMonotonic = monotonicFactory();

/**
 * A new ULID.
 *
 * Monotonic within a millisecond: successive calls at the same instant
 * increment the random component instead of re-rolling it, so ids minted in a
 * tight loop (a transcript's events, a batch insert) sort in the order they
 * were created rather than arbitrarily.
 */
export function newId(): string {
  return nextMonotonic();
}

/**
 * A new ULID for an explicit instant, with fresh randomness.
 *
 * Used where an id must encode a caller-supplied time (backfills, fixtures,
 * tests with an injected clock) rather than "now".
 */
export function newIdAt(at: Date): string {
  const ms = at.getTime();
  if (!Number.isFinite(ms)) {
    throw new RangeError('newIdAt: expected a valid Date');
  }
  return ulid(ms);
}

/** True when `value` is a well-formed canonical ULID. */
export function isId(value: string): boolean {
  return value.length === ULID_LENGTH && isValid(value);
}
