/**
 * The session body, as a reducer over transcript lines and live events
 * (DESIGN §9.2, §9.4).
 *
 * > "**`seq` is the join key.** Transcript lines carry `{seq, ts, type, …}` and
 * > every session event payload carries `seq`, so replayed history and live
 * > events merge into one ordered list with duplicates collapsed by `seq`. This
 * > is what makes step 2 and step 3 overlapping rather than racing."
 *
 * Everything here is pure, and that is what makes the two hard criteria of
 * IMPLEMENTATION §4 provable without a socket:
 *
 * - "settles into the complete message without duplication when `session.message`
 *   arrives" — the delta block and the message share a `seq`, so the second
 *   *replaces* the first rather than appending after it;
 * - "reload mid-session reproduces the full history … with **no duplicated and no
 *   missing** blocks — asserted by comparing the rendered `seq` sequence against
 *   the transcript file" — every block carries the `seqs` it folded in, so the
 *   comparison is exact rather than approximate.
 *
 * A tool call is the one block built from **two** lines (`tool_use` then
 * `tool_result`, which carry different `seq`s and are joined on `toolUseId`), so
 * the key of a block is not always its `seq` — hence `key` and `seqs` both.
 */

import type { EventFrame, TranscriptLine, TranscriptPage } from '../api/types';

/** §9.2: "Rendering is capped at the most recent 500 blocks with a Load earlier control." */
export const BLOCK_CAP = 500;

interface BlockBase {
  readonly key: string;
  /** The block's position in the ordered list — its first `seq`. */
  readonly seq: number;
  /** Every `seq` folded into this block, ascending. */
  readonly seqs: readonly number[];
  readonly ts: string;
}

export interface StartBlock extends BlockBase {
  readonly kind: 'start';
  readonly model: string | null;
  readonly permissionMode: string | null;
  readonly workspace: { kind?: string; path?: string; branch?: string | null } | null;
  readonly elevation: { allow: readonly string[]; reason: string } | null;
  readonly diagnostics: readonly { level?: string; code?: string; message?: string }[];
  readonly resumedFrom: string | null;
  /**
   * runner §5.6's `enabled | degraded | disabled`, written on the `session.start`
   * line as well as on the `session.started` event — which is why the header's
   * "question bridge disabled" badge survives a reload (§9.2, §3.3's rule that
   * anything rendered from a non-persisted event must be derivable from a line).
   */
  readonly questionBridge: string | null;
}

export interface PromptBlock extends BlockBase {
  readonly kind: 'prompt';
  /** §9.2 wants the three visually distinct: the prompt, a steer, an answer. */
  readonly variant: 'user' | 'steer' | 'answer';
  readonly text: string;
  /** §9.2: marked "interrupted the turn" when it did. */
  readonly interrupted: boolean;
}

export interface AssistantBlock extends BlockBase {
  readonly kind: 'assistant';
  readonly text: string;
  /** True while `session.delta` is still appending — the streaming caret (§14.1). */
  readonly streaming: boolean;
}

export interface ToolBlock extends BlockBase {
  readonly kind: 'tool';
  readonly toolUseId: string;
  readonly name: string;
  readonly input: unknown;
  readonly result: string | undefined;
  readonly isError: boolean;
  readonly durationMs: number | undefined;
  readonly settled: boolean;
}

export interface QuestionBlock extends BlockBase {
  readonly kind: 'question';
  readonly questionId: string;
  readonly prompt: string;
  readonly toolName: string | undefined;
  readonly answeredVia: string | undefined;
  readonly latencyMs: number | undefined;
  /** §9.2's delivery distinction: inline, or after a park. */
  readonly delivery: string | undefined;
  readonly decision: string | undefined;
}

export interface DiagnosticBlock extends BlockBase {
  readonly kind: 'diagnostic';
  readonly level: 'error' | 'warn' | 'info';
  readonly code: string;
  readonly message: string;
}

export interface EndBlock extends BlockBase {
  readonly kind: 'end';
  readonly status: string;
  readonly exitReason: string | null;
  readonly turns: number | null;
  readonly durationMs: number | null;
  readonly summary: string | null;
}

