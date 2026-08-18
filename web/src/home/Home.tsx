/**
 * The home screen (DESIGN §2.4) — mission control.
 *
 * `/` used to be the roster board, which answers "who do I have". That is a
 * question about the *tool*; the question someone opens the app with is a
 * question about the *work*: what is waiting on me, what is running, and what
 * just happened. The board is still the board — it is `/agents` now (§2.1, §5) —
 * and this screen is the one the app opens on.
 *
 * Three regions, in the order they matter:
 *
 * 1. **Needs you** — the open question cards, answered *here*, plus the halted
 *    and awaiting-user assignments as compact rows.
 * 2. **Running now** — the live sessions, and the queued ones behind them.
 * 3. **Recently finished** — the last handful, with their outcome.
 *
 * **The cards are the inbox's cards.** §11.3 pins "one answer endpoint, one
 * shape", and that is only true if there is also one client path to it: this
 * screen renders {@link QuestionCardView} through {@link useAnswering}, the
 * inbox's own hook, so answering on home and answering at `/questions` are the
 * same POST with the same optimistic move. A second copy is how two screens
 * start disagreeing about what a card is.
 *
 * **Nothing here polls** (§16, §3.4). Each region's liveness comes from the
 * event → invalidation map, and each query key below is chosen to fall under a
 * prefix that map already invalidates — the per-region comments name which.
 *
 * **Nothing here sorts** (§4). Every list is the server's order, thinned by
 * `regions.ts`.
 */

import { useQueryClient } from '@tanstack/react-query';
import { useMemo, type ReactElement } from 'react';
import { Link } from 'react-router-dom';

import { useAssignments, useProjects, useQuestions, useRoster, useSessions } from '../api/queries';
import { failureOf } from '../api/result';
import type { AgentView, SessionRecord } from '../api/types';
import { useServices } from '../app/AppContext';
import { phaseWord } from '../assignments/conversation';
import { Avatar } from '../board/Avatar';
import { Icon } from '../icons/Sprite';
import { QuestionCardView } from '../questions/QuestionCardView';
import { AnsweringNotices, useAnswering } from '../questions/QuestionInbox';
import { useAppStore } from '../state/store';

import { attentionAssignments, elapsedLabel, recentlyFinished } from './regions';

/**
 * One session, as the same compact row in both session regions.
 *
 * The agent may have been deleted since the run — the transcript is the record,
 * not the roster entry (§9.4) — so a row still draws in full without one.
 */
