/**
 * Transcript retention (projects DESIGN §3.3; IMPLEMENTATION M5).
 *
 * M5's third and fourth acceptance criteria:
 *
 * - "The prune job removes transcripts older than the configured days and,
 *   separately, trims oldest-first once `SUM(sessions.transcript_bytes)` for the
 *   project exceeds its MB cap — in both cases NULLing `transcript_path` so the
 *   timeline entry stays present with `transcriptAvailable: false`, and **never
 *   walking the transcript directory tree**";
 * - "A session with `pinned` set survives both prune paths."
 *
 * The "never walking the tree" half is the one that needs thinking about to
 * test, because absence of a `readdir` is not something an assertion can see.
 * It is proven the other way round: the byte column is made to **disagree** with
 * the files on disk, and the cap is shown to trip on the column. A job that
 * measured the directory would not fire at all.
 *
 * Transcripts here are real files under a real transcripts root, written through
 * foundation's own `TranscriptStore` — the pruner's job is to delete a file and
 * clear a row in one go, and a fake store would leave exactly that pairing
 * untested.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SessionRecord } from '../../storage/index.js';

import { effectiveRetention, transcriptAge } from './retention.js';
import { BUILT_IN_RETENTION_DEFAULTS, type Project } from './types.js';
import { makeHarness, makeTempDir, type TempDir, type TestHarness } from './__tests__/helpers.js';

let dataRootDir: TempDir;
let workDir: TempDir;
let harness: TestHarness | undefined;

/** "Now" for every test here: the retention window is measured back from it. */
const NOW = new Date('2026-08-17T12:00:00.000Z');

beforeEach(() => {
  dataRootDir = makeTempDir('agentmanager-projects-retention-data-');
  workDir = makeTempDir('agentmanager-projects-retention-work-');
  harness = undefined;
});

afterEach(() => {
  harness?.storage.close();
  harness = undefined;
  dataRootDir.cleanup();
  workDir.cleanup();
});

function open(): TestHarness {
  harness = makeHarness({
    dataRoot: dataRootDir.path,
    projectsRoot: resolve(workDir.path, 'projects'),
    clock: () => NOW,
  });
  return harness;
}

async function makeProject(h: TestHarness, name = 'App'): Promise<Project> {
  const folder = resolve(workDir.path, name);
  const { mkdirSync } = await import('node:fs');
  mkdirSync(folder, { recursive: true });
  const project = await h.service.create({ localPath: folder });
  h.storage.store.assignments.create({
    id: `assignment-${project.slug}`,
    projectId: project.id,
    pattern: 'solo',
  });
  return project;
}

/**
 * A finished session with a real transcript on disk.
 *
 * `bytes` overrides what the row records, so a test can make the column and the
 * file disagree — which is how "the measure is the column" is proven.
 */
function makeSession(
  h: TestHarness,
  project: Project,
  options: { endedAt: string; lines?: number; pinned?: boolean; bytes?: number },
): SessionRecord {
  const session = h.storage.store.sessions.create({
    assignmentId: `assignment-${project.slug}`,
    agentId: 'ada',
    projectId: project.id,
    status: 'done',
    summary: 'did the thing',
    pinned: options.pinned ?? false,
    startedAt: options.endedAt,
    endedAt: options.endedAt,
  });

  const writer = h.storage.store.transcripts.open(session.id, { at: new Date(options.endedAt) });
  for (let index = 0; index < (options.lines ?? 3); index += 1) {
    writer.append({ type: 'assistant', text: `line ${String(index)}` });
  }
  writer.close();

  if (options.bytes !== undefined) {
    h.storage.store.sessions.setTranscriptBytes(session.id, options.bytes);
  }
  const stored = h.storage.store.sessions.get(session.id);
  if (stored === undefined) throw new Error('the session vanished');
  return stored;
}

function absoluteTranscript(h: TestHarness, session: SessionRecord): string {
  const path = h.storage.store.sessions.get(session.id)?.transcriptPath;
  return path === null || path === undefined ? '' : resolve(h.storage.paths.transcripts, path);
}

