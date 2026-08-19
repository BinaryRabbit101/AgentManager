/**
 * The assignments destination (DESIGN §2.1) — `/assignments`.
 *
 * `/assignments/:id` renders one collaboration; nothing listed them, so an
 * assignment could only be reached from a session, a question card or a project
 * page. That makes the *unit of work* the one thing in the app with no index,
 * which is backwards: an assignment outlives the sessions under it, so it is the
 * durable handle on "what was this fleet doing".
 *
 * **One request per tab.** `GET /api/assignments?status=` carries the members
 * inline, so a row draws its seats without a join; the roster is read only for
 * the human name behind an id, and it is already cached.
 *
 * The budget is **tokens** (orchestrator §16.8) — the same `budgetLine` the
 * assignment view uses, so no currency figure can appear on one screen and not
 * the other. The phase is the server's word, rendered through the same
 * `phaseWord` table for the same reason.
 */

import { useMemo, useState, type ReactElement } from 'react';
import { Link } from 'react-router-dom';

import { useAssignments, useRoster } from '../api/queries';
import { failureOf } from '../api/result';
import type { AgentView, AssignmentView } from '../api/types';
import { useServices } from '../app/AppContext';
import { Avatar } from '../board/Avatar';

import {
  budgetLine,
  closeWord,
  currentRound,
  isSolo,
  phaseInFlight,
  phaseWord,
} from './conversation';

export function AssignmentsPage(): ReactElement {
  const { client } = useServices();
  const [tab, setTab] = useState<'open' | 'closed'>('open');
  const list = useAssignments(client, tab);
  const roster = useRoster(client);

  const agentsById = useMemo(() => {
    const map = new Map<string, AgentView>();
    for (const agent of roster.data?.agents ?? []) map.set(agent.definition.id, agent);
    return map;
  }, [roster.data]);

  const assignments = list.data?.assignments ?? [];

  return (
    <section aria-labelledby="assignments-heading">
      <h2 id="assignments-heading">Assignments</h2>

      <div className="board__filters" role="tablist" aria-label="Assignment status">
        <button
          type="button"
          role="tab"
          className="chip"
          aria-selected={tab === 'open'}
          onClick={() => setTab('open')}
        >
          Open
        </button>
        <button
          type="button"
          role="tab"
          className="chip"
          aria-selected={tab === 'closed'}
          onClick={() => setTab('closed')}
        >
          Closed
        </button>
      </div>

      {list.isError ? (
        <p className="notice" data-tone="danger" role="alert">
          {failureOf(list.error)?.message ?? 'The assignment list could not be read.'}
        </p>
      ) : null}

      {!list.isPending && assignments.length === 0 ? (
        <p className="empty">
          {tab === 'open'
            ? 'Nothing is open. Launching an agent opens a solo assignment for it.'
            : 'No closed assignments yet.'}
        </p>
      ) : null}

      <ul className="record-list" data-region="assignments">
        {/* The server's order, preserved. Nothing here sorts. */}
        {assignments.map((assignment: AssignmentView) => {
          const budget = budgetLine(assignment.tokensUsed, assignment.tokenBudget);
          return (
            <li key={assignment.id} className="record-row" data-assignment-id={assignment.id}>
              <Link
                className="record-row__name"
                to={`/assignments/${encodeURIComponent(assignment.id)}`}
              >
                {assignment.goal ?? `${assignment.pattern} assignment`}
              </Link>
              <div className="record-row__badges">
                <span className="badge" data-status={assignment.phase}>
                  {phaseWord(assignment.phase)}
                </span>
                <span className="badge">{isSolo(assignment) ? 'solo' : assignment.pattern}</span>
                {assignment.write ? <span className="badge">write</span> : null}
                {assignment.haltReason === null ? null : (
                  <span className="badge" data-tone="warn">
                    {assignment.haltReason.replaceAll('_', ' ')}
                  </span>
                )}
                {assignment.closeReason === null ? null : (
                  <span className="badge">{closeWord(assignment.closeReason)}</span>
                )}
              </div>
              {/* Seats, in the server's member order. */}
              <ul className="record-row__seats">
                {assignment.members.map((member) => {
                  const agent = agentsById.get(member.agentId);
                  return (
                    <li key={`${member.agentId}-${member.role}`}>
                      {agent === undefined ? null : (
                        <Avatar
                          agentId={agent.definition.id}
                          name={agent.definition.name}
                          avatar={agent.definition.avatar}
                        />
                      )}
                      <span>{agent?.definition.name ?? member.agentId}</span>
                      <span className="record-row__seat-role">{member.role}</span>
                    </li>
                  );
                })}
              </ul>
              <p className="record-row__meta">
                {/* Tokens, never money (orchestrator §16.8). */}
                <span>{budget.text}</span>
                {/*
                  The same honest count as the assignment header: while a turn
                  is in flight this row is about the round being worked, not the
                  last one finished (§10.2).
                */}
                <span data-round-in-flight={phaseInFlight(assignment) ? 'true' : 'false'}>
                  {assignment.roundCap === null
                    ? `${String(currentRound(assignment.roundsUsed, null, phaseInFlight(assignment)))} rounds`
                    : `round ${String(currentRound(assignment.roundsUsed, assignment.roundCap, phaseInFlight(assignment)))} of ${String(assignment.roundCap)}`}
                </span>
                <Link to={`/projects/${encodeURIComponent(assignment.projectId)}`}>project</Link>
              </p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
