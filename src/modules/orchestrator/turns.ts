/**
 * `TurnRepository` — `assignment_turns`, the persisted state `plan()` is a pure
 * function of (DESIGN §3.1, IMPLEMENTATION M5-2).
 *
 * ## The table is the lock
 *
 * `assignment_turns_active` is a **partial unique index** over
 * `(assignment_id) WHERE status IN ('planned','running')`, so "at most one turn
 * in flight per assignment" is a database fact rather than an in-process flag a
 * restart forgets (§2.1). {@link TurnRepository.plan} therefore does not check
 * first and insert second — it inserts and lets the index refuse, which is the
 * only version of that check that is safe against two engines racing after a
 * crash. The refusal comes back as {@link TurnAlreadyActiveError}.
 *
 * ## What is derived rather than stored
 *
 * §3.3 records a `retryOf` on the row it re-plans after an unstructured turn.
 * There is no `retry_of` column, and adding one would put a fact in two places:
 * a retry *is* "another row with the same `(round, seat)` as one that already
 * ended", which the `assignment_turns_read` index answers directly. So
 * {@link TurnRow.retryOfTurnId} is computed on read, in the same discipline §8.1
 * applies to breaker counters — "re-derived on every evaluation rather than
 * maintained incrementally, so a restart cannot lose or double-count one".
 */
import type { Clock, Database } from '../../storage/index.js';
import { isoTimestamp, newId } from '../../storage/index.js';

import { OrchestratorError } from './errors.js';

/** The `status` CHECK constraint of `assignment_turns`, as a closed set. */
export const TURN_STATUSES = [
  'planned',
  'running',
  'reported',
  'unstructured',
  'blocked',
  'failed',
] as const;

export type TurnStatus = (typeof TURN_STATUSES)[number];

/** A turn that is neither finished nor abandoned — what the partial index guards. */
export const ACTIVE_TURN_STATUSES: readonly TurnStatus[] = ['planned', 'running'];

// ---------------------------------------------------------------------------
// `report_status`'s payload (§4.3)
// ---------------------------------------------------------------------------

export const REPORT_STATES = ['working', 'blocked', 'needs_review', 'done'] as const;
export type ReportState = (typeof REPORT_STATES)[number];

export function isReportState(value: unknown): value is ReportState {
  return typeof value === 'string' && (REPORT_STATES as readonly string[]).includes(value);
}

export interface ReportArtifact {
  readonly path: string;
  readonly kind?: string | undefined;
}

export interface BlockingIssue {
  readonly severity: string;
  readonly summary: string;
}

/**
 * The critic seat's structured verdict.
 *
 * §3.3's convergence rule reads exactly two things off it, and both are
 * structural: `decision === 'accept'` **and** an empty `blocking` list. "An
 * 'accept, but these three things are blocking' report is treated as `revise` —
 * the words lose to the structure."
 */
export interface TurnVerdict {
  readonly decision: 'accept' | 'revise';
  readonly blocking: readonly BlockingIssue[];
  readonly nonBlocking: readonly string[];
}

export interface TurnReport {
  readonly state: ReportState;
  readonly headline: string;
  readonly detail?: string | undefined;
  readonly artifacts: readonly ReportArtifact[];
  readonly verdict?: TurnVerdict | undefined;
  /** When the report landed — the turn's own `ended_at` is written beside it. */
  readonly at: string;
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export interface TurnRow {
  readonly id: string;
  readonly assignmentId: string;
  readonly round: number;
  readonly seat: string;
  readonly agentId: string;
  readonly sessionId: string | null;
  /** The seat's previous session, for §3.2's `continueFrom`. */
  readonly prevSessionId: string | null;
  readonly status: TurnStatus;
  readonly report: TurnReport | null;
  readonly outputText: string | null;
  readonly artifactHash: string | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  /**
   * Runner's `permission_denials` total for this turn's session (§8.1
   * `tool_denials`).
   *
   * Stored rather than counted in process, because §8.1's counters are
   * "re-derived from `assignment_turns` on every evaluation" and the number
   * arrives exactly once, on `session.ended`.
   */
  readonly permissionDenials: number;
  /** Derived, never stored — see the file header. */
  readonly retryOfTurnId: string | null;
}

export interface PlanTurnInput {
  readonly assignmentId: string;
  readonly round: number;
  readonly seat: string;
  readonly agentId: string;
  readonly prevSessionId?: string | undefined;
}

/** What a turn's completion records, whichever of §3.2's three channels supplied it. */
export interface CompleteTurnInput {
  readonly status: Exclude<TurnStatus, 'planned' | 'running'>;
  readonly outputText?: string | null | undefined;
  readonly artifactHash?: string | null | undefined;
  /** Runner's count for the session, when `session.ended` carried one (§8.1). */
  readonly permissionDenials?: number | undefined;
}

export interface TurnRepository {
  /**
   * Inserts a `planned` turn, or refuses because one is already in flight.
   *
   * @throws {TurnAlreadyActiveError} when `assignment_turns_active` refuses.
   */
  plan(input: PlanTurnInput): TurnRow;
  get(id: string): TurnRow | undefined;
  /** Every turn of an assignment, oldest first — round then insertion order. */
  list(assignmentId: string): readonly TurnRow[];
  /** The one `planned`-or-`running` turn, if there is one. */
  active(assignmentId: string): TurnRow | undefined;
  findBySession(sessionId: string): TurnRow | undefined;
  /** `planned` → `running`, recording the session runner actually started. */
  start(id: string, sessionId: string): TurnRow;
  /** Records a `report_status` payload against a turn (§4.3). */
  report(id: string, report: TurnReport): TurnRow;
  /** Bounded live capture of the last assistant text (§3.2 channel 2). */
  setOutput(id: string, text: string, maxBytes: number): TurnRow;
  setArtifactHash(id: string, hash: string | null): TurnRow;
  /** The terminal transition: `reported` | `unstructured` | `blocked` | `failed`. */
  complete(id: string, input: CompleteTurnInput): TurnRow;
}

/**
 * The partial unique index refused — a turn is already planned or running.
 *
 * Not an internal error: it is the *expected* outcome of two advance attempts
 * racing (an `advance` request arriving while a `session.ended` handler is
 * mid-flight, or two engines after a crash), and the caller's correct response
 * is to do nothing. That is why it is a typed 409 rather than a crash.
 */
export class TurnAlreadyActiveError extends OrchestratorError {
  override readonly name = 'TurnAlreadyActiveError';

