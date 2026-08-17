/**
 * The project page (DESIGN §8.2) — four regions, in priority order.
 *
 * 1. **Header** — name, path, branch, vcs, `status`, the server's health chips,
 *    **Launch an agent…**, and **Relocate** when the folder is `missing`.
 * 2. **Review needed** — retained worktrees. "Projects never discards agent
 *    output (§4.4), so the UI never makes cleanup one click": every Clean up is
 *    behind a confirmation that names the branch.
 * 3. **Activity timeline** — grouped by assignment, newest first. Every value
 *    here is **read**: `outcome` is projects §3.1's projection and §4 forbids
 *    recomputing it, and `transcriptAvailable` decides between a link and the
 *    words "transcript pruned" — never a dead link.
 * 4. **Work items** — the thin ranked list, inline-creatable, ▲▼-reorderable,
 *    and each row a drop target for an agent (§5.3 row 2).
 *
 * Plus the collapsed **Settings**, whose one hard rule is §8.2's: env entries are
 * shown "as `secretRef` names with a set/unset indicator, **never values**". That
 * rule is enforced in the type layer (`envEntryView`), not by the discipline of
 * this file — no component here is ever handed a value to print.
 *
 * ### The one addition this file makes to §8.2's four regions
 *
 * §5.3 makes a work-item row a drop target for an agent, and §8.2 lists four
 * regions, none of which is a roster. A drop target with no drag source on the
 * same screen is not a feature, so region 4 carries a compact strip of draggable
 * agent chips above the list, labelled with what it is for. It is the smallest
 * thing that makes the gesture reachable; the pointer-free equivalent §5.4
 * requires — the row's **Assign an agent…** — is beside every row regardless.
 */

import { useDraggable, useDroppable } from '@dnd-kit/core';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useState, type ReactElement } from 'react';
import { Link, useParams } from 'react-router-dom';

import {
  queryKeys,
  useProject,
  useProjectActivity,
  useRoster,
  useWorkItems,
  useWorkspaces,
} from '../api/queries';
import { failureOf } from '../api/result';
import {
  envEntryView,
  projectLaunchRefusal,
  type ProjectActivityEntry,
  type ProjectDetail,
  type WorkItem,
  type WorkspaceListEntry,
} from '../api/types';
import { useServices } from '../app/AppContext';
import { BoardDndContext } from '../board/BoardDndContext';
import { agentTarget, projectTarget, workItemTarget, type DropOutcome } from '../board/dnd';
import { useAppStore } from '../state/store';

import { groupByStatus, rankForMove } from './workItems';

export function ProjectPage(): ReactElement {
  const { id = '' } = useParams();
  const { client } = useServices();
  const queryClient = useQueryClient();
  const project = useProject(client, id);
  const roster = useRoster(client);
  const workItems = useWorkItems(client, id);
  const openLaunch = useAppStore((store) => store.openLaunch);
  const pushToast = useAppStore((store) => store.pushToast);

  const items = workItems.data?.workItems ?? [];
  const agents = useMemo(
    () => (roster.data?.agents ?? []).filter((agent) => agent.archivedAt === null),
    [roster.data],
  );

  const agentTargets = useMemo(
    () => agents.map((agent) => agentTarget(agent.definition.id, agent.definition.name)),
    [agents],
  );
  const projectTargets = useMemo(
    () => (project.data === undefined ? [] : [projectTarget(project.data)]),
    [project.data],
  );
  const itemTargets = useMemo(() => items.map((item) => workItemTarget(item)), [items]);

  const onDrop = useCallback(
    (outcome: DropOutcome) => {
      switch (outcome.kind) {
        case 'launch':
          openLaunch({ agentId: outcome.agentId, projectId: outcome.projectId, origin: 'drag' });
          return;
        case 'launch-work-item':
          openLaunch({
            agentId: outcome.agentId,
            projectId: outcome.projectId,
            origin: 'work-item',
            workItemIds: [outcome.workItemId],
          });
          return;
        case 'refused':
          pushToast(`${outcome.reason} Nothing was started.`);
          return;
        // A board reorder has no meaning here: there is no board.
        case 'reorder':
        case 'none':
          return;
      }
    },
    [openLaunch, pushToast],
  );

  if (project.isError) {
    return (
      <section>
        <h2>Project</h2>
        <p className="notice" data-tone="danger" role="alert">
          {failureOf(project.error)?.message ?? 'That project could not be read.'}
        </p>
      </section>
    );
  }

  if (project.data === undefined) {
    return (
      <section>
        <h2>Project</h2>
        <p className="empty">Loading the project…</p>
      </section>
    );
  }

  const detail = project.data;

  return (
    <BoardDndContext
      // The chips are a drag source and nothing else here: there is no board to
      // reorder, so an agent is never a target.
      agentTargets={[]}
      dragSources={agentTargets}
      projectTargets={projectTargets}
      workItemTargets={itemTargets}
      onDrop={onDrop}
    >
      <div className="project-page">
        <ProjectHeader project={detail} />
        <ReviewNeeded projectId={id} />
        <Timeline projectId={id} />
        <WorkItems
          projectId={id}
          items={items}
          agents={agents.map((agent) => ({
            id: agent.definition.id,
            name: agent.definition.name,
          }))}
          onChanged={() =>
            void queryClient.invalidateQueries({ queryKey: queryKeys.workItems(id) })
          }
        />
        <ProjectSettings project={detail} />
      </div>
    </BoardDndContext>
  );
}