describe('effectiveRetention (§3.3)', () => {
  it('inherits the globals when the project overrides nothing', () => {
    expect(effectiveRetention({ retention: null }, BUILT_IN_RETENTION_DEFAULTS)).toEqual(
      BUILT_IN_RETENTION_DEFAULTS,
    );
  });

  it('takes the project’s own numbers when it has them', () => {
    const own = { transcriptDays: 7, transcriptCapMb: 1, keepPinned: false };
    expect(effectiveRetention({ retention: own }, BUILT_IN_RETENTION_DEFAULTS)).toEqual(own);
  });
});

describe('transcriptAge', () => {
  it('dates a transcript from endedAt, falling back to startedAt', () => {
    expect(transcriptAge({ endedAt: 'b', startedAt: 'a' } as unknown as SessionRecord)).toBe('b');
    expect(transcriptAge({ endedAt: null, startedAt: 'a' } as unknown as SessionRecord)).toBe('a');
    expect(
      transcriptAge({ endedAt: null, startedAt: null } as unknown as SessionRecord),
    ).toBeUndefined();
  });
});

describe('the age rule (M5 acceptance 3)', () => {
  it('removes transcripts older than transcriptDays and keeps the timeline entry', async () => {
    const h = open();
    const project = await makeProject(h);
    // 30 days, so "old" is unambiguous either side of it.
    h.service.update(project.id, { retention: { transcriptDays: 30, transcriptCapMb: 500 } });

    const old = makeSession(h, project, { endedAt: '2026-06-01T10:00:00.000Z' });
    const recent = makeSession(h, project, { endedAt: '2026-08-16T10:00:00.000Z' });
    const oldFile = absoluteTranscript(h, old);
    expect(existsSync(oldFile)).toBe(true);

    const result = h.service.pruneTranscripts(NOW);

    expect(result.projects[0]?.byAge).toEqual([old.id]);
    expect(result.projects[0]?.byCap).toEqual([]);

    // The file is gone, the row is cleared, and — the point of §3.3 — the entry
    // is still on the timeline.
    expect(existsSync(oldFile)).toBe(false);
    expect(h.storage.store.sessions.get(old.id)?.transcriptPath).toBeNull();
    expect(h.storage.store.sessions.get(old.id)?.transcriptBytes).toBe(0);
    expect(existsSync(absoluteTranscript(h, recent))).toBe(true);

    const sessions = h.service.activity(project.id).entries[0]?.sessions ?? [];
    expect(sessions).toHaveLength(2);
    expect(sessions.find((entry) => entry.id === old.id)).toMatchObject({
      transcriptAvailable: false,
      summary: 'did the thing',
    });
    expect(sessions.find((entry) => entry.id === recent.id)?.transcriptAvailable).toBe(true);
  });

  it('leaves a pinned session alone (M5 acceptance 4)', async () => {
    const h = open();
    const project = await makeProject(h, 'Pinned');
    h.service.update(project.id, { retention: { transcriptDays: 30, transcriptCapMb: 500 } });

    const pinned = makeSession(h, project, {
      endedAt: '2026-01-01T10:00:00.000Z',
      pinned: true,
    });

    const result = h.service.pruneTranscripts(NOW);

    expect(result.projects[0]?.byAge).toEqual([]);
    expect(existsSync(absoluteTranscript(h, pinned))).toBe(true);
    expect(h.storage.store.sessions.get(pinned.id)?.transcriptPath).not.toBeNull();
  });

  it('honours a project’s own transcriptDays over the global default', async () => {
    const h = open();
    const project = await makeProject(h, 'Strict');
    // The global default is 90 days; this project says one.
    h.service.update(project.id, { retention: { transcriptDays: 1, transcriptCapMb: 500 } });

    const yesterday = makeSession(h, project, { endedAt: '2026-08-15T10:00:00.000Z' });
    expect(h.service.pruneTranscripts(NOW).projects[0]?.byAge).toEqual([yesterday.id]);
  });
});

