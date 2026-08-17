/**
 * The backlog (projects DESIGN §1.5, §7.2; IMPLEMENTATION M8).
 *
 * > "Yes, a deliberately thin list — title, body, kind, status, manual rank,
 * > optional scope paths — and assignments link to zero or more items. […]
 * > Anything richer is a tracker, which this is not trying to be."
 *
 * Two rules carry the whole design, and both are about *who writes what*.
 *
 * ## Status is derived, not managed
 *
 * > "Status transitions are mostly derived, not managed: an item flips to
 * > `in_progress` when an assignment linking to it starts and back to `open` if
 * > every linked assignment ends without a human marking it `done`."
 *
 * So there is no workflow engine here. `open ⇄ in_progress` is a projection of
 * `work_item_assignments` and is recomputed from it; `done` and `dropped` are
 * the *human's* two words and no assignment event ever moves an item out of
 * either. That asymmetry is M8's third acceptance — "marking `done` sets
 * `closedAt` and is **not undone** by later assignment events" — and it is why
 * {@link WorkItemRepository.noteAssignmentStarted} and its ending twin filter on
 * status rather than setting one unconditionally.
 *
 * ## Projects owns the table; orchestrator is its only writer
 *
 * > "Projects owns the table and derives status from it, but it never populates
 * > it on its own: the writer is orchestrator's assignment-creation path."
 *
 * Hence {@link WorkItemRepository.link} / {@link WorkItemRepository.unlink} —
 * the two calls of §1.5, idempotent, validating that every item belongs to the
 * assignment's project, and the only sanctioned writers of
 * `work_item_assignments`. Linking is optional end to end: an assignment created
 * with no items writes no rows, and an item never linked to anything simply
 * stays `open` (M8's fourth acceptance).
 */
import { isoTimestamp, newId, type Clock, type Database } from '../../storage/index.js';

import { WorkItemNotFoundError, WorkItemProjectMismatchError } from './errors.js';
import {
  isWorkItemKind,
  isWorkItemSource,
  isWorkItemStatus,
  type WorkItem,
  type WorkItemKind,
  type WorkItemSource,
  type WorkItemStatus,
} from './types.js';

export interface CreateWorkItemInput {
  readonly projectId: string;
  readonly kind: WorkItemKind;
  readonly title: string;
  readonly body?: string;
  readonly status?: WorkItemStatus;
  /** Omitted appends to the end of the project's list. */
  readonly rank?: number;
  readonly scopePaths?: readonly string[];
  readonly source?: WorkItemSource;
}

/** Every field `PATCH /api/work-items/:id` may change (§5). */
export interface UpdateWorkItemPatch {
  readonly kind?: WorkItemKind;
  readonly title?: string;
  readonly body?: string;
  readonly status?: WorkItemStatus;
  readonly rank?: number;
  readonly scopePaths?: readonly string[];
}

export interface ListWorkItemsOptions {
  readonly status?: WorkItemStatus;
}

export interface WorkItemRepository {
  create(input: CreateWorkItemInput): WorkItem;
  get(id: string): WorkItem | undefined;
  /** One project's items in manual (`rank`) order — the board query of §1.5. */
  list(projectId: string, options?: ListWorkItemsOptions): readonly WorkItem[];
  /** @throws WorkItemNotFoundError */
  update(id: string, patch: UpdateWorkItemPatch): WorkItem;
  delete(id: string): boolean;

  // --- §1.5's two calls, orchestrator's to make -----------------------------
  /**
   * Links items to an assignment (§1.5).
   *
   * @param projectId the assignment's project; every item must belong to it.
   * @throws WorkItemNotFoundError | WorkItemProjectMismatchError
   */
  link(assignmentId: string, projectId: string, workItemIds: readonly string[]): void;
  /** Unlinks everything, then returns any item that has no live link left to `open`. */
  unlink(assignmentId: string): void;
  /** The item ids an assignment carries. */
  itemsFor(assignmentId: string): readonly string[];
  /** The assignment ids an item is carried by. */
  assignmentsFor(workItemId: string): readonly string[];

  // --- The derived transitions (§1.5) ---------------------------------------
  /** An assignment started: every `open` item it carries becomes `in_progress`. */
  noteAssignmentStarted(assignmentId: string): readonly string[];
  /**
   * An assignment ended: each item it carries falls back to `open` unless
   * another linked assignment is still named by `stillRunning`.
   */
  noteAssignmentEnded(
    assignmentId: string,
    stillRunning?: (assignmentId: string) => boolean,
  ): readonly string[];
}

