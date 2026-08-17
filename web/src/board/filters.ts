/**
 * The board's filters and sort (DESIGN §5.1, IMPLEMENTATION §2).
 *
 * Pure functions over the roster list and the derived fleet status, so the
 * filter semantics are testable without rendering a card. The default sort is
 * **board order** — roster's `agent_ui_state.board_order` — with pinned agents
 * ahead of the rest (§5.2).
 */

import type { AgentView } from '../api/types';

import {
  NEEDS_ATTENTION_STATES,
  statusFor,
  WORKING_STATES,
  type FleetStatusMap,
} from './fleetStatus';

export interface FilterInput {
  readonly specialty: string | null;
  readonly workingNow: boolean;
  readonly needsAttention: boolean;
  readonly archived: boolean;
}

export type SortKey = 'board-order' | 'name' | 'recent';

export function filterAgents(
  agents: readonly AgentView[],
  filters: FilterInput,
  fleet: FleetStatusMap,
): AgentView[] {
  return agents.filter((agent) => {
    // §5.2: "An archived agent is hidden behind the archive filter." It must
    // stay reachable rather than disappear, because sessions reference it.
    const archived = agent.archivedAt !== null;
    if (archived !== filters.archived) return false;

    if (filters.specialty !== null && agent.definition.specialty !== filters.specialty) {
      return false;
    }

    const state = statusFor(fleet, agent.definition.id).state;
    if (filters.workingNow && !WORKING_STATES.includes(state)) return false;
    if (filters.needsAttention && !NEEDS_ATTENTION_STATES.includes(state)) return false;
    return true;
  });
}

export function sortAgents(agents: readonly AgentView[], sort: SortKey): AgentView[] {
  const copy = [...agents];
  copy.sort((a, b) => {
    // "Pinned agents sort ahead of the rest" (§5.2) — under every sort, because
    // pinning means "keep this where I can see it", not "reorder it once".
    if (a.uiState.pinned !== b.uiState.pinned) return a.uiState.pinned ? -1 : 1;
    switch (sort) {
      case 'name':
        return a.definition.name.localeCompare(b.definition.name);
      case 'recent':
        return (b.uiState.lastUsedAt ?? '').localeCompare(a.uiState.lastUsedAt ?? '');
      case 'board-order':
      default:
        return a.uiState.boardOrder - b.uiState.boardOrder;
    }
  });
  return copy;
}

/** Diagnostics from the library-wide list that name a given agent (§5.2). */
export function diagnosticsForAgent<T extends { readonly agentId?: string }>(
  diagnostics: readonly T[],
  agentId: string,
): T[] {
  return diagnostics.filter((diagnostic) => diagnostic.agentId === agentId);
}
