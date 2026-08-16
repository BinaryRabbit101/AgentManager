/**
 * The transcript writer, byte accounting and summary (runner IMPLEMENTATION M2).
 *
 * Acceptance, criterion by criterion:
 *
 * - "Appending advances `transcript_bytes` to the file's exact size, verified
 *   after a flush, after a clean close, and after a simulated crash followed by
 *   `fs.stat` reconciliation" — *byte accounting*;
 * - "A line containing an OAuth-shaped token and a `Bearer` header is written
 *   with `[redacted]`; the raw value appears nowhere in the file" — *redaction*;
 * - "`seq` is strictly increasing with no gaps across a pause/resume that reuses
 *   the same file" — *seq*;
 * - "Exceeding `transcript.maxMb` appends exactly one `error` line with
 *   `code: transcript_cap`, stops appending, and does not fail the session" —
 *   *the cap*;
 * - "`summary` … matches the §8.3 formula, is ≤ 240 characters, and is present
 *   (prompt + `running`) while the session is still live" — *summary*.
 */
import { appendFileSync, readFileSync, statSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { composeSummary, PROMPT_MAX_LENGTH, SUMMARY_MAX_LENGTH, truncate } from './summary.js';
import { lastSeqOf, type SessionTranscript } from './transcript.js';
import {
  enqueue,
  makeHarness,
  makeTempDir,
  type RunnerHarness,
  type TempDir,
} from './__tests__/helpers.js';

let dataRootDir: TempDir;
let harness: RunnerHarness;
let seed: { projectId: string; assignmentId: string; agentId: string };
let open: SessionTranscript[] = [];

function openFor(
  sessionId: string,
  overrides: { maxMb?: number; flushLines?: number } = {},
): SessionTranscript {
  const transcript = harness.transcripts.open(sessionId, {
    flushLines: overrides.flushLines ?? harness.config.transcript.flushLines,
    flushMs: harness.config.transcript.flushMs,
    maxMb: overrides.maxMb ?? harness.config.transcript.maxMb,
  });
  open.push(transcript);
  return transcript;
}

function rowBytes(sessionId: string): number {
  return harness.sessions.require(sessionId).transcriptBytes;
}

beforeEach(() => {
  dataRootDir = makeTempDir('agentmanager-runner-transcript-');
  harness = makeHarness({ dataRoot: dataRootDir.path });
  seed = harness.seed();
  open = [];
});

afterEach(() => {
  for (const transcript of open) {
    try {
      transcript.close();
    } catch {
      // Already closed by the test; nothing to do.
    }
  }
  harness.close();
  dataRootDir.cleanup();
});

describe('byte accounting', () => {
  it('advances transcript_bytes to the file size after a flush', () => {
    const session = enqueue(harness, seed);
    const transcript = openFor(session.id);

    transcript.append('session.start', { agentId: seed.agentId, model: 'sonnet' });
    transcript.append('user', { text: 'go' });
    transcript.flush();

    const onDisk = statSync(transcript.path).size;
    expect(onDisk).toBeGreaterThan(0);
    expect(transcript.bytes()).toBe(onDisk);
    expect(rowBytes(session.id)).toBe(onDisk);
  });

  it('leaves transcript_bytes exact after a clean close', () => {
    const session = enqueue(harness, seed);
    const transcript = openFor(session.id);
    transcript.append('assistant', { text: 'done' });
    transcript.close();

    expect(rowBytes(session.id)).toBe(statSync(transcript.path).size);
  });

  it('reconciles from fs.stat after a simulated crash', () => {
    const session = enqueue(harness, seed);
    const transcript = openFor(session.id);
    transcript.append('user', { text: 'first' });
    const path = transcript.path;

    // The crash: bytes reach the file, the row's counter does not — exactly the
    // "last flush lagged the crash" case §8.2 names.
    appendFileSync(path, `${JSON.stringify({ seq: 99, ts: 'x', type: 'assistant' })}\n`, 'utf8');
    harness.storage.store.sessions.setTranscriptBytes(session.id, 0);
    expect(rowBytes(session.id)).toBe(0);

    const reconciled = harness.transcripts.reconcileBytes(session.id);
    expect(reconciled).toBe(statSync(path).size);
    expect(rowBytes(session.id)).toBe(reconciled);
  });

  it('answers undefined rather than throwing for a pruned transcript', () => {
    const session = enqueue(harness, seed);
    const transcript = openFor(session.id);
    transcript.append('user', { text: 'x' });
    transcript.close();

    harness.storage.store.transcripts.prune(session.id);
    expect(harness.transcripts.reconcileBytes(session.id)).toBeUndefined();
  });
});

describe('redaction', () => {
  it('writes an OAuth-shaped token and a Bearer header as [redacted]', () => {
    const oauth = 'sk-ant-oat01-Ab3dEfGhIjKlMnOpQrStUvWxYz0123456789';
    const bearer = 'e7b1c9d3f5a7b9c1d3e5f7a9b1c3d5e7';
    const session = enqueue(harness, seed);
    const transcript = openFor(session.id);

    transcript.append('assistant', {
      text: `run: set CLAUDE_CODE_OAUTH_TOKEN=${oauth}`,
      request: { headers: { authorization: `Bearer ${bearer}` } },
      nested: [{ deep: `Authorization: Bearer ${bearer}` }],
    });
    transcript.close();

    const contents = readFileSync(transcript.path, 'utf8');
    expect(contents).not.toContain(oauth);
    expect(contents).not.toContain(bearer);
    expect(contents).toContain('[redacted]');
  });

  it('leaves the stamped fields intact', () => {
    const session = enqueue(harness, seed);
    const transcript = openFor(session.id);
    transcript.append('user', { text: 'hello' });
    transcript.close();

    const line = JSON.parse(readFileSync(transcript.path, 'utf8').trim()) as Record<
      string,
      unknown
    >;
    expect(line).toMatchObject({ seq: 1, type: 'user', text: 'hello' });
    expect(line['ts']).toBe('2026-08-16T10:00:00.000Z');
  });
});

describe('seq', () => {
  it('is strictly increasing with no gaps across a pause/resume on the same file', () => {
    const session = enqueue(harness, seed);

    const first = openFor(session.id);
    first.append('session.start', {});
    first.append('user', { text: 'go' });
    first.append('assistant', { text: 'working' });
    first.close();

    // The pause: same row, same transcript (§9.4's first resume path).
    const second = openFor(session.id);
    expect(second.nextSeq()).toBe(4);
    second.append('user', { text: 'answer' });
    second.append('assistant', { text: 'continuing' });
    second.close();

    const seqs = readFileSync(second.path, 'utf8')
      .trim()
      .split('\n')
      .map((line) => (JSON.parse(line) as { seq: number }).seq);
    expect(seqs).toEqual([1, 2, 3, 4, 5]);
    expect(lastSeqOf(harness.storage.store.transcripts, session.id)).toBe(5);
  });

  it('starts at 1 on a fresh transcript', () => {
    const session = enqueue(harness, seed);
    const transcript = openFor(session.id);
    expect(transcript.nextSeq()).toBe(1);
    expect(transcript.append('system', { subtype: 'init' })).toBe(1);
  });

  it('finds the last seq even when the tail window holds no complete line', () => {
    const session = enqueue(harness, seed);
    const transcript = openFor(session.id);
    transcript.append('assistant', { text: 'x'.repeat(200_000) });
    transcript.close();

    expect(lastSeqOf(harness.storage.store.transcripts, session.id)).toBe(1);
    expect(openFor(session.id).nextSeq()).toBe(2);
  });
});

describe('the maxMb cap', () => {
  it('appends exactly one transcript_cap line, then stops', () => {
    const session = enqueue(harness, seed);
    // 64 KB, so a handful of fat lines crosses it.
    const transcript = openFor(session.id, { maxMb: 64 / 1024 });

    for (let i = 0; i < 40; i += 1) transcript.append('assistant', { text: 'y'.repeat(4096) });
    transcript.flush();

    expect(transcript.capped()).toBe(true);

    const lines = readFileSync(transcript.path, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const capLines = lines.filter((line) => line['code'] === 'transcript_cap');
    expect(capLines).toHaveLength(1);
    expect(capLines[0]).toMatchObject({ type: 'error', code: 'transcript_cap' });
    // The cap line is the last thing in the file: appending stopped there.
    expect(lines[lines.length - 1]).toBe(capLines[0]);

    // Further appends are no-ops rather than throws — "the session continues to
    // run and meter".
    const sizeAfterCap = statSync(transcript.path).size;
    expect(transcript.append('assistant', { text: 'more' })).toBeUndefined();
    expect(statSync(transcript.path).size).toBe(sizeAfterCap);

    // And the session is untouched by it.
    expect(harness.sessions.require(session.id).status).toBe('queued');
  });

  it('reopens a capped transcript already capped', () => {
    const session = enqueue(harness, seed);
    const first = openFor(session.id, { maxMb: 32 / 1024 });
    for (let i = 0; i < 20; i += 1) first.append('assistant', { text: 'z'.repeat(4096) });
    first.close();

    const second = openFor(session.id, { maxMb: 32 / 1024 });
    expect(second.capped()).toBe(true);
    expect(second.append('user', { text: 'ignored' })).toBeUndefined();
  });
});

describe('§8.3 summary', () => {
  it('matches the formula for a completed session', () => {
    expect(
      composeSummary({
        prompt: 'Draft the migration',
        status: 'done',
        lastAssistantText: 'Added migrations/runner/0001_runner.sql.',
      }),
    ).toBe('Draft the migration — completed: Added migrations/runner/0001_runner.sql.');
  });

  it('omits the assistant clause when there is none', () => {
    expect(composeSummary({ prompt: 'Draft the migration', status: 'interrupted' })).toBe(
      'Draft the migration — stopped',
    );
  });

  it('is present as prompt + running while the session is live', () => {
    const session = enqueue(harness, seed);
    const live = composeSummary({ prompt: 'Draft the migration', status: 'running' });
    harness.sessions.setSummary(session.id, live);

    expect(harness.sessions.require(session.id).summary).toBe('Draft the migration — running');
  });

  it('bounds the whole digest at 240 characters', () => {
    const summary = composeSummary({
      prompt: 'p'.repeat(4000),
      status: 'done',
      lastAssistantText: 'a'.repeat(4000),
    });
    expect(summary.length).toBeLessThanOrEqual(SUMMARY_MAX_LENGTH);
    expect(summary).toContain('— completed');
  });

  it('truncates on a grapheme boundary, not a code unit', () => {
    // A flag is two surrogate pairs; cutting between them yields a lone
    // surrogate, which is what this refuses to do.
    const flags = '🇬🇧'.repeat(40);
    const cut = truncate(flags, 21);
    expect(cut.length).toBeLessThanOrEqual(21);
    expect(cut.endsWith('…')).toBe(true);
    expect(
      [...cut].some(
        (ch) => ch.charCodeAt(0) >= 0xd800 && ch.charCodeAt(0) <= 0xdbff && ch.length === 1,
      ),
    ).toBe(false);
    expect(JSON.stringify(cut)).not.toContain('\\ud83c"');
  });

  it('keeps each part inside its own budget', () => {
    expect(truncate('x'.repeat(500), PROMPT_MAX_LENGTH).length).toBe(PROMPT_MAX_LENGTH);
  });

  it('names every status with a plain word', () => {
    const words = (
      ['queued', 'running', 'paused', 'done', 'failed', 'interrupted', 'orphaned'] as const
    ).map((status) => composeSummary({ prompt: 'p', status }));
    expect(words).toEqual([
      'p — queued',
      'p — running',
      'p — paused',
      'p — completed',
      'p — failed',
      'p — stopped',
      'p — orphaned',
    ]);
  });
});
