/**
 * Per-session usage metering (runner DESIGN §7.1–§7.3, as amended by SDK-NOTES
 * **C1**) — milestone M4.
 *
 * ## The two sources, and why there are two
 *
 * - **Live deltas (`source: 'turn'`).** One `usage_events` row per *distinct*
 *   assistant `message.id`, taken from `message.message.usage`. Parallel tool
 *   calls emit several assistant messages sharing one id with identical usage,
 *   so the row is keyed by `(session_id, run_id, message_id)` and a duplicate is
 *   a **no-op insert** rather than a doubled count (`0001_runner.sql`'s unique
 *   index; `INSERT OR IGNORE` below is what turns the index into a no-op). These
 *   rows are explicitly approximate — per-step `output_tokens` is a placeholder
 *   count taken at `message_start` — and they exist so the UI's live counter and
 *   the mid-session budget tripwire have something to read before the turn ends.
 * - **Authoritative reconciliation (`source: 'reconcile'`).** At every turn
 *   `result`, `result.modelUsage` is the per-model total — the strict superset,
 *   including subagent and compaction spend — and one adjustment row per model
 *   carries the difference between it and what has already been recorded. After
 *   each result the recorded total is *exactly* `modelUsage`.
 *
 * ## C1: the baseline is a **run**, never the session row
 *
 * `modelUsage` and `total_cost_usd` are documented as cumulative per `query()`
 * call, and "resumed sessions start fresh". §7.1 as written reconciles against
 * what has been recorded "for this session", which is correct inside one
 * `query()` and wrong the moment §9.4's pause/resume reuses the same session row
 * with a new `query()`: the second run's `modelUsage` restarts at zero, the
 * delta goes negative, and the rollup — and with it `assignments.tokens_used`,
 * which the budget halt reads — would *shrink* back to the resumed run's spend.
 * A parked-and-resumed session would earn its budget back every time it parked.
 *
 * So every write carries a `run_id`, the reconciliation subtracts what this
 * **run** has recorded, and a negative delta throws
 * {@link NegativeUsageDeltaError} instead of being written. That assertion is
 * the whole point: a negative delta can only mean the run boundary was missed,
 * and silently clamping it would hide exactly the bug that costs the user
 * budget. Cost follows the same rule — `session_usage.cost_usd` is
 * `Σ over runs (latest total_cost_usd of that run)`, never a sum across results
 * and never the last result's value alone.
 *
 * C1's other clause is honoured too: "crash/startup-error results may carry
 * **zeroed** usage" — an all-zero `modelUsage` is skipped rather than treated as
 * a correction down to zero.
 *
 * ## One transaction, three writes
 *
 * §7.1 and §7.2 both insist on it: the `usage_events` insert, the
 * `session_usage` upsert and the `assignments.tokens_used` increment commit
 * together or not at all. "Not via an event: a budget check that lags an
 * event-bus hop is a budget check that overruns."
 *
 * **Deviation, raised rather than absorbed.** Foundation ships
 * `store.usage.record()`, which does exactly that shape — and cannot be used
 * here, for three reasons that are all design pins rather than preferences:
 * it adds *all four* counters to `assignments.tokens_used` where §7.2 pins
 * `+= input_tokens + output_tokens` ("cache-read and cache-creation tokens …
 * do **not** count toward the budget"); it has no `source`, `message_id` or
 * `run_id`, so neither the dedupe nor C1's per-run baseline can be expressed;
 * and it cannot write `cost_usd`. `usage_events` and `session_usage` are tables
 * runner **owns** (§1), so the statements live here — beside `repository.ts`'s
 * `sessions` statements and for the same reason — while `assignments` is still
 * reached only through foundation's repository.
 */
import type { AssignmentsRepository, Clock } from '../../storage/index.js';
import { newId } from '../../storage/index.js';
import type { Database } from '../../storage/sqlite.js';

import { NegativeUsageDeltaError } from './errors.js';
import type { AssistantMessage, ResultFacts } from './messages.js';