interface WorkItemRow {
  readonly id: string;
  readonly project_id: string;
  readonly kind: string;
  readonly title: string;
  readonly body: string;
  readonly status: string;
  readonly rank: number;
  readonly scope_paths_json: string;
  readonly source: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly closed_at: string | null;
}

const COLUMNS =
  'id, project_id, kind, title, body, status, "rank", scope_paths_json, source, ' +
  'created_at, updated_at, closed_at';

/** Total, like every stored-blob read here: a bad column must not hide an item. */
function parseScopePaths(json: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
      : [];
  } catch {
    return [];
  }
}

function toWorkItem(row: WorkItemRow): WorkItem {
  return {
    id: row.id,
    projectId: row.project_id,
    // A vocabulary column off its union means a hand-edited row; reading it as
    // the conservative value keeps the board rendering instead of throwing.
    kind: isWorkItemKind(row.kind) ? row.kind : 'chore',
    title: row.title,
    body: row.body,
    status: isWorkItemStatus(row.status) ? row.status : 'open',
    rank: row.rank,
    scopePaths: parseScopePaths(row.scope_paths_json),
    source: isWorkItemSource(row.source) ? row.source : 'user',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
  };
}

/** The two statuses an assignment event may never move an item out of (§1.5). */
function isClosedByHand(status: WorkItemStatus): boolean {
  return status === 'done' || status === 'dropped';
}

