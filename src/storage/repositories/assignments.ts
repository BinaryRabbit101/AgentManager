/**
 * The `assignments` and `assignment_members` repository (§1.4).
 *
 * "Every session has one (orchestrator's uniform-schema rule)" — a solo launch
 * creates a trivial assignment rather than a session without one, which is what
 * makes budgets, scope and question attribution uniform instead of
 * special-cased.
 *
 * `status` is exactly `open`/`closed` here. The richer lifecycle state machine
 * arrives as an orchestrator-owned `phase` column through orchestrator's own
 * migration set; this repository deliberately does not anticipate it.
 */
import { RecordNotFoundError } from '../errors.js';
import { newId } from '../ids.js';
import type { Database } from '../sqlite.js';
import type { Clock } from '../time.js';
import { isoTimestamp } from '../time.js';
import { numberOrNull, orNull, runRestrictedDelete } from './sql.js';

/** The v1 pattern vocabulary (§1.4). */
export type AssignmentPattern = 'solo' | 'pair' | 'review' | 'overseer';

/** Exactly two values, by orchestrator §2.2 and §17 R7. */
export type AssignmentStatus = 'open' | 'closed';

/**
 * The v1 role vocabulary — the same five strings roster's `capabilities.roles`,
 * its `roles/<role>.md` addenda and orchestrator's patterns all key on.
 */
export type AssignmentRole = 'implementer' | 'architect' | 'skeptic' | 'reviewer' | 'overseer';

export interface AssignmentRecord {
  readonly id: string;
  readonly projectId: string;
  readonly pattern: AssignmentPattern;
  readonly scopeJson: string | null;
  readonly goal: string | null;
  readonly status: AssignmentStatus;
  readonly tokenBudget: number | null;
  readonly tokensUsed: number;
  readonly roundCap: number | null;
  readonly roundsUsed: number;
  readonly createdAt: string;
  readonly closedAt: string | null;
  readonly closeReason: string | null;
}

export interface AssignmentInput {
  readonly id?: string;
  readonly projectId: string;
  readonly pattern: AssignmentPattern;
  readonly scopeJson?: string | null;
  readonly goal?: string | null;
  readonly status?: AssignmentStatus;
  readonly tokenBudget?: number | null;
  readonly tokensUsed?: number;
  readonly roundCap?: number | null;
  readonly roundsUsed?: number;
  readonly createdAt?: string;
  /** Members created with the assignment, in one transaction. */
  readonly members?: readonly AssignmentMemberInput[];
}

export interface AssignmentMemberInput {
  readonly agentId: string;
  readonly role: AssignmentRole;
}

export interface AssignmentMember {
  readonly assignmentId: string;
  readonly agentId: string;
  readonly role: AssignmentRole;
}

export interface ListAssignmentsOptions {
  readonly status?: AssignmentStatus;
  readonly limit?: number;
}

export interface AssignmentsRepository {
  /** Creates the assignment and, if given, its members — one transaction. */
  create(input: AssignmentInput): AssignmentRecord;
  get(id: string): AssignmentRecord | undefined;
  listByProject(projectId: string, options?: ListAssignmentsOptions): readonly AssignmentRecord[];
  /** Every assignment an agent is a member of. Backed by `assignment_members(agent_id)`. */
  listByAgent(agentId: string, options?: ListAssignmentsOptions): readonly AssignmentRecord[];
  close(id: string, options?: { reason?: string; at?: string }): AssignmentRecord;
  /** Sets scope, goal or the budget/round caps. Status changes go through `close`. */
  update(
    id: string,
    patch: Partial<
      Pick<AssignmentInput, 'scopeJson' | 'goal' | 'tokenBudget' | 'roundCap' | 'roundsUsed'>
    >,
  ): AssignmentRecord;
  /**
   * Adds `delta` to `tokens_used` and returns the new total.
   *
   * The assignment half of §8's metering decision ("assignment totals rolled
   * onto `assignments.tokens_used`"). Usually reached through
   * `usage.record`, which calls it inside the delta's own transaction.
   */
  addTokensUsed(id: string, delta: number): number;
  /** Adds `by` to `rounds_used` and returns the new count, for the round cap. */
  addRoundsUsed(id: string, by?: number): number;
  addMember(assignmentId: string, member: AssignmentMemberInput): AssignmentMember;
  removeMember(assignmentId: string, agentId: string): boolean;
  listMembers(assignmentId: string): readonly AssignmentMember[];
  /**
   * Deletes the assignment; members, messages, questions and recommendations go
   * with it (ON DELETE CASCADE). Refused while any session references it.
   */
  delete(id: string): boolean;
}

