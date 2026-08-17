/**
 * One agent card (DESIGN §5.2).
 *
 * The anatomy is §5.2's diagram, top to bottom: avatar · name · overseer mark,
 * the specialty chip (colour **and** the word), the tagline, the status pill and
 * its headline, then the badges. Every element's source is the table in §5.2 and
 * nothing on the card is computed from something the server already decided.
 *
 * Drag is M3. This milestone renders the card and its non-drag affordances only.
 */

import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';

import type { AgentView, Diagnostic } from '../api/types';
import { Icon } from '../icons/Sprite';
import { useAgentFleetStatus } from '../state/store';

import { Avatar } from './Avatar';
import { FLEET_STATE_LABELS } from './fleetStatus';

export interface AgentCardProps {
  readonly agent: AgentView;
  /** Library-wide diagnostics that name this agent (§2.3, roster). */
  readonly diagnostics: readonly Diagnostic[];
  readonly projectName?: string | undefined;
}

export function AgentCard({ agent, diagnostics, projectName }: AgentCardProps): ReactElement {
  const { definition, uiState } = agent;
  const status = useAgentFleetStatus(definition.id);
  const archived = agent.archivedAt !== null;
  const overseer = definition.capabilities?.overseer === true;
  const allDiagnostics = [...agent.diagnostics, ...diagnostics];

  return (
    <li
      className="agent-card"
      data-archived={archived ? 'true' : 'false'}
      data-agent-id={definition.id}
    >
      <div className="agent-card__head">
        <Avatar agentId={definition.id} name={definition.name} avatar={definition.avatar} />
        <div style={{ minWidth: 0 }}>
          <Link className="agent-card__name" to={`/agents/${encodeURIComponent(definition.id)}`}>
            {definition.name}
          </Link>
          {overseer ? <Icon name="chevron" title="Overseer" /> : null}
          <div
            className="specialty-chip"
            style={{ ['--specialty' as string]: `var(--specialty-${definition.specialty})` }}
          >
            {definition.specialty}
          </div>
        </div>
        {uiState.pinned ? <Icon name="pin" title="Pinned" /> : null}
      </div>

      {/* §14.1: "Taglines are always shown." One line of the agent's own voice. */}
      <p className="agent-card__tagline">{definition.tagline ?? ' '}</p>

      <div
        className="status-pill"
        data-state={status.state}
        style={{ ['--status' as string]: `var(--status-${status.state})` }}
      >
        <span className="status-pill__dot" aria-hidden="true" />
        {/* The word, verbatim from orchestrator §16.6 — colour is never alone. */}
        <span>{FLEET_STATE_LABELS[status.state]}</span>
        {projectName === undefined ? null : <span>· {projectName}</span>}
      </div>
      {status.headline === null ? null : <p className="status-pill__headline">{status.headline}</p>}

      <div className="agent-card__badges">
        {archived ? <span className="badge">archived</span> : null}
        {agent.needsCredentials === true ? (
          <span className="badge" data-tone="warn">
            <Icon name="key" />
            needs credential
          </span>
        ) : null}
        {allDiagnostics.map((diagnostic, index) => (
          <span
            key={`${diagnostic.code}-${String(index)}`}
            className="badge"
            data-tone={diagnostic.level === 'error' ? 'danger' : 'warn'}
            data-diagnostic-code={diagnostic.code}
            // The server's message, verbatim (§3.1). A diagnostic the UI
            // rewords is a diagnostic nobody can search for.
            title={diagnostic.message}
          >
            <Icon name="warning" />
            {diagnostic.message}
          </span>
        ))}
      </div>
    </li>
  );
}

/**
 * §5.2's last rule, applied wherever a session names an agent: "A session whose
 * `agent_id` no longer resolves renders as **deleted agent**", because
 * foundation §1.4 keeps the reference rather than the row.
 */
export const DELETED_AGENT_LABEL = 'deleted agent';

export function agentLabel(agent: AgentView | undefined): string {
  return agent?.definition.name ?? DELETED_AGENT_LABEL;
}
