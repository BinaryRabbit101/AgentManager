/**
 * The transcript reader (runner IMPLEMENTATION M2, DESIGN §11.1/§11.2).
 *
 * Acceptance, criterion by criterion:
 *
 * - "Tailing from a byte offset returns whole JSONL lines and the next offset;
 *   a NULLed `transcript_path` returns the defined 'pruned' result, not a 500" —
 *   *forward reads* and *pruned* (the HTTP half is in `routes.test.ts`);
 * - "A `from` deliberately set **mid-line** returns the *next* whole line, never
 *   a partial one, and its `next` matches what a from-the-start read would have
 *   produced at that point" — *mid-line*;
 * - "`tail=<bytes>` on a file larger than the cap returns the last N bytes
 *   snapped to a line boundary, parses as JSONL with no partial first line, and
 *   costs **one read** regardless of file size (asserted against a
 *   multi-hundred-MB fixture by comparing request work, not wall clock)" —
 *   *tail*;
 * - "`getTranscriptTail(sessionId, { maxBytes })` returns byte-identical `lines`
 *   to `GET …/transcript?tail=<maxBytes>` — one reader, two faces" — *one
 *   reader* (and again over HTTP in `routes.test.ts`).
 */
import { closeSync, openSync, statSync, writeSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SessionNotFoundError } from './errors.js';
import type { SessionTranscript } from './transcript.js';
import {
  countingIo,
  enqueue,
  makeHarness,
  makeTempDir,
  type CountingIo,
  type RunnerHarness,
  type TempDir,
} from './__tests__/helpers.js';

let dataRootDir: TempDir;
let harness: RunnerHarness;
let io: CountingIo;
let seed: { projectId: string; assignmentId: string; agentId: string };
let opened: SessionTranscript[] = [];

/** A session with `count` transcript lines, and its file. */
function withLines(count: number, text = 'line'): { sessionId: string; path: string } {
  const session = enqueue(harness, seed);
  const transcript = harness.transcripts.open(session.id, {
    flushLines: 1,
    flushMs: 1000,
    maxMb: 512,
  });
  opened.push(transcript);
  for (let i = 0; i < count; i += 1)
    transcript.append('assistant', { text: `${text}-${String(i)}` });
  transcript.close();
  return { sessionId: session.id, path: transcript.path };
}

beforeEach(() => {
  dataRootDir = makeTempDir('agentmanager-runner-reader-');
  io = countingIo();
  harness = makeHarness({ dataRoot: dataRootDir.path, io });
  seed = harness.seed();
  opened = [];
});

afterEach(() => {
  for (const transcript of opened) {
    try {
      transcript.close();
    } catch {
      // Already closed.
    }
  }
  harness.close();
  dataRootDir.cleanup();
});

