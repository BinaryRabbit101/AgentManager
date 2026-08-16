/**
 * `workspace_leases`, typed (projects DESIGN §1.6; IMPLEMENTATION M6).
 *
 * This element's own table, so — unlike `projects`, which is reached only
 * through foundation's repository — the SQL lives here (foundation §1.3).
 *
 * The one rule the storage layer itself enforces is the partial unique index of
 * §1.6:
 *
 * ```sql
 * CREATE UNIQUE INDEX workspace_leases_active_assignment
 *   ON workspace_leases (project_id, assignment_id) WHERE state = 'active';
 * ```
 *
 * §4.3 asks for "an in-process async mutex **plus** the partial unique index, so
 * a crash-restart cannot double-lease". The mutex serialises the read-decide-write
 * sequence within one process; the index is what still holds when the process
 * that took the mutex is gone. Two halves of one guarantee, and only one of them
 * survives a power cut.
 */
import { isoTimestamp, newId, type Clock, type Database } from '../../storage/index.js';

import {
  isWorkspaceKind,
  isWorkspaceLeaseState,
  type WorkspaceKind,
  type WorkspaceLease,
  type WorkspaceLeaseState,
} from './types.js';

export interface CreateLeaseInput {
  readonly projectId: string;
  readonly assignmentId: string;
  readonly kind: WorkspaceKind;
  readonly path: string;
  readonly branch?: string | null;
  readonly baseCommit?: string | null;
  readonly write: boolean;
  readonly acquiredAt?: string;
}

export interface WorkspaceLeaseRepository {
  /** @throws when an `active` lease already exists for the pair — the index. */
  create(input: CreateLeaseInput): WorkspaceLease;
  get(id: string): WorkspaceLease | undefined;
  /** The at-most-one active lease for a pair, which the unique index guarantees. */
  activeFor(projectId: string, assignmentId: string): WorkspaceLease | undefined;
  /** The most recent lease for a pair in `state` — the adoption path of §4.4. */
  latestFor(
    projectId: string,
    assignmentId: string,
    state: WorkspaceLeaseState,
  ): WorkspaceLease | undefined;
  /** Every lease on a project, newest first. */
  list(
    projectId: string,
    options?: { readonly state?: WorkspaceLeaseState },
  ): readonly WorkspaceLease[];
  /** Every `active` lease in the database — startup reconciliation's input (§4.4). */
  listActiveEverywhere(): readonly WorkspaceLease[];
  /** Moves a lease to `released` or `orphaned`, stamping `released_at` for the former. */
  setState(id: string, state: WorkspaceLeaseState, at?: string): WorkspaceLease;
  /** Puts an adopted lease back into `active` and clears `released_at`. */
  reactivate(id: string, at?: string): WorkspaceLease;
  delete(id: string): boolean;
}

interface LeaseRow {
  readonly id: string;
  readonly project_id: string;
  readonly assignment_id: string;
  readonly kind: string;
  readonly path: string;
  readonly branch: string | null;
  readonly base_commit: string | null;
  readonly write: number;
  readonly state: string;
  readonly acquired_at: string;
  readonly released_at: string | null;
}

const COLUMNS =
  'id, project_id, assignment_id, kind, path, branch, base_commit, "write", state, acquired_at, released_at';

function toLease(row: LeaseRow): WorkspaceLease {
  return {
    id: row.id,
    projectId: row.project_id,
    assignmentId: row.assignment_id,
    // A row whose vocabulary column is off the union means somebody hand-edited
    // the database; reading it as the conservative value keeps the project page
    // rendering instead of throwing on a list.
    kind: isWorkspaceKind(row.kind) ? row.kind : 'primary',
    path: row.path,
    branch: row.branch,
    baseCommit: row.base_commit,
    write: row.write !== 0,
    state: isWorkspaceLeaseState(row.state) ? row.state : 'orphaned',
    acquiredAt: row.acquired_at,
    releasedAt: row.released_at,
  };
}

