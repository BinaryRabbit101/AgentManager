/**
 * The integrations panel — ui DESIGN §7.3, roster DESIGN §10.
 *
 * **Why this exists.** roster §7.3 keeps `settingSources` at `["project"]` and
 * rejects `"user"`/`"local"`, because those "would load the *host machine
 * owner's* personal Claude Code configuration into every agent: their memory,
 * their hooks, their MCP servers … config leakage across an identity boundary".
 * That boundary is worth keeping — and its cost is that an agent has no
 * connectors unless someone gives it some. Until now the sanctioned way to do
 * that (`integrations` on the definition) existed only in the schema, so the
 * honest summary of the feature was "hand-edit agent.json". This panel is the
 * other half of §7.3's bargain, and {@link IDENTITY_BOUNDARY_NOTE} says so on
 * screen rather than only in a design doc.
 *
 * **Secrets discipline.** A credential is a `secretRef` — a *name* — everywhere
 * in this file. The API has no route that returns a value (roster §10: "the API
 * returns `{ secretRef, resolved: true|false }`"), so there is nothing here to
 * leak; the `resolved` flag becomes a badge, and an unset ref becomes the
 * `agentmanager secrets set … --stdin` line, which carries the key and never
 * the value (foundation §3.5).
 *
 * **The library, and what the panel does with it (roster §10.3, WO4).** A server
 * may now be defined once under `connectors/` and *referenced* from many agents.
 * The panel therefore renders two kinds of row: an editable card, as before, and
 * a compact **reference** row that shows what the library holds and links to the
 * Connectors page, where it is managed. The list is fetched here — by the panel,
 * with the app's ordinary query client — rather than passed down as a prop,
 * because "what the library holds" is a fact about the machine and not a fact
 * about the agent being edited. When there is no provider above (the editor's own
 * control tests mount it bare), the panel renders every field it always did and
 * simply has no library to offer.
 *
 * Nothing in this file writes. Every control edits the editor's model, and the
 * definition changes when the owner saves the editor — the same path the
 * persona and the permission lists take (`editorModel.ts`).
 */

