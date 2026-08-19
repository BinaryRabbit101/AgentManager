/**
 * The Connectors page, as data — ui DESIGN §7.4, roster DESIGN §10.3 (WO4).
 *
 * Everything the page decides without a DOM: what a create or an edit posts,
 * which agents already carry a connector, and what one agent's `integrations`
 * record looks like after it is assigned or unassigned. The React half owns the
 * fields and the network; this owns the decisions, so the decisions can be
 * asserted directly — and so the "assign" flow cannot quietly disagree with the
 * editor about what an attachment is.
 *
 * Two rules are load-bearing here and are stated once, in this file:
 *
 * 1. **An assignment is an ordinary agent `PATCH`.** There is no assign route
 *    and this does not invent one: the attachment belongs to the identity (roster
 *    §10), so the thing that changes is the agent's own `integrations` record,
 *    written through the same whole-agent write the editor uses. That is also why
 *    an emptied record is sent as `null` — roster's spelling of "clear this
 *    field" (§9.1).
 * 2. **A name collision is refused, not resolved.** An agent that already has a
 *    *different* server under the connector's id is not a case for silently
 *    renaming one of them: the record key is the tool prefix, so renaming would
 *    change what every permission rule for that agent matches. The page says so
 *    and leaves the agent alone.
 */

import { integrationsBody, type IntegrationForm } from '../agents/integrationsModel';
import type { AgentView } from '../api/types';

// ---------------------------------------------------------------------------
// Reading an agent's attachments
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** True when this attachment is exactly `{ connector: "<id>" }` (roster §10.3). */
export function isRefTo(attachment: unknown, connectorId: string): boolean {
  return asRecord(attachment)?.['connector'] === connectorId;
}

/** One row of the **Assign to agents…** multi-select. */
export interface AssignmentRow {
  readonly agentId: string;
  readonly agentName: string;
  /** Checked: this agent already references the connector. */
  readonly attached: boolean;
  /**
   * Why this agent cannot take it, or `undefined`.
   *
   * The one case: a *different* server already occupies the connector's id on
   * that agent. Rendered inline beside the disabled row rather than raised when
   * the dialog is confirmed — a refusal the user meets after choosing is a
   * refusal they have to undo.
   */
  readonly refusal?: string;
}

/**
 * Every live agent, with whether it carries the connector already.
 *
 * Archived agents are left out for the reason roster's own `usedBy` leaves them
 * out: an archived agent cannot be launched, so attaching a connector to one
 * would be a write nothing can act on — and it would then block the delete.
 */
export function assignmentRows(
  agents: readonly AgentView[],
  connectorId: string,
): readonly AssignmentRow[] {
  return agents
    .filter((agent) => agent.archivedAt === null)
    .map((agent) => {
      const integrations = agent.definition.integrations ?? {};
      const attached = Object.values(integrations).some((one) => isRefTo(one, connectorId));
      const occupant = integrations[connectorId];
      const collides = !attached && occupant !== undefined;
      return {
        agentId: agent.definition.id,
        agentName: agent.definition.name,
        attached,
        ...(collides
          ? {
              refusal:
                `${agent.definition.name} already has a different server called ` +
                `“${connectorId}”. Rename or remove it in that agent’s editor first — the name is ` +
                'the mcp__<server>__ tool prefix its permission rules match on.',
            }
          : {}),
      };
    });
}

/**
 * One agent's `integrations` after the connector is attached or detached.
 *
 * `null` is returned for an emptied record, because that is how roster's `patch`
 * spells "clear this field" (§9.1) — an empty object would be a definition that
 * declares zero integrations, which is a different thing to say and a different
 * thing to diff.
 */
export function integrationsAfterAssign(
  integrations: Readonly<Record<string, unknown>> | undefined,
  connectorId: string,
  attach: boolean,
): Readonly<Record<string, unknown>> | null {
  const current = { ...(integrations ?? {}) };
  if (attach) {
    return { ...current, [connectorId]: { connector: connectorId } };
  }
  // Every key that references it, not only the one under the library id: an
  // agent may mount a connector under a name of its own, and detaching has to
  // mean "this agent no longer carries it".
  for (const [name, attachment] of Object.entries(current)) {
    if (isRefTo(attachment, connectorId)) delete current[name];
  }
  return Object.keys(current).length === 0 ? null : current;
}

// ---------------------------------------------------------------------------
// Creating and editing a connector
// ---------------------------------------------------------------------------

/** The page's form: the library identity, plus §10's server config. */
export interface ConnectorDraft {
  /** The library id — also the folder name and the default server name. */
  readonly id: string;
  readonly label: string;
  readonly description: string;
  /** The config, held in exactly the shape the editor's card edits. */
  readonly config: IntegrationForm;
}

/**
 * `POST /api/roster/connectors` — the body, with the id sent explicitly.
 *
 * The server would derive an id from the label, but the page asks for one: the
 * id is what `mcp__<id>__` is built from and what the card shows while it is
 * being typed, and a prefix that changed after saving would be a promise the
 * form had already broken.
 */
export function createConnectorBody(draft: ConnectorDraft): Record<string, unknown> {
  const id = draft.id.trim();
  return {
    id,
    ...(draft.label.trim() === '' ? {} : { label: draft.label.trim() }),
    ...(draft.description.trim() === '' ? {} : { description: draft.description.trim() }),
    config: configBody(draft),
  };
}

/**
 * `PATCH /api/roster/connectors/:id` — the same three fields, `null` to clear.
 *
 * The id is never sent: it is immutable (it is the folder name), and a body that
 * carried it would be refused the moment somebody typed in a disabled field.
 */
export function patchConnectorBody(draft: ConnectorDraft): Record<string, unknown> {
  return {
    label: draft.label.trim() === '' ? null : draft.label.trim(),
    description: draft.description.trim() === '' ? null : draft.description.trim(),
    config: configBody(draft),
  };
}

/**
 * The `config` half, produced by the editor's own serialiser.
 *
 * `integrationsBody` keys by the server name, so the draft's id is used as the
 * name and the one entry is taken back out. That indirection is the point: a
 * library connector's config **is** an inline integration's config (roster §10.3
 * decision 2), and writing a second serialiser for it is how the two would come
 * to disagree.
 */
function configBody(draft: ConnectorDraft): Record<string, unknown> | undefined {
  const id = draft.id.trim();
  if (id === '') return undefined;
  return integrationsBody([{ ...draft.config, name: id, connector: undefined }])[id];
}
