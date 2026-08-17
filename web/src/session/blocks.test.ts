/**
 * The `seq` merge (DESIGN §9.2, §9.4; IMPLEMENTATION §4).
 *
 * Three of §4's acceptance criteria are statements about the ordered list rather
 * than about the screen, and this is where they are proved exactly:
 *
 * - assistant text "streams token-by-token via `session.delta` and settles into
 *   the complete message **without duplication** when `session.message` arrives";
 * - a reload "reproduces the full history from the transcript and continues live
 *   with **no duplicated and no missing** blocks — asserted by comparing the
 *   rendered `seq` sequence against the transcript file";
 * - a 30s disconnect during active output, then a re-tail, "reproduces the missed
 *   output **exactly once**".
 */

import { describe, expect, it } from 'vitest';

import type { EventFrame, TranscriptLine, TranscriptPage } from '../api/types';

import {
  applyAnswered,
  applyEvent,
  applyPage,
  BLOCK_CAP,
  EMPTY_TRANSCRIPT,
  inputPreview,
  renderedSeqs,
} from './blocks';

function page(lines: readonly TranscriptLine[], from = 0, next?: number): TranscriptPage {
  return {
    sessionId: 's1',
    lines,
    from,
    next: next ?? from + lines.length * 100,
    size: (next ?? from + lines.length * 100) + 0,
    pruned: false,
  };
}

function line(seq: number, type: string, rest: Record<string, unknown> = {}): TranscriptLine {
  return { seq, ts: `2026-08-17T09:00:${String(seq).padStart(2, '0')}.000Z`, type, ...rest };
}

function frame(type: string, payload: unknown, ids: Record<string, string> = {}): EventFrame {
  return { ts: '2026-08-17T09:01:00.000Z', type, ids, payload, persist: false };
}

/** The transcript a scripted session actually writes, in runner's vocabulary. */
const SESSION: readonly TranscriptLine[] = [
  line(1, 'session.start', {
    model: 'claude-sonnet',
    permissionMode: 'acceptEdits',
    workspace: { kind: 'primary', path: 'C:\\Code\\lpm', branch: 'main' },
    elevation: { allow: ['Bash(git push:*)'], reason: 'the deploy script needs to push tags' },
    diagnostics: [{ level: 'warn', code: 'unknown_skill', message: 'skill "brief" is missing.' }],
    questionBridge: 'enabled',
  }),
  line(2, 'system', { subtype: 'init' }),
  line(3, 'assistant', { text: 'Looking at the invoices route.' }),
  line(4, 'tool_use', { toolUseId: 't1', name: 'Read', input: { file_path: 'src/invoices.php' } }),
  line(5, 'tool_result', { toolUseId: 't1', content: '120 lines' }),
  line(6, 'usage', { subtype: 'success', turns: 1 }),
  line(7, 'steer', { text: 'check the logs first', interrupted: true }),
  line(8, 'assistant', { text: 'Reading the logs.' }),
  line(9, 'session.end', { status: 'done', exitReason: 'completed', turns: 2, summary: 'Fixed.' }),
];

