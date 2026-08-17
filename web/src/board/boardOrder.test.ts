/**
 * Board order: one whole-list write, optimistic, rolled back on refusal
 * (DESIGN §5.3, §18 #6; roster §9.5; IMPLEMENTATION §3).
 *
 * The four criteria in §3's reorder bullet are all about *the request and the
 * cache*, so they are asserted here against a real `QueryClient` and a real
 * `ApiClient` with only `fetch` substituted:
 *
 * - the whole ordered id list goes in **one** request;
 * - replaying the same order is a no-op;
 * - an unknown id is a 400 and the previous order stands;
 * - a failed optimistic reorder rolls back **and** raises a toast.
 *
 * "Persists across a reload and across a second client" is the server's promise
 * and is asserted where it is kept — roster's own suite — plus the e2e in
 * `web/e2e/coreLoop.test.ts`, which reorders over a real listener and reads it
 * back through a second request.
 */

import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

import { anAgent, json } from '../../test/harness';
import { ApiClient } from '../api/client';
import { queryKeys } from '../api/queries';
import type { RosterListView } from '../api/types';

import { applyLocalOrder, moveWithin, orderOf, persistBoardOrder } from './boardOrder';

function rosterOf(ids: readonly string[]): RosterListView {
  return {
    agents: ids.map((id, index) => anAgent({ id, name: id.toUpperCase(), boardOrder: index })),
    diagnostics: [],
  };
}

interface Harness {
  readonly client: ApiClient;
  readonly queryClient: QueryClient;
  readonly calls: { url: string; body: unknown }[];
  readonly toasts: string[];
  order(): readonly string[];
}

function harness(
  ids: readonly string[],
  respond: (body: unknown) => Response = () => json(rosterOf(ids)),
): Harness {
  const calls: { url: string; body: unknown }[] = [];
  const toasts: string[] = [];
  const client = new ApiClient({
    fetch: ((url: string, init: RequestInit) => {
      const body: unknown =
        typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      calls.push({ url, body });
      return Promise.resolve(respond(body));
    }) as unknown as typeof globalThis.fetch,
    tokens: { get: () => null, set: () => undefined },
  });
  const queryClient = new QueryClient();
  queryClient.setQueryData<RosterListView>(queryKeys.roster, rosterOf(ids));
  return {
    client,
    queryClient,
    calls,
    toasts,
    order: () => orderOf(queryClient.getQueryData<RosterListView>(queryKeys.roster)?.agents ?? []),
  };
}

describe('moving a card within the list', () => {
  it('takes the dragged card to the target’s position', () => {
    expect(moveWithin(['a', 'b', 'c'], 'c', 'a')).toEqual(['c', 'a', 'b']);
    expect(moveWithin(['a', 'b', 'c'], 'a', 'c')).toEqual(['b', 'c', 'a']);
  });

  it('is the identity for a move onto itself or onto an id it does not hold', () => {
    const order = ['a', 'b', 'c'];
    expect(moveWithin(order, 'a', 'a')).toBe(order);
    expect(moveWithin(order, 'a', 'zz')).toBe(order);
  });
});

