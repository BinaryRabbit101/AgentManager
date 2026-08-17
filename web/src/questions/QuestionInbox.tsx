/**
 * The question inbox (DESIGN §11) — the screen that completes the core loop.
 *
 * > "Each row is the full card — there is no list-then-detail dance, because an
 * > inbox that requires two taps per question is an inbox that goes unanswered."
 *
 * **One request, cold — on both routes.** orchestrator §11.1's list projection
 * carries the recommendations inline and the assignment / project / session ids
 * denormalised, so nothing here fetches a roster, a project or an assignment to
 * draw a card; `/questions` reads the list for the tab it is showing, and
 * `/questions/:id` reads that one card. IMPLEMENTATION §5 makes a second request
 * on a cold load a milestone failure, and the request count is the assertion.
 *
 * `/questions/:id` is the ntfy deep-link target (§2.1, orchestrator §10), so
 * arriving there cold with no prior state must produce an **answerable** card,
 * not a link to one.
 *
 * **No remote branch at all** (§11.3): answering is in remote's ungated Observe
 * tier, so "does this work remotely?" is not a question this code asks.
 */

import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { Link, useParams } from 'react-router-dom';

import type { ApiClient } from '../api/client';
import { queryKeys, useQuestion, useQuestions } from '../api/queries';
import { failureOf } from '../api/result';
import type { QuestionCard, QuestionListView, QuestionStatus } from '../api/types';
import { useServices } from '../app/AppContext';
import { useAppStore } from '../state/store';

import { QuestionCardView } from './QuestionCardView';

interface Answering {
  readonly busyId: string | null;
  readonly failures: Readonly<Record<string, string>>;
  readonly answer: (card: QuestionCard, body: Record<string, unknown>) => void;
}

/**
 * `POST /api/questions/:id/answer` — one endpoint, local and remote alike.
 *
 * The optimistic move is small on purpose: the card leaves Open and appears in
 * Answered immediately, and the *server's* returned card is what lands there, so
 * the optimism is about **when** the screen changes rather than about **what** it
 * claims. The session the card belongs to is invalidated, because §11.3's real
 * consequence — an inline resolve or an auto-resume — happens over there.
 */
function useAnswering(client: ApiClient, queryClient: QueryClient): Answering {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [failures, setFailures] = useState<Readonly<Record<string, string>>>({});
  const setOpenQuestions = useAppStore((store) => store.setOpenQuestions);

  const answer = useCallback(
    (card: QuestionCard, body: Record<string, unknown>) => {
      setBusyId(card.id);
      void (async () => {
        const result = await client.request<QuestionCard>(
          `/questions/${encodeURIComponent(card.id)}/answer`,
          { method: 'POST', body },
        );
        setBusyId(null);
        if (result.kind !== 'ok') {
          // The server's message, verbatim — a `question_not_open` 409 is the
          // honest answer to "someone answered this on the phone first".
          setFailures((current) => ({ ...current, [card.id]: result.message }));
          return;
        }

        const settled: QuestionCard =
          result.value ?? ({ ...card, status: 'answered' } satisfies QuestionCard);
        queryClient.setQueryData<QuestionCard>(queryKeys.question(card.id), settled);
        queryClient.setQueryData<QuestionListView>(queryKeys.questions('open'), (current) =>
          current === undefined
            ? current
            : { questions: current.questions.filter((one) => one.id !== card.id) },
        );
        queryClient.setQueryData<QuestionListView>(queryKeys.questions('answered'), (current) =>
          current === undefined
            ? current
            : { questions: [settled, ...current.questions.filter((one) => one.id !== card.id)] },
        );
        const open = useAppStore.getState().openQuestions;
        if (open !== null) setOpenQuestions(Math.max(0, open - 1));
        if (card.sessionId !== null) {
          await queryClient.invalidateQueries({ queryKey: queryKeys.session(card.sessionId) });
        }
      })();
    },
    [client, queryClient, setOpenQuestions],
  );

  return { busyId, failures, answer };
}

/** `/questions` — the list, one request for the tab being shown. */
function InboxList(): ReactElement {
  const { client } = useServices();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<QuestionStatus>('open');
  const list = useQuestions(client, tab);
  const { busyId, failures, answer } = useAnswering(client, queryClient);
  const setOpenQuestions = useAppStore((store) => store.setOpenQuestions);

  const openCount = tab === 'open' ? list.data?.questions.length : undefined;
  useEffect(() => {
    if (openCount !== undefined) setOpenQuestions(openCount);
  }, [openCount, setOpenQuestions]);

  const now = Date.now();
  const cards = list.data?.questions ?? [];

  return (
    <section aria-labelledby="questions-heading">
      <h2 id="questions-heading">Questions</h2>

      <div className="board__filters" role="tablist" aria-label="Question status">
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
          aria-selected={tab === 'answered'}
          onClick={() => setTab('answered')}
        >
          Answered
        </button>
      </div>

      {list.isError ? (
        <p className="notice" data-tone="danger" role="alert">
          {failureOf(list.error)?.message ?? 'The inbox could not be read.'}
        </p>
      ) : null}

      {!list.isPending && cards.length === 0 ? (
        <p className="empty">
          {tab === 'open' ? 'Nothing is waiting on you.' : 'No answered questions yet.'}
        </p>
      ) : null}

      <ul className="question-list">
        {/* The server's order, preserved. Nothing here sorts (§11.2). */}
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
    </section>
  );
}

/** `/questions/:id` — the deep link. One request, and the card is answerable. */
function InboxOne({ id }: { readonly id: string }): ReactElement {
  const { client } = useServices();
  const queryClient = useQueryClient();
  const card = useQuestion(client, id);
  const { busyId, failures, answer } = useAnswering(client, queryClient);
  const now = Date.now();

  return (
    <section aria-labelledby="questions-heading">
      <h2 id="questions-heading">Question</h2>
      <p>
        <Link to="/questions">All questions</Link>
      </p>

      {card.isError ? (
        <p className="notice" data-tone="danger" role="alert">
          {failureOf(card.error)?.message ?? 'That question could not be read.'}
        </p>
      ) : null}

      {card.isPending ? <p className="empty">Loading the card…</p> : null}

      <ul className="question-list">
        {card.data === undefined ? null : (
          <QuestionCardView
            card={card.data}
            now={now}
            busy={busyId === card.data.id}
            failureMessage={failures[card.data.id]}
            onAnswer={answer}
          />
        )}
      </ul>
    </section>
  );
}

export function QuestionInbox(): ReactElement {
  const { id } = useParams();
  return id === undefined ? <InboxList /> : <InboxOne id={id} />;
}