describe('forward reads', () => {
  it('returns whole lines and an advancing next offset', () => {
    const { sessionId, path } = withLines(5);

    const first = harness.reader.read(sessionId, { limit: 2 });
    expect(first.pruned).toBe(false);
    expect(first.from).toBe(0);
    expect(first.lines.map((line) => line['text'])).toEqual(['line-0', 'line-1']);
    expect(first.next).toBeGreaterThan(0);

    const second = harness.reader.read(sessionId, { from: first.next });
    expect(second.lines.map((line) => line['text'])).toEqual(['line-2', 'line-3', 'line-4']);
    expect(second.next).toBe(statSync(path).size);

    // Rule 2: a poll loop terminates rather than repeating the last page.
    const third = harness.reader.read(sessionId, { from: second.next });
    expect(third.lines).toEqual([]);
    expect(third.next).toBe(second.next);
  });

  it('carries seq, ts and type on every line', () => {
    const { sessionId } = withLines(3);
    const page = harness.reader.read(sessionId);
    expect(page.lines.map((line) => line.seq)).toEqual([1, 2, 3]);
    for (const line of page.lines) {
      expect(line.type).toBe('assistant');
      expect(line.ts).toBe('2026-08-16T10:00:00.000Z');
    }
  });

  it('advances a mid-line offset to the next whole line', () => {
    const { sessionId } = withLines(4);
    const whole = harness.reader.read(sessionId);
    const lineTwoStart = whole.next - lengthOfLastLines(harness, sessionId, 3);

    // Land three bytes into line 2 — the case a client hits whenever it computes
    // an offset from `transcript_bytes` mid-flush.
    const midLine = harness.reader.read(sessionId, { from: lineTwoStart + 3, limit: 1 });
    expect(midLine.lines).toHaveLength(1);
    expect(midLine.lines[0]?.['text']).toBe('line-2');
    expect(midLine.from).toBeGreaterThan(lineTwoStart + 3);

    // …and `next` is exactly what a from-the-start read produces at that point.
    const fromStart = harness.reader.read(sessionId, { limit: 3 });
    expect(midLine.next).toBe(fromStart.next);
  });

  it('treats an offset exactly on a line boundary as that line', () => {
    const { sessionId } = withLines(3);
    const first = harness.reader.read(sessionId, { limit: 1 });
    const second = harness.reader.read(sessionId, { from: first.next, limit: 1 });
    expect(second.from).toBe(first.next);
    expect(second.lines[0]?.['text']).toBe('line-1');
  });

  it('reports no progress when the offset sits inside an unterminated last line', () => {
    const { sessionId, path } = withLines(1);
    // A line the writer has not finished: bytes with no newline yet.
    const fd = openSync(path, 'a');
    writeSync(fd, Buffer.from('{"seq":2,"type":"assist'));
    closeSync(fd);

    const size = statSync(path).size;
    const page = harness.reader.read(sessionId, { from: size - 5 });
    expect(page.lines).toEqual([]);
    expect(page.next).toBe(size - 5);
  });

  it('clamps an offset past the end of the file', () => {
    const { sessionId, path } = withLines(2);
    const size = statSync(path).size;
    const page = harness.reader.read(sessionId, { from: size + 10_000 });
    expect(page).toMatchObject({ lines: [], from: size, next: size, pruned: false });
  });

  it('reads an empty transcript without complaint', () => {
    const session = enqueue(harness, seed);
    const transcript = harness.transcripts.open(session.id, {
      flushLines: 1,
      flushMs: 1,
      maxMb: 1,
    });
    opened.push(transcript);
    expect(harness.reader.read(session.id)).toMatchObject({ lines: [], from: 0, next: 0 });
  });
});

describe('pruned transcripts', () => {
  it('answers pruned for a NULLed transcript_path, on both faces', async () => {
    const { sessionId } = withLines(3);
    harness.storage.store.sessions.clearTranscript(sessionId);

    expect(harness.reader.read(sessionId, { from: 40 })).toMatchObject({ pruned: true, from: 40 });
    expect(harness.reader.tail(sessionId)).toMatchObject({ pruned: true, lines: [] });
    await expect(harness.service.getTranscriptTail(sessionId)).resolves.toMatchObject({
      pruned: true,
    });
  });

  it('answers pruned when the row names a file that is gone', () => {
    const { sessionId } = withLines(2);
    harness.storage.store.transcripts.prune(sessionId);
    // The pruner NULLs the path, so re-point the row at the missing file to
    // exercise the other half of foundation §1.5's pruned pair.
    harness.storage.store.sessions.setTranscript(sessionId, {
      path: '2026/08/gone.jsonl',
      bytes: 10,
    });
    expect(harness.reader.tail(sessionId).pruned).toBe(true);
  });

  it('throws for an unknown session rather than reporting it pruned', () => {
    expect(() => harness.reader.read('no-such-session')).toThrow(SessionNotFoundError);
  });
});

