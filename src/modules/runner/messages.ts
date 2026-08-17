/**
 * SDK messages → runner's own vocabularies: the transcript line types of
 * DESIGN §8.1 and the status/`exit_reason` mapping of §2.2.
 *
 * Pure functions, no I/O, so the mapping can be driven from a scripted message
 * sequence without a session — which is what makes M3's acceptance provable
 * against a fake `query` (see `sdk.ts`).
 *
 * ## Two SDK facts the mapping exists to absorb
 *
 * - **SDK-NOTES G2 — there are no `tool_use` / `tool_result` message types.**
 *   Tool calls are content blocks inside `SDKAssistantMessage.message.content`;
 *   results arrive as `SDKUserMessage` whose content holds `tool_result` blocks,
 *   with the structured twin on `SDKUserMessage.tool_use_result` ("the tool's
 *   full Output object, not the string content sent to the model"). §8.1's line
 *   vocabulary is the *transcript's*, and these two line types are **derived by
 *   runner**, which is what this file does.
 * - **SDK-NOTES §3.1 — `SDKMessage` is a 38-member open union.** Anything not
 *   named below is passed through untouched rather than treated as an error:
 *   §7.4's "the reader loop tolerates unknown message types by construction" is
 *   a requirement, not an observation, and this version already ships a dozen
 *   subtypes runner has no opinion about.
 */
import type { SessionStatus } from '../../storage/index.js';

import type { ExitReason } from './status.js';
import type { SDKMessage } from './sdk.js';

export type InitMessage = Extract<SDKMessage, { type: 'system'; subtype: 'init' }>;
export type AssistantMessage = Extract<SDKMessage, { type: 'assistant' }>;
export type UserMessage = Extract<SDKMessage, { type: 'user' }>;
export type ResultMessage = Extract<SDKMessage, { type: 'result' }>;

export function isInitMessage(message: SDKMessage): message is InitMessage {
  return message.type === 'system' && message.subtype === 'init';
}

/** The facts `session.started` and the transcript header need from `init` (§3.1 step 10). */
export interface InitFacts {
  readonly sdkSessionId: string;
  readonly model: string | null;
  readonly permissionMode: string | null;
  readonly tools: readonly string[];
  readonly mcpServers: readonly { readonly name: string; readonly status: string }[];
  /**
   * roster §7.1: "the runner asserts that the `system`/`init` message's
   * `plugins` and `skills` arrays contain what was requested, raising a
   * session-start diagnostic if not" — because "a nonexistent plugin path is
   * **silently skipped**" by the CLI, which is the failure mode the assertion
   * exists to make loud.
   */
  readonly plugins: readonly { readonly name: string; readonly path: string }[];
  readonly skills: readonly string[];
  /** SDK-NOTES §3.2: gives §8.1's "SDK + CLI version" for free. */
  readonly claudeCodeVersion: string | null;
  /** Which credential actually won — the read-out behind §3.4's guard. */
  readonly apiKeySource: string | null;
  /** SDK-NOTES §4.2 / G4: `interrupt_receipt_v1` and friends, for M6. */
  readonly capabilities: readonly string[];
}

export function readInitFacts(message: InitMessage): InitFacts {
  return {
    sdkSessionId: message.session_id,
    model: message.model,
    permissionMode: message.permissionMode,
    tools: message.tools,
    mcpServers: message.mcp_servers.map((server) => ({
      name: server.name,
      status: server.status,
    })),
    plugins: (message.plugins ?? []).map((plugin) => ({ name: plugin.name, path: plugin.path })),
    skills: message.skills ?? [],
    claudeCodeVersion: message.claude_code_version ?? null,
    apiKeySource: message.apiKeySource,
    capabilities: message.capabilities ?? [],
  };
}

/** One tool call, derived from an assistant content block (G2). */
export interface ToolUseLine {
  readonly toolUseId: string;
  readonly name: string;
  readonly input: unknown;
}

/** One tool result, derived from a user content block plus its structured twin (G2). */
export interface ToolResultLine {
  readonly toolUseId: string;
  readonly isError: boolean;
  readonly content: unknown;
  /** `SDKUserMessage.tool_use_result` — the Output object, when the SDK sent one. */
  readonly output?: unknown;
}

export interface AssistantParts {
  /** The content blocks, verbatim: §8.1's `assistant` line is "full content blocks". */
  readonly content: readonly unknown[];
  /** Concatenated text blocks — §8.3's `lastAssistantText` input. */
  readonly text: string;
  readonly messageId: string | null;
  readonly toolUses: readonly ToolUseLine[];
}

