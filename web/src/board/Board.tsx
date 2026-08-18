/**
 * The roster board (DESIGN §5.1) — the home screen and the element's centre of
 * gravity.
 *
 * A responsive grid of agent cards, the filter chips above, and the sort control
 * defaulting to board order. The projects rail used to be pinned right; projects
 * are their own destination now (`ProjectsPage`, §2.1), so this screen answers
 * "who do I have" and leaves "what am I pointed at" to `/projects`. What each
 * agent is *currently* on still rides on its own card, which is the half of the
 * old rail's job the board actually needed.
 *
 * M3 makes it the drag surface. The project drop target moved to `/projects`
 * with the cards themselves (§5.3 row 1); what is left here is the pair gesture
 * and reorder, and every gesture still has the non-drag equivalent §5.4
 * requires: the card `⋯` menu for launching and pairing, and an explicit
 * **Reorder** mode with ▲▼ controls that persists **once** when it is left. All
 * of them end in the same two functions — `openLaunch` and `persistBoardOrder`
 * — because "there is no 'mobile launch' and 'desktop launch'".
 */

import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, type ReactElement } from 'react';

import { useServices } from '../app/AppContext';
import { useProjects, useRoster } from '../api/queries';
import { SPECIALTIES } from '../api/types';
import { failureOf } from '../api/result';
import { useAppStore } from '../state/store';

import { AgentCard } from './AgentCard';
import { applyLocalOrder, moveWithin, orderOf, persistBoardOrder } from './boardOrder';
import { BoardDndContext } from './BoardDndContext';
import { agentTarget, type DropOutcome, type DropTarget } from './dnd';
import { diagnosticsForAgent, filterAgents, sortAgents } from './filters';

/** Stable identity, so the ring is not rebuilt on every render. */
const NO_PROJECT_TARGETS: readonly DropTarget[] = [];