describe('the size cap (M5 acceptance 3)', () => {
  it('trims oldest-first once SUM(transcript_bytes) exceeds the cap', async () => {
    const h = open();
    const project = await makeProject(h, 'Big');
    // 1 MB cap, and a long age window so only the cap can fire.
    h.service.update(project.id, { retention: { transcriptDays: 3650, transcriptCapMb: 1 } });

    const oldest = makeSession(h, project, {
      endedAt: '2026-08-10T10:00:00.000Z',
      bytes: 700_000,
    });
    const middle = makeSession(h, project, {
      endedAt: '2026-08-12T10:00:00.000Z',
      bytes: 400_000,
    });
    const newest = makeSession(h, project, {
      endedAt: '2026-08-14T10:00:00.000Z',
      bytes: 100_000,
    });

    const result = h.service.pruneTranscripts(NOW);

    // 1.2 MB over a 1 MB cap: dropping the oldest 700 KB is enough, so the
    // other two survive. Oldest-first, not largest-first.
    expect(result.projects[0]?.byAge).toEqual([]);
    expect(result.projects[0]?.byCap).toEqual([oldest.id]);
    expect(h.storage.store.sessions.get(oldest.id)?.transcriptPath).toBeNull();
    expect(h.storage.store.sessions.get(middle.id)?.transcriptPath).not.toBeNull();
    expect(h.storage.store.sessions.get(newest.id)?.transcriptPath).not.toBeNull();
    expect(result.projects[0]?.bytesAfter).toBe(500_000);
  });

  it('measures the byte column, not the transcripts tree', async () => {
    const h = open();
    const project = await makeProject(h, 'Column');
    h.service.update(project.id, { retention: { transcriptDays: 3650, transcriptCapMb: 1 } });

    // Two tiny files whose *rows* claim megabytes. A job that walked the
    // directory would measure a few hundred bytes and prune nothing; §3.3 says
    // the measure is `SUM(sessions.transcript_bytes)`, and it fires.
    const oldest = makeSession(h, project, {
      endedAt: '2026-08-10T10:00:00.000Z',
      lines: 1,
      bytes: 900_000,
    });
    makeSession(h, project, { endedAt: '2026-08-12T10:00:00.000Z', lines: 1, bytes: 900_000 });

    expect(h.storage.store.sessions.transcriptBytesByProject(project.id)).toBe(1_800_000);
    const result = h.service.pruneTranscripts(NOW);
    expect(result.projects[0]?.byCap).toEqual([oldest.id]);
  });

  it('leaves a pinned session alone even when it is what blows the cap (M5 acceptance 4)', async () => {
    const h = open();
    const project = await makeProject(h, 'PinnedCap');
    h.service.update(project.id, { retention: { transcriptDays: 3650, transcriptCapMb: 1 } });

    const pinned = makeSession(h, project, {
      endedAt: '2026-08-01T10:00:00.000Z',
      bytes: 5_000_000,
      pinned: true,
    });

    const result = h.service.pruneTranscripts(NOW);

    expect(result.projects[0]?.byCap).toEqual([]);
    expect(existsSync(absoluteTranscript(h, pinned))).toBe(true);
    // The project stays over its cap, which is the honest outcome: a pin is the
    // user overriding the policy, not a hint.
    expect(result.projects[0]?.bytesAfter).toBeGreaterThan(1024 * 1024);
  });

  it('drops keepPinned when the project turns it off', async () => {
    const h = open();
    const project = await makeProject(h, 'NoPins');
    h.service.update(project.id, {
      retention: { transcriptDays: 1, transcriptCapMb: 500, keepPinned: false },
    });
    const pinned = makeSession(h, project, {
      endedAt: '2026-01-01T10:00:00.000Z',
      pinned: true,
    });

    expect(h.service.pruneTranscripts(NOW).projects[0]?.byAge).toEqual([pinned.id]);
  });
});

describe('the job as a whole', () => {
  it('walks archived projects too — archiving is not itself a prune trigger', async () => {
    const h = open();
    const project = await makeProject(h, 'Archived');
    h.service.update(project.id, { retention: { transcriptDays: 1, transcriptCapMb: 500 } });
    const stale = makeSession(h, project, { endedAt: '2026-01-01T10:00:00.000Z' });
    h.service.archive(project.id);

    const result = h.service.pruneTranscripts(NOW);
    expect(result.pruned).toBe(1);
    expect(result.projects[0]?.byAge).toEqual([stale.id]);
  });

  it('prunes nothing on a project whose transcripts are all inside both limits', async () => {
    const h = open();
    const project = await makeProject(h, 'Fine');
    makeSession(h, project, { endedAt: '2026-08-16T10:00:00.000Z' });

    const result = h.service.pruneTranscripts(NOW);
    expect(result.pruned).toBe(0);
  });
});
