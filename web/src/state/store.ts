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
import { applyCloneEvent, NO_CLONES, type CloneProgressMap } from '../projects/clone';
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
  /**
   * Where it was opened from, so the flow knows which picker to focus.
   *
   * `home` is the fourth way in (§2.4's **Start work**) and the only one that
   * arrives with *neither* seat filled: the other three all come from a card, a
   * row or a drop that already names an agent or a project. It is a word in this
   * vocabulary rather than a reused one because the flow's first question
   * differs — "which agent, on which project" rather than "on what".
   */
  readonly origin: 'drag' | 'agent-menu' | 'project' | 'work-item' | 'home';
  /**
   * A work item dropped on, or picked from a row's `⋯` (§5.3, §8.2 region 4).
   *
   * Carried as an id list because that is what `POST /api/assignments/solo`
   * takes; the title and the scope paths are read from the item itself so the
   * intent never holds a stale copy of either.
   */
  readonly workItemIds?: readonly string[];
}

/**
 * What the pattern create dialog was opened with (§5.3 row 3, §10.4).
 *
 * The same shape for both ways in — the agent→agent drag and the card `⋯` →
 * **Start a pair…** — because §5.4's rule that every drag has a non-drag
 * equivalent is only true if both equivalents end in the same dialog with the
 * same pre-fill.
 */
export interface PairIntent {
  /** The dragged card — the drafting seat. */
  readonly agentId: string | null;
  /** The card it was dropped on — the critic seat. `null` from the menu. */
  readonly withAgentId: string | null;
  readonly projectId?: string | null;
  readonly patternId?: string;
}

/** `runner.ratelimited`'s payload, kept for §12's cool-down strip. */
export interface RateLimitNotice {
  readonly until: string;
  readonly source: string;
  readonly hint: string;
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
  /**
   * In-flight clones, keyed by project id (§8.1).
   *
   * In the app store rather than in the dialog that started them, which is what
   * makes "the dialog can be dismissed" true: the progress bar belongs to the
   * rail, and the dialog is only where the clone was asked for.
   */
  readonly clones: CloneProgressMap;
  readonly filters: BoardFilters;
  readonly sort: BoardSort;
  readonly quickAddOpen: boolean;
  /** §5.4's explicit Reorder mode — the pointer-free path to board order. */
  readonly reorderMode: boolean;
  readonly launch: LaunchIntent | null;
  /** §10.4’s dialog, open or not — the agent→agent gesture’s destination. */
  readonly pair: PairIntent | null;
  readonly toasts: readonly Toast[];
  /**
   * Open questions, for the rail badge (§2.2).
   *
   * `null` until something has said — a badge that reads `0` before the inbox
   * has been read is a claim the app cannot yet make. Live from
   * `assignment.question.raised` / `.answered` (§3.4).
   */
  readonly openQuestions: number | null;
  /**
   * The live cool-down (§12 panel 2).
   *
   * `runner.ratelimited` is the **only** carrier of `source` and `hint` — the
   * queue route knows the deadline but not where it came from — so the frame is
   * kept rather than discarded, and cleared when the queue says cooling ended.
   */
  readonly rateLimit: RateLimitNotice | null;

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
  /** Clears a failed clone's row once its message has been read. */
  readonly dismissClone: (projectId: string) => void;
  readonly setFilters: (patch: Partial<BoardFilters>) => void;
  readonly setSort: (sort: BoardSort) => void;
  readonly setQuickAddOpen: (open: boolean) => void;
  readonly setReorderMode: (on: boolean) => void;
  readonly openLaunch: (intent: LaunchIntent) => void;
  readonly closeLaunch: () => void;
  readonly openPair: (intent: PairIntent) => void;
  readonly closePair: () => void;
  readonly pushToast: (message: string, tone?: Toast['tone']) => void;
  readonly dismissToast: (id: string) => void;
  readonly setOpenQuestions: (count: number | null) => void;
  readonly reset: () => void;
}

/**
 * `runner.ratelimited` raises the strip; `runner.queue.changed` lowers it.
 *
 * Two events rather than a timer, because the deadline can move: runner extends
 * `coolingUntil` on a second hit, and the scheduler is what knows when
 * admissions actually resume.
 */
export function applyRateLimitEvent(
  current: RateLimitNotice | null,
  frame: EventFrame,
): RateLimitNotice | null {
  if (frame.type === 'runner.ratelimited') {
    const payload = frame.payload as Partial<RateLimitNotice> | null;
    if (payload === null || typeof payload !== 'object') return current;
    return {
      until: typeof payload.until === 'string' ? payload.until : '',
      source: typeof payload.source === 'string' ? payload.source : 'observed',
      hint: typeof payload.hint === 'string' ? payload.hint : '',
    };
  }
  if (frame.type === 'runner.queue.changed') {
    const payload = frame.payload as { cooling?: unknown } | null;
    if (payload !== null && typeof payload === 'object' && payload.cooling === false) return null;
  }
  return current;
}

let toastSeq = 0;

export const useAppStore = create<AppState>((set) => ({
  theme: 'system',
  // The app starts out *trying* rather than connected: claiming `live` before a
  // socket has answered is the one lie the indicator must never tell.
  connection: 'reconnecting',
  fleet: EMPTY_FLEET_STATUS,
  clones: NO_CLONES,
  filters: DEFAULT_FILTERS,
  sort: 'board-order',
  quickAddOpen: false,
  reorderMode: false,
  launch: null,
  pair: null,
  toasts: [],
  openQuestions: null,
  rateLimit: null,

  setTheme: (theme) => set({ theme }),
  setConnection: (connection) => set({ connection }),
  ingest: (frame) =>
    set((state) => ({
      fleet: applySessionEvent(state.fleet, frame),
      clones: applyCloneEvent(state.clones, frame),
      rateLimit: applyRateLimitEvent(state.rateLimit, frame),
    })),
  dismissClone: (projectId) =>
    set((state) => {
      const { [projectId]: _gone, ...rest } = state.clones;
      return { clones: rest };
    }),
  setFilters: (patch) => set((state) => ({ filters: { ...state.filters, ...patch } })),
  setSort: (sort) => set({ sort }),
  setQuickAddOpen: (quickAddOpen) => set({ quickAddOpen }),
  setReorderMode: (reorderMode) => set({ reorderMode }),
  openLaunch: (launch) => set({ launch }),
  closeLaunch: () => set({ launch: null }),
  openPair: (pair) => set({ pair }),
  closePair: () => set({ pair: null }),
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
      clones: NO_CLONES,
      filters: DEFAULT_FILTERS,
      sort: 'board-order',
      quickAddOpen: false,
      reorderMode: false,
      launch: null,
      pair: null,
      toasts: [],
      openQuestions: null,
      rateLimit: null,
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
