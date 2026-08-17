/**
 * The work-item list's arithmetic (DESIGN §8.2 region 4, projects §1.5).
 *
 * > "a simple ranked list per status, inline-creatable (title only is enough),
 * > drag-reorderable with the same ▲▼ fallback, and each row a drop target for an
 * > agent. Deliberately thin: no priorities, labels, or assignees."
 *
 * `rank` is a REAL "so an item can be dropped between two neighbours without
 * renumbering" (projects §1.5), so a move is **one** `PATCH /api/work-items/:id`
 * with a new rank rather than a rewrite of the list. That is the opposite choice
 * from the board's whole-list `PUT /api/roster/board-order`, and deliberately so:
 * roster's order is one list with one owner, while work-item ranks are per row
 * and the backlog is edited by agents as well as by the user (`source:
 * 'overseer'`), so a whole-list rewrite here would clobber a concurrent insert.
 */

import type { WorkItem, WorkItemStatus } from '../api/types';

/** The gap used when an item moves past the end of the list. */
export const RANK_STEP = 1;

/** §8.2's grouping: "a simple ranked list **per status**". */
export const WORK_ITEM_ORDER: readonly WorkItemStatus[] = [
  'open',
  'in_progress',
  'done',
  'dropped',
];

export function byRank(items: readonly WorkItem[]): readonly WorkItem[] {
  return [...items].sort((a, b) =>
    a.rank === b.rank ? a.id.localeCompare(b.id) : a.rank - b.rank,
  );
}

export function groupByStatus(
  items: readonly WorkItem[],
): readonly { readonly status: WorkItemStatus; readonly items: readonly WorkItem[] }[] {
  return WORK_ITEM_ORDER.map((status) => ({
    status,
    items: byRank(items.filter((item) => item.status === status)),
  })).filter((group) => group.items.length > 0);
}

/**
 * The rank that puts `items[index]` where `items[index + delta]` is.
 *
 * The midpoint between the two items it lands between, or a step beyond the end.
 * `undefined` means the move is a no-op — the first item cannot move up — and the
 * caller sends no request at all, which is what makes ▲ on the top row silent
 * rather than a 400.
 */
export function rankForMove(
  ordered: readonly WorkItem[],
  id: string,
  delta: -1 | 1,
): number | undefined {
  const from = ordered.findIndex((item) => item.id === id);
  if (from === -1) return undefined;
  const to = from + delta;
  if (to < 0 || to >= ordered.length) return undefined;

  // Moving down past `to` means landing between `to` and the one after it;
  // moving up means landing between the one before `to` and `to`.
  const after = delta === 1 ? ordered[to] : ordered[to - 1];
  const before = delta === 1 ? ordered[to + 1] : ordered[to];
  if (after === undefined) return (before?.rank ?? 0) - RANK_STEP;
  if (before === undefined) return after.rank + RANK_STEP;
  return (after.rank + before.rank) / 2;
}

/**
 * The scope hint §5.3 requires the launch flow to show.
 *
 * "its `title` seeded into the prompt and its `scopePaths` shown as a scope
 * hint". Both are read from the item at open time rather than copied into the
 * drag payload, so a row edited between the drag and the submit does not launch
 * with a stale title.
 */
export function workItemPromptSeed(item: WorkItem): string {
  return item.body.trim() === '' ? item.title : `${item.title}\n\n${item.body.trim()}`;
}
