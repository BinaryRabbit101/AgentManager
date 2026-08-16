/**
 * The small conversions every repository does between a SQLite row and a
 * typed record.
 *
 * They live in one file so the mapping rules are decided once: SQLite has no
 * boolean and no JSON type, so `0`/`1` and `TEXT` are the storage forms, and
 * every repository must agree on how they come back out.
 */
import { RestrictedDeleteError, sqliteCode } from '../errors.js';

/** SQLite has no boolean type; `0`/`1` INTEGER is the storage form. */
export function toBool(value: number): boolean {
  return value !== 0;
}

/** @see toBool */
export function fromBool(value: boolean): number {
  return value ? 1 : 0;
}

/**
 * A `*_json` column's value, as stored.
 *
 * `undefined` and `null` both mean "no value" at the call site and both store
 * as SQL NULL — there is no useful distinction between a column that was never
 * set and one set to nothing, and pretending there is produces two ways to
 * express the same row.
 */
export function toJsonColumn(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

/** Parses a `*_json` column. A NULL column yields `undefined`, not `null`. */
export function fromJsonColumn<T>(value: string | null): T | undefined {
  if (value === null) return undefined;
  return JSON.parse(value) as T;
}

/** Normalises an optional string input to the nullable column it becomes. */
export function orNull(value: string | null | undefined): string | null {
  return value === undefined || value === null ? null : value;
}

/** Normalises an optional number input to the nullable column it becomes. */
export function numberOrNull(value: number | null | undefined): number | null {
  return value === undefined || value === null ? null : value;
}

/**
 * Result codes SQLite uses for a foreign-key refusal.
 *
 * Two of them, which is not obvious: a deferred or immediate FK violation is
 * `SQLITE_CONSTRAINT_FOREIGNKEY`, but `ON DELETE RESTRICT` is implemented
 * internally as a trigger and surfaces as `SQLITE_CONSTRAINT_TRIGGER` — so
 * matching only the first would let the very rule §1.4 relies on escape as an
 * unrecognised driver error.
 */
const FOREIGN_KEY_CODES = new Set(['SQLITE_CONSTRAINT_FOREIGNKEY', 'SQLITE_CONSTRAINT_TRIGGER']);

/**
 * Runs a delete, translating a RESTRICT refusal into {@link RestrictedDeleteError}.
 *
 * §1.4 makes "deleting a project with history is refused" a database
 * guarantee. The driver reports it as a constraint code and the bare message
 * "FOREIGN KEY constraint failed", which says nothing about which row was
 * protected or what the caller should do instead; this wraps it once, at the
 * only place that can name the table and the id.
 */
export function runRestrictedDelete(table: string, id: string, run: () => number): boolean {
  try {
    return run() > 0;
  } catch (error) {
    const code = sqliteCode(error);
    if (code !== undefined && FOREIGN_KEY_CODES.has(code)) {
      throw new RestrictedDeleteError(table, id, code, { cause: error });
    }
    throw error;
  }
}
