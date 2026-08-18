/**
 * The projects screen (DESIGN §2.1, §5.1, §5.3) — `/projects`.
 *
 * Projects used to ride along on the board as a 220px rail. They are their own
 * destination now: a full-width grid of project cards with **Add project**
 * above it, which is the only place that answers "what am I pointed at" without
 * competing with the roster for the same screen.
 *
 * Moving them off the board would have cost §5.3 row 1 — an agent dropped on a
 * project opens the launch flow — because a drop target needs a drag source on
 * the same screen. So this page carries the same compact strip of draggable
 * agent chips the project page already uses for its work-item rows (§8.2 region
 * 4), for exactly the reason stated there: "A drop target with no drag source on
 * the same screen is not a feature." The gesture survives the move; only the
 * screen it lives on changed.
 *
 * The status and health chips are **read**, never derived: projects §2.3
 * computes `health` server-side and §3.1 forbids the UI recomputing it. The same
 * rule decides whether a card is a valid drop target — `projectLaunchRefusal`
 * reads `status`, `archivedAt` and the server's `missing` condition, and the
 * card dims and says why rather than accepting a drop that would fail on submit.
 *
 * **Start work…** is §5.4's pointer-free counterpart to dropping here. It lives
 * on the card as well as on the project page (§8.2, M7) because there is no drag
 * at all on a phone. It replaces the pair of buttons this card used to carry —
 * "Launch an agent…" and "Start a pair…" — because how many agents work on
 * something is a question §6 now asks *inside* the flow, after the project and
 * the task, rather than one the card makes the user answer first.
 */

import { useDraggable, useDroppable } from '@dnd-kit/core';
import { useCallback, useMemo, useState, type ReactElement } from 'react';
import { Link } from 'react-router-dom';

import { useProjects, useRoster } from '../api/queries';
import { failureOf } from '../api/result';
import { projectLaunchRefusal, type Project } from '../api/types';
import { useServices } from '../app/AppContext';
import { BoardDndContext } from '../board/BoardDndContext';
import { agentTarget, projectTarget, type DropOutcome } from '../board/dnd';
import { Icon } from '../icons/Sprite';
import { useAppStore } from '../state/store';

import { cloneProgressLabel } from './clone';
import { QuickAddDialog } from './QuickAddDialog';

function ProjectCard({ project }: { readonly project: Project }): ReactElement {
  const openStartWork = useAppStore((store) => store.openStartWork);
  const clone = useAppStore((store) => store.clones[project.id]);
  const refusal = projectLaunchRefusal(project);
  const { setNodeRef, isOver } = useDroppable({
    id: project.id,
    data: { type: 'project', projectId: project.id },
  });

  return (
    <li
      ref={setNodeRef}
      className="project-card"
      data-project-id={project.id}
      data-drop-refused={refusal === undefined ? 'false' : 'true'}
      data-over={isOver ? 'true' : 'false'}
      // §5.3: "it dims during the drag and its tooltip says why".
      title={refusal === undefined ? undefined : `${project.name} is ${refusal}.`}
    >
      <Link className="project-card__name" to={`/projects/${encodeURIComponent(project.id)}`}>
        {project.name}
      </Link>
      <div className="project-card__path">{project.localPath}</div>
      <div className="agent-card__badges">
        <span className="badge" data-status={project.status}>
          {project.status}
        </span>
        {project.health.map((condition) => (
          <span
            key={condition.code}
            className="badge"
            data-tone={condition.level === 'error' ? 'danger' : 'warn'}
            title={condition.message}
          >
            {condition.code}
          </span>
        ))}
      </div>
      {/*
        §8.1: the clone's progress lives on the card, not in the dialog that
        started it — which is what makes "the dialog can be dismissed" true.
      */}
      {clone === undefined ? null : clone.state === 'failed' ? (
        <p className="notice" data-tone="danger" role="alert" data-clone-state="failed">
          {/* git's own message, verbatim: the credential helper is the user's
              and paraphrasing an auth failure hides the fix (§8.1). */}
          <code>{clone.stderr ?? 'git gave no output.'}</code>
        </p>
      ) : (
        <p className="project-card__clone" data-clone-state="running">
          <progress
            aria-label={`Cloning ${project.name}`}
            {...(clone.percent === null ? {} : { value: clone.percent, max: 100 })}
          />
          <span>{cloneProgressLabel(clone)}</span>
        </p>
      )}

      {refusal === undefined ? (
        <div className="project-card__actions">
          <button
            type="button"
            className="button project-card__launch"
            onClick={() =>
              openStartWork({ agentIds: [], projectId: project.id, origin: 'project' })
            }
          >
            Start work…
          </button>
        </div>
      ) : (
        <p className="project-card__refusal">Can’t launch: {refusal}.</p>
      )}
    </li>
  );
}