export function createWorkItemRepository(db: Database, clock: Clock): WorkItemRepository {
  const insert = db.prepare<
    [string, string, string, string, string, string, number, string, string, string, string]
  >(
    `INSERT INTO work_items
       (id, project_id, kind, title, body, status, "rank", scope_paths_json, source,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const selectById = db.prepare<[string], WorkItemRow>(
    `SELECT ${COLUMNS} FROM work_items WHERE id = ?`,
  );
  const selectByProject = db.prepare<[string], WorkItemRow>(
    `SELECT ${COLUMNS} FROM work_items WHERE project_id = ? ORDER BY "rank", created_at, id`,
  );
  const selectByProjectStatus = db.prepare<[string, string], WorkItemRow>(
    `SELECT ${COLUMNS} FROM work_items WHERE project_id = ? AND status = ? ` +
      'ORDER BY "rank", created_at, id',
  );
  const maxRank = db.prepare<[string], { top: number | null }>(
    'SELECT MAX("rank") AS top FROM work_items WHERE project_id = ?',
  );
  const deleteById = db.prepare<[string]>('DELETE FROM work_items WHERE id = ?');

  const insertLink = db.prepare<[string, string]>(
    'INSERT INTO work_item_assignments (work_item_id, assignment_id) VALUES (?, ?) ' +
      'ON CONFLICT(work_item_id, assignment_id) DO NOTHING',
  );
  const deleteLinks = db.prepare<[string]>(
    'DELETE FROM work_item_assignments WHERE assignment_id = ?',
  );
  const selectItemsFor = db.prepare<[string], { work_item_id: string }>(
    'SELECT work_item_id FROM work_item_assignments WHERE assignment_id = ? ORDER BY work_item_id',
  );
  const selectAssignmentsFor = db.prepare<[string], { assignment_id: string }>(
    'SELECT assignment_id FROM work_item_assignments WHERE work_item_id = ? ORDER BY assignment_id',
  );

  function mustGet(id: string): WorkItem {
    const row = selectById.get(id);
    if (row === undefined) throw new WorkItemNotFoundError(id);
    return toWorkItem(row);
  }

  function now(): string {
    return isoTimestamp(clock());
  }

  /** One UPDATE, built from the patch — the same shape the other repositories use. */
  function applyPatch(id: string, patch: UpdateWorkItemPatch): WorkItem {
    const current = mustGet(id);
    const sets: string[] = [];
    const values: (string | number | null)[] = [];

    const push = (column: string, value: string | number | null): void => {
      sets.push(`${column} = ?`);
      values.push(value);
    };

    if (patch.kind !== undefined) push('kind', patch.kind);
    if (patch.title !== undefined) push('title', patch.title);
    if (patch.body !== undefined) push('body', patch.body);
    if (patch.rank !== undefined) push('"rank"', patch.rank);
    if (patch.scopePaths !== undefined) {
      push('scope_paths_json', JSON.stringify([...patch.scopePaths]));
    }
    if (patch.status !== undefined && patch.status !== current.status) {
      push('status', patch.status);
      // §1.5: `closedAt` records when the item stopped being work. Reopening an
      // item clears it, so "closed" and "has a closing timestamp" can never
      // disagree.
      push('closed_at', isClosedByHand(patch.status) ? now() : null);
    }

    if (sets.length === 0) return current;
    push('updated_at', now());

    db.prepare(`UPDATE work_items SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
    return mustGet(id);
  }

  /**
   * Moves an item between `open` and `in_progress`, never out of a human's
   * `done` / `dropped` (§1.5).
   */
  function derive(id: string, to: 'open' | 'in_progress'): boolean {
    const row = selectById.get(id);
    if (row === undefined) return false;
    const item = toWorkItem(row);
    if (isClosedByHand(item.status) || item.status === to) return false;
    db.prepare('UPDATE work_items SET status = ?, updated_at = ? WHERE id = ?').run(to, now(), id);
    return true;
  }

  const linkTransaction = db.transaction(
    (assignmentId: string, projectId: string, ids: readonly string[]): void => {
      for (const workItemId of ids) {
        const item = mustGet(workItemId);
        if (item.projectId !== projectId) {
          throw new WorkItemProjectMismatchError(workItemId, item.projectId, projectId);
        }
      }
      // Validated first, then written: a link call naming four items, one of
      // them another project's, must write none of the four.
      for (const workItemId of ids) insertLink.run(workItemId, assignmentId);
    },
  );

  return {
    create(input) {
      const id = newId();
      const at = now();
      const rank = input.rank ?? (maxRank.get(input.projectId)?.top ?? 0) + 1;
      insert.run(
        id,
        input.projectId,
        input.kind,
        input.title,
        input.body ?? '',
        input.status ?? 'open',
        rank,
        JSON.stringify([...(input.scopePaths ?? [])]),
        input.source ?? 'user',
        at,
        at,
      );
      return mustGet(id);
    },

    get: (id) => {
      const row = selectById.get(id);
      return row === undefined ? undefined : toWorkItem(row);
    },

    list: (projectId, options = {}) =>
      (options.status === undefined
        ? selectByProject.all(projectId)
        : selectByProjectStatus.all(projectId, options.status)
      ).map(toWorkItem),

    update: (id, patch) => applyPatch(id, patch),

    delete: (id) => deleteById.run(id).changes > 0,

    link(assignmentId, projectId, workItemIds) {
      // "Passing no ids writes no rows" (§1.5) — and takes no transaction either.
      const ids = [...new Set(workItemIds)].filter((id) => id.length > 0);
      if (ids.length === 0) return;
      linkTransaction(assignmentId, projectId, ids);
    },

    unlink(assignmentId) {
      const ids = selectItemsFor.all(assignmentId).map((row) => row.work_item_id);
      if (ids.length === 0) return;
      db.transaction((): void => {
        deleteLinks.run(assignmentId);
        // Recomputed *after* the delete, from the links that remain: an item
        // still carried by another open assignment stays `in_progress`.
        for (const id of ids) {
          if (selectAssignmentsFor.all(id).length === 0) derive(id, 'open');
        }
      })();
    },

    itemsFor: (assignmentId) => selectItemsFor.all(assignmentId).map((row) => row.work_item_id),

    assignmentsFor: (workItemId) =>
      selectAssignmentsFor.all(workItemId).map((row) => row.assignment_id),

    noteAssignmentStarted(assignmentId) {
      const changed: string[] = [];
      for (const row of selectItemsFor.all(assignmentId)) {
        if (derive(row.work_item_id, 'in_progress')) changed.push(row.work_item_id);
      }
      return changed;
    },

    noteAssignmentEnded(assignmentId, stillRunning) {
      const changed: string[] = [];
      for (const row of selectItemsFor.all(assignmentId)) {
        const others = selectAssignmentsFor
          .all(row.work_item_id)
          .map((link) => link.assignment_id)
          .filter((id) => id !== assignmentId);
        // "back to `open` if **every** linked assignment ends": one that is
        // still running keeps the item where it is.
        if (others.some((id) => stillRunning?.(id) === true)) continue;
        if (derive(row.work_item_id, 'open')) changed.push(row.work_item_id);
      }
      return changed;
    },
  };
}
