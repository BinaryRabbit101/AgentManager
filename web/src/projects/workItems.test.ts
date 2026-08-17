/**
 * The work-item list's arithmetic (ui §8.2 region 4, projects §1.5).
 *
 * `rank` is a REAL so an item can move between two neighbours in one `PATCH`
 * rather than a whole-list rewrite. That is worth asserting because the two
 * ordered lists in this app are ordered *differently on purpose*: roster's board
 * order is a whole-list `PUT`, and these are per-row patches (see `workItems.ts`
 * for why).
 */
import { describe, expect, it } from 'vitest';

import type { WorkItem } from '../api/types';

import { byRank, groupByStatus, rankForMove, workItemPromptSeed } from './workItems';

function item(overrides: Partial<WorkItem> & { readonly id: string }): WorkItem {
  return {
    projectId: 'p1',
    kind: 'chore',
    title: overrides.id,
    body: '',
    status: 'open',
    rank: 0,
    scopePaths: [],
    source: 'user',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    closedAt: null,
    ...overrides,
  };
}

const LIST = [item({ id: 'a', rank: 1 }), item({ id: 'b', rank: 2 }), item({ id: 'c', rank: 3 })];

describe('ordering', () => {
  it('sorts by rank, and by id when two ranks collide', () => {
    const tied = [item({ id: 'z', rank: 1 }), item({ id: 'a', rank: 1 })];
    expect(byRank(tied).map((one) => one.id)).toEqual(['a', 'z']);
  });

  it('groups per status, in the order the page shows them', () => {
    const groups = groupByStatus([
      item({ id: 'done1', status: 'done', rank: 1 }),
      item({ id: 'open1', status: 'open', rank: 2 }),
      item({ id: 'busy1', status: 'in_progress', rank: 3 }),
    ]);
    expect(groups.map((group) => group.status)).toEqual(['open', 'in_progress', 'done']);
    // An empty status is not a heading with nothing under it.
    expect(groups.some((group) => group.status === 'dropped')).toBe(false);
  });
});

describe('▲▼, as one rank', () => {
  it('lands between the two neighbours it moves past', () => {
    // b moves down past c: between c (3) and nothing, so a step beyond.
    expect(rankForMove(LIST, 'b', 1)).toBe(4);
    // b moves up past a: between nothing and a (1), so a step before.
    expect(rankForMove(LIST, 'b', -1)).toBe(0);
  });

  it('takes the midpoint when it lands in the middle', () => {
    const longer = [...LIST, item({ id: 'd', rank: 4 })];
    // a moves down past b: between b (2) and c (3).
    expect(rankForMove(longer, 'a', 1)).toBe(2.5);
  });

  it('is a no-op at the ends, so no request is sent', () => {
    // The alternative — sending a patch that changes nothing — turns ▲ on the
    // top row into a round-trip and a rerender for no reason.
    expect(rankForMove(LIST, 'a', -1)).toBeUndefined();
    expect(rankForMove(LIST, 'c', 1)).toBeUndefined();
    expect(rankForMove(LIST, 'ghost', 1)).toBeUndefined();
  });
});

describe('the prompt seed (§5.3)', () => {
  it('is the title alone when there is no body', () => {
    expect(workItemPromptSeed(item({ id: 'x', title: 'Fix the 500 on /invoices' }))).toBe(
      'Fix the 500 on /invoices',
    );
  });

  it('carries the body under the title when there is one', () => {
    expect(
      workItemPromptSeed(item({ id: 'x', title: 'Fix the 500', body: 'Since Tuesday.\n' })),
    ).toBe('Fix the 500\n\nSince Tuesday.');
  });
});