function SessionRow({
  session,
  agent,
  projectName,
  when,
}: {
  readonly session: SessionRecord;
  readonly agent: AgentView | undefined;
  readonly projectName: string;
  readonly when: string;
}): ReactElement {
  return (
    <li className="record-row home-row" data-session-id={session.id}>
      <Link className="record-row__name" to={`/sessions/${encodeURIComponent(session.id)}`}>
        {agent === undefined ? (
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
        {/* runner's word, verbatim — colour is never the only carrier (§15). */}
        <span className="badge" data-status={session.status}>
          {session.status}
        </span>
        {session.exitReason === null ? null : (
          <span className="badge">{session.exitReason.replaceAll('_', ' ')}</span>
        )}
      </div>
      {session.summary === null ? null : <p className="record-row__summary">{session.summary}</p>}
      <p className="record-row__meta">
        <span>{projectName}</span>
        <span data-elapsed="true">{when}</span>
      </p>
    </li>
  );
}

export function Home(): ReactElement {
  const { client } = useServices();
  const queryClient = useQueryClient();
  const openLaunch = useAppStore((store) => store.openLaunch);

  /*
    Seven queries, one per thing on screen, and every one of them a key another
    screen already uses — so arriving here warms the caches the board, the
    inbox and the two indexes read, rather than duplicating them. None of them
    is a new endpoint and none of them polls:

    - `['questions', …]`   invalidated by `assignment.question.*` (§3.4).
    - `['assignments', …]` invalidated by every `assignment.*` frame.
    - `['sessions', …]`    invalidated by the session lifecycle frames.
    - `['roster', …]`      invalidated by `roster.*`; `['projects']` by
      `project.*` *and* by the session lifecycle, which is what moves a
      project's `lastActivityAt`.
  */
  const questions = useQuestions(client, 'open');
  const assignments = useAssignments(client, 'open');
  const running = useSessions(client, 'running');
  const queued = useSessions(client, 'queued');
  const history = useSessions(client, 'all');
  const roster = useRoster(client);
  const projects = useProjects(client);

  const { busyId, failures, notices, answer } = useAnswering(client, queryClient);

  const agentsById = useMemo(() => {
    const map = new Map<string, AgentView>();
    for (const agent of roster.data?.agents ?? []) map.set(agent.definition.id, agent);
    return map;
  }, [roster.data]);

  const projectsById = useMemo(() => {
    const map = new Map<string, string>();
    for (const project of projects.data?.projects ?? []) map.set(project.id, project.name);
    return map;
  }, [projects.data]);

  const now = Date.now();
  const cards = questions.data?.questions ?? [];
  const attention = attentionAssignments(assignments.data?.assignments ?? []);
  const live = [...(running.data?.sessions ?? []), ...(queued.data?.sessions ?? [])];
  const finished = recentlyFinished(history.data?.sessions ?? []);
  /** Not "nothing is running" but "nothing has ever run" — a different sentence. */
  const nothingEverRan = live.length === 0 && (history.data?.sessions.length ?? 0) === 0;

  const nameOfProject = (id: string): string => projectsById.get(id) ?? id;

  return (
    <div className="home">
      {/* --- 1. Needs you ------------------------------------------------- */}
      <section className="home-region" aria-labelledby="home-needs-heading">
        <div className="home-region__head">
          <h2 id="home-needs-heading">Needs you</h2>
        </div>

        {questions.isError ? (
          <p className="notice" data-tone="danger" role="alert">
            {failureOf(questions.error)?.message ?? 'The open questions could not be read.'}
          </p>
        ) : null}

        {/* An "Always allow" answer is two writes; the second reports here,
            because its card has left this region by the time it lands. */}
        <AnsweringNotices notices={notices} />

        {/* The inbox's own card and the inbox's own answer path (§11.3). */}
        <ul className="question-list">
          {cards.map((card) => (
            <QuestionCardView
              key={card.id}
              card={card}
              now={now}
              busy={busyId === card.id}
              failureMessage={failures[card.id]}
              onAnswer={answer}
            />
          ))}
        </ul>

        {/*
          A halted or awaiting-user assignment is not a card to answer — it is a
          place to go — so it is a row with a link rather than anything that
          pretends to be answerable here (§10.2's phases, read never derived).
        */}
        {attention.length === 0 ? null : (
          <ul className="record-list" data-region="attention">
            {attention.map((assignment) => (
              <li key={assignment.id} className="record-row home-row" data-assignment-id={assignment.id}>
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
                  {assignment.haltReason === null ? null : (
                    <span className="badge" data-tone="warn">
                      {assignment.haltReason.replaceAll('_', ' ')}
                    </span>
                  )}
                </div>
                <p className="record-row__meta">
                  <span>{nameOfProject(assignment.projectId)}</span>
                </p>
              </li>
            ))}
          </ul>
        )}

        {/* Calm, not apologetic: the good state is stated plainly and once. */}
        {cards.length === 0 && attention.length === 0 && !questions.isPending ? (
          <p className="empty">Nothing needs you.</p>
        ) : null}
      </section>

      {/* --- 2. Running now ----------------------------------------------- */}
      <section className="home-region" aria-labelledby="home-running-heading">
        <div className="home-region__head">
          <h2 id="home-running-heading">Running now</h2>
          {/*
            §5.4's rule reaches home too: starting work is one flow, reached
            from several screens. This is another way in, not another flow —
            with neither seat filled, because home knows neither.
          */}
          <button
            type="button"
            className="button"
            data-variant="primary"
            onClick={() => {
              openLaunch({ agentId: null, projectId: null, origin: 'home' });
            }}
          >
            <Icon name="plus" />
            <span>Start work</span>
          </button>
        </div>

        {running.isError ? (
          <p className="notice" data-tone="danger" role="alert">
            {failureOf(running.error)?.message ?? 'The running sessions could not be read.'}
          </p>
        ) : null}

        <ul className="record-list" data-region="running">
          {live.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              agent={agentsById.get(session.agentId)}
              projectName={nameOfProject(session.projectId)}
              when={
                session.status === 'queued'
                  ? 'waiting for a slot'
                  : `running for ${elapsedLabel(session.startedAt, now) ?? 'a moment'}`
              }
            />
          ))}
        </ul>

        {live.length === 0 && !running.isPending ? (
          <p className="empty">
            {nothingEverRan ? (
              <>
                Nothing has run yet. <Link to="/projects">Launch an agent at a project</Link> to see
                it here.
              </>
            ) : (
              'Nothing is running.'
            )}
          </p>
        ) : null}
      </section>

      {/* --- 3. Recently finished ----------------------------------------- */}
      <section className="home-region" aria-labelledby="home-recent-heading">
        <div className="home-region__head">
          <h2 id="home-recent-heading">Recently finished</h2>
          <Link className="home-region__more" to="/sessions">
            All sessions
          </Link>
        </div>

        {history.isError ? (
          <p className="notice" data-tone="danger" role="alert">
            {failureOf(history.error)?.message ?? 'The session history could not be read.'}
          </p>
        ) : null}

        <ul className="record-list" data-region="recent">
          {finished.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              agent={agentsById.get(session.agentId)}
              projectName={nameOfProject(session.projectId)}
              when={session.endedAt === null ? 'ended' : new Date(session.endedAt).toLocaleString()}
            />
          ))}
        </ul>

        {finished.length === 0 && !history.isPending ? (
          <p className="empty">
            {nothingEverRan ? (
              <>
                Nothing has finished yet. <Link to="/projects">Launch an agent at a project</Link> to
                start a run.
              </>
            ) : (
              'Nothing has finished yet.'
            )}
          </p>
        ) : null}
      </section>
    </div>
  );
}
