/**
 * The assignment / collaboration view (DESIGN §10; IMPLEMENTATION §9).
 *
 * > "Where 'collaborations render as a readable conversation between the
 * > agents, not two disconnected terminals' is actually delivered."
 *
 * Two requests and no join: `GET /api/assignments/:id` for the header and
 * `…/conversation` for the body (§10.1). **The ordering is the server's** — the
 * rounds arrive ordered, the entries inside them arrive ordered, and nothing
 * here sorts. The two-column desktop layout is a visual affordance laid over
 * that order (§10.2), never a re-ordering of it, which is why every entry also
 * carries its own attribution row: on a phone the columns collapse and identity
 * has to survive the collapse (§2.3).
 *
 * Three rules this screen is built to keep, each asserted:
 *
 * - **The budget is tokens.** No currency figure appears anywhere in this view
 *   (orchestrator §16.8), and a string assertion over the rendered output holds
 *   the line.
 * - **Members and pattern are immutable.** `PATCH /api/assignments/:id` accepts
 *   `tokenBudget`, `roundCap` and `goal` only, so the UI offers no control for
 *   anything else — inventing one would be inventing backend behaviour (§18-5).
 * - **A solo assignment is not a special case** (§10.3): one seat, no round
 *   strip, same component.
 */

import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useState, type ReactElement } from 'react';
import { Link, useParams } from 'react-router-dom';

import { useAssignment, useConversation, useRoster, queryKeys } from '../api/queries';
import { failureOf } from '../api/result';
import type {
  AgentView,
  AssignmentView,
  ConversationEntry,
  ConversationMessageEntry,
  ConversationQuestionEntry,
  ConversationRound,
  ConversationTurnEntry,
} from '../api/types';
import { useServices } from '../app/AppContext';
import { Avatar } from '../board/Avatar';
import { KIND_LABELS, STRENGTH_EMPHASIS, strengthWord } from '../questions/card';
import { useAppStore } from '../state/store';

import {
  attribution,
  budgetLine,
  closeWord,
  bannerFor,
  deliveryWord,
  entryKey,
  isSolo,
  isUnseen,
  phaseWord,
  roundPips,
  seatColumn,
  seatsOf,
  turnStatusNote,
} from './conversation';

/** The seat order §10.2 alternates on; `GET /api/patterns` carries the real one. */
const DEFAULT_SEAT_ORDER: readonly string[] = ['drafter', 'critic'];

