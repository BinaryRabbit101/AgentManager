/**
 * Transcripts (DESIGN §1.5), against the acceptance criteria of
 * IMPLEMENTATION §5:
 *
 * - a transcript can be appended to and tailed from a byte offset;
 * - a missing transcript file yields a defined "pruned" result rather than an
 *   exception;
 * - appending advances `sessions.transcript_bytes` to match the file's actual
 *   size, including across a writer restart;
 * - `SUM(transcript_bytes)` over a project's sessions is what projects' size
 *   cap reads.
 */
import { readFileSync, rmSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RecordNotFoundError } from './errors.js';
import { openStorage, type Storage } from './storage.js';
import { transcriptRelativePath } from './transcripts.js';
import { makeTempRoot, type TempRoot } from './__tests__/helpers.js';
import type { Store } from './repositories/index.js';

let root: TempRoot;
let storage: Storage;
let store: Store;

beforeEach(() => {
  root = makeTempRoot();
  storage = openStorage({ dataRoot: root.path, tightenAcl: false });
  store = storage.store;
});

afterEach(() => {
  storage.close();
  root.cleanup();
});

interface Fixture {
  readonly projectId: string;
  readonly sessionId: string;
}

function fixture(slug = 'acme', agentId = 'ada'): Fixture {
  const project = store.projects.create({ slug, name: slug });
  const assignment = store.assignments.create({ projectId: project.id, pattern: 'solo' });
  const session = store.sessions.create({
    assignmentId: assignment.id,
    agentId,
    projectId: project.id,
    status: 'running',
  });
  return { projectId: project.id, sessionId: session.id };
}

function bytesOnDisk(relativePath: string): number {
  return statSync(resolve(storage.paths.transcripts, relativePath)).size;
}

describe('the path layout (§1.5)', () => {
  it('is <YYYY>/<MM>/<session-id>.jsonl, in UTC', () => {
    expect(transcriptRelativePath('01J8SESSION', new Date('2026-01-05T23:30:00.000Z'))).toBe(
      '2026/01/01J8SESSION.jsonl',
    );
    // 31 December 23:00 UTC is still December, whatever the host's timezone.
    expect(transcriptRelativePath('s', new Date('2026-12-31T23:00:00.000Z'))).toBe(
      '2026/12/s.jsonl',
    );
  });

  it('is the only thing that joins a stored path to the transcripts root', () => {
    expect(store.transcripts.root).toBe(storage.paths.transcripts);
    expect(store.transcripts.absolutePath('2026/08/s.jsonl')).toBe(
      resolve(storage.paths.transcripts, '2026/08/s.jsonl'),
    );
  });
});