/** The four counters, in runner's names. `usage_events` has one column each. */
export interface UsageTokens {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheCreation: number;
}

export const ZERO_TOKENS: UsageTokens = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };

export function addTokens(left: UsageTokens, right: UsageTokens): UsageTokens {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheCreation: left.cacheCreation + right.cacheCreation,
  };
}

export function subtractTokens(left: UsageTokens, right: UsageTokens): UsageTokens {
  return {
    input: left.input - right.input,
    output: left.output - right.output,
    cacheRead: left.cacheRead - right.cacheRead,
    cacheCreation: left.cacheCreation - right.cacheCreation,
  };
}

export function isZeroTokens(tokens: UsageTokens): boolean {
  return (
    tokens.input === 0 &&
    tokens.output === 0 &&
    tokens.cacheRead === 0 &&
    tokens.cacheCreation === 0
  );
}

export function hasNegative(tokens: UsageTokens): boolean {
  return tokens.input < 0 || tokens.output < 0 || tokens.cacheRead < 0 || tokens.cacheCreation < 0;
}

export function totalTokens(tokens: UsageTokens): number {
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheCreation;
}

/**
 * §7.2's pinned definition: `assignments.tokens_used += input_tokens +
 * output_tokens`. Cache tokens are metered for cost display and do **not** count
 * toward an assignment's budget.
 */
export function billableTokens(tokens: UsageTokens): number {
  return tokens.input + tokens.output;
}

/** §7.1's two row kinds. */
export type UsageSource = 'turn' | 'reconcile';

/** One row bound for `usage_events`. */
export interface UsageDeltaInput {
  readonly source: UsageSource;
  /** The assistant `message.id` for a live delta; `null` for a reconciliation. */
  readonly messageId: string | null;
  readonly model: string | null;
  readonly tokens: UsageTokens;
}

/** The `session_usage` row, with §7.3's estimate under a name that says so. */
export interface SessionUsageTotals {
  readonly sessionId: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  /** The sum of the four counters (foundation's column). */
  readonly totalTokens: number;
  /** How many `usage_events` rows have been rolled up. */
  readonly events: number;
  /** Turn `result` messages seen (§2.4: one per turn). */
  readonly turns: number;
  /** §7.3: an estimate, nullable, never a spend figure. */
  readonly costUsdEstimate: number | null;
  readonly updatedAt: string;
}

/** One `usage_events` row, with runner's three added columns (§3.5, C1). */
export interface UsageEventRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly ts: string;
  readonly tokens: UsageTokens;
  readonly model: string | null;
  readonly source: UsageSource;
  readonly messageId: string | null;
  readonly runId: string | null;
}

export interface UsageWriteResult {
  /** `false` when the dedupe index made the insert a no-op (§7.1). */
  readonly recorded: boolean;
  /** What was actually added — all zeroes on a deduped write. */
  readonly delta: UsageTokens;
  readonly totals: SessionUsageTotals | undefined;
  /** `assignments.tokens_used` after the increment, for the budget tripwire. */
  readonly assignmentTokensUsed: number | undefined;
}

export interface RecordDeltaInput {
  readonly sessionId: string;
  readonly assignmentId: string;
  readonly runId: string;
  readonly delta: UsageDeltaInput;
  readonly at?: string;
}

export interface RecordTurnInput {
  readonly sessionId: string;
  readonly assignmentId: string;
  readonly runId: string;
  /** One row per model whose recorded total is behind `modelUsage`. */
  readonly adjustments: readonly UsageDeltaInput[];
  /** Added to `session_usage.cost_usd`; `null` leaves the column untouched. */
  readonly costUsdDelta: number | null;
  readonly at?: string;
}

/**
 * One rolling window's sums over `usage_events` (§7.4, M11).
 *
 * `sessions` is `COUNT(DISTINCT session_id)` rather than a row count: §7.4's
 * payload says "N sessions since <t>", and a session that wrote forty deltas is
 * still one session. It counts sessions that *spent* in the window, which is a
 * different — and more useful — number than sessions that *started* in it: a
 * long session started before the cut-off is still consuming the owner's plan
 * window right now, and a window that ignored it would under-report exactly
 * when the owner most wants the truth.
 */