describe('tail reads', () => {
  it('snaps forward to a line boundary and never returns a partial first line', () => {
    const { sessionId, path } = withLines(20, 'padded'.repeat(8));
    const size = statSync(path).size;

    const page = harness.reader.tail(sessionId, { maxBytes: Math.floor(size / 3) });
    expect(page.pruned).toBe(false);
    expect(page.lines.length).toBeGreaterThan(0);
    expect(page.lines.length).toBeLessThan(20);
    expect(page.from).toBeGreaterThan(0);
    expect(page.next).toBe(size);
    // Every returned line is a complete record, and the last one is the file's.
    expect(page.lines[page.lines.length - 1]?.seq).toBe(20);
  });

  it('returns the whole file when the window covers it', () => {
    const { sessionId, path } = withLines(4);
    const page = harness.reader.tail(sessionId, { maxBytes: 1_000_000 });
    expect(page.lines).toHaveLength(4);
    expect(page).toMatchObject({ from: 0, next: statSync(path).size });
  });

  it('is capped by runner.transcript.maxTailBytes', () => {
    const capped = makeHarness({
      dataRoot: makeTempDir('agentmanager-runner-cap-').path,
      config: { transcript: { ...harness.config.transcript, maxTailBytes: 200 } },
      io,
    });
    try {
      const seeded = capped.seed();
      const session = capped.sessions.enqueue({
        assignmentId: seeded.assignmentId,
        agentId: seeded.agentId,
        projectId: seeded.projectId,
        prompt: 'p',
      });
      const transcript = capped.transcripts.open(session.id, {
        flushLines: 1,
        flushMs: 1,
        maxMb: 1,
      });
      for (let i = 0; i < 50; i += 1) transcript.append('assistant', { text: `t-${String(i)}` });
      transcript.close();

      const page = capped.reader.tail(session.id, { maxBytes: 5_000_000 });
      const bytes = page.lines.reduce((sum, line) => sum + JSON.stringify(line).length + 1, 0);
      expect(bytes).toBeLessThanOrEqual(200);
      expect(page.lines.length).toBeGreaterThan(0);
    } finally {
      capped.close();
    }
  });

  it('costs one read on a multi-hundred-megabyte transcript', () => {
    const gapBytes = 300 * 1024 * 1024;
    const { sessionId, path } = withLines(1);

    // A 300 MB file whose last quarter-megabyte is real JSONL and whose body is
    // a gap containing no newline at all — so a reader that scanned forward, or
    // that failed to snap to a line boundary, would be obvious rather than slow.
    const tailLines = Array.from(
      { length: 2000 },
      (_unused, i) =>
        `${JSON.stringify({ seq: i + 1, ts: '2026-08-16T10:00:00.000Z', type: 'assistant', text: `big-${String(i)}` })}\n`,
    ).join('');
    const fd = openSync(path, 'r+');
    try {
      writeSync(fd, Buffer.from(tailLines, 'utf8'), 0, Buffer.byteLength(tailLines), gapBytes);
    } finally {
      closeSync(fd);
    }
    const size = statSync(path).size;
    expect(size).toBeGreaterThan(gapBytes);
    harness.storage.store.sessions.setTranscriptBytes(sessionId, size);

    const before = { ...io.stats };
    const page = harness.reader.tail(sessionId, { maxBytes: 65_536 });

    expect(io.stats.reads - before.reads).toBe(1);
    expect(io.stats.opens - before.opens).toBe(1);
    expect(io.stats.bytes - before.bytes).toBeLessThanOrEqual(65_536);
    expect(page.lines.length).toBeGreaterThan(0);
    expect(page.lines[page.lines.length - 1]).toMatchObject({ seq: 2000, text: 'big-1999' });
    expect(page.next).toBe(size);
    // No partial first line survived the snap.
    for (const line of page.lines) expect(typeof line.seq).toBe('number');

    // The same request against a tiny file costs exactly the same work.
    const small = withLines(3);
    const beforeSmall = { ...io.stats };
    harness.reader.tail(small.sessionId, { maxBytes: 65_536 });
    expect(io.stats.reads - beforeSmall.reads).toBe(1);
  }, 60_000);
});

describe('one reader, two faces', () => {
  it('getTranscriptTail returns exactly what tail() does', async () => {
    const { sessionId } = withLines(12, 'shared');
    const direct = harness.reader.tail(sessionId, { maxBytes: 400 });
    const viaService = await harness.service.getTranscriptTail(sessionId, { maxBytes: 400 });
    expect(JSON.stringify(viaService.lines)).toBe(JSON.stringify(direct.lines));
    expect(viaService).toMatchObject({ from: direct.from, next: direct.next, pruned: false });
  });

  it('readTranscript is the forward face of the same reader', async () => {
    const { sessionId } = withLines(6);
    const direct = harness.reader.read(sessionId, { from: 0, limit: 2 });
    const viaService = await harness.service.readTranscript(sessionId, { from: 0, limit: 2 });
    expect(JSON.stringify(viaService)).toBe(JSON.stringify(direct));
  });
});

/** The byte length of the last `count` lines of a session's transcript. */
function lengthOfLastLines(local: RunnerHarness, sessionId: string, count: number): number {
  const page = local.reader.read(sessionId);
  return page.lines
    .slice(page.lines.length - count)
    .reduce((sum, line) => sum + Buffer.byteLength(`${JSON.stringify(line)}\n`), 0);
}