import { useState, type ReactElement, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

import type { ApiClient } from '../api/client';
import { useConnectors } from '../api/queries';
import type {
  ConnectorCredentialStatus,
  ConnectorView,
  Diagnostic,
  IntegrationCredentialStatus,
} from '../api/types';
import { useOptionalServices } from '../app/AppContext';

import {
  EMPTY_INTEGRATION,
  INTEGRATION_TRANSPORTS,
  connectorRefForm,
  inlineFormOf,
  integrationProblems,
  isConnectorRef,
  mcpToolPrefix,
  secretSetCommand,
  suggestedSecretRef,
  type CredentialField,
  type IntegrationForm,
  type IntegrationTransport,
} from './integrationsModel';
import { parseMcpJson, withFieldSecret, type ImportRow } from './mcpImport';

/** The §7.3 rationale, in the owner's words rather than the spec's. */
export const IDENTITY_BOUNDARY_NOTE =
  'Agents don’t inherit your personal Claude config — not your memory, your hooks or your MCP ' +
  'servers. Give each agent its own connectors here. (A project’s own .mcp.json still applies ' +
  'when the agent is pointed at that project.)';

/** Said on every reference row — the ownership rule of §7.3.1, on screen. */
export const MANAGED_IN_LIBRARY_NOTE = 'Managed on the Connectors page';

export interface IntegrationsPanelProps {
  readonly integrations: readonly IntegrationForm[];
  readonly onChange: (next: readonly IntegrationForm[]) => void;
  /** roster's `{ secretRef, resolved }` per ref — a badge, never a value. */
  readonly credentials?: readonly IntegrationCredentialStatus[];
  /** roster's own diagnostics; the `integrations.*` ones are shown in context. */
  readonly diagnostics?: readonly Diagnostic[];
  readonly idPrefix: string;
}

/**
 * The panel, with the library read when there is a client to read it with.
 *
 * The split is one component deep and no deeper: `useConnectors` needs both the
 * services context and a `QueryClientProvider`, and the two always arrive
 * together (`web/test/harness.tsx` provides both, `main.tsx` mounts both). So
 * the presence of the services is the honest test for "can this reach the
 * network", and the branch is taken once per mount rather than per render.
 */
export function IntegrationsPanel(props: IntegrationsPanelProps): ReactElement {
  const services = useOptionalServices();
  if (services === undefined) return <IntegrationsPanelBody {...props} connectors={undefined} />;
  return <IntegrationsPanelWithLibrary {...props} client={services.client} />;
}

function IntegrationsPanelWithLibrary({
  client,
  ...props
}: IntegrationsPanelProps & { readonly client: ApiClient }): ReactElement {
  const library = useConnectors(client);
  // `undefined` and "the library is empty" are different facts and are kept
  // different: the first must not produce a dangling-connector warning for every
  // reference the agent holds (see `integrationProblems`).
  return <IntegrationsPanelBody {...props} connectors={library.data?.connectors} />;
}

interface IntegrationsPanelBodyProps extends IntegrationsPanelProps {
  /** The library, or `undefined` when it could not be read at all. */
  readonly connectors: readonly ConnectorView[] | undefined;
}

function IntegrationsPanelBody({
  integrations,
  onChange,
  credentials = [],
  diagnostics = [],
  idPrefix,
  connectors,
}: IntegrationsPanelBodyProps): ReactElement {
  const [importing, setImporting] = useState(false);
  const at = (name: string): string => `${idPrefix}-${name}`;

  const replace = (index: number, next: IntegrationForm): void => {
    onChange(integrations.map((one, position) => (position === index ? next : one)));
  };

  // roster's warnings for this field group, rendered where the field group is
  // rather than only in the page-level list — `roster.integration.no-allow-rule`
  // is about *this* server and is unactionable three screens away.
  const scoped = diagnostics.filter((diagnostic) => diagnostic.path?.startsWith('integrations.'));
  const problems = integrationProblems(integrations, {
    connectorIds: connectors?.map((one) => one.id),
  });
  // The library minus what this agent already references — offering a connector
  // it already carries would append a second row under a name that is taken.
  const attachable = (connectors ?? []).filter(
    (one) => !integrations.some((form) => form.connector === one.id),
  );

  return (
    <fieldset className="integrations">
      <legend>Integrations</legend>
      <p className="editor__note">{IDENTITY_BOUNDARY_NOTE}</p>

      {scoped.map((diagnostic, index) => (
        <p
          key={`${diagnostic.code}-${String(index)}`}
          className="notice"
          data-tone={diagnostic.level === 'error' ? 'danger' : 'warn'}
          data-diagnostic-code={diagnostic.code}
        >
          {diagnostic.message}
        </p>
      ))}

      {problems.map((problem, index) => (
        <p
          key={`${problem.integration}-${problem.key ?? ''}-${String(index)}`}
          className="notice"
          data-tone="warn"
          data-integration-problem={problem.integration}
        >
          {problem.message}
        </p>
      ))}

      {integrations.length === 0 ? (
        <p className="empty">No connectors. This agent can only use its built-in tools.</p>
      ) : null}

      {integrations.map((integration, index) => {
        const remove = (): void =>
          onChange(integrations.filter((_one, position) => position !== index));
        if (isConnectorRef(integration)) {
          const held = connectors?.find((one) => one.id === integration.connector);
          return (
            <ConnectorRefCard
              key={index}
              integration={integration}
              connector={held}
              onDetach={remove}
              // The one path from a reference back to an editable card. It fills
              // the form from the library's *current* config, so what the owner
              // then edits is a copy of what would have compiled — not a blank
              // card they have to retype (roster §10.3).
              onConvert={
                held === undefined
                  ? undefined
                  : () => replace(index, inlineFormOf(integration.name, held.config))
              }
            />
          );
        }
        return (
          <IntegrationCard
            key={index}
            integration={integration}
            credentials={credentials}
            idPrefix={at(`integration-${String(index)}`)}
            onChange={(next) => replace(index, next)}
            onRemove={remove}
          />
        );
      })}

      <div className="integrations__actions">
        <button
          type="button"
          className="button"
          onClick={() => onChange([...integrations, EMPTY_INTEGRATION])}
        >
          Add a connector
        </button>
        {attachable.length === 0 ? null : (
          <div className="field" data-control="attach-from-library">
            <label htmlFor={at('attach')}>Attach from library</label>
            <select
              id={at('attach')}
              value=""
              onChange={(event) => {
                const id = event.target.value;
                if (id === '') return;
                onChange([...integrations, connectorRefForm(id)]);
              }}
            >
              <option value="">choose a connector…</option>
              {attachable.map((one) => (
                <option key={one.id} value={one.id}>
                  {one.label === undefined || one.label === ''
                    ? one.id
                    : `${one.label} (${one.id})`}
                </option>
              ))}
            </select>
          </div>
        )}
        <button type="button" className="button" onClick={() => setImporting(!importing)}>
          Import from .mcp.json
        </button>
      </div>

      {importing ? (
        <ImportPanel
          idPrefix={at('import')}
          onApply={(drafts) => {
            onChange([...integrations, ...drafts]);
            setImporting(false);
          }}
          onCancel={() => setImporting(false)}
        />
      ) : null}
    </fieldset>
  );
}

// ---------------------------------------------------------------------------
// One server
// ---------------------------------------------------------------------------

export interface IntegrationCardProps {
  readonly integration: IntegrationForm;
  readonly credentials: readonly IntegrationCredentialStatus[];
  readonly idPrefix: string;
  readonly onChange: (next: IntegrationForm) => void;
  /** Omitted where the row cannot be removed from inside the card — the
   *  Connectors page deletes a connector, it does not "remove" one field group. */
  readonly onRemove?: (() => void) | undefined;
  /** "Server name" here; "Connector id" on the Connectors page, where the same
   *  field is the library id and therefore the folder name (roster §10.3). */
  readonly nameLabel?: string;
  /** The id is the folder name and is immutable once written (roster §10.3). */
  readonly nameDisabled?: boolean;
  /** Overrides the legend, which is otherwise the server name. */
  readonly legend?: string;
}

/**
 * One MCP server's fields — the idiom, shared by the two places one is authored.
 *
 * Exported because the Connectors page authors exactly the same object: a
 * library connector's `config` **is** roster's `IntegrationConfig` (§10.3
 * decision 2), so a second form for it would be a second dialect of the same
 * shape, and the day the two disagreed would be the day a connector behaved
 * differently depending on where it was typed.
 */
export function IntegrationCard({
  integration,
  credentials,
  idPrefix,
  onChange,
  onRemove,
  nameLabel = 'Server name',
  nameDisabled = false,
  legend,
}: IntegrationCardProps): ReactElement {
  const at = (name: string): string => `${idPrefix}-${name}`;
  const stdio = integration.transport === 'stdio';
  const label = stdio ? 'Variable' : 'Header';

  const patchField = (index: number, patch: Partial<CredentialField>): void => {
    onChange({
      ...integration,
      fields: integration.fields.map((field, position) =>
        position === index ? { ...field, ...patch } : field,
      ),
    });
  };

  return (
    <fieldset className="integration" data-integration={integration.name}>
      <legend>{legend ?? (integration.name === '' ? 'New connector' : integration.name)}</legend>

      <div className="field">
        <label htmlFor={at('name')}>{nameLabel}</label>
        <input
          id={at('name')}
          value={integration.name}
          placeholder="gmail"
          disabled={nameDisabled}
          onChange={(event) => onChange({ ...integration, name: event.target.value })}
        />
      </div>
      {/* §10: MCP tools are namespaced `mcp__<server>__<tool>`, and permission
          rules match on that prefix — so the prefix is shown beside the name it
          is derived from, where it is useful when writing an allow rule. */}
      <p className="integration__prefix">
        Tools appear as <code>{mcpToolPrefix(integration.name || '<name>')}*</code> — permission
        rules use that form, and <code>acceptEdits</code> does not auto-approve them.
      </p>

      <div className="field">
        <label htmlFor={at('transport')}>Transport</label>
        <select
          id={at('transport')}
          value={integration.transport}
          onChange={(event) =>
            onChange({
              ...integration,
              transport: event.target.value as IntegrationTransport,
            })
          }
        >
          {INTEGRATION_TRANSPORTS.map((transport) => (
            <option key={transport} value={transport}>
              {transport}
            </option>
          ))}
        </select>
      </div>

      {stdio ? (
        <>
          <div className="field">
            <label htmlFor={at('command')}>Command</label>
            <input
              id={at('command')}
              value={integration.command}
              placeholder="npx"
              onChange={(event) => onChange({ ...integration, command: event.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor={at('args')}>Arguments (one per line)</label>
            <textarea
              id={at('args')}
              rows={3}
              value={integration.args}
              onChange={(event) => onChange({ ...integration, args: event.target.value })}
            />
          </div>
        </>
      ) : (
        <div className="field">
          <label htmlFor={at('url')}>URL</label>
          <input
            id={at('url')}
            value={integration.url}
            // A shape, not an example origin: §1.4's scan forbids naming an
            // http(s) origin anywhere in the tree, and a placeholder is not
            // worth an exception to a rule that exists to keep the tailnet
            // browser from ever reaching for the internet.
            placeholder="the server’s https URL"
            onChange={(event) => onChange({ ...integration, url: event.target.value })}
          />
        </div>
      )}

      {/*
        roster §10.1 (WO6). The one control that makes an agent need no key at
        all: the server authorises *the human* through the MCP OAuth flow, so
        nothing about it is stored on this machine and there is nothing here to
        scavenge for. It is remote-only because a stdio server is a local child
        process with no OAuth challenge to answer.
      */}
      {stdio ? null : (
        <label className="launch__toggle" data-control="oauth">
          <input
            type="checkbox"
            checked={integration.oauth}
            onChange={(event) => onChange({ ...integration, oauth: event.target.checked })}
          />
          Authorise with OAuth — no key stored on this machine
        </label>
      )}

      <p className="editor__note">
        {integration.oauth && !stdio ? (
          <>
            This server authorises through the browser the first time an agent uses it: the session
            raises the link, you sign in, and the grant is cached by the Claude CLI under this
            install’s data folder. Add headers below only for non-credential things like routing —
            an OAuth server carries no key and no secret reference.
          </>
        ) : (
          <>
            {stdio ? 'Environment variables' : 'HTTP headers'} for this server. Tick <em>secret</em>{' '}
            and the definition stores the <em>name</em> of a stored secret. <code>agent.json</code>{' '}
            never holds the value, so it never reaches git or an export.
          </>
        )}
      </p>

      {integration.fields.map((field, index) => (
        <div className="credential" key={index} data-field={field.key}>
          <div className="field">
            <label htmlFor={at(`field-${String(index)}-key`)}>{label}</label>
            <input
              id={at(`field-${String(index)}-key`)}
              value={field.key}
              onChange={(event) => patchField(index, { key: event.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor={at(`field-${String(index)}-value`)}>
              {field.secret ? 'Secret reference' : 'Value'}
            </label>
            <input
              id={at(`field-${String(index)}-value`)}
              value={field.value}
              placeholder={field.secret ? 'mcp.gmail.token' : ''}
              onChange={(event) => patchField(index, { value: event.target.value })}
            />
          </div>
          <label className="launch__toggle">
            <input
              type="checkbox"
              checked={field.secret}
              // Ticking proposes the conventional ref name rather than reusing
              // whatever literal was in the box — a literal that was typed into
              // a value field is a *value*, and turning it into a key name would
              // put it back in the definition under a different heading.
              onChange={(event) =>
                patchField(index, {
                  secret: event.target.checked,
                  value: event.target.checked
                    ? suggestedSecretRef(integration.name || 'server', field.key)
                    : '',
                })
              }
            />
            secret
          </label>
          <button
            type="button"
            className="button"
            data-variant="quiet"
            onClick={() =>
              onChange({
                ...integration,
                fields: integration.fields.filter((_one, position) => position !== index),
              })
            }
          >
            Remove {label.toLowerCase()}
          </button>
          <CredentialBadge field={field} credentials={credentials} />
        </div>
      ))}

      <div className="integrations__actions">
        <button
          type="button"
          className="button"
          onClick={() =>
            onChange({
              ...integration,
              fields: [...integration.fields, { key: '', value: '', secret: false }],
            })
          }
        >
          Add {label.toLowerCase()}
        </button>
        {onRemove === undefined ? null : (
          <button type="button" className="button" data-variant="danger" onClick={onRemove}>
            Remove connector
          </button>
        )}
      </div>
    </fieldset>
  );
}

// ---------------------------------------------------------------------------
// One reference to a library connector (roster §10.3)
// ---------------------------------------------------------------------------

/**
 * A reference row: what the library holds, and the two things an agent may do
 * about it.
 *
 * Deliberately **not editable here**. The whole point of the library is that the
 * connector is defined in one place, so a form on this row would be a second
 * place it was defined — the exact problem §10.3 exists to remove. What the row
 * offers instead is *Detach* (this agent stops carrying it; the library keeps it)
 * and *Convert to inline copy* (this agent takes a private copy and stops
 * following the library), which are the only two honest ways out.
 *
 * When the library does not hold the id, the row still renders: a dangling
 * reference is exactly the thing the owner has to be able to see and fix, and a
 * row that vanished would leave the launch refusal with no visible cause.
 */
function ConnectorRefCard({
  integration,
  connector,
  onDetach,
  onConvert,
}: {
  readonly integration: IntegrationForm;
  readonly connector: ConnectorView | undefined;
  readonly onDetach: () => void;
  /** Absent while the library cannot supply a config to copy. */
  readonly onConvert?: (() => void) | undefined;
}): ReactElement {
  return (
    <fieldset
      className="integration integration--ref"
      data-integration={integration.name}
      data-connector-ref={integration.connector}
    >
      <legend>{integration.name}</legend>

      {connector === undefined ? (
        <p className="notice" data-tone="danger">
          The library has no connector called “{integration.connector}”. Recreate it on the
          Connectors page, or detach this row — a reference the library cannot resolve refuses the
          launch (roster §10.3).
        </p>
      ) : (
        <>
          <p className="integration__ref-head">
            <strong>
              {connector.label === undefined || connector.label === ''
                ? connector.id
                : connector.label}
            </strong>{' '}
            <span className="badge">{connector.transport}</span>{' '}
            {connector.auth === 'oauth' ? <span className="badge">OAuth</span> : null}
          </p>
          <p className="integration__prefix">
            Tools appear as <code>{mcpToolPrefix(integration.name)}*</code> — the name this agent
            mounts it under, which need not be the library id.
          </p>
          {connector.credentials.map((credential) => (
            <CredentialStatusBadge key={credential.secretRef} status={credential} />
          ))}
        </>
      )}

      <div className="integrations__actions">
        <Link to="/connectors">{MANAGED_IN_LIBRARY_NOTE}</Link>
        <button type="button" className="button" onClick={onDetach}>
          Detach
        </button>
        {onConvert === undefined ? null : (
          <button type="button" className="button" onClick={onConvert}>
            Convert to inline copy
          </button>
        )}
      </div>
    </fieldset>
  );
}

/**
 * roster's "needs credential" badge (§10), plus the way to fix it.
 *
 * `resolved` is a boolean the API computed from a presence probe — the status
 * shape "is built from a `has`-style probe, never from a `reveal()`"
 * (`integrations.ts`), which is why showing it here is safe.
 */
function CredentialBadge({
  field,
  credentials,
}: {
  readonly field: CredentialField;
  readonly credentials: readonly IntegrationCredentialStatus[];
}): ReactElement | null {
  if (!field.secret || field.value.trim() === '') return null;
  const status = credentials.find((one) => one.secretRef === field.value.trim());
  if (status === undefined) return null;
  return <CredentialStatusBadge status={status} />;
}

/**
 * The badge and, when it is missing, the one documented way to fix it.
 *
 * Exported and shared by the panel, the reference row and the Connectors page:
 * `agentmanager secrets set <ref> --stdin` is the *only* sanctioned way a value
 * reaches the store (foundation §3.5 — "never a command line (visible in Task
 * Manager), never a temp file"), and three copies of that sentence would be
 * three chances for one of them to suggest something else.
 */
export function CredentialStatusBadge({
  status,
}: {
  readonly status: ConnectorCredentialStatus;
}): ReactElement {
  if (status.resolved) {
    return (
      <span className="badge" data-credential="resolved" data-secret-ref={status.secretRef}>
        credential stored
      </span>
    );
  }
  return (
    <span
      className="credential__missing"
      data-credential="missing"
      data-secret-ref={status.secretRef}
    >
      <span className="badge" data-status="halted">
        needs credential
      </span>{' '}
      Store it with <code>{secretSetCommand(status.secretRef)}</code> — the value is read from
      standard input, so it never lands in a command line or a shell history.
    </span>
  );
}

// ---------------------------------------------------------------------------
// Paste-import
// ---------------------------------------------------------------------------

export interface ImportPanelProps {
  readonly idPrefix: string;
  readonly onApply: (drafts: readonly IntegrationForm[]) => void;
  readonly onCancel: () => void;
  /** What happens on apply, which differs between the two callers: the editor
   *  appends drafts to a form, the Connectors page creates library entries. */
  readonly note?: ReactNode;
  readonly applyLabel?: (count: number) => string;
}

/**
 * Paste → preview → append. The preview step is the whole point: `mcpImport.ts`
 * rewrites transports and converts `${VAR}` placeholders, and a mapping the
 * owner did not see would be a silent edit to their config.
 *
 * Exported so the Connectors page can raise the same panel one level up: the
 * owner's complaint was that a `.mcp.json` could only be imported *into an
 * agent*, and a second parser and a second preview table for the library would
 * be two answers to "what will this paste do".
 */
export function ImportPanel({
  idPrefix,
  onApply,
  onCancel,
  note,
  applyLabel = (count) => `Add ${String(count)} connector${count === 1 ? '' : 's'}`,
}: ImportPanelProps): ReactElement {
  const [text, setText] = useState('');
  const [rows, setRows] = useState<readonly ImportRow[] | undefined>();
  const [error, setError] = useState<string | undefined>();

  return (
    <section className="import" aria-labelledby={`${idPrefix}-heading`} data-import="mcp-json">
      <h4 id={`${idPrefix}-heading`}>Import from .mcp.json</h4>
      <p className="editor__note">
        {note ?? (
          <>
            Paste a <code>.mcp.json</code> or just its <code>mcpServers</code> object. Nothing is
            written until you save this agent.
          </>
        )}
      </p>
      <div className="field">
        <label htmlFor={`${idPrefix}-text`}>.mcp.json</label>
        <textarea
          id={`${idPrefix}-text`}
          rows={8}
          value={text}
          placeholder={
            '{\n  "mcpServers": {\n    "gmail": { "command": "npx", "args": ["-y", "…"] }\n  }\n}'
          }
          onChange={(event) => setText(event.target.value)}
        />
      </div>

      <div className="integrations__actions">
        <button
          type="button"
          className="button"
          onClick={() => {
            const result = parseMcpJson(text);
            if (result.kind === 'ok') {
              setRows(result.rows);
              setError(undefined);
              return;
            }
            setRows(undefined);
            setError(result.message);
          }}
        >
          Preview the mapping
        </button>
        <button type="button" className="button" data-variant="quiet" onClick={onCancel}>
          Cancel
        </button>
      </div>

      {error === undefined ? null : (
        <p className="notice" data-tone="danger" role="alert">
          {error}
        </p>
      )}

      {rows === undefined ? null : (
        <>
          <table className="import__table">
            <caption>What will be added</caption>
            <thead>
              <tr>
                <th scope="col">Server</th>
                <th scope="col">Transport</th>
                <th scope="col">Command or URL</th>
                <th scope="col">Tools</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.draft.name} data-import-row={row.draft.name}>
                  <td>{row.draft.name}</td>
                  <td>{row.draft.transport}</td>
                  <td>
                    <code>
                      {row.draft.transport === 'stdio'
                        ? [row.draft.command, ...row.draft.args.split('\n')].join(' ').trim()
                        : row.draft.url}
                    </code>
                  </td>
                  <td>
                    <code>{mcpToolPrefix(row.draft.name)}*</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {rows
            .flatMap((row) => row.notes)
            .map((note) => (
              <p key={note} className="notice" data-tone="info" data-import-note="true">
                {note}
              </p>
            ))}

          {rows.map((row, index) => (
            <ImportFlags
              key={row.draft.name}
              row={row}
              onChange={(next) =>
                setRows(rows.map((one, position) => (position === index ? next : one)))
              }
            />
          ))}

          <button
            type="button"
            className="button"
            data-variant="primary"
            onClick={() => onApply(rows.map((row) => row.draft))}
          >
            {applyLabel(rows.length)}
          </button>
        </>
      )}
    </section>
  );
}

/** The per-field decisions: a ref, or a literal accepted knowingly. */
function ImportFlags({
  row,
  onChange,
}: {
  readonly row: ImportRow;
  readonly onChange: (next: ImportRow) => void;
}): ReactElement | null {
  if (row.flags.length === 0) return null;
  return (
    <div className="import__flags" data-import-flags={row.draft.name}>
      <h5>{row.draft.name} — values that cannot be copied across as they are</h5>
      {row.flags.map((flag) => {
        const field = row.draft.fields.find((one) => one.key === flag.key);
        const secret = field?.secret ?? true;
        return (
          <div
            className="import__flag"
            key={flag.key}
            data-flag={flag.key}
            data-reason={flag.reason}
          >
            <p>{flag.message}</p>
            <label className="launch__toggle">
              <input
                type="checkbox"
                checked={secret}
                // A credential-shaped key has no literal option at all: roster's
                // schema rejects one, so offering the choice would be offering a
                // save that cannot succeed.
                disabled={flag.required}
                onChange={(event) => onChange(withFieldSecret(row, flag.key, event.target.checked))}
              />
              Store as a secret reference
            </label>
            {secret ? (
              <p className="import__ref">
                <code>{field?.value ?? ''}</code> —{' '}
                <code>{secretSetCommand(field?.value ?? '')}</code>
              </p>
            ) : (
              <p className="import__ref">
                Kept as a literal in <code>agent.json</code>. Type the real value in the connector
                below.
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