describe('a transcript page becomes an ordered list of blocks (§9.2)', () => {
  it('maps each line type to the block §9.2’s table names, and ignores the rest', () => {
    const state = applyPage(EMPTY_TRANSCRIPT, page(SESSION));
    expect(state.blocks.map((block) => block.kind)).toEqual([
      'start',
      'assistant',
      'tool',
      'prompt',
      'assistant',
      'end',
    ]);
    // `system` and `usage` are not body blocks: the header renders the first and
    // the rail renders the second.
    expect(state.blocks.some((block) => block.seqs.includes(2))).toBe(false);
    expect(state.blocks.some((block) => block.seqs.includes(6))).toBe(false);
  });

  it('joins tool_use and tool_result into one block on toolUseId', () => {
    const state = applyPage(EMPTY_TRANSCRIPT, page(SESSION));
    const tool = state.blocks.find((block) => block.kind === 'tool');
    if (tool?.kind !== 'tool') throw new Error('no tool block');
    expect(tool.name).toBe('Read');
    expect(tool.result).toBe('120 lines');
    expect(tool.settled).toBe(true);
    // Two lines, one block — which is why a block carries `seqs`, not one `seq`.
    expect(tool.seqs).toEqual([4, 5]);
  });

  it('marks a steer as steered, and as having interrupted the turn', () => {
    const state = applyPage(EMPTY_TRANSCRIPT, page(SESSION));
    const steer = state.blocks.find((block) => block.kind === 'prompt');
    if (steer?.kind !== 'prompt') throw new Error('no prompt block');
    expect(steer.variant).toBe('steer');
    expect(steer.interrupted).toBe(true);
  });

  it('carries the header facts a reload needs from the session.start line', () => {
    const state = applyPage(EMPTY_TRANSCRIPT, page(SESSION));
    const start = state.blocks[0];
    if (start?.kind !== 'start') throw new Error('no start block');
    expect(start.model).toBe('claude-sonnet');
    expect(start.elevation?.reason).toContain('deploy script');
    expect(start.questionBridge).toBe('enabled');
    expect(start.diagnostics).toHaveLength(1);
  });

  it('renders a pruned transcript as pruned rather than as an error', () => {
    const state = applyPage(EMPTY_TRANSCRIPT, {
      sessionId: 's1',
      lines: [],
      from: 0,
      next: 0,
      size: 0,
      pruned: true,
    });
    expect(state.pruned).toBe(true);
    expect(state.blocks).toEqual([]);
  });
});

describe('streaming settles without duplication (§4’s first criterion)', () => {
  it('appends deltas into one block and replaces it when the message arrives', () => {
    let state = EMPTY_TRANSCRIPT;
    for (const text of ['Look', 'ing at ', 'the inv']) {
      state = applyEvent(state, frame('session.delta', { seq: 12, text }));
    }
    expect(state.blocks).toHaveLength(1);
    const streaming = state.blocks[0];
    if (streaming?.kind !== 'assistant') throw new Error('no assistant block');
    expect(streaming.text).toBe('Looking at the inv');
    expect(streaming.streaming).toBe(true);

    state = applyEvent(
      state,
      frame('session.message', { seq: 12, role: 'assistant', text: 'Looking at the invoices.' }),
    );
    // One block, complete, not two.
    expect(state.blocks).toHaveLength(1);
    const settled = state.blocks[0];
    if (settled?.kind !== 'assistant') throw new Error('no assistant block');
    expect(settled.text).toBe('Looking at the invoices.');
    expect(settled.streaming).toBe(false);
    expect(renderedSeqs(state)).toEqual([12]);
  });

  it('opens a tool block on tool.start and completes it on tool.end', () => {
    let state = applyEvent(
      EMPTY_TRANSCRIPT,
      frame('session.tool.start', { seq: 20, toolUseId: 't9', name: 'Bash', inputPreview: 'ls' }),
    );
    state = applyEvent(
      state,
      frame('session.tool.end', {
        seq: 21,
        toolUseId: 't9',
        name: 'Bash',
        isError: true,
        durationMs: 1200,
        resultPreview: 'no such file',
      }),
    );
    expect(state.blocks).toHaveLength(1);
    const tool = state.blocks[0];
    if (tool?.kind !== 'tool') throw new Error('no tool block');
    expect(tool.isError).toBe(true);
    expect(tool.result).toBe('no such file');
    expect(tool.seqs).toEqual([20, 21]);
  });

  it('decorates the question card with how the answer landed (§9.2)', () => {
    let state = applyEvent(
      EMPTY_TRANSCRIPT,
      frame('session.question.raised', { seq: 30, questionId: 'q1', prompt: 'Disk or DB?' }),
    );
    state = applyAnswered(
      state,
      frame('session.question.answered', {
        questionId: 'q1',
        answeredVia: 'remote',
        latencyMs: 42_000,
        delivery: 'inline',
      }),
    );
    const question = state.blocks[0];
    if (question?.kind !== 'question') throw new Error('no question block');
    expect(question.delivery).toBe('inline');
    expect(question.answeredVia).toBe('remote');
    expect(question.latencyMs).toBe(42_000);
  });
});