describe('appending and byte accounting', () => {
  it('records the path on the session and stamps ts when the entry has none', () => {
    const { sessionId } = fixture();
    const writer = store.transcripts.open(sessionId, { at: new Date('2026-08-16T10:00:00.000Z') });

    writer.append({ seq: 1, type: 'system', subtype: 'init' });
    writer.close();

    expect(writer.relativePath).toBe(`2026/08/${sessionId}.jsonl`);
    expect(store.sessions.get(sessionId)?.transcriptPath).toBe(writer.relativePath);

    const line = JSON.parse(readFileSync(writer.path, 'utf8').trim()) as Record<string, unknown>;
    expect(line['seq']).toBe(1);
    expect(line['ts']).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('advances transcript_bytes to exactly the file size on every append', () => {
    const { sessionId } = fixture();
    const writer = store.transcripts.open(sessionId);

    for (let i = 0; i < 25; i += 1) {
      writer.append({ seq: i, type: 'assistant', text: `line ${i}` });
      const row = store.sessions.get(sessionId);
      expect(row?.transcriptBytes).toBe(writer.bytes());
      expect(row?.transcriptBytes).toBe(bytesOnDisk(writer.relativePath));
    }

    writer.close();
    expect(store.sessions.get(sessionId)?.transcriptBytes).toBe(bytesOnDisk(writer.relativePath));
  });

  it('keeps the count right across a writer restart, initialising from the file', () => {
    const { sessionId } = fixture();

    const first = store.transcripts.open(sessionId);
    first.append({ seq: 1, type: 'user' });
    first.append({ seq: 2, type: 'assistant' });
    const afterFirst = first.bytes();
    first.close();

    // The row is deliberately corrupted to prove the reopen re-derives it from
    // the file rather than trusting whatever the column happened to hold.
    store.sessions.setTranscriptBytes(sessionId, 999_999);

    const second = store.transcripts.open(sessionId);
    expect(second.bytes()).toBe(afterFirst);
    expect(store.sessions.get(sessionId)?.transcriptBytes).toBe(afterFirst);

    second.append({ seq: 3, type: 'assistant' });
    second.close();

    const size = bytesOnDisk(second.relativePath);
    expect(size).toBeGreaterThan(afterFirst);
    expect(store.sessions.get(sessionId)?.transcriptBytes).toBe(size);
  });

  it('reuses the recorded path after a restart in a different month', () => {
    const { sessionId } = fixture();
    const first = store.transcripts.open(sessionId, { at: new Date('2026-08-31T23:59:00.000Z') });
    first.append({ seq: 1 });
    first.close();
    expect(first.relativePath).toBe(`2026/08/${sessionId}.jsonl`);

    // A month later the writer must append to the original file, not start a
    // second one under 2026/09.
    const second = store.transcripts.open(sessionId, { at: new Date('2026-09-01T00:01:00.000Z') });
    expect(second.relativePath).toBe(first.relativePath);
    second.append({ seq: 2 });
    second.close();

    const tail = store.transcripts.tail(sessionId);
    expect(tail.status === 'ok' && tail.lines).toHaveLength(2);
  });

  it('appendMany writes one batch and still lands the right byte count', () => {
    const { sessionId } = fixture();
    const writer = store.transcripts.open(sessionId);

    writer.appendMany([{ seq: 1 }, { seq: 2 }, { seq: 3 }]);
    writer.close();

    expect(writer.linesWritten()).toBe(3);
    expect(store.sessions.get(sessionId)?.transcriptBytes).toBe(bytesOnDisk(writer.relativePath));
  });

  it('flushes on the line threshold and refuses writes after close', () => {
    const { sessionId } = fixture();
    const writer = store.transcripts.open(sessionId, { fsyncEveryLines: 2, fsyncIntervalMs: 50 });

    writer.append({ seq: 1 });
    writer.append({ seq: 2 }); // threshold reached — fsync happens here
    writer.close();

    expect(() => writer.append({ seq: 3 })).toThrow(/closed/);
    expect(() => writer.close()).not.toThrow();
  });

  it('escapes a newline inside a value, so one entry is always one line', () => {
    const { sessionId } = fixture();
    const writer = store.transcripts.open(sessionId);
    writer.append({ seq: 1, text: 'line one\nline two' });
    writer.close();

    expect(readFileSync(writer.path, 'utf8').split('\n').filter(Boolean)).toHaveLength(1);
    const tail = store.transcripts.tail(sessionId);
    expect(
      tail.status === 'ok' && (JSON.parse(tail.lines[0] as string) as { text: string }).text,
    ).toBe('line one\nline two');
  });
});

describe('tailing from a byte offset', () => {
  it('reads from an offset and resumes exactly where it left off', () => {
    const { sessionId } = fixture();
    const writer = store.transcripts.open(sessionId);
    writer.append({ seq: 1, type: 'user' });
    writer.append({ seq: 2, type: 'assistant' });
    writer.flush();

    const first = store.transcripts.tail(sessionId);
    expect(first.status).toBe('ok');
    if (first.status !== 'ok') return;
    expect(first.from).toBe(0);
    expect(first.lines).toHaveLength(2);
    expect(first.nextOffset).toBe(first.size);

    // Nothing new yet.
    const idle = store.transcripts.tail(sessionId, { from: first.nextOffset });
    expect(idle.status === 'ok' && idle.lines).toEqual([]);

    writer.append({ seq: 3, type: 'result' });
    writer.close();

    const resumed = store.transcripts.tail(sessionId, { from: first.nextOffset });
    expect(resumed.status).toBe('ok');
    if (resumed.status !== 'ok') return;
    expect(resumed.lines).toHaveLength(1);
    expect((JSON.parse(resumed.lines[0] as string) as { seq: number }).seq).toBe(3);
    expect(resumed.nextOffset).toBe(bytesOnDisk(writer.relativePath));
  });

  it('never returns a partial line, and reports where the whole one starts', () => {
    const { sessionId } = fixture();
    const writer = store.transcripts.open(sessionId);
    writer.append({ seq: 1, type: 'user' });
    writer.append({ seq: 2, type: 'assistant' });
    writer.close();

    const size = bytesOnDisk(writer.relativePath);
    // A cap that lands mid-way through the second line.
    const capped = store.transcripts.tail(sessionId, { maxBytes: size - 5 });
    expect(capped.status).toBe('ok');
    if (capped.status !== 'ok') return;

    expect(capped.lines).toHaveLength(1);
    expect(capped.nextOffset).toBeLessThan(size);
    // Resuming from there yields the line the cap cut off, in full.
    const rest = store.transcripts.tail(sessionId, { from: capped.nextOffset });
    expect(rest.status === 'ok' && rest.lines).toHaveLength(1);
  });

  it('clamps an offset past the end instead of throwing', () => {
    const { sessionId } = fixture();
    const writer = store.transcripts.open(sessionId);
    writer.append({ seq: 1 });
    writer.close();

    const tail = store.transcripts.tail(sessionId, { from: 10_000 });
    expect(tail.status).toBe('ok');
    if (tail.status !== 'ok') return;
    expect(tail.lines).toEqual([]);
    expect(tail.from).toBe(tail.size);
  });
});

describe('pruning', () => {
  it('a file deleted out from under the DB reads as pruned, not as an exception', () => {
    const { sessionId } = fixture();
    const writer = store.transcripts.open(sessionId);
    writer.append({ seq: 1 });
    writer.close();

    rmSync(writer.path);

    const tail = store.transcripts.tail(sessionId);
    expect(tail).toEqual({ status: 'pruned', sessionId, reason: 'file-missing' });
  });

  it('prune() deletes the file and NULLs the path, and the tail says so', () => {
    const { sessionId } = fixture();
    const writer = store.transcripts.open(sessionId);
    writer.append({ seq: 1 });
    writer.close();

    expect(store.transcripts.prune(sessionId)).toBe(true);

    const session = store.sessions.get(sessionId);
    expect(session?.transcriptPath).toBeNull();
    expect(session?.transcriptBytes).toBe(0);

    const tail = store.transcripts.tail(sessionId);
    expect(tail).toEqual({ status: 'pruned', sessionId, reason: 'path-cleared' });

    // Pruning twice is not an error; there is simply nothing left to do.
    expect(store.transcripts.prune(sessionId)).toBe(false);
  });

  it('a session that never wrote a transcript reads as pruned', () => {
    const { sessionId } = fixture();
    expect(store.transcripts.tail(sessionId)).toEqual({
      status: 'pruned',
      sessionId,
      reason: 'path-cleared',
    });
  });

  it('an unknown session is an error, because that is a caller bug', () => {
    expect(() => store.transcripts.tail('no-such-session')).toThrow(RecordNotFoundError);
  });
});

describe('the per-project size cap (§1.5)', () => {
  it('sums transcript_bytes over a project’s sessions, and only that project’s', () => {
    const acme = store.projects.create({ slug: 'acme', name: 'Acme' });
    const other = store.projects.create({ slug: 'other', name: 'Other' });
    const acmeAssignment = store.assignments.create({ projectId: acme.id, pattern: 'pair' });
    const otherAssignment = store.assignments.create({ projectId: other.id, pattern: 'solo' });

    let expected = 0;
    for (const agentId of ['ada', 'linus']) {
      const session = store.sessions.create({
        assignmentId: acmeAssignment.id,
        agentId,
        projectId: acme.id,
      });
      const writer = store.transcripts.open(session.id);
      writer.appendMany([
        { seq: 1, agentId },
        { seq: 2, agentId },
      ]);
      writer.close();
      expected += writer.bytes();
    }

    const noise = store.sessions.create({
      assignmentId: otherAssignment.id,
      agentId: 'grace',
      projectId: other.id,
    });
    const noiseWriter = store.transcripts.open(noise.id);
    noiseWriter.append({ seq: 1 });
    noiseWriter.close();

    expect(store.sessions.transcriptBytesByProject(acme.id)).toBe(expected);
    expect(store.sessions.transcriptBytesByProject(other.id)).toBe(noiseWriter.bytes());

    // Pruning one transcript takes its bytes out of the project's total.
    const first = store.sessions.list({ projectId: acme.id }).at(-1);
    const firstBytes = first?.transcriptBytes ?? 0;
    store.transcripts.prune(first?.id ?? '');
    expect(store.sessions.transcriptBytesByProject(acme.id)).toBe(expected - firstBytes);
  });

  it('reads it as one indexed query rather than a table scan', () => {
    const plan = storage.db
      .prepare<[string], { detail: string }>(
        'EXPLAIN QUERY PLAN SELECT SUM(transcript_bytes) FROM sessions WHERE project_id = ?',
      )
      .all('p')
      .map((row) => row.detail)
      .join(' | ');

    expect(plan).toContain('sessions_project_idx');
  });
});
