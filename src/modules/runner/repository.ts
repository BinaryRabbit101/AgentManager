/**
 * The session repository (runner IMPLEMENTATION M1): foundation's `sessions`
 * repository plus §3.5's columns, `session_inputs`, and §2.2's status machine.
 *
 * ## Why this composes SQL, and against what
 *
 * `sessions` is a foundation-*shipped* table that runner **owns** (§1: "the
 * `sessions` table, its lifecycle, and its statuses"), and §3.5's eight added
 * columns arrive in this element's own migration. Foundation §1.3's rule is that
 * no feature module composes SQL against *another* element's tables; M3's
 * acceptance names the tables that rule covers for runner — `agents`,
 * `projects`, `assignments`, `questions` — and `sessions` is deliberately not
 * among them. So the base columns are still created through
 * `store.sessions.create` (id minting, defaults, `started_at` policy) and the
 * added columns are written here, in the same transaction.
 *
 * ## What this repository refuses
 *
 * Every status change goes through {@link SessionRepository.transition}, which
 * checks §2.2's table and §2.3's closed `exit_reason` set before it writes
 * anything. There is no method that sets `status` any other way — a patch that
 * carried a status would be a second, unchecked door into the state machine.
 */
import type { Database } from '../../storage/sqlite.js';
import type {
  Clock,
  SessionOrigin,
  SessionRecord,
  SessionStatus,
  Store,
} from '../../storage/index.js';

import { DuplicateSessionInputError, SessionNotFoundError } from './errors.js';
import { assertTransition, TERMINAL_STATUSES, type ExitReason } from './status.js';

/** §6.2's two bands. Copied onto the row at enqueue, never re-derived. */
export type SessionPriority = 'interactive' | 'normal';

/** A session row with §3.5's columns. */
export interface RunnerSessionRecord extends SessionRecord {
  /** `assignment_members.role`, for roster's system-prompt addendum. */
  readonly role: string | null;
  /** `workspace_leases.id` held for this assignment (§3.1). */
  readonly leaseId: string | null;
  /** Prior session id, for the §9.3 chain. */
  readonly resumedFrom: string | null;
  readonly queuedAt: string | null;
  readonly priority: SessionPriority;
  /** roster's `concurrencyWeight`; the cap is on the sum of these (§6.1). */
  readonly weight: number;
  /** Set while a `queued` session waits on a retryable workspace refusal (§6.2). */
  readonly blockedReason: string | null;
  readonly turns: number;
}

/** The launch request, written once at admission (§3.5). */
export interface SessionInputRecord {
  readonly sessionId: string;
  readonly prompt: string;
  readonly attachments: readonly unknown[];
  readonly createdAt: string;
}

export interface EnqueueSessionInput {
  readonly id?: string;
  readonly assignmentId: string;
  readonly agentId: string;
  readonly projectId: string;
  readonly prompt: string;
  readonly attachments?: readonly unknown[];
  readonly role?: string | null;
  readonly priority?: SessionPriority;
  readonly weight?: number;
  readonly origin?: SessionOrigin;
  /** Set on the §9.4 "continue" path; never on a plain pause/resume. */
  readonly resumedFrom?: string | null;
  readonly summary?: string | null;
  readonly queuedAt?: string;
}

/**
 * What may change on a live session without moving its status.
 *
 * `status` is absent on purpose — see the header. So are `assignmentId`,
 * `agentId` and `projectId`, which foundation's repository already refuses.
 */
export interface RunnerSessionPatch {
  readonly sdkSessionId?: string | null;
  readonly model?: string | null;
  readonly permissionMode?: string | null;
  readonly summary?: string | null;
  readonly pinned?: boolean;
  readonly role?: string | null;
  readonly leaseId?: string | null;
  readonly priority?: SessionPriority;
  readonly weight?: number;
  readonly blockedReason?: string | null;
  readonly turns?: number;
  readonly startedAt?: string | null;
}

export interface TransitionRequest extends RunnerSessionPatch {
  /** Required for every terminal or `paused` move (§2.3). */
  readonly exitReason?: ExitReason;
  /** The §9.2 boot task's marker; the only way to reach `orphaned`. */
  readonly boot?: boolean;
  /** Overrides the clock for `ended_at` / `started_at`. */
  readonly at?: string;
}

export interface ListSessionsQuery {
  readonly status?: SessionStatus;
  readonly projectId?: string;
  readonly assignmentId?: string;
  readonly agentId?: string;
  readonly limit?: number;
}

