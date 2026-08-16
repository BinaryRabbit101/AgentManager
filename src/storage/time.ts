/**
 * Timestamp helpers.
 *
 * DESIGN §1.3: "all timestamps stored as ISO-8601 UTC strings
 * (`2026-08-16T10:35:00.000Z`)". Every column, event and log field that carries
 * a time uses {@link isoTimestamp}, so the shape is decided in exactly one
 * place and sorts lexicographically everywhere it lands.
 */

/** A function returning the current instant; injectable so tests are not time-dependent. */
export type Clock = () => Date;

export const systemClock: Clock = () => new Date();

/** Matches the exact shape `2026-08-16T10:35:00.000Z` — always UTC, always milliseconds. */
export const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * Formats an instant as an ISO-8601 UTC timestamp.
 *
 * `Date.prototype.toISOString` already produces the required shape; this
 * wrapper exists so call sites name the contract rather than the mechanism,
 * and so an invalid `Date` fails here instead of writing `"Invalid Date"` into
 * a row.
 */
export function isoTimestamp(at: Date = systemClock()): string {
  const ms = at.getTime();
  if (!Number.isFinite(ms)) {
    throw new RangeError('isoTimestamp: expected a valid Date');
  }
  return at.toISOString();
}

/** True when `value` is an ISO-8601 UTC timestamp of the shape this project stores. */
export function isIsoTimestamp(value: string): boolean {
  return ISO_TIMESTAMP_PATTERN.test(value) && Number.isFinite(Date.parse(value));
}

/**
 * The same instant, rendered for use inside a filename.
 *
 * Windows forbids `:` in path components, so backup files
 * (`agentmanager-<schemaVersion>-<ts>.db`, DESIGN §1.2) cannot carry a raw ISO
 * string. Separators become `-`, which keeps the lexicographic ordering the
 * ISO form was chosen for.
 */
export function filenameTimestamp(at: Date = systemClock()): string {
  return isoTimestamp(at).replace(/[:.]/g, '-');
}