export type Block =
  | StartBlock
  | PromptBlock
  | AssistantBlock
  | ToolBlock
  | QuestionBlock
  | DiagnosticBlock
  | EndBlock;

export interface TranscriptState {
  readonly blocks: readonly Block[];
  /** Byte offset the loaded window starts at — what **Load earlier** walks back from. */
  readonly from: number;
  /** Byte offset to resume from after a disconnect (§9.4). */
  readonly next: number;
  readonly size: number;
  readonly pruned: boolean;
  /** True once the 500-block cap has dropped older blocks. */
  readonly capped: boolean;
  readonly lastSeq: number;
}

export const EMPTY_TRANSCRIPT: TranscriptState = Object.freeze({
  blocks: [],
  from: 0,
  next: 0,
  size: 0,
  pruned: false,
  capped: false,
  lastSeq: 0,
});

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** `tool_result` content, which the SDK gives as text or as content parts. */
function resultText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const parts = value
      .map((part) => {
        const asRecord = record(part);
        return asRecord === undefined ? undefined : str(asRecord['text']);
      })
      .filter((part): part is string => part !== undefined);
    return parts.length === 0 ? undefined : parts.join('\n');
  }
  return undefined;
}

/** A one-line preview for a collapsed tool call — `Edit  src/invoices.php` (§9.2). */
export function inputPreview(name: string, input: unknown): string {
  const asRecord = record(input);
  if (asRecord === undefined) return typeof input === 'string' ? input.slice(0, 120) : '';
  for (const field of ['file_path', 'path', 'command', 'pattern', 'url', 'prompt', 'description']) {
    const value = str(asRecord[field]);
    if (value !== undefined) return value.split('\n')[0]?.slice(0, 120) ?? '';
  }
  return Object.keys(asRecord).slice(0, 3).join(', ');
}

/** One line of a transcript, as the block it becomes. `undefined` = not a block. */
function blockOfLine(line: TranscriptLine): Block | undefined {
  const { seq, ts, type } = line;
  const base = { seq, seqs: [seq], ts };

  switch (type) {
    case 'session.start': {
      const workspace = record(line['workspace']);
      const elevationRaw = record(line['elevation']);
      const diagnostics = Array.isArray(line['diagnostics'])
        ? (line['diagnostics'] as StartBlock['diagnostics'])
        : [];
      return {
        ...base,
        key: `start:${String(seq)}`,
        kind: 'start',
        model: str(line['model']) ?? null,
        permissionMode: str(line['permissionMode']) ?? null,
        workspace: workspace === undefined ? null : workspace,
        elevation:
          elevationRaw === undefined
            ? null
            : {
                allow: Array.isArray(elevationRaw['allow'])
                  ? (elevationRaw['allow'] as string[])
                  : [],
                reason: str(elevationRaw['reason']) ?? '',
              },
        diagnostics,
        resumedFrom: str(line['resumedFrom']) ?? null,
        questionBridge: str(line['questionBridge']) ?? null,
      };
    }
    case 'user': {
      const text = resultText(line['content']) ?? '';
      if (text.trim() === '') return undefined;
      return {
        ...base,
        key: `prompt:${String(seq)}`,
        kind: 'prompt',
        variant: 'user',
        text,
        interrupted: false,
      };
    }
    case 'steer':
      return {
        ...base,
        key: `prompt:${String(seq)}`,
        kind: 'prompt',
        variant: 'steer',
        text: str(line['text']) ?? '',
        interrupted: line['interrupted'] === true,
      };
    case 'answer':
      return {
        ...base,
        key: `prompt:${String(seq)}`,
        kind: 'prompt',
        variant: 'answer',
        text: str(line['text']) ?? '',
        interrupted: false,
      };
    case 'assistant': {
      const text = str(line['text']) ?? resultText(line['content']) ?? '';
      if (text.trim() === '') return undefined;
      return {
        ...base,
        key: `assistant:${String(seq)}`,
        kind: 'assistant',
        text,
        streaming: false,
      };
    }
    case 'tool_use': {
      const toolUseId = str(line['toolUseId']) ?? `seq-${String(seq)}`;
      return {
        ...base,
        key: `tool:${toolUseId}`,
        kind: 'tool',
        toolUseId,
        name: str(line['name']) ?? 'tool',
        input: line['input'],
        result: undefined,
        isError: false,
        durationMs: undefined,
        settled: false,
      };
    }
    case 'question':
      return {
        ...base,
        key: `question:${str(line['questionId']) ?? String(seq)}`,
        kind: 'question',
        questionId: str(line['questionId']) ?? '',
        prompt: str(line['prompt']) ?? '',
        toolName: str(line['toolName']),
        answeredVia: undefined,
        latencyMs: undefined,
        delivery: undefined,
        decision: undefined,
      };
    case 'error':
      return {
        ...base,
        key: `diagnostic:${String(seq)}`,
        kind: 'diagnostic',
        level: 'error',
        code: str(line['code']) ?? 'error',
        message: str(line['message']) ?? str(line['stage']) ?? 'The session reported an error.',
      };
    case 'session.end':
      return {
        ...base,
        key: `end:${String(seq)}`,
        kind: 'end',
        status: str(line['status']) ?? 'done',
        exitReason: str(line['exitReason']) ?? null,
        turns: num(line['turns']) ?? null,
        durationMs: num(line['durationMs']) ?? null,
        summary: str(line['summary']) ?? null,
      };
    // `system` carries the SDK's own init/compact facts, which the header already
    // renders from `session.start`; `usage` feeds the rail, not the body (§9.2).
    default:
      return undefined;
  }
}