export function readAssistant(message: AssistantMessage): AssistantParts {
  const blocks = asBlocks(message.message.content);
  const toolUses: ToolUseLine[] = [];
  const texts: string[] = [];

  for (const block of blocks) {
    const type = readString(block, 'type');
    if (type === 'text') {
      const text = readString(block, 'text');
      if (text !== undefined) texts.push(text);
      continue;
    }
    if (type === 'tool_use') {
      toolUses.push({
        toolUseId: readString(block, 'id') ?? '',
        name: readString(block, 'name') ?? '',
        input: (block as Record<string, unknown>)['input'],
      });
    }
  }

  return {
    content: blocks,
    text: texts.join('\n').trim(),
    messageId: typeof message.message.id === 'string' ? message.message.id : null,
    toolUses,
  };
}

export interface UserParts {
  readonly content: readonly unknown[] | string;
  readonly toolResults: readonly ToolResultLine[];
}

export function readUser(message: UserMessage): UserParts {
  const raw = message.message.content;
  if (typeof raw === 'string') return { content: raw, toolResults: [] };

  const blocks = asBlocks(raw);
  const structured = (message as { tool_use_result?: unknown }).tool_use_result;
  const toolResults: ToolResultLine[] = [];

  for (const block of blocks) {
    if (readString(block, 'type') !== 'tool_result') continue;
    const record = block as Record<string, unknown>;
    toolResults.push({
      toolUseId: readString(block, 'tool_use_id') ?? '',
      isError: record['is_error'] === true,
      content: record['content'],
      ...(structured === undefined ? {} : { output: structured }),
    });
  }

  return { content: blocks, toolResults };
}

/** §8.1's `usage` line: "per-turn reconciled usage and `permission_denials`". */
export interface ResultFacts {
  readonly subtype: ResultMessage['subtype'];
  readonly isError: boolean;
  readonly turns: number;
  readonly durationMs: number;
  readonly stopReason: string | null;
  readonly costUsd: number;
  /** Per-model totals — cumulative per `query()` call, per SDK-NOTES C1. */
  readonly modelUsage: unknown;
  /** Main-loop only, and genuinely per-turn (C1's correction to §2.4). */
  readonly usage: unknown;
  readonly permissionDenials: readonly unknown[];
  /** SDK-NOTES G7: 19 typed members; a better classifier than error text. */
  readonly terminalReason: string | null;
  /** Success only: the final assistant text, free and exact for §8.3. */
  readonly resultText: string | null;
  readonly errors: readonly string[];
}

export function readResult(message: ResultMessage): ResultFacts {
  const success = message.subtype === 'success';
  return {
    subtype: message.subtype,
    isError: message.is_error,
    turns: message.num_turns,
    durationMs: message.duration_ms,
    stopReason: message.stop_reason,
    costUsd: message.total_cost_usd,
    modelUsage: message.modelUsage,
    usage: message.usage,
    permissionDenials: message.permission_denials,
    terminalReason: message.terminal_reason ?? null,
    resultText: success ? message.result : null,
    errors: success ? [] : message.errors,
  };
}

/**
 * The text of a `stream_event` partial, for §10's `session.delta` (M10).
 *
 * Deltas are never written to the transcript (§8.1, D11) — they exist for the
 * UI's live typing and nothing else — so this reads only what a delta *renders*
 * as, and answers `undefined` for every other stream event (`message_start`,
 * `content_block_start`, thinking deltas, and whatever a later SDK adds). A
 * shape this does not recognise costs a keystroke, never a turn.
 */
export function readStreamDelta(message: SDKMessage): string | undefined {
  if (message.type !== 'stream_event') return undefined;
  const event: unknown = message.event;
  if (typeof event !== 'object' || event === null) return undefined;
  if ((event as { type?: unknown }).type !== 'content_block_delta') return undefined;
  const delta: unknown = (event as { delta?: unknown }).delta;
  if (typeof delta !== 'object' || delta === null) return undefined;
  if ((delta as { type?: unknown }).type !== 'text_delta') return undefined;
  const text = (delta as { text?: unknown }).text;
  return typeof text === 'string' && text !== '' ? text : undefined;
}

// ---------------------------------------------------------------------------
// Rate limiting (§6.4, SDK-NOTES G7)
// ---------------------------------------------------------------------------

