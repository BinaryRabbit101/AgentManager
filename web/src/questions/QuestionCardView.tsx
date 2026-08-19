/**
 * One question card — **all three kinds, one component** (DESIGN §11.2).
 *
 * §16-3 pins "one inbox, three kinds", and the acceptance makes it literal: a
 * `question`, an `approval_gate` and a `budget_halt` all render from here, with
 * the right chip and the server's own options. There is no per-kind branch
 * beyond the chip, because there is no per-kind *behaviour* — one answer
 * endpoint, one shape, local and remote alike (§11.3).
 *
 * The row of rules this file is built to satisfy, each of which is asserted:
 *
 * - the stance is the **word**, with emphasis and colour on top of it — never a
 *   number, a bar or a percentage;
 * - the order of recommendations is the server's; nothing here sorts;
 * - `disagreement` and `contested` are **read flags**, so flipping them in a
 *   fixture changes the rendering and nothing else does;
 * - the options are `options_json` verbatim, with no invented "do nothing";
 * - the expiry is a countdown and there is no default-on-timeout affordance.
 */

import { useState, type ReactElement } from 'react';
import { Link } from 'react-router-dom';

import type { QuestionCard } from '../api/types';

import {
  denyConsequence,
  ALLOW_ALWAYS_OPTION_ID,
  alwaysAllowPreview,
  askedAgo,
  askedBy,
  answerBody,
  canSubmit,
  durableAllow,
  expiryLabel,
  gatedCall,
  isEngineRaised,
  KIND_LABELS,
  STRENGTH_EMPHASIS,
  strengthWord,
  type AnswerDraft,
  type DurableAllow,
} from './card';

export interface QuestionCardViewProps {
  readonly card: QuestionCard;
  readonly now: number;
  /**
   * Answering is one POST; the parent owns the optimistic state (§11.3).
   *
   * `durable` is the second, *separate* write behind **Always allow** (runner
   * §5.1's owner decision 2026-08-18): the pending call is allowed exactly like
   * *Allow once*, and the standing permission is a roster edit the parent makes
   * afterwards. This component never composes a rule — it passes on the one the
   * server put on the card, which is the same one it just showed the user.
   */
  readonly onAnswer: (
    card: QuestionCard,
    body: Record<string, unknown>,
    durable?: DurableAllow,
  ) => void;
  readonly busy?: boolean;
  readonly failureMessage?: string | undefined;
}

