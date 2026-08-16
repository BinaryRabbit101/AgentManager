/**
 * The `agents` repository — a rebuildable index of `library/agents/*` (§1.4).
 *
 * Files are truth. Foundation never reads the library: roster pushes the
 * registry through the service registry (`roster.changed`) and foundation
 * writes what it is given. Every method here is therefore shaped for "roster
 * tells us what exists" rather than "we discover what exists".
 */
import type { Clock } from '../time.js';
import { isoTimestamp } from '../time.js';
import type { Database } from '../sqlite.js';
import { fromBool, orNull, toBool } from './sql.js';

export interface AgentRecord {
  readonly id: string;
  readonly name: string;
  readonly specialty: string | null;
  /** The resolved `model.primary` alias or id, flattened to a string (§1.4). */
  readonly model: string | null;
  readonly isOverseer: boolean;
  /** Carried so an archived-but-displayable agent does not vanish from a join. */
  readonly archivedAt: string | null;
  readonly sourcePath: string | null;
  readonly contentHash: string | null;
  readonly indexedAt: string;
}

export interface AgentInput {
  readonly id: string;
  readonly name: string;
  readonly specialty?: string | null;
  readonly model?: string | null;
  readonly isOverseer?: boolean;
  readonly archivedAt?: string | null;
  readonly sourcePath?: string | null;
  readonly contentHash?: string | null;
  /** Defaults to now. */
  readonly indexedAt?: string;
}

export interface ListAgentsOptions {
  /** Default `false`: archived agents are excluded unless asked for. */
  readonly includeArchived?: boolean;
}

export interface AgentsRepository {
  /** Inserts or replaces one indexed agent. Roster's per-agent push. */
  upsert(input: AgentInput): AgentRecord;
  /**
   * Replaces the whole index in one transaction.
   *
   * Roster's full reindex. Atomic because a half-rebuilt index is worse than a
   * stale one: every join in the UI would show a partial roster for the
   * duration.
   */
  replaceAll(inputs: readonly AgentInput[]): number;
  get(id: string): AgentRecord | undefined;
  list(options?: ListAgentsOptions): readonly AgentRecord[];
  count(options?: ListAgentsOptions): number;
  /** Removes the index row. Session history is untouched — there is no FK (§1.4). */
  delete(id: string): boolean;
}

interface AgentRow {
  readonly id: string;
  readonly name: string;
  readonly specialty: string | null;
  readonly model: string | null;
  readonly is_overseer: number;
  readonly archived_at: string | null;
  readonly source_path: string | null;
  readonly content_hash: string | null;
  readonly indexed_at: string;
}

function toRecord(row: AgentRow): AgentRecord {
  return {
    id: row.id,
    name: row.name,
    specialty: row.specialty,
    model: row.model,
    isOverseer: toBool(row.is_overseer),
    archivedAt: row.archived_at,
    sourcePath: row.source_path,
    contentHash: row.content_hash,
    indexedAt: row.indexed_at,
  };
}

const COLUMNS =
  'id, name, specialty, model, is_overseer, archived_at, source_path, content_hash, indexed_at';

export function createAgentsRepository(db: Database, clock: Clock): AgentsRepository {
  const upsertStatement = db.prepare<
    [
      string,
      string,
      string | null,
      string | null,
      number,
      string | null,
      string | null,
      string | null,
      string,
    ]
  >(
    `INSERT INTO agents (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       specialty = excluded.specialty,
       model = excluded.model,
       is_overseer = excluded.is_overseer,
       archived_at = excluded.archived_at,
       source_path = excluded.source_path,
       content_hash = excluded.content_hash,
       indexed_at = excluded.indexed_at`,
  );
  const getStatement = db.prepare<[string], AgentRow>(`SELECT ${COLUMNS} FROM agents WHERE id = ?`);
  const listAll = db.prepare<[], AgentRow>(`SELECT ${COLUMNS} FROM agents ORDER BY id`);
  const listLive = db.prepare<[], AgentRow>(
    `SELECT ${COLUMNS} FROM agents WHERE archived_at IS NULL ORDER BY id`,
  );
  const countAll = db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM agents');
  const countLive = db.prepare<[], { n: number }>(
    'SELECT COUNT(*) AS n FROM agents WHERE archived_at IS NULL',
  );
  const deleteStatement = db.prepare<[string]>('DELETE FROM agents WHERE id = ?');
  const deleteAll = db.prepare<[]>('DELETE FROM agents');

  function write(input: AgentInput): void {
    upsertStatement.run(
      input.id,
      input.name,
      orNull(input.specialty),
      orNull(input.model),
      fromBool(input.isOverseer ?? false),
      orNull(input.archivedAt),
      orNull(input.sourcePath),
      orNull(input.contentHash),
      input.indexedAt ?? isoTimestamp(clock()),
    );
  }

  const replaceAllTransaction = db.transaction((inputs: readonly AgentInput[]): number => {
    deleteAll.run();
    for (const input of inputs) write(input);
    return inputs.length;
  });

  return {
    upsert(input) {
      write(input);
      const row = getStatement.get(input.id);
      // The row was just written; a miss would mean the write did not happen.
      return toRecord(row as AgentRow);
    },
    replaceAll: (inputs) => replaceAllTransaction(inputs),
    get: (id) => {
      const row = getStatement.get(id);
      return row === undefined ? undefined : toRecord(row);
    },
    list: (options = {}) =>
      (options.includeArchived === true ? listAll : listLive).all().map(toRecord),
    count: (options = {}) =>
      (options.includeArchived === true ? countAll : countLive).get()?.n ?? 0,
    delete: (id) => deleteStatement.run(id).changes > 0,
  };
}
