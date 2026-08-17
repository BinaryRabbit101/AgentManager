/**
 * The client-state store (DESIGN §1.2).
 *
 * "Zustand, one small store": theme, connection status, the derived fleet
 * status, and the board's filter/sort state. Everything that belongs to the
 * server lives in TanStack Query instead — there is exactly one copy of any
 * fact, and this file holds none of them.
 */

import { useMemo } from 'react';
import { create } from 'zustand';

import type { AgentFleetStatus, EventFrame } from '../api/types';
import {
  applySessionEvent,
  EMPTY_FLEET_STATUS,
  statusFor,
  type FleetStatusMap,
} from '../board/fleetStatus';
import type { ConnectionState } from '../events/EventStream';
import type { ThemeChoice } from '../theme/theme';

export type BoardSort = 'board-order' | 'name' | 'recent';

export interface BoardFilters {
  readonly specialty: string | null;
  readonly workingNow: boolean;
  readonly needsAttention: boolean;
  /** §5.2: an archived agent is hidden by default and visible under this. */
  readonly archived: boolean;
}

export const DEFAULT_FILTERS: BoardFilters = Object.freeze({
  specialty: null,
  workingNow: false,
  needsAttention: false,
  archived: false,
});

export interface AppState {
  readonly theme: ThemeChoice;
  readonly connection: ConnectionState;
  readonly fleet: FleetStatusMap;
  readonly filters: BoardFilters;
  readonly sort: BoardSort;
  readonly quickAddOpen: boolean;

  /*
   * Declared as function *properties* rather than as methods, deliberately.
   * Every consumer selects an action out of the store and calls it detached
   * (`const setTheme = useAppStore((s) => s.setTheme)`), which is the normal
   * zustand idiom and is exactly what a method signature makes unsound — none
   * of these touches `this`, and saying so here says it once.
   */
  readonly setTheme: (theme: ThemeChoice) => void;
  readonly setConnection: (state: ConnectionState) => void;
  readonly ingest: (frame: EventFrame) => void;
  readonly setFilters: (patch: Partial<BoardFilters>) => void;
  readonly setSort: (sort: BoardSort) => void;
  readonly setQuickAddOpen: (open: boolean) => void;
  readonly reset: () => void;
}

export const useAppStore = create<AppState>((set) => ({
  theme: 'system',
  // The app starts out *trying* rather than connected: claiming `live` before a
  // socket has answered is the one lie the indicator must never tell.
  connection: 'reconnecting',
  fleet: EMPTY_FLEET_STATUS,
  filters: DEFAULT_FILTERS,
  sort: 'board-order',
  quickAddOpen: false,

  setTheme: (theme) => set({ theme }),
  setConnection: (connection) => set({ connection }),
  ingest: (frame) => set((state) => ({ fleet: applySessionEvent(state.fleet, frame) })),
  setFilters: (patch) => set((state) => ({ filters: { ...state.filters, ...patch } })),
  setSort: (sort) => set({ sort }),
  setQuickAddOpen: (quickAddOpen) => set({ quickAddOpen }),
  reset: () =>
    set({
      connection: 'reconnecting',
      fleet: EMPTY_FLEET_STATUS,
      filters: DEFAULT_FILTERS,
      sort: 'board-order',
      quickAddOpen: false,
    }),
}));

/**
 * **The** accessor for a card's status (IMPLEMENTATION §2).
 *
 * Every status pill and headline on the board reads through this one function.
 * When orchestrator M9 ships `GET /api/orchestrator/status`, this body becomes a
 * query read and nothing else in the UI changes.
 */
export function useAgentFleetStatus(agentId: string): AgentFleetStatus {
  // Selecting the entry rather than the derived object on purpose: `statusFor`
  // builds a fresh idle record when nothing is known, and returning a new object
  // from a zustand selector on every render is an infinite loop.
  const entry = useAppStore((state) => state.fleet[agentId]);
  return useMemo(() => entry ?? statusFor(EMPTY_FLEET_STATUS, agentId), [entry, agentId]);
}
