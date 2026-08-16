/**
 * The session repository (runner IMPLEMENTATION M1) against a real database.
 *
 * `status.test.ts` proves the rules; this proves the `UPDATE` cannot get past
 * them, that §3.5's columns round-trip, and that admission writes the row and
 * its `session_inputs` as one act — the property §9.2 item 2 depends on when it
 * re-admits a queued session after a restart.
 *
 * Every session here belongs to a real `assignments` row created through
 * foundation's repository: `sessions.assignment_id` is `NOT NULL` behind a
 * `RESTRICT` foreign key, so there is no other kind.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RecordNotFoundError } from '../../storage/errors.js';

import {
  DuplicateSessionInputError,
  InvalidExitReasonError,
  InvalidTransitionError,
  MissingExitReasonError,
  SessionNotFoundError,
} from './errors.js';
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

beforeEach(() => {
  dataRootDir = makeTempDir('agentmanager-runner-repo-');
  harness = makeHarness({ dataRoot: dataRootDir.path });
  seed = harness.seed();
});

afterEach(() => {
  harness.close();
  dataRootDir.cleanup();
});

describe('admission', () => {
  it('writes the queued row and its launch request together', () => {
    const session = enqueue(harness, seed, {
      prompt: 'Draft the migration.',
      attachments: [{ kind: 'image', id: 'a' }],
      role: 'architect',
      priority: 'interactive',
      weight: 2,
      origin: 'remote',
    });

    expect(session).toMatchObject({
      status: 'queued',
      assignmentId: seed.assignmentId,
      agentId: seed.agentId,
      projectId: seed.projectId,
      role: 'architect',
      priority: 'interactive',
      weight: 2,
      origin: 'remote',
      turns: 0,
      blockedReason: null,
      leaseId: null,
      resumedFrom: null,
    });
    expect(session.queuedAt).toBe('2026-08-16T10:00:00.000Z');

    expect(harness.sessions.input(session.id)).toMatchObject({
      sessionId: session.id,
      prompt: 'Draft the migration.',
      attachments: [{ kind: 'image', id: 'a' }],
    });
  });

  it('defaults priority, weight and role the way §3.5 does', () => {
    const session = enqueue(harness, seed);
    expect(session).toMatchObject({ priority: 'normal', weight: 1, role: null });
  });

  it('records resumed_from for the §9.4 continue path', () => {
    const first = enqueue(harness, seed);
    const second = enqueue(harness, seed, { resumedFrom: first.id });
    expect(second.resumedFrom).toBe(first.id);
  });

  it('rolls the whole admission back when the assignment does not exist', () => {
    expect(() =>
      harness.sessions.enqueue({
        assignmentId: 'no-such-assignment',
        agentId: seed.agentId,
        projectId: seed.projectId,
        prompt: 'orphan',
      }),
    ).toThrow();
    // The `session_inputs` insert is in the same transaction as the row, so a
    // refused row cannot leave a prompt behind.
    expect(harness.sessions.list()).toHaveLength(0);
  });

  it('refuses a second launch request for one session', () => {
    const session = enqueue(harness, seed);
    expect(() =>
      harness.sessions.enqueue({
        id: session.id,
        assignmentId: seed.assignmentId,
        agentId: seed.agentId,
        projectId: seed.projectId,
        prompt: 'again',
      }),
    ).toThrow(/UNIQUE|already/u);
  });

  it('exposes DuplicateSessionInputError for the write-once rule', () => {
    expect(new DuplicateSessionInputError('s1').status).toBe(409);
  });
});

describe('transitions through the database', () => {
  it('drives the queued → running → done path, stamping the timestamps', () => {
    const session = enqueue(harness, seed);
    expect(session.startedAt).toBeNull();

    const running = harness.sessions.transition(session.id, 'running', {
      sdkSessionId: 'sdk-1',
      model: 'sonnet',
      permissionMode: 'default',
    });
    expect(running).toMatchObject({
      status: 'running',
      sdkSessionId: 'sdk-1',
      model: 'sonnet',
      permissionMode: 'default',
      endedAt: null,
    });
    expect(running.startedAt).toBe('2026-08-16T10:00:00.000Z');

    const done = harness.sessions.transition(session.id, 'done', { exitReason: 'completed' });
    expect(done).toMatchObject({ status: 'done', exitReason: 'completed' });
    expect(done.endedAt).toBe('2026-08-16T10:00:00.000Z');
  });

  it('keeps a queued session queued on a retryable workspace refusal', () => {
    const session = enqueue(harness, seed);
    const blocked = harness.sessions.transition(session.id, 'queued', {
      blockedReason: 'another write assignment holds the tree',
    });
    expect(blocked).toMatchObject({
      status: 'queued',
      blockedReason: 'another write assignment holds the tree',
    });
  });

  it('refuses a terminal status without an exit_reason, and writes nothing', () => {
    const session = enqueue(harness, seed);
    harness.sessions.transition(session.id, 'running');

    expect(() => harness.sessions.transition(session.id, 'failed')).toThrow(MissingExitReasonError);
    expect(harness.sessions.require(session.id)).toMatchObject({
      status: 'running',
      exitReason: null,
      endedAt: null,
    });
  });

  it('refuses an exit_reason outside §2.3', () => {
    const session = enqueue(harness, seed);
    harness.sessions.transition(session.id, 'running');
    expect(() =>
      harness.sessions.transition(session.id, 'paused', {
        exitReason: 'because-i-said-so' as never,
      }),
    ).toThrow(InvalidExitReasonError);
  });

  it('refuses paused → orphaned even from the boot task', () => {
    const session = enqueue(harness, seed);
    harness.sessions.transition(session.id, 'running');
    harness.sessions.transition(session.id, 'paused', { exitReason: 'service_shutdown' });

    expect(() =>
      harness.sessions.transition(session.id, 'orphaned', {
        exitReason: 'core_restart',
        boot: true,
      }),
    ).toThrow(InvalidTransitionError);
    expect(harness.sessions.require(session.id).status).toBe('paused');
  });

  it('lets the boot task orphan a running session, and then nothing else can move it', () => {
    const session = enqueue(harness, seed);
    harness.sessions.transition(session.id, 'running');
    const orphaned = harness.sessions.transition(session.id, 'orphaned', {
      exitReason: 'core_restart',
      boot: true,
    });
    expect(orphaned).toMatchObject({ status: 'orphaned', exitReason: 'core_restart' });

    expect(() => harness.sessions.transition(session.id, 'queued', { boot: true })).toThrow(
      InvalidTransitionError,
    );
  });

  it('resumes a paused session onto the same row', () => {
    const session = enqueue(harness, seed);
    harness.sessions.transition(session.id, 'running', { sdkSessionId: 'sdk-9' });
    harness.sessions.transition(session.id, 'paused', { exitReason: 'awaiting_answer' });

    const requeued = harness.sessions.transition(session.id, 'queued', {
      priority: 'interactive',
    });
    expect(requeued).toMatchObject({
      id: session.id,
      status: 'queued',
      priority: 'interactive',
      // The remembered SDK session is what makes the resume a resume (§9.4).
      sdkSessionId: 'sdk-9',
    });
  });

  it('throws SessionNotFoundError for an unknown id', () => {
    expect(() => harness.sessions.transition('nope', 'running')).toThrow(SessionNotFoundError);
    expect(() => harness.sessions.require('nope')).toThrow(SessionNotFoundError);
    expect(harness.sessions.get('nope')).toBeUndefined();
  });
});

describe('§3.5 columns and listing', () => {
  it('round-trips every added column', () => {
    const session = enqueue(harness, seed);
    const patched = harness.sessions.patch(session.id, {
      leaseId: 'lease-1',
      role: 'skeptic',
      weight: 3,
      priority: 'interactive',
      blockedReason: 'waiting',
      turns: 7,
      summary: 'a digest',
      pinned: true,
    });
    expect(patched).toMatchObject({
      leaseId: 'lease-1',
      role: 'skeptic',
      weight: 3,
      priority: 'interactive',
      blockedReason: 'waiting',
      turns: 7,
      summary: 'a digest',
      pinned: true,
    });
  });

  it('refuses a priority the CHECK constraint does not allow', () => {
    const session = enqueue(harness, seed);
    expect(() => harness.sessions.patch(session.id, { priority: 'urgent' as never })).toThrow(
      /CHECK constraint/u,
    );
  });

  it('counts by status and lists by filter', () => {
    const a = enqueue(harness, seed);
    enqueue(harness, seed);
    harness.sessions.transition(a.id, 'running');

    expect(harness.sessions.countByStatus()).toMatchObject({ queued: 1, running: 1, done: 0 });
    expect(harness.sessions.list({ status: 'running' }).map((s) => s.id)).toEqual([a.id]);
    expect(harness.sessions.list({ assignmentId: seed.assignmentId })).toHaveLength(2);
  });

  it('reports no launch request for a session that never had one', () => {
    const bare = harness.storage.store.sessions.create({
      assignmentId: seed.assignmentId,
      agentId: seed.agentId,
      projectId: seed.projectId,
    });
    expect(harness.sessions.input(bare.id)).toBeUndefined();
    // …and it still decorates with §3.5's defaults rather than throwing.
    expect(harness.sessions.require(bare.id)).toMatchObject({ priority: 'normal', weight: 1 });
  });

  it('cascades session_inputs when the session row goes', () => {
    const session = enqueue(harness, seed);
    harness.storage.store.sessions.delete(session.id);
    expect(harness.sessions.input(session.id)).toBeUndefined();
  });

  it('surfaces the transcript columns foundation owns', () => {
    const session = enqueue(harness, seed);
    harness.storage.store.sessions.setTranscript(session.id, {
      path: '2026/08/x.jsonl',
      bytes: 12,
    });
    expect(harness.sessions.require(session.id)).toMatchObject({
      transcriptPath: '2026/08/x.jsonl',
      transcriptBytes: 12,
    });
    expect(() => harness.storage.store.sessions.setTranscriptBytes('missing', 1)).toThrow(
      RecordNotFoundError,
    );
  });
});
