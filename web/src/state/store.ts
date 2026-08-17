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

/**
 * What the launch flow was opened with (§6's pre-fill rules).
 *
 * One shape for all three ways in — drop, card menu, project page — because
 * "both paths call the same code. There is no 'mobile launch' and 'desktop
 * launch' — one launch flow, reached three ways" (§5.4).
 */
export interface LaunchIntent {
  readonly agentId: string | null;
  readonly projectId: string | null;
  /** Where it was opened from, so the flow knows which picker to focus. */
  readonly origin: 'drag' | 'agent-menu' | 'project';
}

/** A transient message — the rollback path of §5.3 and nothing more. */
export interface Toast {
  readonly id: string;
  readonly message: string;
  readonly tone: 'danger' | 'info';
}

export interface AppState {
  readonly theme: ThemeChoice;
  readonly connection: ConnectionState;
  readonly fleet: FleetStatusMap;
  readonly filters: BoardFilters;
  readonly sort: BoardSort;
  readonly quickAddOpen: boolean;
  /** §5.4's explicit Reorder mode — the pointer-free path to board order. */
  readonly reorderMode: boolean;
  readonly launch: LaunchIntent | null;
  readonly toasts: readonly Toast[];
  /**
   * Open questions, for the rail badge (§2.2).
   *
   * `null` until something has said — a badge that reads `0` before the inbox
   * has been read is a claim the app cannot yet make. Live from
   * `assignment.question.raised` / `.answered` (§3.4).
   */
  readonly openQuestions: number | null;

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
  readonly setReorderMode: (on: boolean) => void;
  readonly openLaunch: (intent: LaunchIntent) => void;
  readonly closeLaunch: () => void;
  readonly pushToast: (message: string, tone?: Toast['tone']) => void;
  readonly dismissToast: (id: string) => void;
  readonly setOpenQuestions: (count: number | null) => void;
  readonly reset: () => void;
}

let toastSeq = 0;

export const useAppStore = create<AppState>((set) => ({
  theme: 'system',
  // The app starts out *trying* rather than connected: claiming `live` before a
  // socket has answered is the one lie the indicator must never tell.
  connection: 'reconnecting',
  fleet: EMPTY_FLEET_STATUS,
  filters: DEFAULT_FILTERS,
  sort: 'board-order',
  quickAddOpen: false,
  reorderMode: false,
  launch: null,
  toasts: [],
  openQuestions: null,

  setTheme: (theme) => set({ theme }),
  setConnection: (connection) => set({ connection }),
  ingest: (frame) => set((state) => ({ fleet: applySessionEvent(state.fleet, frame) })),
  setFilters: (patch) => set((state) => ({ filters: { ...state.filters, ...patch } })),
  setSort: (sort) => set({ sort }),
  setQuickAddOpen: (quickAddOpen) => set({ quickAddOpen }),
  setReorderMode: (reorderMode) => set({ reorderMode }),
  openLaunch: (launch) => set({ launch }),
  closeLaunch: () => set({ launch: null }),
  pushToast: (message, tone = 'danger') => {
    toastSeq += 1;
    const toast: Toast = { id: `toast-${String(toastSeq)}`, message, tone };
    set((state) => ({ toasts: [...state.toasts, toast] }));
  },
  dismissToast: (id) => set((state) => ({ toasts: state.toasts.filter((one) => one.id !== id) })),
  setOpenQuestions: (openQuestions) => set({ openQuestions }),
  reset: () =>
    set({
      connection: 'reconnecting',
      fleet: EMPTY_FLEET_STATUS,
      filters: DEFAULT_FILTERS,
      sort: 'board-order',
      quickAddOpen: false,
      reorderMode: false,
      launch: null,
      toasts: [],
      openQuestions: null,
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
