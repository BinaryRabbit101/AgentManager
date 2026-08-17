/**
 * Board order: the whole list, optimistically, rolled back on refusal
 * (DESIGN §5.3, §18 decision 6; roster §9.5).
 *
 * > "a whole-list, idempotent, single-transaction rewrite, which is why the
 * > client sends the entire ordered id list rather than a per-card patch. It
 * > applies optimistically and rolls back with a toast on failure; an id the
 * > roster does not know is a 400 and the previous order stands."
 *
 * Three properties follow from that and are what the tests assert:
 *
 * 1. **One request per gesture**, carrying every id. A per-card `PATCH` would
 *    produce N writes and a torn order on a dropped connection.
 * 2. **Replaying the same order is a no-op** — the request is still sent (the
 *    client cannot know the server's order is identical without asking) and the
 *    server's answer is the same list. Idempotence is roster's promise, not a
 *    client-side short-circuit.
 * 3. **Rollback restores the exact previous cache**, not a recomputed one: the
 *    snapshot is the roster view as it was, so a failure cannot leave the board
 *    holding an order the server never accepted.
 */

import type { QueryClient } from '@tanstack/react-query';

import type { ApiClient } from '../api/client';
import { queryKeys } from '../api/queries';
import type { AgentView, RosterListView } from '../api/types';

/** `order` as roster wants it: every live agent, in the order the board shows. */
export function orderOf(agents: readonly AgentView[]): readonly string[] {
  return agents.map((agent) => agent.definition.id);
}

/** Moves `agentId` to the position of `overAgentId`, the sortable's semantics. */
export function moveWithin(
  order: readonly string[],
  agentId: string,
  overAgentId: string,
): readonly string[] {
  const from = order.indexOf(agentId);
  const to = order.indexOf(overAgentId);
  if (from === -1 || to === -1 || from === to) return order;
  const next = [...order];
  next.splice(from, 1);
  next.splice(to, 0, agentId);
  return next;
}

/** `boardOrder` renumbered from the list's position — the column roster sorts by. */
function renumber(view: RosterListView, order: readonly string[]): RosterListView {
  const rank = new Map(order.map((id, index) => [id, index]));
  const agents = [...view.agents]
    .map((agent) => {
      const next = rank.get(agent.definition.id);
      return next === undefined
        ? agent
        : { ...agent, uiState: { ...agent.uiState, boardOrder: next } };
    })
    .sort((a, b) => a.uiState.boardOrder - b.uiState.boardOrder);
  return { ...view, agents };
}

/**
 * Reorders the cached roster without asking the server.
 *
 * §5.4's Reorder mode "persists **once**" when the mode is left, so each ▲▼
 * press moves the board and nothing else; the single `PUT` comes later.
 */
export function applyLocalOrder(
  queryClient: QueryClient,
  order: readonly string[],
): readonly string[] {
  const snapshot = queryClient.getQueryData<RosterListView>(queryKeys.roster);
  if (snapshot !== undefined) {
    queryClient.setQueryData<RosterListView>(queryKeys.roster, renumber(snapshot, order));
  }
  return order;
}

export interface ReorderDeps {
  readonly client: ApiClient;
  readonly queryClient: QueryClient;
  /** §5.3's "rolled back with a toast on failure". */
  readonly toast: (message: string) => void;
}

export interface ReorderResult {
  readonly ok: boolean;
  /** The server's message, verbatim, when it refused (§3.1). */
  readonly message?: string;
}

/**
 * `PUT /api/roster/board-order { order }`.
 *
 * The optimistic write goes into the query cache rather than into a second copy
 * of the list in the client store: there is exactly one copy of any server fact
 * (§1.2), and a board that read from a local mirror would keep showing the new
 * order after the rollback restored the old one.
 */
export async function persistBoardOrder(
  deps: ReorderDeps,
  order: readonly string[],
): Promise<ReorderResult> {
  const { client, queryClient, toast } = deps;
  const key = queryKeys.roster;
  const snapshot = queryClient.getQueryData<RosterListView>(key);

  if (snapshot !== undefined) {
    queryClient.setQueryData<RosterListView>(key, renumber(snapshot, order));
  }

  const result = await client.request<RosterListView>('/roster/board-order', {
    method: 'PUT',
    body: { order },
  });

  if (result.kind === 'ok') {
    // The server answers with the roster it just wrote, so the cache is settled
    // from the authority rather than from the guess (§1.2).
    if (result.value !== undefined) queryClient.setQueryData<RosterListView>(key, result.value);
    else await queryClient.invalidateQueries({ queryKey: key });
    return { ok: true };
  }

  // "the previous order stands" — restored exactly, then said out loud.
  if (snapshot !== undefined) queryClient.setQueryData<RosterListView>(key, snapshot);
  else await queryClient.invalidateQueries({ queryKey: key });
  toast(result.message);
  return { ok: false, message: result.message };
}