  constructor(readonly assignmentId: string) {
    super(
      'turn_already_active',
      `Assignment ${assignmentId} already has a turn planned or running; v1's patterns are ` +
        'sequential, so a second one is refused by assignment_turns_active.',
      409,
      { assignmentId },
    );
  }
}

interface RawTurn {
  readonly id: string;
  readonly assignment_id: string;
  readonly round: number;
  readonly seat: string;
  readonly agent_id: string;
  readonly session_id: string | null;
  readonly prev_session_id: string | null;
  readonly status: TurnStatus;
  readonly report_json: string | null;
  readonly output_text: string | null;
  readonly artifact_hash: string | null;
  readonly started_at: string | null;
  readonly ended_at: string | null;
  readonly permission_denials: number;
}

const COLUMNS =
  'id, assignment_id, round, seat, agent_id, session_id, prev_session_id, status, ' +
  'report_json, output_text, artifact_hash, started_at, ended_at, permission_denials';

export interface TurnRepositoryOptions {
  readonly db: Database;
  readonly clock: Clock;
  readonly log?: (message: string, detail?: Record<string, unknown>) => void;
}

export function createTurnRepository(options: TurnRepositoryOptions): TurnRepository {
  const { db, clock } = options;

  const insert = db.prepare<
    [string, string, number, string, string, string | null, string, string]
  >(
    'INSERT INTO assignment_turns (id, assignment_id, round, seat, agent_id, prev_session_id, ' +
      'status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const selectOne = db.prepare<[string], RawTurn>(
    `SELECT ${COLUMNS} FROM assignment_turns WHERE id = ?`,
  );
  // `rowid` rather than `id`: ULIDs sort by creation time, but two turns planned
  // inside the same millisecond would sort by their random tail. Insertion order
  // is the fact the pattern's "last turn" reading depends on.
  const selectAll = db.prepare<[string], RawTurn>(
    `SELECT ${COLUMNS} FROM assignment_turns WHERE assignment_id = ? ORDER BY round, rowid`,
  );
  const selectActive = db.prepare<[string], RawTurn>(
    `SELECT ${COLUMNS} FROM assignment_turns WHERE assignment_id = ? ` +
      "AND status IN ('planned', 'running') ORDER BY rowid LIMIT 1",
  );
  const selectBySession = db.prepare<[string], RawTurn>(
    `SELECT ${COLUMNS} FROM assignment_turns WHERE session_id = ? ORDER BY rowid DESC LIMIT 1`,
  );
  const setRunning = db.prepare<[string, string, string]>(
    "UPDATE assignment_turns SET status = 'running', session_id = ?, started_at = ? WHERE id = ?",
  );
  const setReport = db.prepare<[string, string]>(
    'UPDATE assignment_turns SET report_json = ? WHERE id = ?',
  );
  const setOutputText = db.prepare<[string, string]>(
    'UPDATE assignment_turns SET output_text = ? WHERE id = ?',
  );
  const setHash = db.prepare<[string | null, string]>(
    'UPDATE assignment_turns SET artifact_hash = ? WHERE id = ?',
  );
  const setComplete = db.prepare<[string, string, string]>(
    'UPDATE assignment_turns SET status = ?, ended_at = ? WHERE id = ?',
  );
  const setDenials = db.prepare<[number, string]>(
    'UPDATE assignment_turns SET permission_denials = ? WHERE id = ?',
  );

  function now(): string {
    return isoTimestamp(clock());
  }

  function parseReport(json: string | null, id: string): TurnReport | null {
    if (json === null) return null;
    try {
      const parsed: unknown = JSON.parse(json);
      if (typeof parsed !== 'object' || parsed === null) return null;
      return parsed as TurnReport;
    } catch {
      // A report that will not parse is a turn with no structured channel, which
      // is exactly what `unstructured` means — so the safe reading is "no
      // report" rather than a throw that would strand the whole assignment.
      options.log?.('assignment_turns.report_json did not parse; the turn reads as unreported', {
        turnId: id,
      });
      return null;
    }
  }

  /** Turns of one assignment, raw, so `retryOfTurnId` can be derived across them. */
  function hydrateAll(rows: readonly RawTurn[]): readonly TurnRow[] {
    const seenBySeatRound = new Map<string, string>();
    return rows.map((row) => {
      const key = `${String(row.round)}:${row.seat}`;
      const previous = seenBySeatRound.get(key) ?? null;
      seenBySeatRound.set(key, row.id);
      return {
        id: row.id,
        assignmentId: row.assignment_id,
        round: row.round,
        seat: row.seat,
        agentId: row.agent_id,
        sessionId: row.session_id,
        prevSessionId: row.prev_session_id,
        status: row.status,
        report: parseReport(row.report_json, row.id),
        outputText: row.output_text,
        artifactHash: row.artifact_hash,
        startedAt: row.started_at,
        endedAt: row.ended_at,
        permissionDenials: row.permission_denials,
        retryOfTurnId: previous,
      };
    });
  }

  function hydrateOne(row: RawTurn): TurnRow {
    // The single-row read still needs the whole seat/round history to know
    // whether this row is a retry, so it derives from the same list.
    const all = hydrateAll(selectAll.all(row.assignment_id));
    const found = all.find((turn) => turn.id === row.id);
    if (found === undefined) throw new Error(`Internal error: turn ${row.id} vanished.`);
    return found;
  }

  function require_(id: string): TurnRow {
    const row = selectOne.get(id);
    if (row === undefined) throw new Error(`Internal error: no assignment turn ${id}.`);
    return hydrateOne(row);
  }

  return {
    plan(input) {
      const id = newId();
      try {
        insert.run(
          id,
          input.assignmentId,
          input.round,
          input.seat,
          input.agentId,
          input.prevSessionId ?? null,
          'planned',
          now(),
        );
      } catch (error) {
        if (isUniqueViolation(error)) throw new TurnAlreadyActiveError(input.assignmentId);
        throw error;
      }
      return require_(id);
    },

    get(id) {
      const row = selectOne.get(id);
      return row === undefined ? undefined : hydrateOne(row);
    },

    list: (assignmentId) => hydrateAll(selectAll.all(assignmentId)),

    active(assignmentId) {
      const row = selectActive.get(assignmentId);
      return row === undefined ? undefined : hydrateOne(row);
    },

    findBySession(sessionId) {
      const row = selectBySession.get(sessionId);
      return row === undefined ? undefined : hydrateOne(row);
    },

    start(id, sessionId) {
      setRunning.run(sessionId, now(), id);
      return require_(id);
    },

    report(id, report) {
      setReport.run(JSON.stringify(report), id);
      return require_(id);
    },

    setOutput(id, text, maxBytes) {
      setOutputText.run(boundedUtf8(text, maxBytes), id);
      return require_(id);
    },

    setArtifactHash(id, hash) {
      setHash.run(hash, id);
      return require_(id);
    },

    complete(id, input) {
      if (input.outputText !== undefined && input.outputText !== null) {
        setOutputText.run(input.outputText, id);
      }
      if (input.artifactHash !== undefined) setHash.run(input.artifactHash ?? null, id);
      // §8.1's `tool_denials` input, written on the turn rather than remembered:
      // a restart between the session ending and the breaker evaluation must not
      // lose it.
      if (input.permissionDenials !== undefined) {
        setDenials.run(Math.max(0, Math.trunc(input.permissionDenials)), id);
      }
      setComplete.run(input.status, now(), id);
      return require_(id);
    },
  };
}

/**
 * Cuts a string to `maxBytes` **UTF-8** bytes without splitting a code point.
 *
 * §3.2 bounds `output_text` at 32 KB and the number is a byte budget, not a
 * character count: a transcript of Japanese prose would otherwise store three
 * times what the config says.
 */
export function boundedUtf8(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes) return text;
  // `toString` on a buffer cut mid-sequence yields U+FFFD for the partial tail;
  // dropping it is what keeps the stored text valid UTF-8.
  const cut = buffer.subarray(0, maxBytes).toString('utf8');
  return cut.endsWith('�') ? cut.slice(0, -1) : cut;
}

/** True for the unique-index refusal `assignment_turns_active` produces. */
function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY';
}