describe('one request, carrying the whole list (roster §9.5)', () => {
  it('sends every id in one PUT and settles the cache from the answer', async () => {
    const fixture = harness(['a', 'b', 'c'], () => json(rosterOf(['c', 'a', 'b'])));
    const result = await persistBoardOrder(
      {
        client: fixture.client,
        queryClient: fixture.queryClient,
        toast: (m) => fixture.toasts.push(m),
      },
      ['c', 'a', 'b'],
    );

    expect(result.ok).toBe(true);
    // One request. "A per-card `PATCH` would produce N writes and a torn order."
    expect(fixture.calls).toHaveLength(1);
    expect(fixture.calls[0]?.url).toBe('/api/roster/board-order');
    expect(fixture.calls[0]?.body).toEqual({ order: ['c', 'a', 'b'] });
    expect(fixture.order()).toEqual(['c', 'a', 'b']);
    expect(fixture.toasts).toEqual([]);
  });

  it('applies the new order before the request answers', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fixture = harness(['a', 'b', 'c']);
    const client = new ApiClient({
      fetch: (async () => {
        await gate;
        return json(rosterOf(['c', 'a', 'b']));
      }) as unknown as typeof globalThis.fetch,
      tokens: { get: () => null, set: () => undefined },
    });

    const pending = persistBoardOrder(
      { client, queryClient: fixture.queryClient, toast: (m) => fixture.toasts.push(m) },
      ['c', 'a', 'b'],
    );
    // Optimistic: the board has already moved.
    expect(fixture.order()).toEqual(['c', 'a', 'b']);
    release?.();
    await pending;
    expect(fixture.order()).toEqual(['c', 'a', 'b']);
  });

  it('replaying the same order is a no-op, and idempotence is the server’s', async () => {
    const fixture = harness(['a', 'b', 'c'], () => json(rosterOf(['a', 'b', 'c'])));
    const deps = {
      client: fixture.client,
      queryClient: fixture.queryClient,
      toast: (m: string) => fixture.toasts.push(m),
    };
    await persistBoardOrder(deps, ['a', 'b', 'c']);
    await persistBoardOrder(deps, ['a', 'b', 'c']);

    expect(fixture.order()).toEqual(['a', 'b', 'c']);
    expect(fixture.calls.map((call) => call.body)).toEqual([
      { order: ['a', 'b', 'c'] },
      { order: ['a', 'b', 'c'] },
    ]);
    expect(fixture.toasts).toEqual([]);
  });
});

describe('a refusal leaves the previous order intact (§5.3)', () => {
  it('rolls back an unknown agent id’s 400 and raises the server’s message as a toast', async () => {
    const message =
      'Board order names 1 agent the roster does not know: ghost. The previous order stands.';
    const fixture = harness(['a', 'b', 'c'], () =>
      json({ error: 'unknown_board_order_id', message, agentIds: ['ghost'] }, 400),
    );

    const result = await persistBoardOrder(
      {
        client: fixture.client,
        queryClient: fixture.queryClient,
        toast: (m) => fixture.toasts.push(m),
      },
      ['ghost', 'a', 'b', 'c'],
    );

    expect(result.ok).toBe(false);
    expect(fixture.order()).toEqual(['a', 'b', 'c']);
    // Verbatim (§3.1) — including the offending id, which is the fix.
    expect(fixture.toasts).toEqual([message]);
  });

  it('rolls back when nothing answered at all', async () => {
    const fixture = harness(['a', 'b', 'c']);
    const client = new ApiClient({
      fetch: (() =>
        Promise.reject(new Error('socket closed'))) as unknown as typeof globalThis.fetch,
      tokens: { get: () => null, set: () => undefined },
    });
    await persistBoardOrder(
      { client, queryClient: fixture.queryClient, toast: (m) => fixture.toasts.push(m) },
      ['c', 'b', 'a'],
    );
    expect(fixture.order()).toEqual(['a', 'b', 'c']);
    expect(fixture.toasts).toHaveLength(1);
  });
});

describe('Reorder mode persists once (§5.4)', () => {
  it('moves the board with no request at all, then writes once', async () => {
    const fixture = harness(['a', 'b', 'c'], () => json(rosterOf(['b', 'c', 'a'])));

    // Three ▲▼ presses, no network.
    applyLocalOrder(fixture.queryClient, moveWithin(fixture.order(), 'a', 'b'));
    applyLocalOrder(fixture.queryClient, moveWithin(fixture.order(), 'a', 'c'));
    expect(fixture.calls).toEqual([]);
    expect(fixture.order()).toEqual(['b', 'c', 'a']);

    // Leaving the mode.
    await persistBoardOrder(
      {
        client: fixture.client,
        queryClient: fixture.queryClient,
        toast: (m) => fixture.toasts.push(m),
      },
      fixture.order(),
    );
    expect(fixture.calls).toHaveLength(1);
    expect(fixture.calls[0]?.body).toEqual({ order: ['b', 'c', 'a'] });
  });
});
