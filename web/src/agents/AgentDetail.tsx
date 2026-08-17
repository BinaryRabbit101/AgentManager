/**
 * The agent detail page (DESIGN §7.2, §7.3).
 *
 * > "The same editor plus: session history for that agent, diagnostics, the
 * > effective-permissions preview against a chosen project, the remote grant with
 * > its expiry, and Archive/Export."
 *
 * Duplicate lands here too, on the returned definition, with the "cloned from"
 * line and the shared-credentials note — roster §9.2 makes integrations point at
 * the *same* credentials, which is true and a surprise if unstated.
 *
 * Two rules govern the destructive half:
 *
 * - **Archive confirms with what is retained**, because "history and transcripts
 *   are kept; the id is never reused" is the fact that makes archiving safe to
 *   click, and an unlabelled confirm dialog is a coin toss.
 * - **Purge is offered only when no session references the agent** (§7.3). The
 *   session list for the agent is the same fact roster's own purge check reads,
 *   so the button is absent for exactly the agents roster would refuse — and
 *   roster still refuses, because a client-side check is an affordance and not a
 *   guard.
 *
 * The remote grant is §13.2's control and belongs to M10 with the rest of the
 * remote screen; the module is feature-detected here (§3.5) so nothing is probed.
 */

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactElement } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { ConfirmDialog } from '../a11y/ConfirmDialog';
import { queryKeys, useAgent, useAgentSessions, useProjects } from '../api/queries';
import { failureOf, type ApiFailure } from '../api/result';
import type { AgentView, RemoveAgentResult } from '../api/types';
import { useServices } from '../app/AppContext';
import { fetchPermissionPreview, type PermissionPreview } from '../launch/permissionPreview';

import { AgentEditor } from './AgentEditor';
import { fromAgent, toCreateBody, type EditorModel } from './editorModel';