interface AssignmentRow {
  readonly id: string;
  readonly project_id: string;
  readonly pattern: AssignmentPattern;
  readonly scope_json: string | null;
  readonly goal: string | null;
  readonly status: AssignmentStatus;
  readonly token_budget: number | null;
  readonly tokens_used: number;
  readonly round_cap: number | null;
  readonly rounds_used: number;
  readonly created_at: string;
  readonly closed_at: string | null;
  readonly close_reason: string | null;
}

const COLUMNS =
  'id, project_id, pattern, scope_json, goal, status, token_budget, tokens_used, ' +
  'round_cap, rounds_used, created_at, closed_at, close_reason';

function toRecord(row: AssignmentRow): AssignmentRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    pattern: row.pattern,
    scopeJson: row.scope_json,
    goal: row.goal,
    status: row.status,
    tokenBudget: row.token_budget,
    tokensUsed: row.tokens_used,
    roundCap: row.round_cap,
    roundsUsed: row.rounds_used,
    createdAt: row.created_at,
    closedAt: row.closed_at,
    closeReason: row.close_reason,
  };
}

export function createAssignmentsRepository(db: Database, clock: Clock): AssignmentsRepository {
  const insert = db.prepare(
    `INSERT INTO assignments (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const getStatement = db.prepare<[string], AssignmentRow>(
    `SELECT ${COLUMNS} FROM assignments WHERE id = ?`,
  );
  const byProject = db.prepare<[string], AssignmentRow>(
    `SELECT ${COLUMNS} FROM assignments WHERE project_id = ? ORDER BY created_at DESC, id DESC`,
  );
  const byProjectStatus = db.prepare<[string, string], AssignmentRow>(
    `SELECT ${COLUMNS} FROM assignments WHERE project_id = ? AND status = ? ` +
      'ORDER BY created_at DESC, id DESC',
  );
  const byAgent = db.prepare<[string], AssignmentRow>(
    `SELECT ${COLUMNS.split(', ')
      .map((c) => `a.${c}`)
      .join(', ')} FROM assignments a ` +
      'JOIN assignment_members m ON m.assignment_id = a.id WHERE m.agent_id = ? ' +
      'ORDER BY a.created_at DESC, a.id DESC',
  );
  const closeStatement = db.prepare<[string, string | null, string]>(
    "UPDATE assignments SET status = 'closed', closed_at = ?, close_reason = ? WHERE id = ?",
  );
  const addTokens = db.prepare<[number, string]>(
    'UPDATE assignments SET tokens_used = tokens_used + ? WHERE id = ?',
  );
  const addRounds = db.prepare<[number, string]>(
    'UPDATE assignments SET rounds_used = rounds_used + ? WHERE id = ?',
  );
  const deleteStatement = db.prepare<[string]>('DELETE FROM assignments WHERE id = ?');

  const insertMember = db.prepare<[string, string, string]>(
    'INSERT INTO assignment_members (assignment_id, agent_id, role) VALUES (?, ?, ?) ' +
      'ON CONFLICT(assignment_id, agent_id) DO UPDATE SET role = excluded.role',
  );
  const deleteMember = db.prepare<[string, string]>(
    'DELETE FROM assignment_members WHERE assignment_id = ? AND agent_id = ?',
  );
  const listMembers = db.prepare<
    [string],
    { assignment_id: string; agent_id: string; role: AssignmentRole }
  >(
    'SELECT assignment_id, agent_id, role FROM assignment_members WHERE assignment_id = ? ' +
      'ORDER BY role, agent_id',
  );

  function mustGet(id: string): AssignmentRecord {
    const row = getStatement.get(id);
    if (row === undefined) throw new RecordNotFoundError('assignments', id);
    return toRecord(row);
  }

  function limited(rows: readonly AssignmentRow[], limit?: number): readonly AssignmentRecord[] {
    const mapped = rows.map(toRecord);
    return limit === undefined ? mapped : mapped.slice(0, limit);
  }

  const createTransaction = db.transaction((input: AssignmentInput): string => {
    const id = input.id ?? newId();
    insert.run(
      id,
      input.projectId,
      input.pattern,
      orNull(input.scopeJson),
      orNull(input.goal),
      input.status ?? 'open',
      numberOrNull(input.tokenBudget),
      input.tokensUsed ?? 0,
      numberOrNull(input.roundCap),
      input.roundsUsed ?? 0,
      input.createdAt ?? isoTimestamp(clock()),
      null,
      null,
    );
    for (const member of input.members ?? []) insertMember.run(id, member.agentId, member.role);
    return id;
  });

  return {
    create: (input) => mustGet(createTransaction(input)),

    get: (id) => {
      const row = getStatement.get(id);
      return row === undefined ? undefined : toRecord(row);
    },

    listByProject: (projectId, options = {}) =>
      limited(
        options.status === undefined
          ? byProject.all(projectId)
          : byProjectStatus.all(projectId, options.status),
        options.limit,
      ),

    listByAgent: (agentId, options = {}) => {
      const rows = byAgent.all(agentId);
      const filtered =
        options.status === undefined ? rows : rows.filter((r) => r.status === options.status);
      return limited(filtered, options.limit);
    },

    close(id, options = {}) {
      const changes = closeStatement.run(
        options.at ?? isoTimestamp(clock()),
        orNull(options.reason),
        id,
      ).changes;
      if (changes === 0) throw new RecordNotFoundError('assignments', id);
      return mustGet(id);
    },

    update(id, patch) {
      const columns: Record<string, string> = {
        scopeJson: 'scope_json',
        goal: 'goal',
        tokenBudget: 'token_budget',
        roundCap: 'round_cap',
        roundsUsed: 'rounds_used',
      };
      const sets: string[] = [];
      const values: (string | number | null)[] = [];
      for (const [field, column] of Object.entries(columns)) {
        const value = patch[field as keyof typeof patch];
        if (value === undefined) continue;
        sets.push(`${column} = ?`);
        values.push(value);
      }
      if (sets.length === 0) return mustGet(id);

      const changes = db
        .prepare(`UPDATE assignments SET ${sets.join(', ')} WHERE id = ?`)
        .run(...values, id).changes;
      if (changes === 0) throw new RecordNotFoundError('assignments', id);
      return mustGet(id);
    },

    addTokensUsed(id, delta) {
      if (addTokens.run(delta, id).changes === 0) {
        throw new RecordNotFoundError('assignments', id);
      }
      return mustGet(id).tokensUsed;
    },

    addRoundsUsed(id, by = 1) {
      if (addRounds.run(by, id).changes === 0) {
        throw new RecordNotFoundError('assignments', id);
      }
      return mustGet(id).roundsUsed;
    },

    addMember(assignmentId, member) {
      insertMember.run(assignmentId, member.agentId, member.role);
      return { assignmentId, agentId: member.agentId, role: member.role };
    },

    removeMember: (assignmentId, agentId) => deleteMember.run(assignmentId, agentId).changes > 0,

    listMembers: (assignmentId) =>
      listMembers.all(assignmentId).map((row) => ({
        assignmentId: row.assignment_id,
        agentId: row.agent_id,
        role: row.role,
      })),

    delete: (id) => runRestrictedDelete('assignments', id, () => deleteStatement.run(id).changes),
  };
}
