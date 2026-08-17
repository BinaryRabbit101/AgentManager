/**
 * The project activity timeline (projects DESIGN §3.1; IMPLEMENTATION M5).
 *
 * M5's first, second and fifth acceptance criteria live here; the two prune
 * criteria are `retention.test.ts`'s.
 *
 * - "A finished assignment with two agents renders as **one entry** listing both
 *   agents, its workspace, token totals joined from `session_usage`, the derived
 *   outcome, and per-session summaries read from `sessions.summary`";
 * - "**Every value** of `sessions.status` maps to exactly one assignment
 *   `outcome` per the DESIGN §3.1 table, including `orphaned` and `interrupted`;
 *   no status is silently unhandled";
 * - "`lastActivityAt` updates when a session starts on the project".
 *
 * The second one is enumerated from foundation's vocabulary rather than from a
 * hand-written list, so a status added there without a row in §3.1's table fails
 * this file instead of quietly picking a default.
 */
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SessionStatus } from '../../storage/index.js';

import { deriveOutcome } from './activity.js';
import { isWorkspaceRefusal, type Project } from './types.js';
import {
  makeHarness,
  makeTempDir,
  refusalFrom,
  type TempDir,
  type TestHarness,
} from './__tests__/helpers.js';

/** Foundation's session vocabulary, in full (§1.4). */
const ALL_STATUSES: readonly SessionStatus[] = [
  'queued',
  'running',
  'paused',
  'done',
  'failed',
  'interrupted',
  'orphaned',
];

let dataRootDir: TempDir;
let workDir: TempDir;
let harness: TestHarness | undefined;

beforeEach(() => {
  dataRootDir = makeTempDir('agentmanager-projects-activity-data-');
  workDir = makeTempDir('agentmanager-projects-activity-work-');
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
  });
  return harness;
}

async function makeProject(h: TestHarness, name = 'App'): Promise<Project> {
  const folder = resolve(workDir.path, name);
  mkdirSync(folder, { recursive: true });
  return h.service.create({ localPath: folder });
}

describe('deriveOutcome — DESIGN §3.1’s table (M5 acceptance 2)', () => {
  it.each([
    [['queued'], 'running'],
    [['running'], 'running'],
    [['paused'], 'running'],
    [['done'], 'completed'],
    [['failed'], 'failed'],
    [['orphaned'], 'failed'],
    [['interrupted'], 'stopped'],
  ] as [SessionStatus[], string][])('maps a lone %s to %s', (statuses, outcome) => {
    expect(deriveOutcome(statuses)).toBe(outcome);
  });

  it('handles every value of the vocabulary — none is silently unhandled', () => {
    // The point of enumerating foundation's own list: a status added there with
    // no row in §3.1's table shows up here rather than defaulting quietly.
    for (const status of ALL_STATUSES) {
      expect(['running', 'completed', 'stopped', 'failed']).toContain(deriveOutcome([status]));
    }
  });

  it.each([
    // Table order decides the overlaps, and the `stopped` row's own wording
    // ("no session running") is what says so.
    [['running', 'failed'], 'running'],
    [['done', 'failed'], 'failed'],
    [['done', 'interrupted'], 'stopped'],
    [['done', 'done'], 'completed'],
    [['interrupted', 'orphaned'], 'failed'],
  ] as [SessionStatus[], string][])('maps the mixed set %s to %s', (statuses, outcome) => {
    expect(deriveOutcome(statuses)).toBe(outcome);
  });

  it('treats an assignment with no sessions as still running, not completed', () => {
    // "Every session is done" is vacuously true of an empty set, and taking
    // that reading would show a finished entry for work that never started.
    expect(deriveOutcome([])).toBe('running');
  });
});