export function createWorkspaceLeaseRepository(
  db: Database,
  clock: Clock,
): WorkspaceLeaseRepository {
  const insert = db.prepare<
    [string, string, string, string, string, string | null, string | null, number, string]
  >(
    `INSERT INTO workspace_leases
       (id, project_id, assignment_id, kind, path, branch, base_commit, "write", state, acquired_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
  );
  const selectById = db.prepare<[string], LeaseRow>(
    `SELECT ${COLUMNS} FROM workspace_leases WHERE id = ?`,
  );
  const selectActiveForPair = db.prepare<[string, string], LeaseRow>(
    `SELECT ${COLUMNS} FROM workspace_leases
      WHERE project_id = ? AND assignment_id = ? AND state = 'active'`,
  );
  const selectLatestForPair = db.prepare<[string, string, string], LeaseRow>(
    `SELECT ${COLUMNS} FROM workspace_leases
      WHERE project_id = ? AND assignment_id = ? AND state = ?
      ORDER BY acquired_at DESC, id DESC LIMIT 1`,
  );
  const selectByProject = db.prepare<[string], LeaseRow>(
    `SELECT ${COLUMNS} FROM workspace_leases WHERE project_id = ? ORDER BY acquired_at DESC, id DESC`,
  );
  const selectByProjectState = db.prepare<[string, string], LeaseRow>(
    `SELECT ${COLUMNS} FROM workspace_leases WHERE project_id = ? AND state = ?
      ORDER BY acquired_at DESC, id DESC`,
  );
  const selectActiveEverywhere = db.prepare<[], LeaseRow>(
    `SELECT ${COLUMNS} FROM workspace_leases WHERE state = 'active' ORDER BY acquired_at, id`,
  );
  const updateState = db.prepare<[string, string | null, string]>(
    'UPDATE workspace_leases SET state = ?, released_at = ? WHERE id = ?',
  );
  const updateReactivate = db.prepare<[string, string]>(
    "UPDATE workspace_leases SET state = 'active', released_at = NULL, acquired_at = ? WHERE id = ?",
  );
  const deleteById = db.prepare<[string]>('DELETE FROM workspace_leases WHERE id = ?');

  function mustGet(id: string): WorkspaceLease {
    const row = selectById.get(id);
    if (row === undefined) {
      throw new Error(`Internal error: workspace lease ${id} vanished between write and read.`);
    }
    return toLease(row);
  }

  return {
    create(input) {
      const id = newId();
      insert.run(
        id,
        input.projectId,
        input.assignmentId,
        input.kind,
        input.path,
        input.branch ?? null,
        input.baseCommit ?? null,
        input.write ? 1 : 0,
        input.acquiredAt ?? isoTimestamp(clock()),
      );
      return mustGet(id);
    },

    get: (id) => {
      const row = selectById.get(id);
      return row === undefined ? undefined : toLease(row);
    },

    activeFor: (projectId, assignmentId) => {
      const row = selectActiveForPair.get(projectId, assignmentId);
      return row === undefined ? undefined : toLease(row);
    },

    latestFor: (projectId, assignmentId, state) => {
      const row = selectLatestForPair.get(projectId, assignmentId, state);
      return row === undefined ? undefined : toLease(row);
    },

    list: (projectId, options = {}) =>
      (options.state === undefined
        ? selectByProject.all(projectId)
        : selectByProjectState.all(projectId, options.state)
      ).map(toLease),

    listActiveEverywhere: () => selectActiveEverywhere.all().map(toLease),

    setState: (id, state, at) => {
      // `released_at` answers "when did this stop being held", which is exactly
      // what a release is. An orphaned lease was never released — the process
      // died — so the column stays NULL and the two cases stay distinguishable.
      updateState.run(state, state === 'released' ? (at ?? isoTimestamp(clock())) : null, id);
      return mustGet(id);
    },

    reactivate: (id, at) => {
      updateReactivate.run(at ?? isoTimestamp(clock()), id);
      return mustGet(id);
    },

    delete: (id) => deleteById.run(id).changes > 0,
  };
}
