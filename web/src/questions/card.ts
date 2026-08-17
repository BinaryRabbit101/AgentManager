/**
 * The question card's rules, as data (DESIGN §11.2; orchestrator §16.1–§16.4).
 *
 * Everything in §11.2's table that is a *decision* lives here rather than in the
 * component, because each one is a rule the acceptance suite checks literally:
 *
 * - **Stance is the word.** "`blocking | strong | lean | defer` rendered as the
 *   word — never a number, never a bar, never a percentage. Colour is always
 *   secondary to the word." So the renderer gets a word and an emphasis, and
 *   there is no number anywhere in the pipeline to leak.
 * - **An engine-raised gate is attributed to "AgentManager", never to an agent**
 *   (§16-2).
 * - **Order is the server's** — strength rank, then seat order. `sortRecommendations`
 *   does not exist; there is nothing here that sorts.
 * - **Expiry is a countdown with no default action** (§16-4): expiry of an
 *   approval gate is a denial, and the UI must not imply otherwise, so this file
 *   offers a *label* and nothing that could be wired to a button.
 */

import type { QuestionCard, QuestionKind, QuestionStrength } from '../api/types';

/** §16-2's exact word. Never an agent name, never "the system". */
export const ENGINE_ATTRIBUTION = 'AgentManager';

/** One inbox, three kinds (§16-3), each with the chip §11.2 names. */
export const KIND_LABELS: Readonly<Record<QuestionKind, string>> = Object.freeze({
  question: 'QUESTION',
  approval_gate: 'APPROVAL',
  budget_halt: 'BUDGET',
});

/**
 * A gate nobody asked for.
 *
 * orchestrator raises `approval_gate` and `budget_halt` from the engine itself
 * (§8.1, §8.2); a card of either kind that carries no agent recommendation had no
 * asking seat, and attributing it to whichever agent happens to be in the
 * assignment would be a lie about who wants the decision.
 */
export function isEngineRaised(card: QuestionCard): boolean {
  return card.kind !== 'question' && card.recommendations.length === 0;
}

/** Who is asking, or `undefined` when the projection cannot say (see the report). */
export function askedBy(card: QuestionCard): string | undefined {
  if (isEngineRaised(card)) return ENGINE_ATTRIBUTION;
  return card.recommendations[0]?.agentId;
}

/** The word, and how loudly it is set. Colour is applied on top, never instead. */
export const STRENGTH_EMPHASIS: Readonly<
  Record<QuestionStrength, 'shout' | 'bold' | 'normal' | 'muted'>
> = Object.freeze({
  blocking: 'shout',
  strong: 'bold',
  lean: 'normal',
  defer: 'muted',
});

export function strengthWord(strength: QuestionStrength | null): string {
  if (strength === null) return 'no stance';
  return strength === 'blocking' ? 'BLOCKING' : strength;
}

/**
 * `expiresAt` as a countdown (§11.2).
 *
 * There is **no** timeout-default affordance anywhere near this: the label says
 * when the card dies, and orchestrator §16-4 decides what that means (denial).
 */
export function expiryLabel(expiresAt: string | null, now: number): string | undefined {
  if (expiresAt === null) return undefined;
  const remaining = new Date(expiresAt).getTime() - now;
  if (Number.isNaN(remaining)) return undefined;
  if (remaining <= 0) return 'expired';
  const minutes = Math.floor(remaining / 60_000);
  if (minutes < 60) return `expires in ${String(Math.max(1, minutes))}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `expires in ${String(hours)}h`;
  return `expires in ${String(Math.floor(hours / 24))}d`;
}

/** "asked 4 min ago" — the card's own timestamp, phrased (§11.2's diagram). */
export function askedAgo(createdAt: string, now: number): string {
  const elapsed = Math.max(0, now - new Date(createdAt).getTime());
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return 'asked just now';
  if (minutes < 60) return `asked ${String(minutes)} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `asked ${String(hours)}h ago`;
  return `asked ${String(Math.floor(hours / 24))}d ago`;
}

/** What the answer POST carries. The UI never invents an option (§4, §11.2). */
export interface AnswerDraft {
  readonly optionIds: readonly string[];
  readonly text: string;
}

export function answerBody(card: QuestionCard, draft: AnswerDraft): Record<string, unknown> {
  const trimmed = draft.text.trim();
  return {
    ...(draft.optionIds.length === 0 ? {} : { optionIds: draft.optionIds }),
    ...(card.allowFreeText && trimmed !== '' ? { text: trimmed } : {}),
  };
}

export function canSubmit(card: QuestionCard, draft: AnswerDraft): boolean {
  if (draft.optionIds.length > 0) return true;
  return card.allowFreeText && draft.text.trim() !== '';
}