export function AgentDetail(): ReactElement {
  const { id = '' } = useParams();
  const { client } = useServices();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const agent = useAgent(client, id);
  const sessions = useAgentSessions(client, id);

  const [model, setModel] = useState<EditorModel | undefined>();
  /** Which agent the form currently holds — Duplicate navigates between two. */
  const [loadedId, setLoadedId] = useState<string | undefined>();
  const [failure, setFailure] = useState<ApiFailure | undefined>();
  const [saving, setSaving] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [purgeTyped, setPurgeTyped] = useState('');

  const view: AgentView | undefined = agent.data;

  // Filled once **per agent**, from the server's copy. Re-filling on every
  // refetch would throw away whatever the user had typed when a `roster.changed`
  // frame arrived; keying on the id is what lets Duplicate navigate from one
  // agent to its clone and get the clone's fields rather than the original's.
  useEffect(() => {
    if (view === undefined || loadedId === id) return;
    setModel(fromAgent(view));
    setLoadedId(id);
  }, [view, loadedId, id]);

  if (agent.isError) {
    return (
      <section>
        <h2>Agent</h2>
        <p className="notice" data-tone="danger" role="alert">
          {failureOf(agent.error)?.message ?? 'That agent could not be read.'}
        </p>
      </section>
    );
  }

  if (view === undefined || model === undefined) {
    return (
      <section>
        <h2>Agent</h2>
        <p className="empty">Loading the agent…</p>
      </section>
    );
  }

  const sessionCount = sessions.data?.sessions.length ?? 0;
  const purgeable = sessions.isSuccess && sessionCount === 0;

  async function save(): Promise<void> {
    if (model === undefined) return;
    setSaving(true);
    setFailure(undefined);
    const body = toCreateBody(model);
    // PATCH rather than POST: the id and `meta.createdAt` are immutable and the
    // definition already exists (roster §9.3). The body is still exactly the
    // form, with no merge on either side.
    const result = await client.request<AgentView>(`/roster/agents/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body,
    });
    setSaving(false);
    if (result.kind === 'ok') {
      await queryClient.invalidateQueries({ queryKey: queryKeys.agent(id) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.roster });
      return;
    }
    setFailure(result);
  }

  async function duplicate(): Promise<void> {
    const result = await client.request<AgentView>(
      `/roster/agents/${encodeURIComponent(id)}/duplicate`,
      { method: 'POST', body: {} },
    );
    if (result.kind === 'ok') {
      await queryClient.invalidateQueries({ queryKey: queryKeys.roster });
      // The editor opens on the **returned** definition, which is a second,
      // independent folder — not a copy of this page's state.
      navigate(`/agents/${encodeURIComponent(result.value.definition.id)}`);
      return;
    }
    setFailure(result);
  }

  async function remove(purge: boolean): Promise<void> {
    const result = await client.request<RemoveAgentResult>(
      `/roster/agents/${encodeURIComponent(id)}`,
      { method: 'DELETE', query: purge ? { purge: 'true' } : {} },
    );
    if (result.kind === 'ok') {
      await queryClient.invalidateQueries({ queryKey: queryKeys.roster });
      navigate('/');
      return;
    }
    setFailure(result);
  }

  return (
    <section aria-labelledby="agent-heading">
      <h2 id="agent-heading">{view.definition.name}</h2>

      <AgentEditor
        model={model}
        onChange={(patch) => setModel({ ...model, ...patch })}
        idPrefix="agent"
      >
        {view.definition.meta.duplicatedFrom === undefined ||
        view.definition.meta.duplicatedFrom === null ? null : (
          <p className="notice" data-cloned-from={view.definition.meta.duplicatedFrom}>
            Cloned from <strong>{view.definition.meta.duplicatedFrom}</strong>. Its integrations
            point at the <strong>same credentials</strong> — changing one changes both.
          </p>
        )}
        {view.archivedAt === null ? null : (
          <p className="notice" data-tone="warn">
            This agent is archived. Its history and transcripts are kept and its id is never reused.
          </p>
        )}
        {/* roster's own diagnostics, verbatim (roster §2.3). */}
        {view.diagnostics.map((diagnostic, index) => (
          <p
            key={`${diagnostic.code}-${String(index)}`}
            className="notice"
            data-tone={diagnostic.level === 'error' ? 'danger' : 'warn'}
            data-diagnostic-code={diagnostic.code}
          >
            {diagnostic.message}
          </p>
        ))}
      </AgentEditor>

      <div className="launch__actions">
        <button
          type="button"
          className="button"
          data-variant="primary"
          disabled={saving}
          onClick={() => void save()}
        >
          Save
        </button>
        <button type="button" className="button" onClick={() => void duplicate()}>
          Duplicate
        </button>
        {/*
          Export is a plain navigation to a download, not a fetch-to-blob: §3.1's
          blob rule is about requests that must carry a bearer, and this one is
          reached by clicking a link the user chose. Over the tailnet it is the
          one download that needs the same treatment as the log bundle; that
          lands with the remote screen (M10).
        */}
        <a className="button" href={`/api/roster/agents/${encodeURIComponent(id)}/export`}>
          Export
        </a>
        <button type="button" className="button" onClick={() => setConfirmArchive(true)}>
          Archive
        </button>
      </div>

      {failure === undefined ? null : (
        <p className="notice" data-tone="danger" role="alert">
          {failure.message}
        </p>
      )}

      {confirmArchive ? (
        <ConfirmDialog label="Archive agent" onClose={() => setConfirmArchive(false)}>
          <p>
            Archive <strong>{view.definition.name}</strong>? Its history and transcripts are kept,
            and its id is never reused.
          </p>
          <button type="button" className="button" onClick={() => setConfirmArchive(false)}>
            Cancel
          </button>
          <button type="button" className="button" onClick={() => void remove(false)}>
            Archive
          </button>

          {purgeable ? (
            <div data-purge="offered">
              <p>
                No session references this agent, so it can be removed outright instead. Type its
                name to confirm.
              </p>
              <div className="field">
                <label htmlFor="purge-confirm">Agent name</label>
                <input
                  id="purge-confirm"
                  value={purgeTyped}
                  onChange={(event) => setPurgeTyped(event.target.value)}
                />
              </div>
              <button
                type="button"
                className="button"
                data-variant="primary"
                disabled={purgeTyped !== view.definition.name}
                onClick={() => void remove(true)}
              >
                Delete permanently
              </button>
            </div>
          ) : (
            <p data-purge="withheld">
              {sessionCount} session{sessionCount === 1 ? '' : 's'} reference this agent, so it can
              only be archived.
            </p>
          )}
        </ConfirmDialog>
      ) : null}

      <PermissionPreviewPanel agentId={id} />

      <section aria-labelledby="agent-history-heading">
        <h3 id="agent-history-heading">Sessions</h3>
        {sessionCount === 0 ? (
          <p className="empty">This agent has not run yet.</p>
        ) : (
          <ul>
            {(sessions.data?.sessions ?? []).map((session) => (
              <li key={session.id} data-session-id={session.id}>
                <span className="badge" data-status={session.status}>
                  {session.status}
                </span>{' '}
                <Link to={`/sessions/${encodeURIComponent(session.id)}`}>
                  {session.summary ?? session.id}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}

/**
 * §7.3's "effective-permissions preview against a chosen project".
 *
 * The same accessor the launch flow uses — roster is the sole composer (§4), and
 * two callers of `/validate` would be two chances to render a set nobody
 * compiled.
 */
function PermissionPreviewPanel({ agentId }: { readonly agentId: string }): ReactElement {
  const { client } = useServices();
  const projects = useProjects(client);
  const [projectId, setProjectId] = useState('');
  const [preview, setPreview] = useState<PermissionPreview | undefined>();

  useEffect(() => {
    if (projectId === '') {
      setPreview(undefined);
      return;
    }
    let live = true;
    void fetchPermissionPreview(client, agentId, projectId).then((answer) => {
      if (live) setPreview(answer);
    });
    return () => {
      live = false;
    };
  }, [agentId, client, projectId]);

  return (
    <section aria-labelledby="agent-permissions-heading">
      <h3 id="agent-permissions-heading">Effective permissions</h3>
      <div className="field">
        <label htmlFor="preview-project">Against project</label>
        <select
          id="preview-project"
          value={projectId}
          onChange={(event) => setProjectId(event.target.value)}
        >
          <option value="">Choose a project…</option>
          {(projects.data?.projects ?? []).map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      </div>
      {preview === undefined ? null : preview.state === 'ready' ? (
        <dl className="launch__permissions">
          <dt>Mode</dt>
          <dd>{preview.effective.mode}</dd>
          <dt>Allow</dt>
          <dd>{preview.effective.allow.join(', ') || 'nothing beyond the defaults'}</dd>
          <dt>Deny</dt>
          <dd>{preview.effective.deny.join(', ') || 'nothing'}</dd>
          <dt>Ask</dt>
          <dd>{preview.effective.ask.join(', ') || 'nothing'}</dd>
        </dl>
      ) : (
        <p className="notice" data-tone="danger" role="alert">
          {preview.message}
        </p>
      )}
    </section>
  );
}
