/**
 * The Connectors page — ui DESIGN §7.4, roster DESIGN §10.3 (WO4).
 *
 * **Why this screen exists**, in the owner's words: *"New connections should be
 * created on a Connectors page and then assigned to agents — this is currently
 * very manually entered and work has a lot of connectors."* Before this, an MCP
 * server could only be typed into one agent's editor, so N agents reaching the
 * same mailbox meant N hand-typed copies of it and the only shared thing was the
 * `secretRef`. WO3 made a connector a library file; this is the surface that
 * creates one, says who is using it, and hands it to the agents that need it.
 *
 * **The ownership rule, on screen and in the code.** The library *defines* a
 * connector; an agent *references* it. Inline servers stay legal and stay where
 * they were — a one-off belongs in the agent that has it — and an export inlines
 * whatever it finds (roster §9.4), so nothing here changes what a `.agentpack`
 * contains.
 *
 * **Three things this page will not do.**
 *
 * - **It does not carry a secret value.** Every credential is a `{ secretRef,
 *   resolved }` name and a boolean, and the fix for an unset one is the
 *   documented CLI verb (`agentmanager secrets set <ref> --stdin`) shown by the
 *   same component the agent editor uses. There is no HTTP write route for a
 *   secret and this adds none (foundation §3.5).
 * - **It does not invent an "assign" route.** Assigning is an ordinary agent
 *   `PATCH` of that agent's own `integrations` — the attachment belongs to the
 *   identity (roster §10) — so there is one write path for it, the same one the
 *   editor takes. See `connectorModel.ts`.
 * - **It does not delete out from under an agent.** roster refuses with a 409
 *   listing the referencing agents; the page renders that list as links, because
 *   the next thing the owner has to do is go and detach it in each of them.
 */

import { useQueryClient } from '@tanstack/react-query';
import { useState, type ReactElement } from 'react';
import { Link } from 'react-router-dom';

import { CredentialStatusBadge, ImportPanel, IntegrationCard } from '../agents/IntegrationsPanel';
import {
  EMPTY_INTEGRATION,
  inlineFormOf,
  integrationProblems,
  type IntegrationForm,
} from '../agents/integrationsModel';
import { queryKeys, useConnectors, useRoster } from '../api/queries';
import { failureOf, type ApiFailure } from '../api/result';
import type { ConnectorView } from '../api/types';
import { useServices } from '../app/AppContext';
import { useAppStore } from '../state/store';

import {
  assignmentRows,
  createConnectorBody,
  integrationsAfterAssign,
  patchConnectorBody,
  type ConnectorDraft,
} from './connectorModel';

/** What the page teaches when the library is empty (§7.4). */
export const EMPTY_LIBRARY_NOTE =
  'A connector is one MCP server — a mailbox, a ticket system, a search index — defined once here ' +
  'and then assigned to the agents that need it. Editing it here changes it for every agent that ' +
  'references it. An agent can still carry a one-off server of its own, in its editor.';

const BLANK_DRAFT: ConnectorDraft = {
  id: '',
  label: '',
  description: '',
  config: EMPTY_INTEGRATION,
};

/** The agent ids a 409 named, if it named any (roster's `connector_in_use`). */
function blockingAgentIds(failure: ApiFailure | undefined): readonly string[] {
  const raw = failure?.details?.['agentIds'];
  if (!Array.isArray(raw)) return [];
  return raw.filter((value): value is string => typeof value === 'string');
}