function mergeSeqs(existing: readonly number[], seq: number): readonly number[] {
  if (existing.includes(seq)) return existing;
  return [...existing, seq].sort((a, b) => a - b);
}

/**
 * Folds one block into the ordered list, collapsing by `key`.
 *
 * A `tool_result` arriving for a known `toolUseId` completes the existing block
 * instead of adding a second one; a settled `session.message` replaces the
 * streaming block at the same `seq`. Both are "duplicates collapsed" (§9.4).
 */
function upsert(blocks: readonly Block[], incoming: Block): readonly Block[] {
  const index = blocks.findIndex((block) => block.key === incoming.key);
  if (index === -1) {
    const next = [...blocks, incoming];
    next.sort((a, b) => a.seq - b.seq);
    return next;
  }
  const current = blocks[index];
  if (current === undefined) return blocks;
  const merged: Block = {
    ...current,
    ...incoming,
    seq: Math.min(current.seq, incoming.seq),
    seqs: incoming.seqs.reduce<readonly number[]>(mergeSeqs, current.seqs),
  };
  const next = [...blocks];
  next[index] = merged;
  next.sort((a, b) => a.seq - b.seq);
  return next;
}

function cap(state: TranscriptState): TranscriptState {
  if (state.blocks.length <= BLOCK_CAP) return state;
  return {
    ...state,
    blocks: state.blocks.slice(state.blocks.length - BLOCK_CAP),
    capped: true,
  };
}

/**
 * Ingests a transcript page.
 *
 * `?tail=` on open, `?from=` to page and to re-tail after a disconnect. A page
 * whose `from` is *behind* what is loaded is a **Load earlier** result and only
 * widens the window; a page ahead of it advances `next`. Re-reading a line
 * already held is harmless because `upsert` collapses it.
 *
 * **The page is authoritative for the `seq` range it covers**, and that is what
 * closes the one duplication a naive merge lets through. `session.delta` carries
 * the `seq` the *next* transcript line will take, so a turn that ends in a tool
 * call leaves a pending assistant block at a `seq` the transcript spends on a
 * `tool_use`. §3.3 already states the rule that resolves it — "anything the UI
 * renders from a non-persisted event must also be derivable from a transcript
 * line, or it is a bug" — so a streaming block inside the page's range that the
 * page did not re-create is dropped rather than left beside the real one.
 */
