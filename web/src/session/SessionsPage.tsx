/**
 * The sessions destination (DESIGN §2.1) — `/sessions`.
 *
 * Every session the core has run, newest first, with the finished ones still
 * there. `/sessions/:id` has always been deep-linkable, but nothing in the app
 * *listed* sessions: the board shows what is running now and a session that
 * stopped left the board with nowhere to be found again except through the
 * project page's activity timeline. That is a history the user is entitled to
 * reach directly, so it is a destination.
 *
 * **One request per tab, and the server's order.** `GET /api/sessions` returns
 * newest first (runner §11.1) and carries `agentId` / `projectId` / status
 * denormalised, so a row is drawn without a join. The roster is read for the
 * avatar and the human name only — it is already in cache for every other
 * screen, so this costs nothing on arrival — and a row still renders in full
 * when the agent behind it has since been deleted.
 *
 * Nothing here sorts and nothing here derives a status: §4's rule that the UI
 * reads what the server computed applies to `status` and `exitReason` exactly as
 * it applies to project health.
 */

import { useState, type ReactElement } from 'react';
import { Link } from 'react-router-dom';

import { useRoster, useSessions } from '../api/queries';
import { failureOf } from '../api/result';
import type { SessionRecord, SessionStatus } from '../api/types';
import { useServices } from '../app/AppContext';
import { Avatar } from '../board/Avatar';

/** The tabs, in the order §9.2's vocabulary reads. `all` is not a status. */
const TABS: readonly { readonly key: SessionStatus | 'all'; readonly label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'running', label: 'Running' },
  { key: 'queued', label: 'Queued' },
  { key: 'paused', label: 'Paused' },
  { key: 'done', label: 'Done' },
  { key: 'failed', label: 'Failed' },
  { key: 'interrupted', label: 'Interrupted' },
];

/** The timestamp that says the most about a row, phrased rather than formatted. */
function when(session: SessionRecord): string {
  const stamp = session.endedAt ?? session.startedAt;
  if (stamp === null) return 'not started yet';
  const at = new Date(stamp);
  if (Number.isNaN(at.getTime())) return '';
  return `${session.endedAt === null ? 'started' : 'ended'} ${at.toLocaleString()}`;
}

export function SessionsPage(): ReactElement {
  const { client } = useServices();
  const [tab, setTab] = useState<SessionStatus | 'all'>('all');
  const list = useSessions(client, tab);
  const roster = useRoster(client);

  const sessions = list.data?.sessions ?? [];

  return (
    <section aria-labelledby="sessions-heading">
      <h2 id="sessions-heading">Sessions</h2>

      <div className="board__filters" role="tablist" aria-label="Session status">
        {TABS.map((one) => (
          <button
            key={one.key}
            type="button"
            role="tab"
            className="chip"
            aria-selected={tab === one.key}
            onClick={() => setTab(one.key)}
          >
            {one.label}
          </button>
        ))}
      </div>

      {list.isError ? (
        <p className="notice" data-tone="danger" role="alert">
          {failureOf(list.error)?.message ?? 'The session list could not be read.'}
        </p>
      ) : null}

      {!list.isPending && sessions.length === 0 ? (
        <p className="empty">
          {tab === 'all'
            ? 'No sessions yet. Launch an agent from the board or a project.'
            : `No ${tab} sessions.`}
        </p>
      ) : null}

      <ul className="record-list" data-region="sessions">
        {/* The server's order, preserved. */}
        {sessions.map((session) => {
          const agent = roster.data?.agents.find((one) => one.definition.id === session.agentId);
          return (
            <li key={session.id} className="record-row" data-session-id={session.id}>
              <Link className="record-row__name" to={`/sessions/${encodeURIComponent(session.id)}`}>
                {agent === undefined ? (
                  // A deleted agent's sessions stay readable; the transcript is
                  // the record, not the roster entry (§9.4).
                  <span>deleted agent</span>
                ) : (
                  <>
                    <Avatar
                      agentId={agent.definition.id}
                      name={agent.definition.name}
                      avatar={agent.definition.avatar}
                    />
                    <span>{agent.definition.name}</span>
                  </>
                )}
              </Link>
              <div className="record-row__badges">
                {/* runner's vocabulary, verbatim (§9.2). */}
                <span className="badge" data-status={session.status}>
                  {session.status}
                </span>
                {session.exitReason === null ? null : (
                  <span className="badge">{session.exitReason.replaceAll('_', ' ')}</span>
                )}
                {session.model === null ? null : <span className="badge">{session.model}</span>}
                {session.origin === 'remote' ? <span className="badge">remote</span> : null}
                {session.pinned ? <span className="badge">pinned</span> : null}
                {session.transcriptPath === null ? (
                  <span className="badge" data-tone="warn">
                    transcript pruned
                  </span>
                ) : null}
              </div>
              {session.summary === null ? null : (
                <p className="record-row__summary">{session.summary}</p>
              )}
              <p className="record-row__meta">
                <span>{when(session)}</span>
                <Link to={`/projects/${encodeURIComponent(session.projectId)}`}>project</Link>
                <Link to={`/assignments/${encodeURIComponent(session.assignmentId)}`}>
                  assignment
                </Link>
              </p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