export function AssignmentPage(): ReactElement {
  const { id = '' } = useParams();
  const { client } = useServices();
  const assignment = useAssignment(client, id);
  const conversation = useConversation(client, id);
  const roster = useRoster(client);

  const namesById = useMemo(() => {
    const map = new Map<string, AgentView>();
    for (const agent of roster.data?.agents ?? []) map.set(agent.definition.id, agent);
    return map;
  }, [roster.data]);

  if (assignment.isPending) {
    return (
      <section className="assignment">
        <h2>Assignment</h2>
        <p className="empty">Reading the assignment…</p>
      </section>
    );
  }

  if (assignment.isError || assignment.data === undefined) {
    return (
      <section className="assignment">
        <h2>Assignment</h2>
        <p className="notice" data-tone="danger" role="alert">
          {failureOf(assignment.error)?.message ?? 'That assignment could not be read.'}
        </p>
      </section>
    );
  }

  const view = assignment.data;
  const banner = bannerFor(view);
  const solo = isSolo(view);
  const budget = budgetLine(view.tokensUsed, view.tokenBudget);
  const pips = roundPips(view.roundsUsed, view.roundCap);

  return (
    <section className="assignment" aria-labelledby="assignment-heading">
      {/*
        §10.2: phase, rounds and budget are "always visible, because the round
        cap and the budget are the two things that decide when this stops". The
        header is sticky in the stylesheet so they survive scrolling the
        conversation; on a phone it is the first thing above the fold.
      */}
      <header className="assignment__header" data-phase={view.phase}>
        <h2 id="assignment-heading">{view.goal ?? 'Assignment'}</h2>
        <p className="assignment__facts">
          <span className="badge" data-pattern={view.pattern}>
            {view.pattern}
          </span>
          <span className="badge" data-phase-chip={view.phase}>
            {phaseWord(view.phase)}
          </span>
          <Link to={`/projects/${encodeURIComponent(view.projectId)}`}>{view.projectId}</Link>
          {view.artifactPath === null ? null : (
            <span className="assignment__artifact" data-artifact={view.artifactPath}>
              artifact: {view.artifactPath}
            </span>
          )}
        </p>

        <ul className="assignment__seats">
          {seatsOf(view).map((member) => {
            const agent = namesById.get(member.agentId);
            return (
              <li
                key={`${member.agentId}-${String(member.seatOrder)}`}
                data-seat-order={member.seatOrder}
              >
                <Avatar
                  agentId={member.agentId}
                  name={agent?.definition.name ?? member.agentId}
                  avatar={agent?.definition.avatar}
                />
                <span className="assignment__seat-name">
                  {agent?.definition.name ?? member.agentId}
                </span>
                <span className="assignment__seat-role">{member.role}</span>
              </li>
            );
          })}
        </ul>

        {view.scope === null || view.scope.paths.length === 0 ? null : (
          <p className="assignment__scope">Scope: {view.scope.paths.join(', ')}</p>
        )}

        {/* §10.2's progress strip. Solo has no rounds, so it has no pips. */}
        <div className="assignment__progress">
          {solo || pips.length === 0 ? (
            <span data-rounds="none">
              {solo ? 'One seat, no rounds' : `Round ${String(view.roundsUsed)}`}
            </span>
          ) : (
            <span className="assignment__rounds" data-rounds-used={view.roundsUsed}>
              <span className="visually-hidden">
                {`Round ${String(view.roundsUsed)} of ${String(view.roundCap ?? 0)}`}
              </span>
              <span aria-hidden="true">{`Round ${String(view.roundsUsed)} of ${String(view.roundCap ?? 0)}`}</span>
              <span className="assignment__pips">
                {pips.map((pip) => (
                  <span
                    key={pip.index}
                    className="assignment__pip"
                    data-done={pip.done ? 'true' : 'false'}
                    aria-hidden="true"
                  />
                ))}
              </span>
            </span>
          )}
          {/* Tokens, never money (§16.8). */}
          <span className="assignment__budget" data-budget="tokens">
            <span
              className="assignment__budget-bar"
              data-fraction={budget.fraction === null ? 'none' : budget.fraction.toFixed(2)}
              style={
                budget.fraction === null
                  ? undefined
                  : { ['--fill' as string]: `${String(Math.round(budget.fraction * 100))}%` }
              }
              aria-hidden="true"
            />
            {budget.text}
          </span>
        </div>
      </header>

      {banner === undefined ? null : (
        <p className="notice" data-tone={banner.tone} data-banner={view.phase} role="note">
          <strong>{banner.heading}</strong> {banner.detail}{' '}
          {banner.linkToQuestions ? <Link to="/questions">Open the inbox</Link> : null}
        </p>
      )}

      {view.status === 'closed' && banner === undefined ? (
        <p className="notice" data-tone="info" data-banner="closed">
          Closed because {closeWord(view.closeReason)}.
        </p>
      ) : null}

      <AssignmentActions assignment={view} />

      {conversation.isPending ? (
        <p className="empty">Reading the conversation…</p>
      ) : conversation.isError || conversation.data === undefined ? (
        <p className="notice" data-tone="danger" role="alert">
          {failureOf(conversation.error)?.message ?? 'The conversation could not be read.'}
        </p>
      ) : conversation.data.rounds.length === 0 ? (
        <p className="empty">
          {solo
            ? 'Nothing has been said yet — a solo assignment does its work in its session.'
            : 'No rounds yet.'}
        </p>
      ) : (
        <ol className="assignment__rounds-list">
          {conversation.data.rounds.map((round) => (
            <li key={round.round}>
              <RoundSection round={round} agents={namesById} solo={solo} />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function RoundSection({
  round,
  agents,
  solo,
}: {
  readonly round: ConversationRound;
  readonly agents: ReadonlyMap<string, AgentView>;
  readonly solo: boolean;
}): ReactElement {
  return (
    <section className="assignment__round" aria-label={`Round ${String(round.round)}`}>
      {solo ? null : <h3>{`Round ${String(round.round)}`}</h3>}
      <ol className="assignment__entries">
        {round.entries.map((entry) => (
          <li key={entryKey(entry)} data-entry={entry.type}>
            <Entry entry={entry} round={round.round} agents={agents} />
          </li>
        ))}
      </ol>
    </section>
  );
}

function Entry({
  entry,
  round,
  agents,
}: {
  readonly entry: ConversationEntry;
  readonly round: number;
  readonly agents: ReadonlyMap<string, AgentView>;
}): ReactElement {
  switch (entry.type) {
    case 'turn':
      return <TurnEntry turn={entry} round={round} agents={agents} />;
    case 'message':
      return <MessageEntry message={entry} agents={agents} />;
    case 'question':
      return <QuestionEntry question={entry} agents={agents} />;
  }
}

function nameOf(agents: ReadonlyMap<string, AgentView>, agentId: string | null): string {
  if (agentId === null) return 'everyone';
  return agents.get(agentId)?.definition.name ?? agentId;
}

function TurnEntry({
  turn,
  round,
  agents,
}: {
  readonly turn: ConversationTurnEntry;
  readonly round: number;
  readonly agents: ReadonlyMap<string, AgentView>;
}): ReactElement {
  const agent = agents.get(turn.agentId);
  const who = attribution(turn, agent?.definition.name);
  const note = turnStatusNote(turn);
  const verdict = turn.report?.verdict;

  return (
    <article
      className="turn"
      data-seat={turn.seat}
      data-column={seatColumn(turn.seat, DEFAULT_SEAT_ORDER)}
      data-status={turn.status}
    >
      {/*
        The attribution row, always present. On desktop the column carries the
        seat too; on a phone the columns stack and this row is all there is
        (§2.3), so identity can never depend on which side something sits.
      */}
      <p className="turn__who">
        <Avatar
          agentId={turn.agentId}
          name={agent?.definition.name ?? turn.agentId}
          avatar={agent?.definition.avatar}
        />
        <span className="turn__name">{who.line}</span>
        <span className="turn__round">{`round ${String(round)}`}</span>
      </p>

      {turn.report === null ? null : (
        <p className="turn__headline">
          <strong>{turn.report.headline}</strong>
        </p>
      )}

      {verdict === undefined ? null : (
        <div className="turn__verdict">
          <span className="badge" data-verdict={verdict.decision}>
            {verdict.decision}
          </span>
          {verdict.blocking.length === 0 ? null : (
            <ul className="turn__blocking">
              {verdict.blocking.map((issue, index) => (
                <li key={`${issue.severity}-${String(index)}`} data-severity={issue.severity}>
                  <span className="turn__severity">{issue.severity}</span> {issue.summary}
                </li>
              ))}
            </ul>
          )}
          {verdict.nonBlocking.length === 0 ? null : (
            <details className="turn__non-blocking">
              <summary>{`${String(verdict.nonBlocking.length)} non-blocking note${
                verdict.nonBlocking.length === 1 ? '' : 's'
              }`}</summary>
              <ul>
                {verdict.nonBlocking.map((note_, index) => (
                  <li key={`${String(index)}`}>{note_}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      {note === undefined ? null : (
        <p className="turn__status" data-turn-status={turn.status}>
          {note}
        </p>
      )}

      {turn.excerpt === null || turn.excerpt === '' ? null : (
        <p className="turn__excerpt">{turn.excerpt}</p>
      )}

      {turn.report === null || turn.report.artifacts.length === 0 ? null : (
        <ul className="turn__artifacts">
          {turn.report.artifacts.map((artifact) => (
            <li key={artifact.path}>{artifact.path}</li>
          ))}
        </ul>
      )}

      {/* §10.2: "every turn links to its full session transcript". */}
      {turn.sessionId === null ? (
        <p className="turn__no-session">This turn never reached a session.</p>
      ) : (
        <Link className="turn__session" to={`/sessions/${encodeURIComponent(turn.sessionId)}`}>
          {`View ${who.name}'s full session`}
        </Link>
      )}
    </article>
  );
}

function MessageEntry({
  message,
  agents,
}: {
  readonly message: ConversationMessageEntry;
  readonly agents: ReadonlyMap<string, AgentView>;
}): ReactElement {
  return (
    <article className="message" data-delivery={message.delivery} data-kind={message.kind}>
      <p className="message__who">
        {`${nameOf(agents, message.from)} → ${nameOf(agents, message.to)}`}
        <span className="badge" data-message-kind={message.kind}>
          {message.kind}
        </span>
      </p>
      {message.body === null ? null : <p className="message__body">{message.body}</p>}
      {/*
        §16.5: "I sent it and they ignored me" and "I sent it and they never saw
        it" are different failures, so the unseen states are marked rather than
        merely coloured.
      */}
      <p className="message__delivery" data-unseen={isUnseen(message.delivery) ? 'true' : 'false'}>
        {deliveryWord(message.delivery)}
      </p>
    </article>
  );
}

function QuestionEntry({
  question,
  agents,
}: {
  readonly question: ConversationQuestionEntry;
  readonly agents: ReadonlyMap<string, AgentView>;
}): ReactElement {
  const answered = question.answer !== null;
  return (
    <article className="inline-question" data-kind={question.kind} data-answered={String(answered)}>
      <p className="inline-question__head">
        <span className="badge" data-kind-chip={question.kind}>
          {KIND_LABELS[question.kind as keyof typeof KIND_LABELS] ?? question.kind}
        </span>
        <Link to={`/questions/${encodeURIComponent(question.questionId)}`}>{question.prompt}</Link>
      </p>

      {question.disagreement ? (
        <p className="question-card__divider" data-flag="disagreement">
          The team disagrees
        </p>
      ) : null}
      {question.contested ? (
        <p className="notice" data-tone="danger" data-flag="contested">
          One seat is blocking. This decision is contested.
        </p>
      ) : null}

      {question.recommendations.length === 0 ? null : (
        <ul className="question-card__stances">
          {question.recommendations.map((recommendation, index) => (
            <li
              key={`${recommendation.agentId}-${String(index)}`}
              className="question-card__stance"
              data-strength={recommendation.strength ?? 'none'}
              data-emphasis={
                recommendation.strength === null
                  ? 'muted'
                  : STRENGTH_EMPHASIS[recommendation.strength]
              }
            >
              <span className="question-card__who">
                {nameOf(agents, recommendation.agentId)}
                {recommendation.role === null ? '' : ` · ${recommendation.role}`}
              </span>
              {/* The word, here as in the inbox (§11.2). */}
              <span className="question-card__strength">
                {strengthWord(recommendation.strength)}
              </span>
              <span className="question-card__toward">
                {recommendation.stance === null ? 'no preference' : `→ ${recommendation.stance}`}
              </span>
            </li>
          ))}
        </ul>
      )}

      <p className="inline-question__answer">
        {answered
          ? `Answered: ${
              (question.answer?.labels ?? question.answer?.optionIds ?? []).join(', ') ||
              (question.answer?.text ?? '')
            }`
          : 'Still open.'}
      </p>
    </article>
  );
}

/**
 * §10.2's actions: Advance, Close (with a reason), and the budget / round cap.
 *
 * `PATCH /api/assignments/:id` "accepts `tokenBudget`, `roundCap`, `goal` only,
 * so the UI offers no such control" for members or pattern. That sentence is
 * the entire contents of this component's form.
 */
function AssignmentActions({ assignment }: { readonly assignment: AssignmentView }): ReactElement {
  const { client } = useServices();
  const queryClient = useQueryClient();
  const pushToast = useAppStore((store) => store.pushToast);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [tokenBudget, setTokenBudget] = useState(
    assignment.tokenBudget === null ? '' : String(assignment.tokenBudget),
  );
  const [roundCap, setRoundCap] = useState(
    assignment.roundCap === null ? '' : String(assignment.roundCap),
  );
  const [goal, setGoal] = useState(assignment.goal ?? '');
  const closed = assignment.status === 'closed';

  async function call(path: string, body: unknown, method = 'POST'): Promise<void> {
    setBusy(true);
    const result = await client.request(path, { method, body });
    setBusy(false);
    if (result.kind !== 'ok') {
      // The server's message, verbatim (§3.1).
      pushToast(result.message);
      return;
    }
    await queryClient.invalidateQueries({ queryKey: queryKeys.assignment(assignment.id) });
    await queryClient.invalidateQueries({ queryKey: queryKeys.conversation(assignment.id) });
  }

  return (
    <div className="assignment__actions">
      <button
        type="button"
        className="button"
        disabled={busy || closed}
        title={closed ? 'This assignment is closed.' : undefined}
        onClick={() =>
          void call(`/assignments/${encodeURIComponent(assignment.id)}/advance`, undefined)
        }
      >
        Advance
      </button>
      <button
        type="button"
        className="button"
        disabled={busy || closed}
        onClick={() =>
          void call(`/assignments/${encodeURIComponent(assignment.id)}/close`, {
            reason: 'user_closed',
          })
        }
      >
        Close
      </button>
      <button
        type="button"
        className="button"
        aria-expanded={editing}
        onClick={() => setEditing((was) => !was)}
      >
        Edit budget &amp; round cap
      </button>

      {editing ? (
        <form
          className="assignment__edit"
          onSubmit={(event) => {
            event.preventDefault();
            void call(
              `/assignments/${encodeURIComponent(assignment.id)}`,
              {
                tokenBudget: tokenBudget === '' ? null : Number(tokenBudget),
                roundCap: roundCap === '' ? null : Number(roundCap),
                goal,
              },
              'PATCH',
            );
          }}
        >
          <label className="field">
            <span>Token budget</span>
            <input
              type="number"
              min={1}
              value={tokenBudget}
              onChange={(event) => setTokenBudget(event.target.value)}
            />
          </label>
          <label className="field">
            <span>Round cap</span>
            <input
              type="number"
              min={1}
              value={roundCap}
              onChange={(event) => setRoundCap(event.target.value)}
            />
          </label>
          <label className="field">
            <span>Goal</span>
            <input value={goal} onChange={(event) => setGoal(event.target.value)} />
          </label>
          <button type="submit" className="button" data-variant="primary" disabled={busy}>
            Save
          </button>
        </form>
      ) : null}
    </div>
  );
}
