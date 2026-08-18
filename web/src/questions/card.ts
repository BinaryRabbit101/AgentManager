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

/**
 * The call the card is gating, as the two lines a human needs to decide it.
 *
 * "Allow the agent to use Bash?" is not a decision anyone can make: the whole
 * question is *which* Bash. orchestrator §11.1 carries the call on the card as
 * `context.toolName` / `context.toolInput` precisely so the answer can be an
 * informed one, and until now the inbox dropped it on the floor.
 *
 * The value is the agent's own tool input and is therefore untrusted (§1.4), so
 * it goes into the DOM as text — never markup — and the renderer puts it in a
 * `<pre>` that scrolls in its own container (§15).
 */
export interface GatedCall {
  readonly toolName: string;
  /** One line for the header — the command, the path, the URL (§9.2's preview). */
  readonly summary: string | undefined;
  /** The whole input, pretty-printed, for the expandable detail. */
  readonly detail: string | undefined;
}

/** The fields worth promoting to the one-line summary, most specific first. */
const SUMMARY_FIELDS: readonly string[] = [
  'command',
  'file_path',
  'path',
  'url',
  'pattern',
  'query',
  'description',
  'prompt',
];

export function gatedCall(card: QuestionCard): GatedCall | undefined {
  const toolName = card.context?.toolName;
  if (toolName === undefined || toolName === '') return undefined;
  const input = card.context?.toolInput;
  return { toolName, summary: callSummary(input), detail: callDetail(input) };
}

function callSummary(input: unknown): string | undefined {
  if (typeof input === 'string') return firstLine(input);
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;
  for (const field of SUMMARY_FIELDS) {
    const value = record[field];
    if (typeof value === 'string' && value.trim() !== '') return firstLine(value);
  }
  return undefined;
}

function callDetail(input: unknown): string | undefined {
  if (input === undefined || input === null) return undefined;
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    // A tool input the agent made circular costs the detail, not the card.
    return undefined;
  }
}

function firstLine(value: string): string {
  const line = value.split('\n')[0] ?? '';
  return line.length <= 160 ? line : `${line.slice(0, 159)}…`;
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
