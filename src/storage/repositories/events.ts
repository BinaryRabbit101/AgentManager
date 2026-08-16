/**
 * The `events` repository — the append-only structured event spine (§1.4, §6.5).
 *
 * "Every bus event with `persist: true` lands here. Powers UI replay after
 * reconnect and post-hoc debugging. Retention: 30 days or 200k rows, pruned on
 * boot."
 *
 * Replay is by **id watermark**, not by timestamp: ids are ULIDs, so
 * `id > ?` is both a total order and an index seek, and two events emitted in
 * the same millisecond still replay exactly once each — which a `ts >` cursor
 * cannot promise.
 */
import { newId } from '../ids.js';
import type { Database } from '../sqlite.js';
import type { Clock } from '../time.js';
import { isoTimestamp } from '../time.js';
import { orNull, toJsonColumn } from './sql.js';

export interface EventRecord {
  readonly id: string;
  readonly ts: string;
  readonly type: string;
  readonly sessionId: string | null;
  readonly assignmentId: string | null;
  readonly projectId: string | null;
  readonly agentId: string | null;
  readonly payloadJson: string | null;
}

export interface EventInput {
  readonly id?: string;
  readonly ts?: string;
  readonly type: string;
  readonly sessionId?: string | null;
  readonly assignmentId?: string | null;
  readonly projectId?: string | null;
  readonly agentId?: string | null;
  /** Serialized into `payload_json`. Pass the value, not a string. */
  readonly payload?: unknown;
}

export interface EventQuery {
  /** Exclusive watermark: return events with an id strictly greater than this. */
  readonly since?: string;
  /**
   * Exact types and `prefix.*` patterns, as `/api/events?types=` accepts.
   * Applied identically to replay and live fan-out (§6.5).
   */
  readonly types?: readonly string[];
  readonly sessionId?: string;
  readonly assignmentId?: string;
  readonly projectId?: string;
  readonly limit?: number;
}

/** §2.3's `retention.eventDays` / `retention.eventMaxRows`. */
export interface EventRetention {
  readonly eventDays: number;
  readonly eventMaxRows: number;
}

export interface EventPruneResult {
  readonly byAge: number;
  readonly byCap: number;
  readonly remaining: number;
}

export interface EventsRepository {
  append(input: EventInput): EventRecord;
  get(id: string): EventRecord | undefined;
  /** Ordered oldest-first, which is the order a replay must be applied in. */
  list(query?: EventQuery): readonly EventRecord[];
  count(): number;
  /** Newest id, the watermark a client starts from. */
  latestId(): string | undefined;
  /** Retention (§1.4): age first, then the row cap. Run on boot. */
  prune(retention: EventRetention, now?: Date): EventPruneResult;
}

interface EventRow {
  readonly id: string;
  readonly ts: string;
  readonly type: string;
  readonly session_id: string | null;
  readonly assignment_id: string | null;
  readonly project_id: string | null;
  readonly agent_id: string | null;
  readonly payload_json: string | null;
}

const COLUMNS = 'id, ts, type, session_id, assignment_id, project_id, agent_id, payload_json';

function toRecord(row: EventRow): EventRecord {
  return {
    id: row.id,
    ts: row.ts,
    type: row.type,
    sessionId: row.session_id,
    assignmentId: row.assignment_id,
    projectId: row.project_id,
    agentId: row.agent_id,
    payloadJson: row.payload_json,
  };
}

/** `session.*` matches any type in that namespace; anything else is exact. */
function typePredicate(types: readonly string[]): { sql: string; values: string[] } {
  const clauses: string[] = [];
  const values: string[] = [];
  for (const type of types) {
    if (type.endsWith('.*')) {
      clauses.push('type LIKE ?');
      // `ESCAPE` is unnecessary: event types are dotted identifiers, and a `%`
      // or `_` in one would already be a naming bug worth failing loudly on.
      values.push(`${type.slice(0, -1)}%`);
    } else {
      clauses.push('type = ?');
      values.push(type);
    }
  }
  return { sql: `(${clauses.join(' OR ')})`, values };
}

