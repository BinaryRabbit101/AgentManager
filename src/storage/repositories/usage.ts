/**
 * The `usage_events` / `session_usage` repository (§1.4, §8).
 *
 * The decision this implements, verbatim: "`usage_events` append-only deltas +
 * `session_usage` rollup written in the same transaction as the delta insert;
 * assignment totals rolled onto `assignments.tokens_used`. Budget enforcement
 * needs a single indexed read per check; the UI needs the time series. Writing
 * both in one transaction keeps them from drifting."
 *
 * So {@link UsageRepository.record} is deliberately not three calls a caller can
 * make two of.
 */
import { RecordNotFoundError } from '../errors.js';
import { newId } from '../ids.js';
import type { Database } from '../sqlite.js';
import type { Clock } from '../time.js';
import { isoTimestamp } from '../time.js';
import { orNull } from './sql.js';

/** One turn's token counts. Every field defaults to 0. */
export interface UsageDelta {
  readonly sessionId: string;
  readonly id?: string;
  readonly ts?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheCreationTokens?: number;
  readonly model?: string | null;
}

export interface UsageEvent {
  readonly id: string;
  readonly sessionId: string;
  readonly ts: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  readonly model: string | null;
}

/** The `session_usage` rollup — one indexed read, no SUM. */
export interface UsageTotals {
  readonly sessionId: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  /** The sum of the four counters: the one number a budget is checked against. */
  readonly totalTokens: number;
  /** How many deltas have been recorded. */
  readonly events: number;
  readonly updatedAt: string;
}

export interface UsageRepository {
  /**
   * Appends one delta, updates the session rollup and adds the same total to
   * the session's assignment — all in one transaction.
   *
   * Returns the rollup as it now stands, so a caller enforcing a budget does
   * not need a second read.
   */
  record(delta: UsageDelta): UsageTotals;
  /** The rollup for one session. `undefined` until the first delta is recorded. */
  totals(sessionId: string): UsageTotals | undefined;
  /** The raw time series, oldest first — the UI's per-session cost chart. */
  listEvents(sessionId: string, options?: { limit?: number }): readonly UsageEvent[];
}

interface TotalsRow {
  readonly session_id: string;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_read_tokens: number;
  readonly cache_creation_tokens: number;
  readonly total_tokens: number;
  readonly events: number;
  readonly updated_at: string;
}

interface EventRow {
  readonly id: string;
  readonly session_id: string;
  readonly ts: string;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_read_tokens: number;
  readonly cache_creation_tokens: number;
  readonly model: string | null;
}

function toTotals(row: TotalsRow): UsageTotals {
  return {
    sessionId: row.session_id,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheCreationTokens: row.cache_creation_tokens,
    totalTokens: row.total_tokens,
    events: row.events,
    updatedAt: row.updated_at,
  };
}

export function createUsageRepository(db: Database, clock: Clock): UsageRepository {
  const insertEvent = db.prepare<
    [string, string, string, number, number, number, number, string | null]
  >(
    `INSERT INTO usage_events
       (id, session_id, ts, input_tokens, output_tokens, cache_read_tokens,
        cache_creation_tokens, model)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  // One upsert rather than a read-modify-write: the rollup is only correct if
  // it is derived from its own stored value inside the same transaction.
  const upsertTotals = db.prepare<[string, number, number, number, number, number, string]>(
    `INSERT INTO session_usage
       (session_id, input_tokens, output_tokens, cache_read_tokens,
        cache_creation_tokens, total_tokens, events, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       input_tokens          = input_tokens + excluded.input_tokens,
       output_tokens         = output_tokens + excluded.output_tokens,
       cache_read_tokens     = cache_read_tokens + excluded.cache_read_tokens,
       cache_creation_tokens = cache_creation_tokens + excluded.cache_creation_tokens,
       total_tokens          = total_tokens + excluded.total_tokens,
       events                = events + 1,
       updated_at            = excluded.updated_at`,
  );

  const getTotals = db.prepare<[string], TotalsRow>(
    `SELECT session_id, input_tokens, output_tokens, cache_read_tokens,
            cache_creation_tokens, total_tokens, events, updated_at
     FROM session_usage WHERE session_id = ?`,
  );

  const listEvents = db.prepare<[string, number], EventRow>(
    `SELECT id, session_id, ts, input_tokens, output_tokens, cache_read_tokens,
            cache_creation_tokens, model
     FROM usage_events WHERE session_id = ? ORDER BY ts, id LIMIT ?`,
  );

  // Reaches `assignments` through the session, so no caller has to remember to
  // pass an assignment id that could disagree with the session's.
  const addToAssignment = db.prepare<[number, string]>(
    `UPDATE assignments SET tokens_used = tokens_used + ?
     WHERE id = (SELECT assignment_id FROM sessions WHERE id = ?)`,
  );

  const recordTransaction = db.transaction((delta: UsageDelta): TotalsRow => {
    const input = delta.inputTokens ?? 0;
    const output = delta.outputTokens ?? 0;
    const cacheRead = delta.cacheReadTokens ?? 0;
    const cacheCreation = delta.cacheCreationTokens ?? 0;
    const total = input + output + cacheRead + cacheCreation;
    const ts = delta.ts ?? isoTimestamp(clock());

    insertEvent.run(
      delta.id ?? newId(),
      delta.sessionId,
      ts,
      input,
      output,
      cacheRead,
      cacheCreation,
      orNull(delta.model),
    );
    upsertTotals.run(delta.sessionId, input, output, cacheRead, cacheCreation, total, ts);

    // Zero changes means the session has no assignment row, which the schema
    // makes impossible — but a silent no-op here would be a budget that stops
    // counting, so it is worth the assertion.
    if (addToAssignment.run(total, delta.sessionId).changes === 0) {
      throw new RecordNotFoundError('assignments', `via session ${delta.sessionId}`);
    }

    return getTotals.get(delta.sessionId) as TotalsRow;
  });

  return {
    record: (delta) => toTotals(recordTransaction(delta)),
    totals: (sessionId) => {
      const row = getTotals.get(sessionId);
      return row === undefined ? undefined : toTotals(row);
    },
    listEvents: (sessionId, options = {}) =>
      listEvents.all(sessionId, options.limit ?? -1).map((row) => ({
        id: row.id,
        sessionId: row.session_id,
        ts: row.ts,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        cacheReadTokens: row.cache_read_tokens,
        cacheCreationTokens: row.cache_creation_tokens,
        model: row.model,
      })),
  };
}
