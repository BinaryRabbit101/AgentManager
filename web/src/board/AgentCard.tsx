/**
 * One agent card (DESIGN §5.2).
 *
 * The anatomy is §5.2's diagram, top to bottom: avatar · name · overseer mark,
 * the specialty chip (colour **and** the word), the tagline, the status pill and
 * its headline, then the badges. Every element's source is the table in §5.2 and
 * nothing on the card is computed from something the server already decided.
 *
 * M3 adds the gesture and its two non-drag equivalents (§5.4): the card is a
 * sortable draggable, the `⋯` menu carries **Launch on…**, and in Reorder mode
 * it grows ▲▼ buttons with a position readout. All three end in the same code.
 */

import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';

import { useRemoteAgents } from '../api/queries';
import type { AgentView, Diagnostic } from '../api/types';
import { useHasModule, useServices } from '../app/AppContext';
import { Icon } from '../icons/Sprite';
import { grantExpiryLabel } from '../remote/access';
import { useAgentFleetStatus } from '../state/store';

import { AgentCardMenu } from './AgentCardMenu';
import { Avatar } from './Avatar';
import { FLEET_STATE_LABELS } from './fleetStatus';

export interface AgentCardProps {
  readonly agent: AgentView;
  /** Library-wide diagnostics that name this agent (§2.3, roster). */
  readonly diagnostics: readonly Diagnostic[];
  readonly projectName?: string | undefined;
  /** §5.4's Reorder mode: 1-based position, and the two move controls. */
  readonly reorder?:
    | {
        readonly position: number;
        readonly total: number;
        readonly onMove: (delta: -1 | 1) => void;
      }
    | undefined;
}

export function AgentCard({
  agent,
  diagnostics,
  projectName,
  reorder,
}: AgentCardProps): ReactElement {
  const { definition, uiState } = agent;
  const { client } = useServices();
  const status = useAgentFleetStatus(definition.id);
  // One query for the whole board, shared through the cache: the grant list is
  // small, it is invalidated by `remote.agent.access.*` (§3.4), and asking per
  // card would be N requests for one fact.
  const hasRemote = useHasModule('remote');
  const grants = useRemoteAgents(client, hasRemote);
  const grant = grants.data?.agents.find((one) => one.agentId === definition.id);
  const archived = agent.archivedAt !== null;
  const overseer = definition.capabilities?.overseer === true;
  const allDiagnostics = [...agent.diagnostics, ...diagnostics];

  // One sortable serves both gestures §5.3 gives the card: it is the thing that
  // is dragged onto a project, and it is an item of the board's sortable
  // context. An archived card is not draggable — there is nothing to launch.
  const sortable = useSortable({ id: definition.id, disabled: archived });

  return (
    <li
      className="agent-card"
      data-archived={archived ? 'true' : 'false'}
      data-agent-id={definition.id}
      data-dragging={sortable.isDragging ? 'true' : 'false'}
      ref={sortable.setNodeRef}
      style={{
        transform: CSS.Translate.toString(sortable.transform),
        transition: sortable.transition ?? undefined,
      }}
    >
      <div className="agent-card__head">
        {archived ? null : (
          <button
            type="button"
            className="agent-card__grip"
            // §5.4: this is the keyboard path — Tab here, Space to lift, arrows
            // to move between targets, Space to drop.
            aria-label={`Move or launch ${definition.name}`}
            {...sortable.attributes}
            {...sortable.listeners}
          >
            <Icon name="grip" />
          </button>
        )}
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
        <AgentCardMenu
          agentId={definition.id}
          agentName={definition.name}
          archived={archived}
          remoteAvailable={hasRemote}
          grant={grant}
        />
      </div>

      {/* §14.1: "Taglines are always shown." One line of the agent's own voice. */}
      <p className="agent-card__tagline">{definition.tagline ?? ' '}</p>

      {reorder === undefined ? null : (
        <div
          className="agent-card__reorder"
          role="group"
          aria-label={`Position of ${definition.name}`}
        >
          <button
            type="button"
            aria-label={`Move ${definition.name} up`}
            disabled={reorder.position <= 1}
            onClick={() => reorder.onMove(-1)}
          >
            ▲
          </button>
          <span>
            {reorder.position} of {reorder.total}
          </span>
          <button
            type="button"
            aria-label={`Move ${definition.name} down`}
            disabled={reorder.position >= reorder.total}
            onClick={() => reorder.onMove(1)}
          >
            ▼
          </button>
        </div>
      )}

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
        {/*
          remote §12.4 / §13.2: the same grant appears on the card, and its
          **expiry** with it — "a grant with an invisible deadline is a grant the
          user will be surprised by". Live on `remote.agent.access.*`, which
          §3.4 already invalidates.
        */}
        {grant === undefined ? null : (
          <span
            className="badge"
            data-tone="info"
            data-remote-grant={definition.id}
            data-grant-expires={grant.expiresAt}
          >
            remote · {grantExpiryLabel(grant, Date.now())}
          </span>
        )}
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
