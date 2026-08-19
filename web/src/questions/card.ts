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

// ---------------------------------------------------------------------------
// "Always allow" — runner §5.1's third option (owner decision 2026-08-18)
// ---------------------------------------------------------------------------

/** Runner's option id. The UI matches it; it never invents it (§11.2). */
/**
 * Who is asking and what a deny costs — WO4 addendum §6's "one line".
 *
 * Two facts, both the server's, both optional:
 *
 * - **The seat.** "Allow the agent to use Bash?" is unanswerable in a pair
 *   because it does not say *which* agent's work stops. `seatRole` and
 *   `pattern` come off the card's context, which the runner fills from the
 *   assignment context it already fetched at launch.
 * - **The artifact.** Only when the gated input itself names
 *   `scope.artifactPath`. That is a fact about the call being approved, not a
 *   prediction about the agent — a drafter denied `Bash` may well write its
 *   draft with `Write` instead, and a card that said otherwise would frighten
 *   a user out of a correct deny. The broader dependency ("this seat probably
 *   needs this tool to finish") is deliberately left for a later WO.
 *
 * `undefined` when the card carries neither, which is every card raised before
 * the runner started sending them and every `AskUserQuestion`.
 */
export function denyConsequence(card: QuestionCard): string | undefined {
  const seatRole = card.context?.seatRole;
  const pattern = card.context?.pattern;
  const round = card.context?.round;
  const artifactPath = card.context?.artifactPath;

  const parts: string[] = [];
  if (seatRole !== undefined && seatRole !== '') {
    const where =
      pattern === undefined || pattern === '' || pattern === 'solo'
        ? `the ${seatRole} seat`
        : `the ${seatRole} seat of this ${pattern}`;
    // The round only when there is one. A solo has no driver and therefore no
    // turn rows (orchestrator §2.3), and "round undefined" is not a sentence.
    parts.push(
      typeof round === 'number' && round > 0
        ? `Asked by ${where}, round ${String(round)}.`
        : `Asked by ${where}.`,
    );
  }
  if (artifactPath !== undefined && artifactPath !== '') {
    parts.push(`Denying this stops ${artifactPath} being written by this call.`);
  }
  return parts.length === 0 ? undefined : parts.join(' ');
}

export const ALLOW_ALWAYS_OPTION_ID = 'allow-always';

/**
 * The agent and rule an **Always allow** click would write, or `undefined`.
 *
 * Both halves come off the card, and both must be there. Runner puts
 * `context.durableRule` on a tool gate only when a rule can be written that
 * honestly describes the call, and puts the option in `options` at the same
 * time — so a card carrying the option but not the rule (an older core, a
 * hand-rolled fixture) yields nothing here and the button is not rendered.
 * Guessing the rule client-side is the one thing this must never do: the user
 * approves the string they were shown, and a second derivation would eventually
 * show them a different one.
 */
export interface DurableAllow {
  readonly agentId: string;
  readonly rule: string;
}

export function durableAllow(card: QuestionCard): DurableAllow | undefined {
  const rule = card.context?.durableRule;
  const agentId = card.context?.agentId;
  if (rule === undefined || rule === '' || agentId === undefined || agentId === '') {
    return undefined;
  }
  if (!card.options.some((option) => option.id === ALLOW_ALWAYS_OPTION_ID)) return undefined;
  return { agentId, rule };
}

/**
 * What the card says **before** the click.
 *
 * §11.2's whole argument about the gated call applies twice over here: a button
 * labelled only "Always allow" asks the user to approve a scope they cannot see.
 * The rule is the scope, so the rule is on the button.
 */
export function alwaysAllowPreview(target: DurableAllow): string {
  return `adds ${target.rule} to ${target.agentId}`;
}

/** The success line. It says *when* the rule applies, because it is not now. */
export function alwaysAllowRememberedMessage(target: DurableAllow): string {
  return (
    `Allowed, and remembered for ${target.agentId}: ${target.rule} — applies from its next ` +
    'session. Manage in the agent editor.'
  );
}

/**
 * The half-success line.
 *
 * The call ran; the remembering did not. Saying so — with the server's own
 * message — is the only honest option: a user who believes a rule was saved
 * stops watching for the card to come back.
 */
export function alwaysAllowFailedMessage(target: DurableAllow, serverMessage: string): string {
  return (
    `The call was allowed, but the standing permission was not saved for ${target.agentId}: ` +
    `${target.rule} — ${serverMessage}`
  );
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