export interface UsageWindowSums {
  /** The window's lower bound, inclusive, as it was queried. */
  readonly since: string;
  readonly tokens: UsageTokens;
  /** `usage_events` rows in the window. */
  readonly events: number;
  /** Distinct sessions that recorded any of them. */
  readonly sessions: number;
}

export interface UsageRepository {
  /** One live delta: event + rollup + assignment total, in one transaction. */
  recordDelta(input: RecordDeltaInput): UsageWriteResult;
  /** A turn's reconciliation, turn count and cost — also one transaction. */
  recordTurn(input: RecordTurnInput): UsageWriteResult;
  totals(sessionId: string): SessionUsageTotals | undefined;
  /** The append-only series, oldest first — the UI's per-session cost chart. */
  listEvents(sessionId: string): readonly UsageEventRecord[];
  /** What this **run** has recorded, per model — C1's reconciliation baseline. */
  runTotalsByModel(sessionId: string, runId: string): ReadonlyMap<string, UsageTokens>;
  /** `SUM(usage_events)` for a session, which M4 asserts equals the rollup. */
  eventSums(sessionId: string): UsageTokens & { readonly events: number };
  /**
   * §7.4's rolling window: every session's spend since `since`.
   *
   * One indexed range scan over `usage_events_window` (`migrations/runner/
   * 0003_usage_windows.sql`) and no in-memory accumulator anywhere, which is
   * what makes the answer survive a restart: the window is *derived* on every
   * read from the append-only table, so there is no counter to lose.
   */
  windowSums(since: string): UsageWindowSums;
}

interface TotalsRow {
  readonly session_id: string;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_read_tokens: number;
  readonly cache_creation_tokens: number;
  readonly total_tokens: number;
  readonly events: number;
  readonly turns: number;
  readonly cost_usd: number | null;
  readonly updated_at: string;
}

interface ModelSumRow {
  readonly model: string;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_read_tokens: number;
  readonly cache_creation_tokens: number;
}

interface EventSumRow extends ModelSumRow {
  readonly events: number;
}

interface WindowSumRow extends EventSumRow {
  readonly sessions: number;
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
  readonly source: UsageSource;
  readonly message_id: string | null;
  readonly run_id: string | null;
}

function toTotals(row: TotalsRow): SessionUsageTotals {
  return {
    sessionId: row.session_id,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheCreationTokens: row.cache_creation_tokens,
    totalTokens: row.total_tokens,
    events: row.events,
    turns: row.turns,
    costUsdEstimate: row.cost_usd,
    updatedAt: row.updated_at,
  };
}

export interface UsageRepositoryOptions {
  readonly db: Database;
  /** Foundation's repository — the only door to the `assignments` table (§7.2). */
  readonly assignments: Pick<AssignmentsRepository, 'addTokensUsed'>;
  readonly clock: Clock;
}