// ---------------------------------------------------------------------------
// 1 — Header
// ---------------------------------------------------------------------------

function ProjectHeader({ project }: { readonly project: ProjectDetail }): ReactElement {
  const { client } = useServices();
  const queryClient = useQueryClient();
  const openLaunch = useAppStore((store) => store.openLaunch);
  const [relocating, setRelocating] = useState(false);
  const [newPath, setNewPath] = useState('');
  const [failure, setFailure] = useState<string | undefined>();
  const refusal = projectLaunchRefusal(project);
  const missing = project.health.some((condition) => condition.code === 'missing');

  async function relocate(): Promise<void> {
    setFailure(undefined);
    const result = await client.request(`/projects/${encodeURIComponent(project.id)}/relocate`, {
      method: 'POST',
      body: { localPath: newPath },
    });
    if (result.kind === 'ok') {
      setRelocating(false);
      // The id is unchanged — projects re-canonicalises the same row onto the
      // new folder (§2.3), so the activity timeline below is still this
      // project's history and does not need reloading from a different id.
      await queryClient.invalidateQueries({ queryKey: ['projects'] });
    } else {
      setFailure(result.message);
    }
  }

  return (
    <header className="project-header">
      <h2>{project.name}</h2>
      <p className="project-card__path">{project.localPath}</p>
      <div className="agent-card__badges">
        <span className="badge" data-status={project.status}>
          {project.status}
        </span>
        <span className="badge">{project.vcs}</span>
        {project.defaultBranch === null ? null : (
          <span className="badge">{project.defaultBranch}</span>
        )}
        {/* Health is computed server-side (projects §2.3) and read here (§4). */}
        {project.health.map((condition) => (
          <span
            key={condition.code}
            className="badge"
            data-health={condition.code}
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
          className="button"
          data-variant="primary"
          onClick={() => openLaunch({ agentId: null, projectId: project.id, origin: 'project' })}
        >
          Launch an agent…
        </button>
      ) : (
        <p className="project-card__refusal">Can’t launch: {refusal}.</p>
      )}

      {missing ? (
        relocating ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void relocate();
            }}
          >
            <div className="field">
              <label htmlFor="relocate-path">New folder path</label>
              <input
                id="relocate-path"
                value={newPath}
                placeholder="C:\Code\my-app"
                onChange={(event) => setNewPath(event.target.value)}
              />
            </div>
            <button type="submit" className="button" data-variant="primary">
              Relocate
            </button>
            {failure === undefined ? null : (
              <p className="notice" data-tone="danger" role="alert">
                {failure}
              </p>
            )}
          </form>
        ) : (
          <button type="button" className="button" onClick={() => setRelocating(true)}>
            Relocate
          </button>
        )
      ) : null}
    </header>
  );
}