export function createEventsRepository(db: Database, clock: Clock): EventsRepository {
  const insert = db.prepare<
    [
      string,
      string,
      string,
      string | null,
      string | null,
      string | null,
      string | null,
      string | null,
    ]
  >(`INSERT INTO events (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const getStatement = db.prepare<[string], EventRow>(`SELECT ${COLUMNS} FROM events WHERE id = ?`);
  const countStatement = db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM events');
  const latest = db.prepare<[], { id: string }>('SELECT id FROM events ORDER BY id DESC LIMIT 1');
  const deleteByAge = db.prepare<[string]>('DELETE FROM events WHERE ts < ?');
  // Keeps the newest N rows by finding the oldest id that survives — the row at
  // offset N-1 walking backwards — and deleting everything below it. One index
  // walk, no temporary table, and a no-op when there are fewer rows than the
  // cap: the subquery then yields NULL, and `id < NULL` is never true.
  const deleteByCap = db.prepare<[number]>(
    'DELETE FROM events WHERE id < (SELECT id FROM events ORDER BY id DESC LIMIT 1 OFFSET ?)',
  );
  const deleteAll = db.prepare<[]>('DELETE FROM events');

  const pruneTransaction = db.transaction(
    (retention: EventRetention, now: Date): EventPruneResult => {
      const cutoff = isoTimestamp(new Date(now.getTime() - retention.eventDays * 86_400_000));
      const byAge = deleteByAge.run(cutoff).changes;
      // A cap of zero has no "oldest surviving row" to seek to, so it is its
      // own case rather than an off-by-one hiding inside the offset.
      const byCap =
        retention.eventMaxRows <= 0
          ? deleteAll.run().changes
          : deleteByCap.run(retention.eventMaxRows - 1).changes;
      return { byAge, byCap, remaining: countStatement.get()?.n ?? 0 };
    },
  );

  return {
    append(input) {
      const id = input.id ?? newId();
      const record: EventRecord = {
        id,
        ts: input.ts ?? isoTimestamp(clock()),
        type: input.type,
        sessionId: orNull(input.sessionId),
        assignmentId: orNull(input.assignmentId),
        projectId: orNull(input.projectId),
        agentId: orNull(input.agentId),
        payloadJson: toJsonColumn(input.payload),
      };
      insert.run(
        record.id,
        record.ts,
        record.type,
        record.sessionId,
        record.assignmentId,
        record.projectId,
        record.agentId,
        record.payloadJson,
      );
      return record;
    },

    get: (id) => {
      const row = getStatement.get(id);
      return row === undefined ? undefined : toRecord(row);
    },

    list(query = {}) {
      const clauses: string[] = [];
      const values: (string | number)[] = [];

      if (query.since !== undefined) {
        clauses.push('id > ?');
        values.push(query.since);
      }
      if (query.types !== undefined && query.types.length > 0) {
        const predicate = typePredicate(query.types);
        clauses.push(predicate.sql);
        values.push(...predicate.values);
      }
      for (const [column, value] of [
        ['session_id', query.sessionId],
        ['assignment_id', query.assignmentId],
        ['project_id', query.projectId],
      ] as const) {
        if (value === undefined) continue;
        clauses.push(`${column} = ?`);
        values.push(value);
      }

      const where = clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`;
      return db
        .prepare<(string | number)[], EventRow>(
          `SELECT ${COLUMNS} FROM events${where} ORDER BY id LIMIT ?`,
        )
        .all(...values, query.limit ?? -1)
        .map(toRecord);
    },

    count: () => countStatement.get()?.n ?? 0,
    latestId: () => latest.get()?.id,
    prune: (retention, now) => pruneTransaction(retention, now ?? clock()),
  };
}