describe('a reload reproduces the history with no gap and no duplicate (§4)', () => {
  it('renders exactly the transcript’s own seq sequence', () => {
    const state = applyPage(EMPTY_TRANSCRIPT, page(SESSION));
    // The comparison the criterion asks for: rendered seqs against the file's.
    const fromFile = SESSION.filter((one) => !['system', 'usage'].includes(one.type)).map(
      (one) => one.seq,
    );
    expect(renderedSeqs(state)).toEqual(fromFile);
  });

  it('is idempotent when the same page is read twice', () => {
    let state = applyPage(EMPTY_TRANSCRIPT, page(SESSION));
    const before = renderedSeqs(state);
    state = applyPage(state, page(SESSION));
    expect(renderedSeqs(state)).toEqual(before);
    expect(state.blocks).toHaveLength(6);
  });

  it('reproduces missed output exactly once after a disconnect and a re-tail', () => {
    // Live until seq 3, then the socket drops during output. The half-streamed
    // delta carries the `seq` the *next* line will take — here a `tool_use`.
    let state = applyPage(EMPTY_TRANSCRIPT, page(SESSION.slice(0, 3), 0, 300));
    state = applyEvent(state, frame('session.delta', { seq: 4, text: 'partial' }));
    expect(state.blocks.some((block) => block.kind === 'assistant' && block.streaming)).toBe(true);

    // Reconnect: re-tail from the stored offset. The page overlaps what is held,
    // and it is authoritative for its own range — so the pending delta at seq 4
    // is replaced by the tool call the transcript actually recorded, not left
    // beside it (§3.3: what a non-persisted event renders must be derivable from
    // a line).
    state = applyPage(state, page(SESSION.slice(2), 200, 900));
    const seqs = renderedSeqs(state);
    expect(seqs).toEqual([...new Set(seqs)]);
    expect(seqs).toEqual([1, 3, 4, 5, 7, 8, 9]);
    expect(state.blocks.some((block) => block.kind === 'assistant' && block.streaming)).toBe(false);
    expect(state.next).toBe(900);
  });

  it('only widens the window backwards for a Load earlier page', () => {
    let state = applyPage(EMPTY_TRANSCRIPT, page(SESSION.slice(6), 600, 900));
    expect(state.from).toBe(600);
    state = applyPage(state, page(SESSION.slice(0, 6), 0, 600));
    expect(state.from).toBe(0);
    // A forward page never rewinds `from`, so Load earlier stays monotonic.
    state = applyPage(state, page(SESSION.slice(6), 600, 900));
    expect(state.from).toBe(0);
  });
});

describe('the 500-block cap (§9.2)', () => {
  it('keeps the most recent 500 and says it dropped older ones', () => {
    const many: TranscriptLine[] = [];
    for (let seq = 1; seq <= BLOCK_CAP + 40; seq += 1) {
      many.push(line(seq, 'assistant', { text: `line ${String(seq)}` }));
    }
    const state = applyPage(EMPTY_TRANSCRIPT, page(many));
    expect(state.blocks).toHaveLength(BLOCK_CAP);
    expect(state.capped).toBe(true);
    expect(state.blocks[0]?.seq).toBe(41);
    expect(state.blocks.at(-1)?.seq).toBe(BLOCK_CAP + 40);
  });

  it('does not claim to be capped below the cap', () => {
    const state = applyPage(EMPTY_TRANSCRIPT, page(SESSION));
    expect(state.capped).toBe(false);
  });
});

describe('the collapsed one-line preview (§9.2)', () => {
  it('names the file, the command or the pattern rather than the whole input', () => {
    expect(inputPreview('Edit', { file_path: 'src/invoices.php', old_string: 'x' })).toBe(
      'src/invoices.php',
    );
    expect(inputPreview('Bash', { command: 'npm test\n--watch' })).toBe('npm test');
    expect(inputPreview('Grep', { pattern: 'TODO' })).toBe('TODO');
    expect(inputPreview('Weird', { a: 1, b: 2, c: 3, d: 4 })).toBe('a, b, c');
  });
});