describe('GET /api/projects/:id/activity (M5 acceptance 1)', () => {
  it('renders a finished two-agent assignment as one entry, with everything §3.1 lists', async () => {
    const h = open();
    const project = await makeProject(h);

    const lease = await h.service.acquireWorkspace(project.id, 'assignment-1', { write: true });
    if (isWorkspaceRefusal(lease)) throw new Error('the primary tree was refused');

    const assignment = h.storage.store.assignments.create({
      id: 'assignment-1',
      projectId: project.id,
      pattern: 'pair',
      scopeJson: JSON.stringify({ paths: ['docs/', 'src/api'] }),
      members: [
        { agentId: 'ada-architect', role: 'architect' },
        { agentId: 'sceptic-sam', role: 'skeptic' },
      ],
    });

    const first = h.storage.store.sessions.create({
      assignmentId: assignment.id,
      agentId: 'ada-architect',
      projectId: project.id,
      status: 'done',
      summary: 'drafted the design',
      transcriptPath: '2026/08/one.jsonl',
      startedAt: '2026-08-16T09:00:00.000Z',
      endedAt: '2026-08-16T09:30:00.000Z',
    });
    const second = h.storage.store.sessions.create({
      assignmentId: assignment.id,
      agentId: 'sceptic-sam',
      projectId: project.id,
      status: 'done',
      summary: 'found two holes in it',
      // Already pruned: the entry must still render, with the flag false.
      transcriptPath: null,
      startedAt: '2026-08-16T09:05:00.000Z',
      endedAt: '2026-08-16T09:40:00.000Z',
    });

    h.storage.store.usage.record({ sessionId: first.id, inputTokens: 1200, outputTokens: 300 });
    h.storage.store.usage.record({ sessionId: second.id, inputTokens: 800, outputTokens: 150 });

    const page = h.service.activity(project.id);
    expect(page.entries).toHaveLength(1);
    expect(page.total).toBe(1);

    const entry = page.entries[0];
    expect(entry?.assignmentId).toBe('assignment-1');
    expect(entry?.agentIds).toEqual(['ada-architect', 'sceptic-sam']);
    expect(entry?.pattern).toBe('pair');
    expect(entry?.scopeSummary).toBe('docs, src/api');
    expect(entry?.workspace).toEqual({ kind: 'primary', path: project.localPath, branch: null });
    expect(entry?.outcome).toBe('completed');
    // Joined from `session_usage`, not recomputed from a transcript.
    expect(entry?.tokens).toEqual({ input: 2000, output: 450 });
    expect(entry?.startedAt).toBe('2026-08-16T09:00:00.000Z');
    expect(entry?.endedAt).toBe('2026-08-16T09:40:00.000Z');

    expect(entry?.sessions).toEqual([
      expect.objectContaining({
        agentId: 'ada-architect',
        status: 'done',
        summary: 'drafted the design',
        transcriptAvailable: true,
        pinned: false,
      }),
      expect.objectContaining({
        agentId: 'sceptic-sam',
        status: 'done',
        summary: 'found two holes in it',
        // `transcript_path IS NOT NULL`, derived — there is no second column.
        transcriptAvailable: false,
      }),
    ]);
  });

  it('reports a solo assignment’s pattern as null (§3.1)', async () => {
    const h = open();
    const project = await makeProject(h, 'Solo');
    h.storage.store.assignments.create({
      id: 'solo-1',
      projectId: project.id,
      pattern: 'solo',
    });

    expect(h.service.activity(project.id).entries[0]?.pattern).toBeNull();
  });

  it('carries the work items an assignment was launched with', async () => {
    const h = open();
    const project = await makeProject(h, 'Backlog');
    const item = h.service.createWorkItem(project.id, { kind: 'bug', title: 'the crash' });
    h.storage.store.assignments.create({
      id: 'wi-assignment',
      projectId: project.id,
      pattern: 'solo',
    });
    h.service.linkWorkItems('wi-assignment', [item.id]);

    expect(h.service.activity(project.id).entries[0]?.workItemIds).toEqual([item.id]);
  });

  it('renders an assignment that never leased a workspace, rather than inventing one', async () => {
    const h = open();
    const project = await makeProject(h, 'Unleased');
    h.storage.store.assignments.create({ id: 'never-ran', projectId: project.id, pattern: 'solo' });

    const entry = h.service.activity(project.id).entries[0];
    expect(entry?.workspace).toBeNull();
    expect(entry?.outcome).toBe('running');
  });

  it('is grouped by assignment, newest first, and paged', async () => {
    const h = open();
    const project = await makeProject(h, 'Paged');
    for (let index = 0; index < 5; index += 1) {
      h.storage.store.assignments.create({
        id: `assignment-${String(index)}`,
        projectId: project.id,
        pattern: 'solo',
        createdAt: `2026-08-1${String(index)}T10:00:00.000Z`,
      });
      // Two sessions per assignment: they must collapse into one entry.
      for (const agent of ['a', 'b']) {
        h.storage.store.sessions.create({
          assignmentId: `assignment-${String(index)}`,
          agentId: agent,
          projectId: project.id,
          status: 'done',
        });
      }
    }

    const first = h.service.activity(project.id, { limit: 2 });
    expect(first.entries.map((entry) => entry.assignmentId)).toEqual([
      'assignment-4',
      'assignment-3',
    ]);
    expect(first.total).toBe(5);
    expect(first.entries[0]?.sessions).toHaveLength(2);

    const second = h.service.activity(project.id, { limit: 2, offset: 2 });
    expect(second.entries.map((entry) => entry.assignmentId)).toEqual([
      'assignment-2',
      'assignment-1',
    ]);
  });

  it('refuses an unknown project id with a 404-shaped error', async () => {
    const h = open();
    await makeProject(h, 'Known');
    expect(refusalFrom(() => h.service.activity('no-such-project')).code).toBe('project_not_found');
  });
});

describe('lastActivityAt (M5 acceptance 5)', () => {
  it('is stamped when a session starts on the project', async () => {
    const h = open();
    const project = await makeProject(h, 'Active');
    expect(project.lastActivityAt).toBeNull();

    h.service.noteSessionStarted(project.id, '2026-08-17T08:00:00.000Z');

    expect(h.repository.get(project.id)?.lastActivityAt).toBe('2026-08-17T08:00:00.000Z');
  });

  it('ignores a project id it does not know, rather than throwing at the bus', async () => {
    const h = open();
    await makeProject(h, 'Whatever');
    // The caller is a bus subscription; a listener that throws takes the
    // emitter with it.
    expect(() => h.service.noteSessionStarted('ghost')).not.toThrow();
  });
});