export interface SessionRepository {
  /** Admission (§3.1 step 1): the `queued` row and its `session_inputs`, one transaction. */
  enqueue(input: EnqueueSessionInput): RunnerSessionRecord;
  get(id: string): RunnerSessionRecord | undefined;
  /** {@link SessionNotFoundError} rather than `undefined`, for the call sites that need one. */
  require(id: string): RunnerSessionRecord;
  list(query?: ListSessionsQuery): readonly RunnerSessionRecord[];
  /** The durable prompt. `undefined` for a session that never had one (a resume). */
  input(sessionId: string): SessionInputRecord | undefined;
  /** The only door into §2.2's state machine. */
  transition(id: string, to: SessionStatus, request?: TransitionRequest): RunnerSessionRecord;
  /** Everything that changes without a status change. */
  patch(id: string, patch: RunnerSessionPatch): RunnerSessionRecord;
  /** §8.3's digest, written at admission and again at the terminal transition. */
  setSummary(id: string, summary: string): void;
  /** `{ queued: 2, running: 1, … }` — the queue panel and the health report. */
  countByStatus(): Readonly<Record<SessionStatus, number>>;
}

interface RunnerColumns {
  readonly role: string | null;
  readonly lease_id: string | null;
  readonly resumed_from: string | null;
  readonly queued_at: string | null;
  readonly priority: SessionPriority;
  readonly weight: number;
  readonly blocked_reason: string | null;
  readonly turns: number;
}

interface InputRow {
  readonly session_id: string;
  readonly prompt: string;
  readonly attachments_json: string;
  readonly created_at: string;
}

const RUNNER_COLUMNS =
  'role, lease_id, resumed_from, queued_at, priority, weight, blocked_reason, turns';

/** Patch field → column, and the allow-list: nothing outside it is updatable. */
const RUNNER_PATCH_COLUMNS: Readonly<Record<keyof RunnerSessionPatch, string>> = {
  sdkSessionId: 'sdk_session_id',
  model: 'model',
  permissionMode: 'permission_mode',
  summary: 'summary',
  pinned: 'pinned',
  role: 'role',
  leaseId: 'lease_id',
  priority: 'priority',
  weight: 'weight',
  blockedReason: 'blocked_reason',
  turns: 'turns',
  startedAt: 'started_at',
};

export interface SessionRepositoryOptions {
  readonly db: Database;
  readonly store: Store;
  readonly clock: Clock;
}

