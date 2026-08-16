/**
 * The `sessions` repository (§1.4).
 *
 * Two methods here exist for other elements rather than for the runner that
 * owns the table, and both are named in the design:
 *
 * - {@link SessionsRepository.countByAgent} is roster's hard-purge guard. There
 *   is no FK from `sessions.agent_id` to `agents` — deleting an agent must not
 *   destroy its history — so the database cannot refuse the purge, and this
 *   count, backed by `sessions(agent_id)`, is the sanctioned way to ask.
 * - {@link SessionsRepository.transcriptBytesByProject} is projects' size cap:
 *   `SUM(transcript_bytes)` over a project's sessions, which is a single
 *   indexed read precisely because the transcript writer maintains the column
 *   (§1.5) instead of anyone walking the transcripts tree.
 */
import { RecordNotFoundError } from '../errors.js';
import { newId } from '../ids.js';
import type { Database } from '../sqlite.js';
import type { Clock } from '../time.js';
import { isoTimestamp } from '../time.js';
import { fromBool, orNull, toBool } from './sql.js';

/** The v1 session lifecycle vocabulary (§1.4). */
export type SessionStatus =
  'queued' | 'running' | 'paused' | 'done' | 'failed' | 'interrupted' | 'orphaned';

/** Where the request that started the session arrived from. */
export type SessionOrigin = 'local' | 'remote';

export interface SessionRecord {
  readonly id: string;
  readonly assignmentId: string;
  readonly agentId: string;
  readonly projectId: string;
  readonly status: SessionStatus;
  readonly sdkSessionId: string | null;
  readonly model: string | null;
  readonly permissionMode: string | null;
  readonly origin: SessionOrigin;
  /**
   * Path to the transcript, **relative to `state/transcripts/`** (§1.5), or
   * NULL once pruned. `transcript_path IS NOT NULL` is the availability test;
   * there is deliberately no `transcript_available` column.
   */
  readonly transcriptPath: string | null;
  readonly transcriptBytes: number;
  readonly summary: string | null;
  readonly pinned: boolean;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly exitReason: string | null;
}

export interface SessionInput {
  readonly id?: string;
  readonly assignmentId: string;
  readonly agentId: string;
  readonly projectId: string;
  readonly status?: SessionStatus;
  readonly sdkSessionId?: string | null;
  readonly model?: string | null;
  readonly permissionMode?: string | null;
  readonly origin?: SessionOrigin;
  readonly transcriptPath?: string | null;
  readonly transcriptBytes?: number;
  readonly summary?: string | null;
  readonly pinned?: boolean;
  readonly startedAt?: string | null;
  readonly endedAt?: string | null;
  readonly exitReason?: string | null;
}

/**
 * What may change after a session exists.
 *
 * Its identity — which agent, which assignment, which project — deliberately
 * may not: those three are what every other table's join means, and a session
 * that changed agent mid-flight would silently rewrite history rather than
 * record it.
 */
export type SessionPatch = Partial<
  Omit<SessionInput, 'id' | 'assignmentId' | 'projectId' | 'agentId'>
>;

export interface ListSessionsFilter {
  readonly projectId?: string;
  readonly agentId?: string;
  readonly assignmentId?: string;
  readonly status?: SessionStatus;
  readonly limit?: number;
}

export interface SessionsRepository {
  create(input: SessionInput): SessionRecord;
  get(id: string): SessionRecord | undefined;
  /** Newest first (ULID ids sort by creation, so this needs no extra column). */
  list(filter?: ListSessionsFilter): readonly SessionRecord[];
  update(id: string, patch: SessionPatch): SessionRecord;
  /** Status transition plus whatever else changes with it (`endedAt`, `exitReason`). */
  setStatus(id: string, status: SessionStatus, patch?: SessionPatch): SessionRecord;
  /** Roster's purge guard. Backed by the `sessions(agent_id)` index (§1.4). */
  countByAgent(agentId: string): number;
  /** Projects' per-project transcript size cap (§1.5). */
  transcriptBytesByProject(projectId: string): number;
  /** Records where a session's transcript lives and how big it currently is. */
  setTranscript(id: string, transcript: { path: string; bytes: number }): void;
  /** Advances the running byte count. The transcript writer's per-append call. */
  setTranscriptBytes(id: string, bytes: number): void;
  /**
   * The pruner's half of §1.5: NULL the path and zero the byte count in one
   * statement, so "file deleted" and "row says pruned" can never disagree.
   */
  clearTranscript(id: string): boolean;
  delete(id: string): boolean;
}

interface SessionRow {
  readonly id: string;
  readonly assignment_id: string;
  readonly agent_id: string;
  readonly project_id: string;
  readonly status: SessionStatus;
  readonly sdk_session_id: string | null;
  readonly model: string | null;
  readonly permission_mode: string | null;
  readonly origin: SessionOrigin;
  readonly transcript_path: string | null;
  readonly transcript_bytes: number;
  readonly summary: string | null;
  readonly pinned: number;
  readonly started_at: string | null;
  readonly ended_at: string | null;
  readonly exit_reason: string | null;
}

const COLUMNS =
  'id, assignment_id, agent_id, project_id, status, sdk_session_id, model, permission_mode, ' +
  'origin, transcript_path, transcript_bytes, summary, pinned, started_at, ended_at, exit_reason';

/** Patch field → column. Also the allow-list: nothing else is updatable. */
const PATCH_COLUMNS: Readonly<Record<keyof SessionPatch, string>> = {
  status: 'status',
  sdkSessionId: 'sdk_session_id',
  model: 'model',
  permissionMode: 'permission_mode',
  origin: 'origin',
  transcriptPath: 'transcript_path',
  transcriptBytes: 'transcript_bytes',
  summary: 'summary',
  pinned: 'pinned',
  startedAt: 'started_at',
  endedAt: 'ended_at',
  exitReason: 'exit_reason',
};