export function applyPage(state: TranscriptState, page: TranscriptPage): TranscriptState {
  if (page.pruned) {
    return { ...state, pruned: true, size: 0 };
  }

  let blocks = state.blocks;
  let lastSeq = state.lastSeq;
  const covered: number[] = [];
  const written = new Set<string>();
  for (const line of page.lines) {
    if (typeof line.seq !== 'number') continue;
    lastSeq = Math.max(lastSeq, line.seq);
    covered.push(line.seq);
    // A `tool_result` is not a block of its own — it completes one.
    if (line.type === 'tool_result') {
      blocks = completeTool(blocks, line);
      continue;
    }
    const block = blockOfLine(line);
    if (block !== undefined) {
      written.add(block.key);
      blocks = upsert(blocks, block);
    }
  }

  if (covered.length > 0) {
    const lowest = Math.min(...covered);
    const highest = Math.max(...covered);
    blocks = blocks.filter(
      (block) =>
        !(
          block.kind === 'assistant' &&
          block.streaming &&
          block.seq >= lowest &&
          block.seq <= highest &&
          !written.has(block.key)
        ),
    );
  }

  const widened = state.blocks.length === 0 || page.from < state.from;
  return cap({
    ...state,
    blocks,
    from: widened ? page.from : state.from,
    next: Math.max(state.next, page.next),
    size: page.size,
    pruned: false,
    lastSeq,
  });
}

function completeTool(blocks: readonly Block[], line: TranscriptLine): readonly Block[] {
  const toolUseId = str(line['toolUseId']);
  if (toolUseId === undefined) return blocks;
  const index = blocks.findIndex((block) => block.key === `tool:${toolUseId}`);
  if (index === -1) return blocks;
  const current = blocks[index];
  if (current === undefined || current.kind !== 'tool') return blocks;
  const next = [...blocks];
  next[index] = {
    ...current,
    seqs: mergeSeqs(current.seqs, line.seq),
    result: resultText(line['content']) ?? resultText(line['result']),
    isError: line['isError'] === true || line['is_error'] === true,
    durationMs: num(line['durationMs']),
    settled: true,
  };
  return next;
}

/**
 * Ingests one live per-session event (runner §10's non-persisted four).
 *
 * `session.delta` appends into the pending assistant block at its `seq`;
 * `session.message` replaces it with the complete text. That is exactly the
 * "streams token-by-token … and settles without duplication" criterion, and it
 * works because both carry the same `seq`.
 */