export function createSessionRepository(options: SessionRepositoryOptions): SessionRepository {
  const { db, store, clock } = options;

  const readRunner = db.prepare<[string], RunnerColumns>(
    `SELECT ${RUNNER_COLUMNS} FROM sessions WHERE id = ?`,
  );
  const readInput = db.prepare<[string], InputRow>(
    'SELECT session_id, prompt, attachments_json, created_at FROM session_inputs WHERE session_id = ?',
  );
  const insertInput = db.prepare<[string, string, string, string]>(
    `INSERT INTO session_inputs (session_id, prompt, attachments_json, created_at)
     VALUES (?, ?, ?, ?)`,
  );
  const countStatuses = db.prepare<[], { status: SessionStatus; n: number }>(
    'SELECT status, COUNT(*) AS n FROM sessions GROUP BY status',
  );
  const setStatusRow = db.prepare<[string, string | null, string | null, string]>(
    'UPDATE sessions SET status = ?, exit_reason = ?, ended_at = ? WHERE id = ?',
  );

  function now(): string {
    return clock().toISOString();
  }

  /** Joins the base record with §3.5's columns. Both reads hit the same row by primary key. */
  function decorate(base: SessionRecord): RunnerSessionRecord {
    const extra = readRunner.get(base.id);
    return {
      ...base,
      role: extra?.role ?? null,
      leaseId: extra?.lease_id ?? null,
      resumedFrom: extra?.resumed_from ?? null,
      queuedAt: extra?.queued_at ?? null,
      priority: extra?.priority ?? 'normal',
      weight: extra?.weight ?? 1,
      blockedReason: extra?.blocked_reason ?? null,
      turns: extra?.turns ?? 0,
    };
  }

  function get(id: string): RunnerSessionRecord | undefined {
    const base = store.sessions.get(id);
    return base === undefined ? undefined : decorate(base);
  }

  function require(id: string): RunnerSessionRecord {
    const record = get(id);
    if (record === undefined) throw new SessionNotFoundError(id);
    return record;
  }

  function writePatch(id: string, patch: RunnerSessionPatch): void {
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    for (const [field, column] of Object.entries(RUNNER_PATCH_COLUMNS)) {
      const value = patch[field as keyof RunnerSessionPatch];
      if (value === undefined) continue;
      sets.push(`${column} = ?`);
      values.push(typeof value === 'boolean' ? (value ? 1 : 0) : value);
    }
    if (sets.length === 0) return;
    const changes = db
      .prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`)
      .run(...values, id).changes;
    if (changes === 0) throw new SessionNotFoundError(id);
  }

  const enqueue = db.transaction((input: EnqueueSessionInput): RunnerSessionRecord => {
    const queuedAt = input.queuedAt ?? now();
    const base = store.sessions.create({
      ...(input.id === undefined ? {} : { id: input.id }),
      assignmentId: input.assignmentId,
      agentId: input.agentId,
      projectId: input.projectId,
      status: 'queued',
      origin: input.origin ?? 'local',
      ...(input.summary === undefined ? {} : { summary: input.summary }),
    });

    writePatch(base.id, {
      role: input.role ?? null,
      priority: input.priority ?? 'normal',
      weight: input.weight ?? 1,
    });
    // `queued_at` and `resumed_from` are set once, at admission, and are not in
    // the patch allow-list: a session that could be re-dated would break the
    // scheduler's FIFO, and one that could change its resume chain would rewrite
    // history rather than record it.
    db.prepare('UPDATE sessions SET queued_at = ?, resumed_from = ? WHERE id = ?').run(
      queuedAt,
      input.resumedFrom ?? null,
      base.id,
    );

    if (readInput.get(base.id) !== undefined) throw new DuplicateSessionInputError(base.id);
    insertInput.run(base.id, input.prompt, JSON.stringify(input.attachments ?? []), queuedAt);

    return decorate(store.sessions.get(base.id) as SessionRecord);
  });

  const transition = db.transaction(
    (id: string, to: SessionStatus, request: TransitionRequest): RunnerSessionRecord => {
      const current = require(id);
      assertTransition(current.status, to, {
        ...(request.exitReason === undefined ? {} : { exitReason: request.exitReason }),
        ...(request.boot === undefined ? {} : { boot: request.boot }),
      });

      const at = request.at ?? now();
      // `ended_at` is stamped by the arrow, not by the caller: a terminal row
      // without one is a row projects' timeline cannot place.
      const endedAt = TERMINAL_STATUSES.has(to) ? at : null;
      setStatusRow.run(to, request.exitReason ?? null, endedAt, id);

      const patch: RunnerSessionPatch = {
        ...request,
        // Entering `running` stamps the start unless the caller pinned one.
        ...(to === 'running' && request.startedAt === undefined && current.startedAt === null
          ? { startedAt: at }
          : {}),
      };
      writePatch(id, patch);
      return require(id);
    },
  );

  return {
    enqueue: (input) => enqueue(input),
    get,
    require,
    list: (query = {}) =>
      store.sessions
        .list({
          ...(query.status === undefined ? {} : { status: query.status }),
          ...(query.projectId === undefined ? {} : { projectId: query.projectId }),
          ...(query.assignmentId === undefined ? {} : { assignmentId: query.assignmentId }),
          ...(query.agentId === undefined ? {} : { agentId: query.agentId }),
          ...(query.limit === undefined ? {} : { limit: query.limit }),
        })
        .map(decorate),
    input(sessionId) {
      const row = readInput.get(sessionId);
      if (row === undefined) return undefined;
      const parsed: unknown = JSON.parse(row.attachments_json);
      return {
        sessionId: row.session_id,
        prompt: row.prompt,
        attachments: Array.isArray(parsed) ? (parsed as readonly unknown[]) : [],
        createdAt: row.created_at,
      };
    },
    transition: (id, to, request = {}) => transition(id, to, request),
    patch(id, patch) {
      writePatch(id, patch);
      return require(id);
    },
    setSummary(id, summary) {
      writePatch(id, { summary });
    },
    countByStatus() {
      const counts: Record<SessionStatus, number> = {
        queued: 0,
        running: 0,
        paused: 0,
        done: 0,
        failed: 0,
        interrupted: 0,
        orphaned: 0,
      };
      for (const row of countStatuses.all()) counts[row.status] = row.n;
      return counts;
    },
  };
}