/** The drag source for §5.3 row 1 — see the file header. */
function AgentChip({ id, name }: { readonly id: string; readonly name: string }): ReactElement {
  const { attributes, listeners, setNodeRef } = useDraggable({
    id,
    data: { type: 'agent', agentId: id },
  });
  return (
    <li>
      <button
        type="button"
        className="chip"
        ref={setNodeRef}
        aria-label={`Launch ${name} on a project`}
        {...listeners}
        {...attributes}
      >
        {name}
      </button>
    </li>
  );
}

export function ProjectsPage(): ReactElement {
  const { client } = useServices();
  const projects = useProjects(client);
  const roster = useRoster(client);
  const openStartWork = useAppStore((store) => store.openStartWork);
  const pushToast = useAppStore((store) => store.pushToast);
  const [adding, setAdding] = useState(false);

  const agents = useMemo(
    () => (roster.data?.agents ?? []).filter((agent) => agent.archivedAt === null),
    [roster.data],
  );

  const agentTargets = useMemo(
    () => agents.map((agent) => agentTarget(agent.definition.id, agent.definition.name)),
    [agents],
  );
  const projectTargets = useMemo(
    () => (projects.data?.projects ?? []).map(projectTarget),
    [projects.data],
  );

  const onDrop = useCallback(
    (outcome: DropOutcome) => {
      switch (outcome.kind) {
        case 'launch':
          // §5.3: "Nothing is started by the drop itself."
          openStartWork({
            agentIds: [outcome.agentId],
            projectId: outcome.projectId,
            origin: 'drag',
          });
          return;
        case 'refused':
          pushToast(`${outcome.reason} Nothing was started.`);
          return;
        // No board to reorder and no agent card to pair with: the chips are a
        // drag source and nothing else here.
        case 'pair':
        case 'launch-work-item':
        case 'reorder':
        case 'none':
          return;
      }
    },
    [openStartWork, pushToast],
  );

  const list = projects.data?.projects ?? [];

  return (
    <BoardDndContext
      // The chips are a drag source and nothing else here (see `onDrop`), so an
      // agent is never a target.
      agentTargets={[]}
      dragSources={agentTargets}
      projectTargets={projectTargets}
      onDrop={onDrop}
    >
      <section className="projects-page" aria-labelledby="projects-heading">
        <div className="projects-page__header">
          <h2 id="projects-heading">Projects</h2>
          <button
            type="button"
            className="button"
            data-variant="primary"
            onClick={() => setAdding(true)}
          >
            <Icon name="plus" />
            Add project
          </button>
        </div>

        {projects.isError ? (
          <p className="notice" data-tone="danger" role="alert">
            {failureOf(projects.error)?.message ?? 'The project list could not be read.'}
          </p>
        ) : null}

        {projects.isPending ? <p className="empty">Loading the projects…</p> : null}

        {/* The drag source for §5.3 row 1 — see the file header. */}
        {agentTargets.length === 0 || list.length === 0 ? null : (
          <div className="project-agent-strip">
            <p id="projects-strip-hint">
              Drag an agent onto a project, or use its Start work… button.
            </p>
            <ul aria-labelledby="projects-strip-hint">
              {agents.map((agent) => (
                <AgentChip
                  key={agent.definition.id}
                  id={agent.definition.id}
                  name={agent.definition.name}
                />
              ))}
            </ul>
          </div>
        )}

        <ul className="project-grid">
          {list.map((project) => (
            <ProjectCard key={project.id} project={project} />
          ))}
        </ul>

        {!projects.isPending && list.length === 0 ? (
          <p className="empty">No projects yet — point the app at a folder you already work in.</p>
        ) : null}

        {/*
          Over a scrim, like the launch flow and the pattern dialog (§8.1). The
          markup already claims `aria-modal`; without the scrim it was claiming
          it while sitting in the page flow, and `.dialog::backdrop` never
          applied because this is not a native `<dialog>`.
        */}
        {adding ? (
          <div className="dialog-scrim">
            <QuickAddDialog onClose={() => setAdding(false)} />
          </div>
        ) : null}
      </section>
    </BoardDndContext>
  );
}