export function ConnectorsPage(): ReactElement {
  const { client } = useServices();
  const queryClient = useQueryClient();
  const library = useConnectors(client);
  const roster = useRoster(client);
  const pushToast = useAppStore((store) => store.pushToast);

  /** `null` while nothing is being authored, `''` while a new one is. */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ConnectorDraft>(BLANK_DRAFT);
  const [importing, setImporting] = useState(false);
  const [assigning, setAssigning] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<{
    readonly connectorId: string;
    readonly agentIds: readonly string[];
  } | null>(null);
  const [busy, setBusy] = useState(false);

  const connectors = library.data?.connectors ?? [];
  const agents = roster.data?.agents ?? [];

  async function refresh(): Promise<void> {
    // Both keys: an assignment changes an agent's definition and a connector's
    // `usedBy` in the same breath, and a page that refreshed only one of them
    // would show a delete as available a moment after it stopped being.
    await queryClient.invalidateQueries({ queryKey: queryKeys.connectors });
    await queryClient.invalidateQueries({ queryKey: queryKeys.roster });
  }

  function openCreate(): void {
    setEditingId('');
    setDraft(BLANK_DRAFT);
    setImporting(false);
  }

  function openEdit(connector: ConnectorView): void {
    setEditingId(connector.id);
    setDraft(draftOf(connector));
    setImporting(false);
  }

  async function save(): Promise<void> {
    const creating = editingId === '';
    setBusy(true);
    const result = creating
      ? await client.request<ConnectorView>('/roster/connectors', {
          method: 'POST',
          body: createConnectorBody(draft),
        })
      : await client.request<ConnectorView>(
          `/roster/connectors/${encodeURIComponent(editingId ?? '')}`,
          { method: 'PATCH', body: patchConnectorBody(draft) },
        );
    setBusy(false);
    if (result.kind !== 'ok') {
      // roster's own sentence, verbatim (§3.1) — it names the field.
      pushToast(result.message);
      return;
    }
    setEditingId(null);
    await refresh();
  }

  async function importDrafts(drafts: readonly IntegrationForm[]): Promise<void> {
    setBusy(true);
    let created = 0;
    for (const one of drafts) {
      const result = await client.request<ConnectorView>('/roster/connectors', {
        method: 'POST',
        body: createConnectorBody({
          id: one.name,
          label: '',
          description: '',
          config: one,
        }),
      });
      if (result.kind === 'ok') created += 1;
      else pushToast(result.message);
    }
    setBusy(false);
    setImporting(false);
    if (created > 0) {
      pushToast(`Added ${String(created)} connector${created === 1 ? '' : 's'}.`, 'info');
      await refresh();
    }
  }

  async function remove(connector: ConnectorView): Promise<void> {
    setBusy(true);
    const result = await client.request(`/roster/connectors/${encodeURIComponent(connector.id)}`, {
      method: 'DELETE',
    });
    setBusy(false);
    if (result.kind !== 'ok') {
      const agentIds = blockingAgentIds(result);
      // The 409 is the useful case and gets the list; anything else is a message
      // the user cannot act on from here and goes to the toast rail.
      if (agentIds.length > 0) setBlocked({ connectorId: connector.id, agentIds });
      else pushToast(result.message);
      return;
    }
    setBlocked(null);
    await refresh();
  }

  return (
    <section aria-labelledby="connectors-heading">
      <h2 id="connectors-heading">Connectors</h2>
      <p className="editor__note">{EMPTY_LIBRARY_NOTE}</p>

      {library.isError ? (
        <p className="notice" data-tone="danger" role="alert">
          {failureOf(library.error)?.message ?? 'The connector library could not be read.'}
        </p>
      ) : null}

      {(library.data?.diagnostics ?? []).map((diagnostic, index) => (
        <p
          key={`${diagnostic.code}-${String(index)}`}
          className="notice"
          data-tone={diagnostic.level === 'error' ? 'danger' : 'warn'}
          data-diagnostic-code={diagnostic.code}
        >
          {diagnostic.message}
        </p>
      ))}

      <div className="integrations__actions">
        <button type="button" className="button" data-variant="primary" onClick={openCreate}>
          New connector
        </button>
        <button
          type="button"
          className="button"
          onClick={() => {
            setImporting(!importing);
            setEditingId(null);
          }}
        >
          Import from .mcp.json
        </button>
      </div>

      {importing ? (
        <ImportPanel
          idPrefix="connectors-import"
          note={
            <>
              Paste a <code>.mcp.json</code> or just its <code>mcpServers</code> object. Each server
              becomes a connector in the library, which you can then assign to agents.
            </>
          }
          applyLabel={(count) =>
            `Create ${String(count)} connector${count === 1 ? '' : 's'} in the library`
          }
          onApply={(drafts) => void importDrafts(drafts)}
          onCancel={() => setImporting(false)}
        />
      ) : null}

      {editingId === null ? null : (
        <ConnectorForm
          draft={draft}
          creating={editingId === ''}
          busy={busy}
          onChange={setDraft}
          onSave={() => void save()}
          onCancel={() => setEditingId(null)}
        />
      )}

      {!library.isPending && connectors.length === 0 ? (
        <p className="empty">No connectors yet. Create one, or paste a .mcp.json above.</p>
      ) : null}

      <ul className="connectors" data-region="connectors">
        {connectors.map((connector) => (
          <li key={connector.id} data-connector={connector.id}>
            <div className="connectors__head">
              <strong>
                {connector.label === undefined || connector.label === ''
                  ? connector.id
                  : connector.label}
              </strong>
              <code>{connector.id}</code>
              <span className="badge">{connector.transport}</span>
              {connector.auth === 'oauth' ? <span className="badge">OAuth</span> : null}
            </div>

            {connector.description === undefined || connector.description === '' ? null : (
              <p className="connectors__description">{connector.description}</p>
            )}

            <p className="integration__prefix">
              Tools appear as <code>{connector.toolPrefix}*</code> for an agent that mounts it under
              its own id — permission rules use that form.
            </p>

            {connector.credentials.map((credential) => (
              <CredentialStatusBadge key={credential.secretRef} status={credential} />
            ))}

            <p className="connectors__used-by">
              {connector.usedBy.length === 0 ? (
                <span className="empty">Not assigned to any agent yet.</span>
              ) : (
                <>
                  Used by{' '}
                  {connector.usedBy.map((agentId, index) => (
                    <span key={agentId}>
                      {index === 0 ? '' : ', '}
                      <Link to={`/agents/${encodeURIComponent(agentId)}`}>
                        {agents.find((one) => one.definition.id === agentId)?.definition.name ??
                          agentId}
                      </Link>
                    </span>
                  ))}
                </>
              )}
            </p>

            {blocked?.connectorId === connector.id ? (
              <p className="notice" data-tone="danger" role="alert" data-blocked-by="agents">
                Still referenced by{' '}
                {blocked.agentIds.map((agentId, index) => (
                  <span key={agentId}>
                    {index === 0 ? '' : ', '}
                    <Link to={`/agents/${encodeURIComponent(agentId)}`}>
                      {agents.find((one) => one.definition.id === agentId)?.definition.name ??
                        agentId}
                    </Link>
                  </span>
                ))}
                . Detach it from each of them before deleting it.
              </p>
            ) : null}

            <div className="integrations__actions">
              <button type="button" className="button" onClick={() => openEdit(connector)}>
                Edit
              </button>
              <button
                type="button"
                className="button"
                onClick={() => setAssigning(assigning === connector.id ? null : connector.id)}
              >
                Assign to agents…
              </button>
              <button
                type="button"
                className="button"
                data-variant="danger"
                disabled={busy}
                onClick={() => void remove(connector)}
              >
                Delete
              </button>
            </div>

            {assigning === connector.id ? (
              <AssignPanel
                connectorId={connector.id}
                agents={agents}
                busy={busy}
                onCancel={() => setAssigning(null)}
                onApply={async (changes) => {
                  setBusy(true);
                  for (const change of changes) {
                    const agent = agents.find((one) => one.definition.id === change.agentId);
                    if (agent === undefined) continue;
                    const result = await client.request(
                      `/roster/agents/${encodeURIComponent(change.agentId)}`,
                      {
                        method: 'PATCH',
                        body: {
                          integrations: integrationsAfterAssign(
                            agent.definition.integrations,
                            connector.id,
                            change.attach,
                          ),
                        },
                      },
                    );
                    if (result.kind !== 'ok') pushToast(result.message);
                  }
                  setBusy(false);
                  setAssigning(null);
                  await refresh();
                }}
              />
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * A stored connector, read into the page's form.
 *
 * The config half goes through the editor's own reader (`inlineFormOf` →
 * `integrationsOf`), because the library's `config` **is** roster's
 * `IntegrationConfig` — the same object an inline integration holds (§10.3
 * decision 2). A second reader here would be a second opinion about what a
 * `{ secretRef }` looks like, on the one screen where getting that wrong would
 * print a credential.
 */
function draftOf(connector: ConnectorView): ConnectorDraft {
  return {
    id: connector.id,
    label: connector.label ?? '',
    description: connector.description ?? '',
    config: inlineFormOf(connector.id, connector.config),
  };
}

// ---------------------------------------------------------------------------
// Create / edit
// ---------------------------------------------------------------------------

/**
 * The authoring form: the library identity, then §7.3.1's card for the server.
 *
 * The card is the editor's own {@link IntegrationCard}, with its name field
 * relabelled to the connector id — which is exactly what it is here (roster
 * §10.3: "the id is an integration name"). That is why the `mcp__<id>__` line
 * the card already draws is correct on this page without a second rule.
 */
function ConnectorForm({
  draft,
  creating,
  busy,
  onChange,
  onSave,
  onCancel,
}: {
  readonly draft: ConnectorDraft;
  readonly creating: boolean;
  readonly busy: boolean;
  readonly onChange: (next: ConnectorDraft) => void;
  readonly onSave: () => void;
  readonly onCancel: () => void;
}): ReactElement {
  // The same warnings the editor gives, in the same words: the card is the same
  // card, so a credential-shaped literal is caught here exactly as it is there.
  const problems = integrationProblems([{ ...draft.config, name: draft.id.trim() }]);

  return (
    <section
      className="import"
      aria-labelledby="connector-form-heading"
      data-form={creating ? 'create' : 'edit'}
    >
      <h3 id="connector-form-heading">{creating ? 'New connector' : `Edit ${draft.id}`}</h3>

      <div className="field">
        <label htmlFor="connector-label">Label</label>
        <input
          id="connector-label"
          value={draft.label}
          placeholder="Gmail (work)"
          onChange={(event) => onChange({ ...draft, label: event.target.value })}
        />
      </div>

      <div className="field">
        <label htmlFor="connector-description">Description</label>
        <input
          id="connector-description"
          value={draft.description}
          onChange={(event) => onChange({ ...draft, description: event.target.value })}
        />
      </div>

      {problems.map((problem, index) => (
        <p
          key={`${problem.key ?? ''}-${String(index)}`}
          className="notice"
          data-tone="warn"
          data-integration-problem={problem.integration}
        >
          {problem.message}
        </p>
      ))}

      <IntegrationCard
        integration={{ ...draft.config, name: draft.id }}
        credentials={[]}
        idPrefix="connector-config"
        nameLabel="Connector id"
        // The id is the folder name under `connectors/` and the segment of every
        // URL that names it, so it is fixed once written (roster §10.3).
        nameDisabled={!creating}
        legend={creating ? 'New connector' : draft.id}
        onChange={(next) => onChange({ ...draft, id: next.name, config: next })}
      />

      <div className="integrations__actions">
        <button
          type="button"
          className="button"
          data-variant="primary"
          disabled={busy || draft.id.trim() === ''}
          onClick={onSave}
        >
          {creating ? 'Create connector' : 'Save connector'}
        </button>
        <button type="button" className="button" data-variant="quiet" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Assign to agents
// ---------------------------------------------------------------------------

export interface AssignChange {
  readonly agentId: string;
  readonly attach: boolean;
}

/**
 * The multi-select: checked means "already references this connector".
 *
 * Only what the owner *changed* is posted. Rewriting every agent's
 * `integrations` on confirm would turn "assign this to Priya" into a write
 * against every agent in the roster, and each of those writes is a chance to
 * clobber an edit somebody made between opening the dialog and confirming it.
 */
function AssignPanel({
  connectorId,
  agents,
  busy,
  onApply,
  onCancel,
}: {
  readonly connectorId: string;
  readonly agents: Parameters<typeof assignmentRows>[0];
  readonly busy: boolean;
  readonly onApply: (changes: readonly AssignChange[]) => void | Promise<void>;
  readonly onCancel: () => void;
}): ReactElement {
  const rows = assignmentRows(agents, connectorId);
  const [ticked, setTicked] = useState<ReadonlySet<string>>(
    () => new Set(rows.filter((row) => row.attached).map((row) => row.agentId)),
  );

  const changes = rows.flatMap((row) => {
    if (row.refusal !== undefined) return [];
    const attach = ticked.has(row.agentId);
    return attach === row.attached ? [] : [{ agentId: row.agentId, attach }];
  });

  return (
    <div className="connectors__assign" data-assign={connectorId}>
      <fieldset>
        <legend>Assign “{connectorId}” to agents</legend>
        {rows.length === 0 ? <p className="empty">No live agents to assign it to.</p> : null}
        {rows.map((row) => (
          <div key={row.agentId} data-assign-row={row.agentId}>
            <label className="launch__toggle">
              <input
                type="checkbox"
                checked={ticked.has(row.agentId)}
                disabled={row.refusal !== undefined}
                onChange={(event) => {
                  const next = new Set(ticked);
                  if (event.target.checked) next.add(row.agentId);
                  else next.delete(row.agentId);
                  setTicked(next);
                }}
              />
              {row.agentName}
            </label>
            {row.refusal === undefined ? null : (
              <p className="notice" data-tone="warn" data-assign-refusal={row.agentId}>
                {row.refusal}
              </p>
            )}
          </div>
        ))}
      </fieldset>
      <div className="integrations__actions">
        <button
          type="button"
          className="button"
          data-variant="primary"
          disabled={busy || changes.length === 0}
          onClick={() => void onApply(changes)}
        >
          Apply
        </button>
        <button type="button" className="button" data-variant="quiet" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