function toRecord(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    assignmentId: row.assignment_id,
    agentId: row.agent_id,
    projectId: row.project_id,
    status: row.status,
    sdkSessionId: row.sdk_session_id,
    model: row.model,
    permissionMode: row.permission_mode,
    origin: row.origin,
    transcriptPath: row.transcript_path,
    transcriptBytes: row.transcript_bytes,
    summary: row.summary,
    pinned: toBool(row.pinned),
    startedAt: row.started_at,
    endedAt: row.ended_at,
    exitReason: row.exit_reason,
  };
}

export function createSessionsRepository(db: Database, clock: Clock): SessionsRepository {
  const insert = db.prepare(
    `INSERT INTO sessions (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const getStatement = db.prepare<[string], SessionRow>(
    `SELECT ${COLUMNS} FROM sessions WHERE id = ?`,
  );

  // One statement with optional predicates rather than SQL assembled per call:
  // a prepared statement is cached and reused, and `:x IS NULL OR col = :x`
  // still resolves to an index seek once the parameter is bound. Named
  // parameters because better-sqlite3 binds arrays only to anonymous `?`.
  const listStatement = db.prepare<
    {
      projectId: string | null;
      agentId: string | null;
      assignmentId: string | null;
      status: string | null;
      limit: number;
    },
    SessionRow
  >(
    `SELECT ${COLUMNS} FROM sessions
     WHERE (:projectId IS NULL OR project_id = :projectId)
       AND (:agentId IS NULL OR agent_id = :agentId)
       AND (:assignmentId IS NULL OR assignment_id = :assignmentId)
       AND (:status IS NULL OR status = :status)
     ORDER BY id DESC
     LIMIT :limit`,
  );

  const countByAgent = db.prepare<[string], { n: number }>(
    'SELECT COUNT(*) AS n FROM sessions WHERE agent_id = ?',
  );
  const bytesByProject = db.prepare<[string], { bytes: number }>(
    'SELECT COALESCE(SUM(transcript_bytes), 0) AS bytes FROM sessions WHERE project_id = ?',
  );
  const setTranscript = db.prepare<[string, number, string]>(
    'UPDATE sessions SET transcript_path = ?, transcript_bytes = ? WHERE id = ?',
  );
  const setBytes = db.prepare<[number, string]>(
    'UPDATE sessions SET transcript_bytes = ? WHERE id = ?',
  );
  const clearTranscript = db.prepare<[string]>(
    'UPDATE sessions SET transcript_path = NULL, transcript_bytes = 0 WHERE id = ?',
  );
  const deleteStatement = db.prepare<[string]>('DELETE FROM sessions WHERE id = ?');

  function mustGet(id: string): SessionRecord {
    const row = getStatement.get(id);
    if (row === undefined) throw new RecordNotFoundError('sessions', id);
    return toRecord(row);
  }

  function applyPatch(id: string, patch: SessionPatch): SessionRecord {
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    for (const [field, column] of Object.entries(PATCH_COLUMNS)) {
      const value = patch[field as keyof SessionPatch];
      if (value === undefined) continue;
      sets.push(`${column} = ?`);
      values.push(typeof value === 'boolean' ? fromBool(value) : value);
    }
    if (sets.length === 0) return mustGet(id);

    const changes = db
      .prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`)
      .run(...values, id).changes;
    if (changes === 0) throw new RecordNotFoundError('sessions', id);
    return mustGet(id);
  }

  return {
    create(input) {
      const id = input.id ?? newId();
      const status = input.status ?? 'queued';
      insert.run(
        id,
        input.assignmentId,
        input.agentId,
        input.projectId,
        status,
        orNull(input.sdkSessionId),
        orNull(input.model),
        orNull(input.permissionMode),
        input.origin ?? 'local',
        orNull(input.transcriptPath),
        input.transcriptBytes ?? 0,
        orNull(input.summary),
        fromBool(input.pinned ?? false),
        // A session created already running carries its start time; a queued one
        // has none yet, and the ULID id already encodes when it was enqueued.
        input.startedAt === undefined
          ? status === 'queued'
            ? null
            : isoTimestamp(clock())
          : orNull(input.startedAt),
        orNull(input.endedAt),
        orNull(input.exitReason),
      );
      return mustGet(id);
    },

    get: (id) => {
      const row = getStatement.get(id);
      return row === undefined ? undefined : toRecord(row);
    },

    list: (filter = {}) =>
      listStatement
        .all({
          projectId: filter.projectId ?? null,
          agentId: filter.agentId ?? null,
          assignmentId: filter.assignmentId ?? null,
          status: filter.status ?? null,
          limit: filter.limit ?? -1, // SQLite: a negative LIMIT means "no limit"
        })
        .map(toRecord),

    update: (id, patch) => applyPatch(id, patch),

    setStatus: (id, status, patch = {}) => applyPatch(id, { ...patch, status }),

    countByAgent: (agentId) => countByAgent.get(agentId)?.n ?? 0,

    transcriptBytesByProject: (projectId) => bytesByProject.get(projectId)?.bytes ?? 0,

    setTranscript(id, transcript) {
      if (setTranscript.run(transcript.path, transcript.bytes, id).changes === 0) {
        throw new RecordNotFoundError('sessions', id);
      }
    },

    setTranscriptBytes(id, bytes) {
      if (setBytes.run(bytes, id).changes === 0) {
        throw new RecordNotFoundError('sessions', id);
      }
    },

    clearTranscript: (id) => clearTranscript.run(id).changes > 0,

    delete: (id) => deleteStatement.run(id).changes > 0,
  };
}