export function QuestionCardView({
  card,
  now,
  onAnswer,
  busy = false,
  failureMessage,
}: QuestionCardViewProps): ReactElement {
  const [draft, setDraft] = useState<AnswerDraft>({ optionIds: [], text: '' });
  const [showCall, setShowCall] = useState(false);
  const answered = card.status !== 'open';
  // The call being gated (§11.1's `context`). "Allow the agent to use Bash?" is
  // not answerable without it.
  const call = gatedCall(card);
  const consequence = denyConsequence(card);
  // Present only when the server offered the third option *and* named the rule
  // it would add. The card shows that rule on the button, so the user approves a
  // rule rather than a vibe (runner §5.1, §11.2's argument about the gated call).
  const durable = durableAllow(card);
  const expires = expiryLabel(card.expiresAt, now);
  const asker = askedBy(card);

  const toggle = (optionId: string): void => {
    setDraft((current) => {
      if (!card.multiSelect) return { ...current, optionIds: [optionId] };
      const has = current.optionIds.includes(optionId);
      return {
        ...current,
        optionIds: has
          ? current.optionIds.filter((one) => one !== optionId)
          : [...current.optionIds, optionId],
      };
    });
  };

  return (
    <li
      className="question-card"
      data-kind={card.kind}
      data-question-id={card.id}
      data-status={card.status}
    >
      <div className="question-card__head">
        <span className="badge" data-kind-chip={card.kind}>
          {KIND_LABELS[card.kind]}
        </span>
        {card.projectId === null ? null : (
          <Link to={`/projects/${encodeURIComponent(card.projectId)}`}>{card.projectId}</Link>
        )}
        <Link to={`/assignments/${encodeURIComponent(card.assignmentId)}`}>
          {card.assignmentId}
        </Link>
      </div>

      <h3 className="question-card__prompt">
        <Link to={`/questions/${encodeURIComponent(card.id)}`}>{card.prompt}</Link>
      </h3>

      {call === undefined ? null : (
        <div className="question-card__call" data-tool={call.toolName}>
          <p className="question-card__call-head">
            <span className="badge" data-tool-name="true">
              {call.toolName}
            </span>
            {call.summary === undefined ? null : (
              <code className="question-card__call-summary">{call.summary}</code>
            )}
          </p>
          {call.detail === undefined || call.detail === call.summary ? null : (
            <details open={showCall} onToggle={(event) => setShowCall(event.currentTarget.open)}>
              <summary>Show the whole call</summary>
              {/*
                §1.4: the agent's own tool input is untrusted, so it lands as a
                text node inside a container that scrolls itself (§15).
              */}
              <pre className="question-card__call-detail">{call.detail}</pre>
            </details>
          )}
        </div>
      )}

      {/*
        WO4 addendum §6. Under the call and above the attribution, because it
        is about *this* call: one line, no nagging, and nothing at all when the
        server sent no context to say it with.
      */}
      {consequence === undefined ? null : (
        <p className="question-card__consequence" role="note">
          {consequence}
        </p>
      )}

      <p className="question-card__asked">
        {askedAgo(card.createdAt, now)}
        {asker === undefined ? null : (
          <>
            {' · asked by '}
            <span data-attribution={isEngineRaised(card) ? 'engine' : 'agent'}>{asker}</span>
          </>
        )}
      </p>

      {/* Server-computed, never derived (§16-1). */}
      {card.disagreement ? (
        <p className="question-card__divider" data-flag="disagreement">
          The team disagrees
        </p>
      ) : null}
      {card.contested ? (
        <p className="notice" data-tone="danger" data-flag="contested">
          One seat is blocking. This decision is contested.
        </p>
      ) : null}

      {card.recommendations.length === 0 ? null : (
        <ul className="question-card__stances">
          {card.recommendations.map((recommendation, index) => (
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
                {recommendation.agentId}
                {recommendation.role === null ? '' : ` · ${recommendation.role}`}
              </span>
              {/* The word. There is no number in this pipeline to leak. */}
              <span className="question-card__strength">
                {strengthWord(recommendation.strength)}
              </span>
              <span className="question-card__toward">
                {recommendation.stance === null ? 'no preference' : `→ ${recommendation.stance}`}
              </span>
              {recommendation.rationale === null ? null : (
                <p className="question-card__rationale">{recommendation.rationale}</p>
              )}
            </li>
          ))}
        </ul>
      )}

      {answered ? (
        <p className="question-card__answered" data-answered-via={card.answeredVia ?? ''}>
          {`Answered${card.answeredVia === null ? '' : ` ${card.answeredVia}`}`}
          {card.answer?.labels === undefined && card.answer?.optionIds === undefined
            ? card.answer?.text === undefined
              ? ''
              : `: ${card.answer.text}`
            : `: ${(card.answer.labels ?? card.answer.optionIds ?? []).join(', ')}`}
        </p>
      ) : (
        <div className="question-card__answer">
          {/* Options exactly as `options_json` gave them (§11.2). */}
          {card.options.map((option) => {
            // The one option that carries a second write. `durable` is undefined
            // unless the server named both the rule and the agent, so a card
            // that offers the option without them renders a button that answers
            // once — never one that silently drops the remembering.
            const remembering = option.id === ALLOW_ALWAYS_OPTION_ID ? durable : undefined;
            return (
              <button
                key={option.id}
                type="button"
                className="button question-card__option"
                data-option-id={option.id}
                {...(remembering === undefined ? {} : { 'data-durable-rule': remembering.rule })}
                aria-pressed={card.multiSelect ? draft.optionIds.includes(option.id) : undefined}
                disabled={busy}
                onClick={() => {
                  if (card.multiSelect) {
                    toggle(option.id);
                    return;
                  }
                  onAnswer(
                    card,
                    answerBody(card, { optionIds: [option.id], text: draft.text }),
                    remembering,
                  );
                }}
              >
                {option.label}
                {remembering === undefined ? null : (
                  <span className="question-card__option-rule">
                    {alwaysAllowPreview(remembering)}
                  </span>
                )}
                {option.description === undefined ? null : (
                  <span className="question-card__option-detail">{option.description}</span>
                )}
              </button>
            );
          })}

          {card.allowFreeText ? (
            <label className="field">
              <span>Or answer in your own words…</span>
              <input
                value={draft.text}
                disabled={busy}
                aria-label={`Answer ${card.prompt} in your own words`}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, text: event.target.value }))
                }
              />
            </label>
          ) : null}

          {card.multiSelect || card.allowFreeText ? (
            <button
              type="button"
              className="button"
              data-variant="primary"
              disabled={busy || !canSubmit(card, draft)}
              onClick={() => onAnswer(card, answerBody(card, draft))}
            >
              Submit
            </button>
          ) : null}

          {/*
            §16-4: expiry of an approval gate is a denial and the UI must not
            imply otherwise — so this is a label, beside nothing that acts on it.
          */}
          {expires === undefined ? null : (
            <span className="question-card__expiry" data-expiry="true">
              {expires}
            </span>
          )}
        </div>
      )}

      {failureMessage === undefined ? null : (
        <p className="notice" data-tone="danger" role="alert">
          {failureMessage}
        </p>
      )}
    </li>
  );
}