export function applyEvent(state: TranscriptState, frame: EventFrame): TranscriptState {
  const payload = record(frame.payload);
  if (payload === undefined) return state;
  const seq = num(payload['seq']);
  if (seq === undefined) return state;
  const ts = frame.ts;

  switch (frame.type) {
    case 'session.delta': {
      const key = `assistant:${String(seq)}`;
      const existing = state.blocks.find((block) => block.key === key);
      const previous = existing !== undefined && existing.kind === 'assistant' ? existing.text : '';
      return cap({
        ...state,
        lastSeq: Math.max(state.lastSeq, seq),
        blocks: upsert(state.blocks, {
          key,
          seq,
          seqs: [seq],
          ts,
          kind: 'assistant',
          text: previous + (str(payload['text']) ?? ''),
          streaming: true,
        }),
      });
    }
    case 'session.message': {
      const text = str(payload['text']) ?? resultText(payload['contentBlocks']) ?? '';
      const role = str(payload['role']);
      const key = role === 'user' ? `prompt:${String(seq)}` : `assistant:${String(seq)}`;
      // A message whose content is only `tool_use` / `tool_result` parts carries
      // no text of its own, and runner emits it anyway because the tool events
      // that follow number their `seq` from it (runner §10). Rendering it would
      // put an empty "you said" card beside every tool call — so it is skipped
      // here exactly as `blockOfLine` skips the transcript line it becomes, which
      // is also why **Load earlier** used to "fix" the view: the replay never
      // produced these blocks in the first place. A block already at this `seq` —
      // a `session.delta` that streamed real text — is settled, not dropped.
      if (text.trim() === '') {
        const streamed = state.blocks.find((block) => block.key === key);
        if (streamed === undefined || streamed.kind !== 'assistant') return state;
        return cap({
          ...state,
          lastSeq: Math.max(state.lastSeq, seq),
          blocks: upsert(state.blocks, { ...streamed, streaming: false }),
        });
      }
      if (role === 'user') {
        return cap({
          ...state,
          lastSeq: Math.max(state.lastSeq, seq),
          blocks: upsert(state.blocks, {
            key,
            seq,
            seqs: [seq],
            ts,
            kind: 'prompt',
            variant: 'user',
            text,
            interrupted: false,
          }),
        });
      }
      return cap({
        ...state,
        lastSeq: Math.max(state.lastSeq, seq),
        blocks: upsert(state.blocks, {
          key,
          seq,
          seqs: [seq],
          ts,
          kind: 'assistant',
          text,
          streaming: false,
        }),
      });
    }
    case 'session.tool.start': {
      const toolUseId = str(payload['toolUseId']) ?? `seq-${String(seq)}`;
      return cap({
        ...state,
        lastSeq: Math.max(state.lastSeq, seq),
        blocks: upsert(state.blocks, {
          key: `tool:${toolUseId}`,
          seq,
          seqs: [seq],
          ts,
          kind: 'tool',
          toolUseId,
          name: str(payload['name']) ?? 'tool',
          input: payload['inputPreview'],
          result: undefined,
          isError: false,
          durationMs: undefined,
          settled: false,
        }),
      });
    }
    case 'session.tool.end': {
      const toolUseId = str(payload['toolUseId']) ?? `seq-${String(seq)}`;
      const key = `tool:${toolUseId}`;
      const existing = state.blocks.find((block) => block.key === key);
      const base =
        existing !== undefined && existing.kind === 'tool'
          ? existing
          : {
              key,
              seq,
              seqs: [seq] as readonly number[],
              ts,
              kind: 'tool' as const,
              toolUseId,
              name: str(payload['name']) ?? 'tool',
              input: undefined,
              result: undefined,
              isError: false,
              durationMs: undefined,
              settled: false,
            };
      return cap({
        ...state,
        lastSeq: Math.max(state.lastSeq, seq),
        blocks: upsert(state.blocks, {
          ...base,
          seqs: [seq],
          result: str(payload['resultPreview']),
          isError: payload['isError'] === true,
          durationMs: num(payload['durationMs']),
          settled: true,
        }),
      });
    }
    case 'session.question.raised':
      return cap({
        ...state,
        blocks: upsert(state.blocks, {
          key: `question:${str(payload['questionId']) ?? String(seq)}`,
          seq,
          seqs: [seq],
          ts,
          kind: 'question',
          questionId: str(payload['questionId']) ?? '',
          prompt: str(payload['prompt']) ?? '',
          toolName: str(payload['toolName']),
          answeredVia: undefined,
          latencyMs: undefined,
          delivery: undefined,
          decision: undefined,
        }),
      });
    default:
      return state;
  }
}

/**
 * `session.question.answered` decorates the card that was asked (§9.2).
 *
 * Separate from {@link applyEvent} because the event carries no `seq` of its own
 * — it names the question — and pretending otherwise would put it in the wrong
 * place in the ordered list.
 */
export function applyAnswered(state: TranscriptState, frame: EventFrame): TranscriptState {
  const payload = record(frame.payload);
  const questionId = payload === undefined ? undefined : str(payload['questionId']);
  if (questionId === undefined) return state;
  const index = state.blocks.findIndex((block) => block.key === `question:${questionId}`);
  if (index === -1) return state;
  const current = state.blocks[index];
  if (current === undefined || current.kind !== 'question') return state;
  const blocks = [...state.blocks];
  blocks[index] = {
    ...current,
    answeredVia: str(payload?.['answeredVia']),
    latencyMs: num(payload?.['latencyMs']),
    delivery: str(payload?.['delivery']),
    decision: str(payload?.['decision']),
  };
  return { ...state, blocks };
}

/** Every `seq` the view is rendering, ascending — the §4 acceptance's assertion. */
export function renderedSeqs(state: TranscriptState): readonly number[] {
  return state.blocks.flatMap((block) => block.seqs).sort((a, b) => a - b);
}
