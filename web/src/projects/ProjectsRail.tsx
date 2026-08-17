/**
 * The projects rail (DESIGN §5.1, §5.3).
 *
 * "Desktop: … a **projects rail** (220px) pinned right. Below the rail: Add
 * project. The rail is not decoration — it is the drop target set (§5.3) and it
 * doubles as the projects list." On a phone it becomes a horizontal scroller;
 * that is a media query, not a second component (§2.3).
 *
 * The status and health chips are **read**, never derived: projects §2.3
 * computes `health` server-side and §3.1 forbids the UI recomputing it. The same
 * rule decides whether a card is a valid drop target — `projectLaunchRefusal`
 * reads `status`, `archivedAt` and the server's `missing` condition, and the
 * card dims and says why rather than accepting a drop that would fail on submit.
 *
 * **Launch an agent…** is §5.4's pointer-free counterpart to dropping here. It
 * lives on the card as well as on the project page (§8.2, M7) because the rail
 * *is* the projects list on a phone, where there is no drag at all.
 */

import { useDroppable } from '@dnd-kit/core';
import { useState, type ReactElement } from 'react';
import { Link } from 'react-router-dom';

import { useProjects } from '../api/queries';
import { failureOf } from '../api/result';
import { projectLaunchRefusal, type Project } from '../api/types';
import { useServices } from '../app/AppContext';
import { Icon } from '../icons/Sprite';
import { useAppStore } from '../state/store';

import { QuickAddDialog } from './QuickAddDialog';

function ProjectRailCard({ project }: { readonly project: Project }): ReactElement {
  const openLaunch = useAppStore((store) => store.openLaunch);
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
      {refusal === undefined ? (
        <button
          type="button"
          className="button project-card__launch"
          onClick={() => openLaunch({ agentId: null, projectId: project.id, origin: 'project' })}
        >
          Launch an agent…
        </button>
      ) : (
        <p className="project-card__refusal">Can’t launch: {refusal}.</p>
      )}
    </li>
  );
}

export function ProjectsRail(): ReactElement {
  const { client } = useServices();
  const projects = useProjects(client);
  const [adding, setAdding] = useState(false);

  return (
    <aside className="rail" aria-labelledby="projects-heading">
      <h2 id="projects-heading">Projects</h2>

      {projects.isError ? (
        <p className="notice" data-tone="danger" role="alert">
          {failureOf(projects.error)?.message ?? 'The project list could not be read.'}
        </p>
      ) : null}

      <ul>
        {(projects.data?.projects ?? []).map((project) => (
          <ProjectRailCard key={project.id} project={project} />
        ))}
      </ul>

      {!projects.isPending && (projects.data?.projects.length ?? 0) === 0 ? (
        <p className="empty">No projects yet — point the app at a folder you already work in.</p>
      ) : null}

      <button
        type="button"
        className="button"
        data-variant="primary"
        onClick={() => setAdding(true)}
      >
        <Icon name="plus" />
        Add project
      </button>

      {adding ? <QuickAddDialog onClose={() => setAdding(false)} /> : null}
    </aside>
  );
}
