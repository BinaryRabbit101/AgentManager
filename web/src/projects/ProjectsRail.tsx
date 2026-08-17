/**
 * The projects rail (DESIGN §5.1).
 *
 * "Desktop: … a **projects rail** (220px) pinned right. Below the rail: Add
 * project. The rail is not decoration — it is the drop target set (§5.3) and it
 * doubles as the projects list." On a phone it becomes a horizontal scroller;
 * that is a media query, not a second component (§2.3).
 *
 * The status and health chips are **read**, never derived: projects §2.3
 * computes `health` server-side and §3.1 forbids the UI recomputing it.
 */

import { useState, type ReactElement } from 'react';
import { Link } from 'react-router-dom';

import { useProjects } from '../api/queries';
import { failureOf } from '../api/result';
import { useServices } from '../app/AppContext';
import { Icon } from '../icons/Sprite';

import { QuickAddDialog } from './QuickAddDialog';

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
          <li key={project.id} className="project-card" data-project-id={project.id}>
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
          </li>
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