export function createUsageRepository(options: UsageRepositoryOptions): UsageRepository {
  const { db, assignments, clock } = options;

  // `OR IGNORE` is the dedupe: the unique index of `0001_runner.sql` turns a
  // repeated `(session_id, run_id, message_id)` into a skipped row rather than
  // an error, which is exactly what §7.1 asks for ("a duplicate is a no-op
  // insert, not a doubled count"). Foreign-key violations still abort, so a
  // session id that does not exist is still a failure rather than a silent loss.
  const insertEvent = db.prepare<
    [
      string,
      string,
      string,
      number,
      number,
      number,
      number,
      string | null,
      string,
      string | null,
      string,
    ]
  >(
    `INSERT OR IGNORE INTO usage_events
       (id, session_id, ts, input_tokens, output_tokens, cache_read_tokens,
        cache_creation_tokens, model, source, message_id, run_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  // One upsert rather than a read-modify-write, for foundation's reason: the
  // rollup is only correct if it is derived from its own stored value inside the
  // same transaction. `cost_usd` accumulates only when an estimate was supplied
  // — NULL means "not reported", which is a different fact from 0.00 (§7.3).
  const upsertTotals = db.prepare<
    [string, number, number, number, number, number, number, number, number | null, string]
  >(
    `INSERT INTO session_usage
       (session_id, input_tokens, output_tokens, cache_read_tokens,
        cache_creation_tokens, total_tokens, events, turns, cost_usd, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       input_tokens          = input_tokens + excluded.input_tokens,
       output_tokens         = output_tokens + excluded.output_tokens,
       cache_read_tokens     = cache_read_tokens + excluded.cache_read_tokens,
       cache_creation_tokens = cache_creation_tokens + excluded.cache_creation_tokens,
       total_tokens          = total_tokens + excluded.total_tokens,
       events                = events + excluded.events,
       turns                 = turns + excluded.turns,
       cost_usd              = CASE WHEN excluded.cost_usd IS NULL THEN cost_usd
                                    ELSE COALESCE(cost_usd, 0) + excluded.cost_usd END,
       updated_at            = excluded.updated_at`,
  );

  const readTotals = db.prepare<[string], TotalsRow>(
    `SELECT session_id, input_tokens, output_tokens, cache_read_tokens,
            cache_creation_tokens, total_tokens, events, turns, cost_usd, updated_at
     FROM session_usage WHERE session_id = ?`,
  );

  const readRunByModel = db.prepare<[string, string], ModelSumRow>(
    `SELECT COALESCE(model, '')            AS model,
            SUM(input_tokens)              AS input_tokens,
            SUM(output_tokens)             AS output_tokens,
            SUM(cache_read_tokens)         AS cache_read_tokens,
            SUM(cache_creation_tokens)     AS cache_creation_tokens
     FROM usage_events
     WHERE session_id = ? AND run_id = ?
     GROUP BY COALESCE(model, '')`,
  );

  const readEvents = db.prepare<[string], EventRow>(
    `SELECT id, session_id, ts, input_tokens, output_tokens, cache_read_tokens,
            cache_creation_tokens, model, source, message_id, run_id
     FROM usage_events WHERE session_id = ? ORDER BY ts, id`,
  );

  const readEventSums = db.prepare<[string], EventSumRow>(
    `SELECT COUNT(*)                              AS events,
            ''                                    AS model,
            COALESCE(SUM(input_tokens), 0)        AS input_tokens,
            COALESCE(SUM(output_tokens), 0)       AS output_tokens,
            COALESCE(SUM(cache_read_tokens), 0)   AS cache_read_tokens,
            COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens
     FROM usage_events WHERE session_id = ?`,
  );

  // §7.4's window, M11. `ts >= ?` over the `usage_events_window` index; the
  // upper bound is deliberately open, because a row stamped a few milliseconds
  // into the future by a clock skew is still this app's spend and dropping it
  // would make the window quietly wrong rather than visibly late.
  const readWindow = db.prepare<[string], WindowSumRow>(
    `SELECT COUNT(*)                                AS events,
            COUNT(DISTINCT session_id)              AS sessions,
            ''                                      AS model,
            COALESCE(SUM(input_tokens), 0)          AS input_tokens,
            COALESCE(SUM(output_tokens), 0)         AS output_tokens,
            COALESCE(SUM(cache_read_tokens), 0)     AS cache_read_tokens,
            COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens
     FROM usage_events WHERE ts >= ?`,
  );

  function now(): string {
    return clock().toISOString();
  }

  /** The three writes §7.1/§7.2 require to commit together. */
  function apply(input: {
    readonly sessionId: string;
    readonly assignmentId: string;
    readonly runId: string;
    readonly deltas: readonly UsageDeltaInput[];
    readonly turns: number;
    readonly costUsdDelta: number | null;
    readonly at: string;
  }): UsageWriteResult {
    let written = ZERO_TOKENS;
    let rows = 0;

    for (const delta of input.deltas) {
      const changes = insertEvent.run(
        newId(),
        input.sessionId,
        input.at,
        delta.tokens.input,
        delta.tokens.output,
        delta.tokens.cacheRead,
        delta.tokens.cacheCreation,
        delta.model,
        delta.source,
        delta.messageId,
        input.runId,
      ).changes;
      // Zero changes is the dedupe firing. Skipping the rollup with it is what
      // makes the whole write idempotent rather than only the insert.
      if (changes === 0) continue;
      written = addTokens(written, delta.tokens);
      rows += 1;
    }

    if (rows === 0 && input.turns === 0 && input.costUsdDelta === null) {
      // Everything deduped and there was nothing else to roll up: the write is a
      // no-op by design, not a failure.
      const existing = readTotals.get(input.sessionId);
      return {
        recorded: false,
        delta: ZERO_TOKENS,
        totals: existing === undefined ? undefined : toTotals(existing),
        assignmentTokensUsed: undefined,
      };
    }

    upsertTotals.run(
      input.sessionId,
      written.input,
      written.output,
      written.cacheRead,
      written.cacheCreation,
      totalTokens(written),
      rows,
      input.turns,
      input.costUsdDelta,
      input.at,
    );

    // §7.2, verbatim: `tokens_used += input_tokens + output_tokens`. Through
    // foundation's repository, inside this transaction — the budget halt of §7.2
    // reads the column one statement later and must not see a half-applied turn.
    const billable = billableTokens(written);
    const assignmentTokensUsed =
      billable === 0 ? undefined : assignments.addTokensUsed(input.assignmentId, billable);

    return {
      recorded: rows > 0,
      delta: written,
      totals: toTotals(readTotals.get(input.sessionId) as TotalsRow),
      assignmentTokensUsed,
    };
  }

  const applyTransaction = db.transaction(apply);

  return {
    recordDelta: (input) =>
      applyTransaction({
        sessionId: input.sessionId,
        assignmentId: input.assignmentId,
        runId: input.runId,
        deltas: [input.delta],
        turns: 0,
        costUsdDelta: null,
        at: input.at ?? now(),
      }),

    recordTurn: (input) =>
      applyTransaction({
        sessionId: input.sessionId,
        assignmentId: input.assignmentId,
        runId: input.runId,
        deltas: input.adjustments,
        turns: 1,
        costUsdDelta: input.costUsdDelta,
        at: input.at ?? now(),
      }),

    totals(sessionId) {
      const row = readTotals.get(sessionId);
      return row === undefined ? undefined : toTotals(row);
    },

    listEvents: (sessionId) =>
      readEvents.all(sessionId).map((row) => ({
        id: row.id,
        sessionId: row.session_id,
        ts: row.ts,
        tokens: {
          input: row.input_tokens,
          output: row.output_tokens,
          cacheRead: row.cache_read_tokens,
          cacheCreation: row.cache_creation_tokens,
        },
        model: row.model,
        source: row.source,
        messageId: row.message_id,
        runId: row.run_id,
      })),

    runTotalsByModel(sessionId, runId) {
      const totals = new Map<string, UsageTokens>();
      for (const row of readRunByModel.all(sessionId, runId)) {
        totals.set(row.model, {
          input: row.input_tokens,
          output: row.output_tokens,
          cacheRead: row.cache_read_tokens,
          cacheCreation: row.cache_creation_tokens,
        });
      }
      return totals;
    },

    eventSums(sessionId) {
      const row = readEventSums.get(sessionId) as EventSumRow;
      return {
        input: row.input_tokens,
        output: row.output_tokens,
        cacheRead: row.cache_read_tokens,
        cacheCreation: row.cache_creation_tokens,
        events: row.events,
      };
    },

    windowSums(since) {
      const row = readWindow.get(since) as WindowSumRow;
      return {
        since,
        tokens: {
          input: row.input_tokens,
          output: row.output_tokens,
          cacheRead: row.cache_read_tokens,
          cacheCreation: row.cache_creation_tokens,
        },
        events: row.events,
        sessions: row.sessions,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Reading the SDK's numbers
// ---------------------------------------------------------------------------

/** One model's entry in `result.modelUsage`. */
export interface ModelUsageEntry {
  readonly model: string;
  readonly tokens: UsageTokens;
}

function readNumber(source: Record<string, unknown>, key: string): number {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * `message.message.usage` — the live per-message estimate (§7.1).
 *
 * Permissive by construction: the SDK's `BetaUsage` marks the cache counters
 * nullable, and a build that renames one must cost the UI a live counter, not a
 * session.
 */
export function readMessageTokens(message: AssistantMessage): UsageTokens {
  const usage: unknown = message.message.usage;
  if (typeof usage !== 'object' || usage === null) return ZERO_TOKENS;
  const record = usage as Record<string, unknown>;
  return {
    input: readNumber(record, 'input_tokens'),
    output: readNumber(record, 'output_tokens'),
    cacheRead: readNumber(record, 'cache_read_input_tokens'),
    cacheCreation: readNumber(record, 'cache_creation_input_tokens'),
  };
}

/**
 * `result.modelUsage` — `Record<string, ModelUsage>`, per SDK-NOTES §6.1.
 *
 * Read defensively for the same reason: this is accounting, and a shape change
 * must degrade to "no reconciliation this turn" rather than to a throw inside
 * the reader loop.
 */
export function readModelUsage(value: unknown): readonly ModelUsageEntry[] {
  if (typeof value !== 'object' || value === null) return [];
  const entries: ModelUsageEntry[] = [];
  for (const [model, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== 'object' || raw === null) continue;
    const record = raw as Record<string, unknown>;
    entries.push({
      model,
      tokens: {
        input: readNumber(record, 'inputTokens'),
        output: readNumber(record, 'outputTokens'),
        cacheRead: readNumber(record, 'cacheReadInputTokens'),
        cacheCreation: readNumber(record, 'cacheCreationInputTokens'),
      },
    });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// The run meter
// ---------------------------------------------------------------------------

/** What a metering write tells the caller, for `session.usage` (§10). */
export interface MeteredUsage {
  readonly source: UsageSource;
  readonly delta: UsageTokens;
  readonly model: string | null;
  readonly totals: SessionUsageTotals | undefined;
  readonly assignmentTokensUsed: number | undefined;
}

export type MeterLog = (
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string,
  detail?: Record<string, unknown>,
) => void;

export interface RunMeterOptions {
  readonly usage: UsageRepository;
  readonly sessionId: string;
  readonly assignmentId: string;
  /** One id per `query()` call — C1's baseline grain. */
  readonly runId: string;
  readonly log?: MeterLog | undefined;
  readonly onUsage?: ((usage: MeteredUsage) => void) | undefined;
}

/**
 * Meters one `query()` call.
 *
 * Created per run rather than per session, because that is the only grain the
 * SDK's cumulative numbers actually have (C1). A pause/resume makes a second
 * meter over the same session row, and the two never share a baseline.
 */
export interface RunMeter {
  readonly runId: string;
  /** A live delta, deduped by assistant `message.id` (§7.1). */
  recordAssistantMessage(message: AssistantMessage): UsageWriteResult | undefined;
  /** A turn `result`: turn count, cost, and the per-run reconciliation. */
  recordResult(facts: ResultFacts): UsageWriteResult | undefined;
}

/**
 * How far a reconciliation may move the run's recorded total before it is worth
 * a `warn` rather than a `debug` (§7.1: "a large one at `warn`, because that
 * means the live estimate is misleading the UI").
 *
 * A ratio rather than a count: "500 tokens off" means nothing without knowing
 * whether the turn spent 600 or 600 000. The floor keeps a two-token turn from
 * warning about a two-token correction.
 */
export const LARGE_ADJUSTMENT_RATIO = 0.25;
export const LARGE_ADJUSTMENT_FLOOR = 200;

export function createRunMeter(options: RunMeterOptions): RunMeter {
  const { usage, sessionId, assignmentId, runId } = options;
  const log: MeterLog = options.log ?? ((): void => {});

  /** The latest `total_cost_usd` **this run** has already contributed (C1). */
  let costRecorded = 0;

  function emit(source: UsageSource, model: string | null, result: UsageWriteResult): void {
    if (!result.recorded) return;
    options.onUsage?.({
      source,
      delta: result.delta,
      model,
      totals: result.totals,
      assignmentTokensUsed: result.assignmentTokensUsed,
    });
  }

  return {
    runId,

    recordAssistantMessage(message) {
      const messageId = typeof message.message.id === 'string' ? message.message.id : null;
      // No id means no dedupe key, and parallel tool calls are exactly the case
      // the key defends against. Counting an unkeyed message would be a guess
      // that the reconciliation would then have to unpick; skipping it costs a
      // live counter update and nothing else, because the reconciliation reads
      // `modelUsage` and not these rows.
      if (messageId === null) return undefined;

      const tokens = readMessageTokens(message);
      if (isZeroTokens(tokens)) return undefined;

      const model = typeof message.message.model === 'string' ? message.message.model : null;
      const written = usage.recordDelta({
        sessionId,
        assignmentId,
        runId,
        delta: { source: 'turn', messageId, model, tokens },
      });
      emit('turn', model, written);
      return written;
    },

    recordResult(facts) {
      const entries = readModelUsage(facts.modelUsage);
      // C1: "crash/startup-error results may carry zeroed usage — reconciliation
      // must skip an all-zero `modelUsage` rather than treat it as a correction
      // to zero." The turn still happened, so it is still counted.
      const zeroed = entries.length === 0 || entries.every((entry) => isZeroTokens(entry.tokens));
      const recordedByModel = zeroed
        ? new Map<string, UsageTokens>()
        : usage.runTotalsByModel(sessionId, runId);

      const adjustments: UsageDeltaInput[] = [];
      let adjusted = ZERO_TOKENS;

      if (!zeroed) {
        for (const entry of entries) {
          const recorded = recordedByModel.get(entry.model) ?? ZERO_TOKENS;
          const delta = subtractTokens(entry.tokens, recorded);
          if (hasNegative(delta)) {
            throw new NegativeUsageDeltaError(sessionId, runId, entry.model, delta);
          }
          if (isZeroTokens(delta)) continue;
          adjustments.push({
            source: 'reconcile',
            messageId: null,
            model: entry.model,
            tokens: delta,
          });
          adjusted = addTokens(adjusted, delta);
        }
      }

      // `total_cost_usd` carries the same per-run lifecycle as `modelUsage`, so
      // the stored estimate is a sum of per-run latest values (C1).
      let costUsdDelta: number | null = null;
      if (!zeroed && typeof facts.costUsd === 'number' && Number.isFinite(facts.costUsd)) {
        const delta = facts.costUsd - costRecorded;
        if (delta < 0) {
          throw new NegativeUsageDeltaError(sessionId, runId, 'total_cost_usd', ZERO_TOKENS, delta);
        }
        costRecorded = facts.costUsd;
        costUsdDelta = delta;
      }

      const written = usage.recordTurn({
        sessionId,
        assignmentId,
        runId,
        adjustments,
        costUsdDelta,
      });

      if (adjustments.length > 0) {
        const moved = totalTokens(adjusted);
        const after = written.totals?.totalTokens ?? moved;
        const large = moved >= LARGE_ADJUSTMENT_FLOOR && moved >= after * LARGE_ADJUSTMENT_RATIO;
        log(large ? 'warn' : 'debug', 'reconciled session usage against result.modelUsage', {
          sessionId,
          runId,
          adjustedTokens: moved,
          rollupTokens: after,
          models: adjustments.map((one) => one.model),
        });
      }

      emit('reconcile', adjustments.length === 1 ? (adjustments[0]?.model ?? null) : null, written);
      return written;
    },
  };
}
