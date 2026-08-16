/**
 * `sessions.summary` (runner DESIGN §8.3).
 *
 * "Runner maintains the one-line digest projects' timeline renders from, so no
 * timeline read ever opens a transcript." Composition is fixed so it stays
 * predictable:
 *
 * ```
 * summary = `${truncate(firstUserPrompt, 100)} — ${outcome}` +
 *           (lastAssistantText ? `: ${truncate(lastAssistantText, 120)}` : '')
 * ```
 *
 * Truncation is on a **grapheme** boundary, not a code-unit one: a prompt that
 * ends in an emoji, a flag, or a combining accent would otherwise be cut into
 * lone surrogates and render as a replacement character in the timeline. The
 * whole string is bounded at 240 characters, on the same boundary.
 */
import type { SessionStatus } from '../../storage/index.js';

/** §8.3's ceiling on the whole digest. */
export const SUMMARY_MAX_LENGTH = 240;

/** §8.3's per-part budgets. */
export const PROMPT_MAX_LENGTH = 100;
export const ASSISTANT_MAX_LENGTH = 120;

const ELLIPSIS = '…';

const segmenter =
  typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter('en', { granularity: 'grapheme' })
    : undefined;

/**
 * Cuts `text` to at most `max` characters, ending on a grapheme boundary and
 * marking the cut with an ellipsis.
 *
 * The ellipsis is inside the budget: `truncate(x, 100).length <= 100` always,
 * which is what lets §8.3's three parts add up to a bounded total.
 */
export function truncate(text: string, max: number): string {
  const collapsed = text.replace(/\s+/gu, ' ').trim();
  if (collapsed.length <= max) return collapsed;
  if (max <= 1) return ELLIPSIS.slice(0, Math.max(0, max));

  const budget = max - ELLIPSIS.length;
  if (segmenter === undefined) {
    // No `Intl.Segmenter` (never true on Node 22, but the fallback keeps the
    // function total): cut at a code-point boundary, which at least never
    // splits a surrogate pair.
    return `${[...collapsed].slice(0, budget).join('')}${ELLIPSIS}`;
  }

  let out = '';
  for (const { segment } of segmenter.segment(collapsed)) {
    if (out.length + segment.length > budget) break;
    out += segment;
  }
  return `${out.trimEnd()}${ELLIPSIS}`;
}

/**
 * §8.3's "plain word derived from the terminal status".
 *
 * `running` and `queued` are here because the digest is written **twice** — at
 * admission, so a live session already has a readable row, and again at the
 * terminal transition.
 */
export function outcomeWord(status: SessionStatus): string {
  switch (status) {
    case 'done':
      return 'completed';
    case 'interrupted':
      return 'stopped';
    case 'failed':
      return 'failed';
    case 'paused':
      return 'paused';
    case 'orphaned':
      return 'orphaned';
    case 'running':
      return 'running';
    case 'queued':
      return 'queued';
  }
}

export interface SummaryParts {
  readonly prompt: string;
  readonly status: SessionStatus;
  /** The session's last assistant text, when there is one. */
  readonly lastAssistantText?: string | null;
}

/** Composes §8.3's digest. Always ≤ {@link SUMMARY_MAX_LENGTH}. */
export function composeSummary(parts: SummaryParts): string {
  const head = `${truncate(parts.prompt, PROMPT_MAX_LENGTH)} — ${outcomeWord(parts.status)}`;
  const tail =
    parts.lastAssistantText === undefined ||
    parts.lastAssistantText === null ||
    parts.lastAssistantText.trim() === ''
      ? ''
      : `: ${truncate(parts.lastAssistantText, ASSISTANT_MAX_LENGTH)}`;
  return truncate(`${head}${tail}`, SUMMARY_MAX_LENGTH);
}