export function Board(): ReactElement {
  const { client } = useServices();
  const queryClient = useQueryClient();
  const roster = useRoster(client);
  const projects = useProjects(client);
  const filters = useAppStore((store) => store.filters);
  const setFilters = useAppStore((store) => store.setFilters);
  const sort = useAppStore((store) => store.sort);
  const setSort = useAppStore((store) => store.setSort);
  const fleet = useAppStore((store) => store.fleet);
  const reorderMode = useAppStore((store) => store.reorderMode);
  const setReorderMode = useAppStore((store) => store.setReorderMode);
  const openLaunch = useAppStore((store) => store.openLaunch);
  const openPair = useAppStore((store) => store.openPair);
  const pushToast = useAppStore((store) => store.pushToast);

  const agents = roster.data?.agents ?? [];
  const libraryDiagnostics = roster.data?.diagnostics ?? [];

  const visible = useMemo(
    () => sortAgents(filterAgents(agents, filters, fleet), sort),
    [agents, filters, fleet, sort],
  );

  const projectsById = useMemo(() => {
    const map = new Map<string, string>();
    for (const project of projects.data?.projects ?? []) map.set(project.id, project.name);
    return map;
  }, [projects.data]);

  const agentTargets = useMemo(
    () =>
      visible
        .filter((agent) => agent.archivedAt === null)
        .map((agent) => agentTarget(agent.definition.id, agent.definition.name)),
    [visible],
  );

  /** The whole live roster in board order — what roster §9.5 wants written. */
  const fullOrder = useMemo(
    () =>
      orderOf(
        sortAgents(
          agents.filter((agent) => agent.archivedAt === null),
          'board-order',
        ),
      ),
    [agents],
  );

  const reorderTo = useCallback(
    (agentId: string, overAgentId: string, persist: boolean) => {
      const next = moveWithin(fullOrder, agentId, overAgentId);
      if (next === fullOrder) return;
      if (persist) {
        void persistBoardOrder({ client, queryClient, toast: pushToast }, next);
      } else {
        applyLocalOrder(queryClient, next);
      }
    },
    [client, fullOrder, pushToast, queryClient],
  );

  const onDrop = useCallback(
    (outcome: DropOutcome) => {
      switch (outcome.kind) {
        case 'launch':
          // §5.3: "Nothing is started by the drop itself."
          openLaunch({ agentId: outcome.agentId, projectId: outcome.projectId, origin: 'drag' });
          return;
        case 'pair':
          // §5.3 row 3: the dragged card takes the drafting seat, the card it
          // was dropped on takes the critic seat. Nothing starts here either.
          openPair({ agentId: outcome.agentId, withAgentId: outcome.withAgentId });
          return;
        case 'reorder':
          reorderTo(outcome.agentId, outcome.overAgentId, true);
          return;
        case 'refused':
          pushToast(`${outcome.reason} Nothing was started.`);
          return;
        case 'none':
          return;
      }
    },
    [openLaunch, openPair, pushToast, reorderTo],
  );

  const move = useCallback(
    (agentId: string, delta: -1 | 1) => {
      const index = fullOrder.indexOf(agentId);
      const neighbour = fullOrder[index + delta];
      if (neighbour === undefined) return;
      reorderTo(agentId, neighbour, false);
    },
    [fullOrder, reorderTo],
  );

  /** §5.4: "leaving the mode persists **once**." */
  const leaveReorderMode = useCallback(() => {
    setReorderMode(false);
    void persistBoardOrder({ client, queryClient, toast: pushToast }, fullOrder);
  }, [client, fullOrder, pushToast, queryClient, setReorderMode]);

  return (
    <BoardDndContext
      agentTargets={agentTargets}
      // Projects live on `/projects` now, so the board has no project drop
      // target: §5.3 row 1 moved there with them, agent chips and all.
      projectTargets={NO_PROJECT_TARGETS}
      reordering={reorderMode}
      onDrop={onDrop}
    >
      <div className="board">
        <section aria-labelledby="board-heading">
          <h2 id="board-heading" className="visually-hidden">
            Roster
          </h2>

          <div className="board__filters" role="group" aria-label="Filters">
            <label className="chip">
              <span className="visually-hidden">Specialty</span>
              <select
                aria-label="Specialty"
                value={filters.specialty ?? ''}
                onChange={(event) =>
                  setFilters({ specialty: event.target.value === '' ? null : event.target.value })
                }
              >
                <option value="">All specialties</option>
                {SPECIALTIES.map((specialty) => (
                  <option key={specialty} value={specialty}>
                    {specialty}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="chip"
              aria-pressed={filters.workingNow}
              onClick={() => setFilters({ workingNow: !filters.workingNow })}
            >
              Working now
            </button>
            <button
              type="button"
              className="chip"
              aria-pressed={filters.needsAttention}
              onClick={() => setFilters({ needsAttention: !filters.needsAttention })}
            >
              Needs attention
            </button>
            <button
              type="button"
              className="chip"
              aria-pressed={filters.archived}
              onClick={() => setFilters({ archived: !filters.archived })}
            >
              Archived
            </button>
            <label className="chip">
              <span className="visually-hidden">Sort</span>
              <select
                aria-label="Sort"
                value={sort}
                onChange={(event) => {
                  const value = event.target.value;
                  if (value === 'board-order' || value === 'name' || value === 'recent') {
                    setSort(value);
                  }
                }}
              >
                <option value="board-order">Board order</option>
                <option value="name">Name</option>
                <option value="recent">Recently used</option>
              </select>
            </label>
            {/* §5.4's pointer-free path to board order. */}
            <button
              type="button"
              className="chip"
              aria-pressed={reorderMode}
              onClick={() => {
                if (reorderMode) leaveReorderMode();
                else {
                  // Reordering a filtered or re-sorted board would write an order
                  // for a list the user is not looking at.
                  setSort('board-order');
                  setReorderMode(true);
                }
              }}
            >
              {reorderMode ? 'Done reordering' : 'Reorder'}
            </button>
          </div>

          {/*
          §2.3: a roster diagnostic must show "and the rest of the board still
          renders". Library-wide diagnostics that name no agent belong here,
          because there is no card to hang them on — an `agent.json` too broken
          to parse has no agent to be a badge of.
        */}
          {libraryDiagnostics
            .filter((diagnostic) => diagnostic.agentId === undefined)
            .map((diagnostic, index) => (
              <p
                key={`${diagnostic.code}-${String(index)}`}
                className="notice"
                data-tone={diagnostic.level === 'error' ? 'danger' : 'warn'}
                data-diagnostic-code={diagnostic.code}
              >
                {diagnostic.message}
              </p>
            ))}

          {roster.isPending ? <p className="empty">Loading the roster…</p> : null}

          {roster.isError ? (
            <p className="notice" data-tone="danger" role="alert">
              {failureOf(roster.error)?.message ?? 'The roster could not be read.'}
            </p>
          ) : null}

          {!roster.isPending && visible.length === 0 ? (
            <p className="empty">
              {filters.archived
                ? 'No archived agents.'
                : 'No agents yet — describe someone in a sentence and Claude will draft them.'}
            </p>
          ) : null}

          <ul className="card-grid">
            {visible.map((agent) => {
              const status = fleet[agent.definition.id];
              const projectName =
                status?.projectId === undefined || status.projectId === null
                  ? undefined
                  : projectsById.get(status.projectId);
              const position = fullOrder.indexOf(agent.definition.id);
              return (
                <AgentCard
                  key={agent.definition.id}
                  agent={agent}
                  diagnostics={diagnosticsForAgent(libraryDiagnostics, agent.definition.id)}
                  projectName={projectName}
                  reorder={
                    reorderMode && position !== -1
                      ? {
                          position: position + 1,
                          total: fullOrder.length,
                          onMove: (delta) => move(agent.definition.id, delta),
                        }
                      : undefined
                  }
                />
              );
            })}
          </ul>
        </section>
      </div>
    </BoardDndContext>
  );
}