// ---------------------------------------------------------------------------
// 2 — Review needed
// ---------------------------------------------------------------------------

function ReviewNeeded({ projectId }: { readonly projectId: string }): ReactElement | null {
  const { client } = useServices();
  const queryClient = useQueryClient();
  const workspaces = useWorkspaces(client, projectId);
  const [confirming, setConfirming] = useState<WorkspaceListEntry | undefined>();

  // §4.4: a worktree is "review needed" only when the server says it is retained
  // with something on it. A clean worktree never appears here.
  const retained = (workspaces.data?.workspaces ?? []).filter(
    (entry) => entry.review !== undefined && (entry.review.commits > 0 || entry.review.dirty),
  );
  if (retained.length === 0) return null;

  async function cleanUp(entry: WorkspaceListEntry): Promise<void> {
    await client.request(
      `/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(entry.id)}/cleanup`,
      { method: 'POST' },
    );
    setConfirming(undefined);
    await queryClient.invalidateQueries({ queryKey: queryKeys.workspaces(projectId) });
  }

  return (
    <section aria-labelledby="review-heading" className="project-review">
      <h3 id="review-heading">Review needed</h3>
      <ul>
        {retained.map((entry) => (
          <li key={entry.id} data-workspace-id={entry.id}>
            <strong>{entry.branch ?? entry.path}</strong>
            <span>
              {' '}
              {entry.review?.commits ?? 0} commit
              {(entry.review?.commits ?? 0) === 1 ? '' : 's'}
              {entry.review?.dirty === true ? ' · uncommitted changes' : ''}
            </span>
            <button type="button" className="button" onClick={() => setConfirming(entry)}>
              Clean up
            </button>
          </li>
        ))}
      </ul>

      {confirming === undefined ? null : (
        <div className="dialog" role="dialog" aria-modal="true" aria-label="Clean up worktree">
          {/* Named, always: projects never discards agent output on its own, so
              the user has to be able to see which branch they are throwing out. */}
          <p>
            Remove the worktree on <strong>{confirming.branch ?? confirming.path}</strong>? Its{' '}
            {confirming.review?.commits ?? 0} commit
            {(confirming.review?.commits ?? 0) === 1 ? '' : 's'} will go with it.
          </p>
          <button type="button" className="button" onClick={() => setConfirming(undefined)}>
            Keep it
          </button>
          <button
            type="button"
            className="button"
            data-variant="primary"
            onClick={() => void cleanUp(confirming)}
          >
            Remove {confirming.branch ?? 'the worktree'}
          </button>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// 3 — Activity timeline
// ---------------------------------------------------------------------------

function Timeline({ projectId }: { readonly projectId: string }): ReactElement {
  const { client } = useServices();
  const activity = useProjectActivity(client, projectId);
  const entries = activity.data?.entries ?? [];

  return (
    <section aria-labelledby="activity-heading" className="project-activity">
      <h3 id="activity-heading">Activity</h3>
      {entries.length === 0 ? (
        <p className="empty">Nothing has run here yet.</p>
      ) : (
        <ul>
          {entries.map((entry) => (
            <TimelineEntry key={entry.assignmentId} entry={entry} />
          ))}
        </ul>
      )}
    </section>
  );
}

function TimelineEntry({ entry }: { readonly entry: ProjectActivityEntry }): ReactElement {
  return (
    <li data-assignment-id={entry.assignmentId}>
      <div className="agent-card__badges">
        {/* Read, never derived (projects §3.1, ui §4). */}
        <span className="badge" data-outcome={entry.outcome}>
          {entry.outcome}
        </span>
        <span className="badge">{entry.pattern ?? 'solo'}</span>
        {entry.workspace === null ? null : (
          <span className="badge" data-workspace-kind={entry.workspace.kind}>
            {entry.workspace.kind}
            {entry.workspace.branch === null ? '' : ` · ${entry.workspace.branch}`}
          </span>
        )}
        <span className="badge">{entry.tokens.input + entry.tokens.output} tokens</span>
      </div>
      <Link to={`/assignments/${encodeURIComponent(entry.assignmentId)}`}>
        {entry.scopeSummary ?? 'whole project'}
      </Link>
      <ul>
        {entry.sessions.map((session) => (
          <li key={session.id} data-session-id={session.id}>
            <span className="badge" data-status={session.status}>
              {session.status}
            </span>
            <span>{session.summary ?? 'no summary'}</span>
            {session.transcriptAvailable ? (
              <Link to={`/sessions/${encodeURIComponent(session.id)}`}>transcript</Link>
            ) : (
              // §8.2: "says 'transcript pruned' rather than offering a dead link".
              <span data-transcript="pruned">transcript pruned</span>
            )}
            {session.pinned ? <span className="badge">pinned</span> : null}
          </li>
        ))}
      </ul>
    </li>
  );
}

// ---------------------------------------------------------------------------
// 4 — Work items
// ---------------------------------------------------------------------------

interface WorkItemsProps {
  readonly projectId: string;
  readonly items: readonly WorkItem[];
  readonly agents: readonly { readonly id: string; readonly name: string }[];
  readonly onChanged: () => void;
}

function WorkItems({ projectId, items, agents, onChanged }: WorkItemsProps): ReactElement {
  const { client } = useServices();
  const [title, setTitle] = useState('');
  const groups = groupByStatus(items);

  async function create(): Promise<void> {
    if (title.trim() === '') return;
    await client.request(`/projects/${encodeURIComponent(projectId)}/work-items`, {
      method: 'POST',
      // "title only is enough" (§8.2).
      body: { title: title.trim() },
    });
    setTitle('');
    onChanged();
  }

  async function move(item: WorkItem, delta: -1 | 1): Promise<void> {
    const ordered = groups.find((group) => group.status === item.status)?.items ?? [];
    const rank = rankForMove(ordered, item.id, delta);
    if (rank === undefined) return;
    await client.request(`/work-items/${encodeURIComponent(item.id)}`, {
      method: 'PATCH',
      body: { rank },
    });
    onChanged();
  }

  return (
    <section aria-labelledby="work-items-heading" className="project-work-items">
      <h3 id="work-items-heading">Work items</h3>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <div className="field">
          <label htmlFor="work-item-title">New work item</label>
          <input
            id="work-item-title"
            value={title}
            placeholder="What needs doing?"
            onChange={(event) => setTitle(event.target.value)}
          />
        </div>
        <button type="submit" className="button">
          Add
        </button>
      </form>

      {/* The drag source for §5.3 row 2 — see the file header. */}
      {agents.length === 0 ? null : (
        <div className="project-agent-strip">
          <p id="agent-strip-hint">
            Drag an agent onto an item, or use its Assign an agent… button.
          </p>
          <ul aria-labelledby="agent-strip-hint">
            {agents.map((agent) => (
              <AgentChip key={agent.id} id={agent.id} name={agent.name} />
            ))}
          </ul>
        </div>
      )}

      {groups.length === 0 ? <p className="empty">No work items yet.</p> : null}

      {groups.map((group) => (
        <div key={group.status}>
          <h4>{group.status.replace('_', ' ')}</h4>
          <ul>
            {group.items.map((item, index) => (
              <WorkItemRow
                key={item.id}
                item={item}
                position={index + 1}
                total={group.items.length}
                onMove={(delta) => void move(item, delta)}
              />
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

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
        aria-label={`Launch ${name} on a work item`}
        {...listeners}
        {...attributes}
      >
        {name}
      </button>
    </li>
  );
}

interface WorkItemRowProps {
  readonly item: WorkItem;
  readonly position: number;
  readonly total: number;
  readonly onMove: (delta: -1 | 1) => void;
}

function WorkItemRow({ item, position, total, onMove }: WorkItemRowProps): ReactElement {
  const openLaunch = useAppStore((store) => store.openLaunch);
  const { setNodeRef, isOver } = useDroppable({
    id: item.id,
    data: { type: 'workItem', workItemId: item.id, projectId: item.projectId },
  });

  return (
    <li
      ref={setNodeRef}
      data-work-item-id={item.id}
      data-status={item.status}
      data-over={isOver ? 'true' : 'false'}
    >
      <span>{item.title}</span>
      <span className="badge" data-status={item.status}>
        {item.status}
      </span>
      {item.scopePaths.length === 0 ? null : (
        <span className="badge" data-scope="paths">
          {item.scopePaths.join(', ')}
        </span>
      )}

      {/* §5.4's pointer-free equivalent of the drop. */}
      <button
        type="button"
        className="button"
        onClick={() =>
          openLaunch({
            agentId: null,
            projectId: item.projectId,
            origin: 'work-item',
            workItemIds: [item.id],
          })
        }
      >
        Assign an agent…
      </button>

      <span className="visually-hidden">
        Position {position} of {total}
      </span>
      <button type="button" aria-label={`Move ${item.title} up`} onClick={() => onMove(-1)}>
        ▲
      </button>
      <button type="button" aria-label={`Move ${item.title} down`} onClick={() => onMove(1)}>
        ▼
      </button>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Settings (collapsed)
// ---------------------------------------------------------------------------

function ProjectSettings({ project }: { readonly project: ProjectDetail }): ReactElement {
  const defaults = project.defaults;
  const env = (defaults.env ?? []).map(envEntryView);

  return (
    <details className="project-settings">
      <summary>Settings</summary>
      <dl className="debug-panel">
        <dt>Default agents</dt>
        <dd>{(defaults.agentIds ?? []).join(', ') || 'none'}</dd>
        <dt>Permission override</dt>
        <dd>
          {defaults.permissions === undefined
            ? 'none'
            : `${defaults.permissions.mode ?? 'inherit'} · ${String(
                (defaults.permissions.allow ?? []).length,
              )} allow · ${String((defaults.permissions.deny ?? []).length)} deny`}
        </dd>
        <dt>Permission elevation</dt>
        <dd>
          {defaults.permissionElevation === undefined ? (
            'none'
          ) : (
            <>
              {defaults.permissionElevation.allow.join(', ')}
              {' — '}
              <em>{defaults.permissionElevation.reason}</em>
            </>
          )}
        </dd>
        <dt>Setup command</dt>
        <dd>{defaults.setupCommand ?? 'none'}</dd>
        <dt>Instructions</dt>
        <dd>{defaults.instructionsPath ?? 'none'}</dd>
        <dt>Workspace policy</dt>
        <dd>{project.workspacePolicy}</dd>
        <dt>Retention</dt>
        <dd>
          {project.retention === null
            ? 'inherits the global settings'
            : `${String(project.retention.transcriptDays)} days · ${String(
                project.retention.transcriptCapMb,
              )} MB · ${project.retention.keepPinned ? 'keeps pinned' : 'prunes pinned'}`}
        </dd>
      </dl>

      <h4>Environment</h4>
      {env.length === 0 ? (
        <p className="empty">No project environment entries.</p>
      ) : (
        <ul>
          {env.map((entry) => (
            <li key={entry.name} data-env-name={entry.name}>
              <code>{entry.name}</code>{' '}
              {/*
                §8.2: "secret refs shown as `secretRef` names with a set/unset
                indicator, never values". `envEntryView` never hands a value
                over, so there is none to print here even by accident.

                The indicator says whether the *project declares* something, not
                whether foundation's secret store resolves it: nothing serves
                per-project credential status the way roster serves it per agent
                (`{ secretRef, resolved }`, roster §10), and claiming resolution
                from a declaration would be a badge that is wrong in the
                reassuring direction.
              */}
              <span data-env-state={entry.set ? 'set' : 'unset'}>
                {entry.secretRef === null
                  ? entry.set
                    ? 'a value is stored in the project row — never shown here'
                    : 'no value'
                  : `from the secret ${entry.secretRef} — never shown here`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}
