/**
 * The roster board (DESIGN §5.1) — the home screen and the element's centre of
 * gravity.
 *
 * A responsive grid of agent cards with the projects rail pinned right, the
 * filter chips above, and the sort control defaulting to board order. The rail
 * is not decoration: it doubles as the projects list, so one screen answers
 * "who do I have" and "what are they pointed at".
 *
 * Drag and drop is M3. What is here is the read-first half plus the smallest
 * path to having something to launch against.
 */

import { useMemo, type ReactElement } from 'react';

import { useServices } from '../app/AppContext';
import { useProjects, useRoster } from '../api/queries';
import { SPECIALTIES } from '../api/types';
import { failureOf } from '../api/result';
import { ProjectsRail } from '../projects/ProjectsRail';
import { useAppStore } from '../state/store';

import { AgentCard } from './AgentCard';
import { diagnosticsForAgent, filterAgents, sortAgents } from './filters';

export function Board(): ReactElement {
  const { client } = useServices();
  const roster = useRoster(client);
  const projects = useProjects(client);
  const filters = useAppStore((store) => store.filters);
  const setFilters = useAppStore((store) => store.setFilters);
  const sort = useAppStore((store) => store.sort);
  const setSort = useAppStore((store) => store.setSort);
  const fleet = useAppStore((store) => store.fleet);

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

  return (
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
            return (
              <AgentCard
                key={agent.definition.id}
                agent={agent}
                diagnostics={diagnosticsForAgent(libraryDiagnostics, agent.definition.id)}
                projectName={projectName}
              />
            );
          })}
        </ul>
      </section>

      <ProjectsRail />
    </div>
  );
}