/**
 * Where a rate-limit classification came from (§6.4, §10's `runner.ratelimited`).
 *
 * **Deviation from §10, raised rather than absorbed.** §10 pins the event's
 * `source` as `'error-text' | 'rate_limit_event'`. SDK-NOTES **G7** then found
 * `result.terminal_reason` — 19 typed members including `'blocking_limit'` and
 * `'rapid_refill_breaker'` — and directs §6.4's classification to "read
 * `terminal_reason` first and fall back to text". A third value is the honest
 * way to say which of the two actually fired: folding a typed terminal into
 * `'error-text'` would report a provenance that is not true, and provenance is
 * the entire purpose of the field (§7.4's honesty labels).
 */
export type RateLimitSource = 'terminal-reason' | 'error-text' | 'rate_limit_event';

/** `TerminalReason` members that mean the plan window, not the work, stopped it. */
const RATE_LIMIT_TERMINALS: ReadonlySet<string> = new Set([
  'blocking_limit',
  'rapid_refill_breaker',
]);

/**
 * The text fallback of §6.4, kept deliberately narrow.
 *
 * It runs only on an `error_during_execution` result, and only over the SDK's
 * own `errors` strings — never over model output, which can discuss rate limits
 * without being one.
 */
const RATE_LIMIT_TEXT = /rate[\s_-]?limit|usage limit|too many requests|\b429\b/iu;

/** §6.4's classification: typed terminal first, error text second (G7). */
export function classifyRateLimit(facts: ResultFacts): RateLimitSource | undefined {
  if (facts.terminalReason !== null && RATE_LIMIT_TERMINALS.has(facts.terminalReason)) {
    return 'terminal-reason';
  }
  if (facts.subtype === 'error_during_execution' && RATE_LIMIT_TEXT.test(facts.errors.join(' '))) {
    return 'error-text';
  }
  return undefined;
}

/** What runner reads off a `rate_limit_event`, all of it optional (§7.4). */
export interface RateLimitEventFacts {
  readonly status: string | null;
  readonly rateLimitType: string | null;
  readonly utilization: number | null;
  readonly resetsAt: Date | undefined;
  /** True only for `status: 'rejected'` — the one value §6.4 acts on. */
  readonly exhausted: boolean;
}

/**
 * Parses `rate_limit_event` permissively (§7.4).
 *
 * SDK-NOTES §7.1 shows the message *is* declared and typed in this build, which
 * §7.4 assumed it was not — but "whether it is ever emitted is still runtime
 * behaviour", so the defensive read stands: anything unrecognised yields
 * `undefined` and nothing downstream changes. §6.4 acts on the *presence* of an
 * exhaustion, never on the numbers.
 */
export function readRateLimitEvent(message: SDKMessage): RateLimitEventFacts | undefined {
  if (message.type !== 'rate_limit_event') return undefined;
  const info: unknown = (message as { rate_limit_info?: unknown }).rate_limit_info;
  if (typeof info !== 'object' || info === null) return undefined;
  const record = info as Record<string, unknown>;
  const status = typeof record['status'] === 'string' ? record['status'] : null;
  const resets = record['resetsAt'];
  const resetsAt =
    typeof resets === 'number' && Number.isFinite(resets)
      ? new Date(resets < 1e12 ? resets * 1000 : resets)
      : undefined;
  return {
    status,
    rateLimitType: typeof record['rateLimitType'] === 'string' ? record['rateLimitType'] : null,
    utilization: typeof record['utilization'] === 'number' ? record['utilization'] : null,
    resetsAt,
    exhausted: status === 'rejected',
  };
}

/** §2.2's terminal row for a `result`, and §2.3's `exit_reason` for it. */
export interface ResultOutcome {
  readonly status: SessionStatus;
  readonly exitReason: ExitReason;
}

/**
 * The mapping of §2.2, complete against the pinned SDK's five subtypes
 * (SDK-NOTES §6.1: "Subtypes are **exactly** DESIGN's five").
 *
 * A subtype this build has never heard of maps to `failed` /
 * `error_during_execution` rather than throwing: an SDK that adds a sixth
 * failure mode must not make a session unfinishable.
 */
export function outcomeForResult(subtype: string): ResultOutcome {
  switch (subtype) {
    case 'success':
      return { status: 'done', exitReason: 'completed' };
    case 'error_max_turns':
      return { status: 'failed', exitReason: 'max_turns' };
    case 'error_max_budget_usd':
      return { status: 'failed', exitReason: 'max_budget_usd' };
    case 'error_max_structured_output_retries':
      return { status: 'failed', exitReason: 'error_structured_output' };
    case 'error_during_execution':
    default:
      return { status: 'failed', exitReason: 'error_during_execution' };
  }
}

// ---------------------------------------------------------------------------

function asBlocks(content: unknown): readonly unknown[] {
  return Array.isArray(content) ? (content as readonly unknown[]) : [];
}

function readString(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'string' ? field : undefined;
}
