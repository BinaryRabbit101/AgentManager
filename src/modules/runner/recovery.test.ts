/**
 * Crash recovery, orphan detection and graceful shutdown (runner IMPLEMENTATION
 * M9), one `describe` per acceptance bullet.
 *
 * ## How "the core was hard-killed" is simulated
 *
 * By building the state a hard kill *leaves behind* — a `running` row, a
 * transcript with no `session.end`, and a `transcript_bytes` that lags the file
 * because the last flush never landed — and then running the boot task over it.
 * That is precisely what §9.2 sees on the next start, and it is reproducible;
 * actually killing a process mid-write would test the operating system's
 * buffering rather than runner's reconciliation.
 *
 * §9.3's two filesystem questions — does the workspace still exist, is the SDK
 * session file still there — come through the injected {@link RecoveryFs}, so
 * "the SDK session file is missing" is a stated fact rather than a deletion
 * inside somebody's real Claude config directory.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// A test may name a sibling element: `boundaries.test.ts` excludes `*.test.ts`
// from the no-sibling-imports rule precisely so a contract can be checked from
// both ends. `hasContinuation` is the predicate orchestrator's engine runs
// against whatever the registry hands it, so applying it to the *real* service
// is the only assertion that proves the probe now lights up.
import { hasContinuation, hasLauncher, hasTranscriptTail } from '../orchestrator/ports.js';

import { makeTempDir, type TempDir } from './__tests__/helpers.js';
import {
  controllableQuery,
  fakeAssistant,
  scriptedQuery,
  successScript,
} from './__tests__/fakeQuery.js';
import { makeLaunchHarness, type LaunchHarness } from './__tests__/launchHarness.js';
import type { RecoveryFs } from './recovery.js';
import type { RunnerSessionRecord } from './repository.js';

let temp: TempDir;

beforeEach(() => {
  temp = makeTempDir('agentmanager-runner-recovery-');
});

afterEach(() => {
  temp.cleanup();
});

function dataRoot(): string {
  return `${temp.path}\\data`;
}

const WORKSPACE = 'C:\\workspace\\fixture';

/**
 * §9.3's two questions, answered by the test.
 *
 * The SDK session file is the only `.jsonl` path the resumability check ever
 * asks about, which makes the split unambiguous.
 */
function recoveryFs(answers: { workspace?: boolean; sdkFile?: boolean } = {}): RecoveryFs {
  return {
    exists: (path) =>
      path.endsWith('.jsonl') ? (answers.sdkFile ?? true) : (answers.workspace ?? true),
    entries: () => [],
  };
}

/**
 * The state a hard kill leaves: a `running` row, a transcript with no
 * `session.end`, and a `transcript_bytes` that lags the file.
 */
function leaveRunningSession(
  harness: LaunchHarness,
  seed: { projectId: string; assignmentId: string; agentId: string },
  options: { sdkSessionId?: string | null; pendingTool?: boolean; leaseId?: string } = {},
): RunnerSessionRecord {
  const record = harness.sessions.enqueue({
    assignmentId: seed.assignmentId,
    agentId: seed.agentId,
    projectId: seed.projectId,
    prompt: 'Refactor the launch chain.',
  });

  const transcript = harness.transcripts.open(record.id, {
    flushLines: 1,
    flushMs: 1,
    maxMb: 512,
  });
  transcript.append('session.start', {
    agentId: seed.agentId,
    projectId: seed.projectId,
    assignmentId: seed.assignmentId,
    workspace: { kind: 'primary', path: WORKSPACE, branch: null },
  });
  transcript.append('system', { subtype: 'init' });
  transcript.append('assistant', { text: 'Editing the file.' });
  if (options.pendingTool !== false) {
    // The pair §9.3 detects: a `tool_use` whose `tool_result` never arrived.
    transcript.append('tool_use', { toolUseId: 'tu_9', name: 'Edit', input: { file: 'a.ts' } });
  }
  transcript.close();

  harness.sessions.transition(record.id, 'running', {
    sdkSessionId: options.sdkSessionId === undefined ? 'sdk-9f2a2b64-0001' : options.sdkSessionId,
    model: 'claude-sonnet-4-5',
    permissionMode: 'default',
    ...(options.leaseId === undefined ? {} : { leaseId: options.leaseId }),
  });
  // The last flush lagged the crash (§8.2), so the column is wrong on disk.
  harness.storage.store.sessions.setTranscriptBytes(record.id, 7);

  return harness.sessions.require(record.id);
}

function lineTypes(harness: LaunchHarness, sessionId: string): string[] {
  return harness.transcriptLines(sessionId).map((line) => String(line['type']));
}

// ---------------------------------------------------------------------------

describe('boot reconciliation orphans what a previous life left running (§9.2)', () => {
  it('moves it to orphaned / core_restart, closes its transcript and reconciles its bytes', async () => {
    const harness = makeLaunchHarness({ dataRoot: dataRoot(), recoveryFs: recoveryFs() });
    try {
      const seed = harness.seed();
      const abandoned = leaveRunningSession(harness, seed);

      const reconciled = await harness.recovery.reconcileOnBoot();
      expect(reconciled.orphaned).toEqual([abandoned.id]);

      const after = harness.sessions.require(abandoned.id);
      expect(after.status).toBe('orphaned');
      expect(after.exitReason).toBe('core_restart');
      expect(after.endedAt).not.toBeNull();

      // The transcript is closed off rather than left dangling…
      expect(lineTypes(harness, abandoned.id).at(-1)).toBe('session.end');
      // …and `transcript_bytes` matches the file, not the stale 7 the crash left.
      const page = harness.reader.tail(abandoned.id, { maxBytes: 1_000_000 });
      expect(after.transcriptBytes).toBe(page.size);
      expect(after.transcriptBytes).toBeGreaterThan(7);

      const orphaned = harness.events.filter((event) => event.type === 'session.orphaned');
      expect(orphaned).toHaveLength(1);
      expect(orphaned[0]?.ids).toMatchObject({
        sessionId: abandoned.id,
        assignmentId: seed.assignmentId,
        projectId: seed.projectId,
        agentId: seed.agentId,
      });
      expect(orphaned[0]?.payload).toMatchObject({
        resumable: true,
        reason: 'core_restart',
        sdkSessionId: 'sdk-9f2a2b64-0001',
      });
      expect((orphaned[0]?.payload as { lastSeq: number }).lastSeq).toBeGreaterThan(0);
      expect(orphaned[0]?.persist).toBe(true);
    } finally {
      harness.close();
    }
  });

  it('makes orphaned terminal: no API call moves it to another status', async () => {
    const harness = makeLaunchHarness({ dataRoot: dataRoot(), recoveryFs: recoveryFs() });
    try {
      const seed = harness.seed();
      const abandoned = leaveRunningSession(harness, seed);
      await harness.recovery.reconcileOnBoot();

      await expect(harness.service.resume(abandoned.id)).rejects.toMatchObject({ status: 409 });
      await expect(harness.service.steer(abandoned.id, 'go on')).rejects.toMatchObject({
        status: 409,
      });
      // The idempotent verbs answer 200 with the current state rather than moving it.
      expect((await harness.service.pause(abandoned.id)).changed).toBe(false);
      expect((await harness.service.stop(abandoned.id)).changed).toBe(false);
      expect(() => harness.sessions.transition(abandoned.id, 'running')).toThrow(
        /cannot move from "orphaned"/u,
      );
      expect(harness.sessions.require(abandoned.id).status).toBe('orphaned');
    } finally {
      harness.close();
    }
  });

  it('reports resumable: false when there is nothing to replay (§9.3)', async () => {
    const cases: {
      readonly name: string;
      readonly fs: RecoveryFs;
      readonly sdkSessionId: string | null;
      readonly code: string;
    }[] = [
      {
        name: 'no sdk_session_id',
        fs: recoveryFs(),
        sdkSessionId: null,
        code: 'no_sdk_session',
      },
      {
        name: 'the lease path is gone',
        fs: recoveryFs({ workspace: false }),
        sdkSessionId: 'sdk-1',
        code: 'workspace_gone',
      },
      {
        name: 'the SDK session file is missing',
        fs: recoveryFs({ sdkFile: false }),
        sdkSessionId: 'sdk-1',
        code: 'sdk_session_file_missing',
      },
    ];

    for (const [index, scenario] of cases.entries()) {
      // Its own data root per scenario: three harnesses over one root would
      // collide on `projects.local_path`, which is a fixture problem rather
      // than anything under test.
      const harness = makeLaunchHarness({
        dataRoot: `${temp.path}\\data-${String(index)}`,
        recoveryFs: scenario.fs,
      });
      try {
        const seed = harness.seed();
        const abandoned = leaveRunningSession(harness, seed, {
          sdkSessionId: scenario.sdkSessionId,
        });
        await harness.recovery.reconcileOnBoot();

        const orphaned = harness.events.find((event) => event.type === 'session.orphaned');
        expect(orphaned?.payload, scenario.name).toMatchObject({
          resumable: false,
          notResumable: scenario.code,
        });

        // …and therefore **no Continue action** on the session detail.
        const detail = await harness.service.getSessionDetail(abandoned.id);
        expect(detail?.affordances.canContinue, scenario.name).toBe(false);
        expect(detail?.affordances.canRelaunch, scenario.name).toBe(true);
        expect(detail?.affordances.notResumable, scenario.name).toBe(scenario.code);
      } finally {
        harness.close();
      }
    }
  });

  it('carries queued sessions forward and drops the ones past queueStaleHours', async () => {
    const script = scriptedQuery({ messages: successScript() });
    const harness = makeLaunchHarness({
      dataRoot: dataRoot(),
      query: script.query,
      recoveryFs: recoveryFs(),
      config: { queueStaleHours: 24 },
    });
    try {
      const seed = harness.seed();
      const fresh = harness.sessions.enqueue({
        assignmentId: seed.assignmentId,
        agentId: seed.agentId,
        projectId: seed.projectId,
        prompt: 'still wanted',
        queuedAt: new Date('2026-08-16T09:00:00.000Z').toISOString(),
      });
      const ancient = harness.sessions.enqueue({
        assignmentId: seed.assignmentId,
        agentId: seed.agentId,
        projectId: seed.projectId,
        prompt: 'a week old',
        queuedAt: new Date('2026-08-09T09:00:00.000Z').toISOString(),
      });

      const reconciled = await harness.recovery.reconcileOnBoot();
      expect(reconciled.stale).toEqual([ancient.id]);
      expect(reconciled.requeued).toEqual([fresh.id]);

      expect(harness.sessions.require(ancient.id).status).toBe('interrupted');
      expect(harness.sessions.require(ancient.id).exitReason).toBe('stale_queue');

      // "re-admitted through the scheduler": the survivor actually runs.
      const settled = await harness.service.awaitSettled(fresh.id);
      expect(settled.status).toBe('done');
    } finally {
      harness.close();
    }
  });

  it('leaves paused sessions exactly as they were, and auto-resumes none of them', async () => {
    const harness = makeLaunchHarness({ dataRoot: dataRoot(), recoveryFs: recoveryFs() });
    try {
      const seed = harness.seed();
      const parked = leaveRunningSession(harness, seed);
      harness.sessions.transition(parked.id, 'paused', { exitReason: 'user_stopped' });

      const reconciled = await harness.recovery.reconcileOnBoot();
      expect(reconciled.orphaned).toEqual([]);

      const after = harness.sessions.require(parked.id);
      expect(after.status).toBe('paused');
      expect(after.exitReason).toBe('user_stopped');
      expect(harness.launch.liveSessionIds()).toEqual([]);
    } finally {
      harness.close();
    }
  });

  it('releases leases for assignments that are no longer open, and never double-leases one that is', async () => {
    const harness = makeLaunchHarness({ dataRoot: dataRoot(), recoveryFs: recoveryFs() });
    try {
      const closed = harness.seed();
      leaveRunningSession(harness, closed, { leaseId: 'lease-stale' });
      harness.storage.store.assignments.close(closed.assignmentId, { reason: 'user_closed' });

      const openSeed = harness.seed();
      leaveRunningSession(harness, openSeed, { leaseId: 'lease-live' });

      const reconciled = await harness.recovery.reconcileOnBoot();
      expect(reconciled.leasesReleased).toEqual(['lease-stale']);
      expect(harness.projects.releases).toEqual(['lease-stale']);

      // Re-acquiring for the still-open assignment goes to projects exactly once,
      // however many sessions ask (§3.1's refcount).
      const script = scriptedQuery({ messages: successScript() });
      const second = makeLaunchHarness({ dataRoot: `${temp.path}\\data2`, query: script.query });
      try {
        const seed = second.seed();
        const a = await second.service.startSession({
          assignmentId: seed.assignmentId,
          agentId: seed.agentId,
          projectId: seed.projectId,
          prompt: 'one',
        });
        await second.service.awaitSettled(a.sessionId);
        const b = await second.service.startSession({
          assignmentId: seed.assignmentId,
          agentId: seed.agentId,
          projectId: seed.projectId,
          prompt: 'two',
        });
        await second.service.awaitSettled(b.sessionId);
        expect(second.projects.acquisitions).toHaveLength(1);
      } finally {
        second.close();
      }
    } finally {
      harness.close();
    }
  });
});

// ---------------------------------------------------------------------------

describe('Continue: §9.4 path 2', () => {
  it('creates a new row with resumed_from, a new transcript and a first message naming what was interrupted', async () => {
    const query = controllableQuery();
    const harness = makeLaunchHarness({
      dataRoot: dataRoot(),
      query: query.query,
      recoveryFs: recoveryFs(),
    });
    try {
      const seed = harness.seed();
      const abandoned = leaveRunningSession(harness, seed);
      await harness.recovery.reconcileOnBoot();

      // The affordance says Continue is real before anything calls it.
      const detail = await harness.service.getSessionDetail(abandoned.id);
      expect(detail?.affordances).toMatchObject({ canContinue: true, canRelaunch: false });

      const continued = await harness.service.continueFrom(abandoned.id, 'Finish the refactor.');
      expect(continued.sessionId).not.toBe(abandoned.id);

      const row = harness.sessions.require(continued.sessionId);
      expect(row.resumedFrom).toBe(abandoned.id);
      // A **new** transcript: the old session genuinely died and its record must
      // keep saying so (§9.4).
      expect(row.transcriptPath).not.toBe(abandoned.transcriptPath);

      const prompt = harness.sessions.input(continued.sessionId)?.prompt ?? '';
      expect(prompt).toContain(abandoned.id);
      expect(prompt).toContain('interrupted when AgentManager restarted');
      // §9.3's structural detection, stated in the first message.
      expect(prompt).toContain('"Edit"');
      expect(prompt).toContain('tu_9');
      expect(prompt).toContain('Finish the refactor.');

      // The resumed agent demonstrably retains the prior conversation: the SDK
      // was handed the previous session's id to replay.
      await query.started(1);
      expect(query.sessions[0]?.resume).toBe('sdk-9f2a2b64-0001');

      const resumedEvent = harness.events.find(
        (event) => event.type === 'session.resumed' && event.ids.sessionId === continued.sessionId,
      );
      expect(resumedEvent?.payload).toMatchObject({
        mode: 'new-session',
        resumedFrom: abandoned.id,
      });
    } finally {
      query.endAll();
      harness.close();
    }
  });

  it('says so, rather than pretending, when the conversation cannot be replayed', async () => {
    const query = controllableQuery();
    const harness = makeLaunchHarness({
      dataRoot: dataRoot(),
      query: query.query,
      recoveryFs: recoveryFs({ sdkFile: false }),
    });
    try {
      const seed = harness.seed();
      const abandoned = leaveRunningSession(harness, seed);
      await harness.recovery.reconcileOnBoot();

      const continued = await harness.service.continueFrom(abandoned.id, 'Try again.');
      const prompt = harness.sessions.input(continued.sessionId)?.prompt ?? '';
      expect(prompt).toContain('could not be replayed');
      expect(harness.sessions.require(continued.sessionId).resumedFrom).toBe(abandoned.id);

      // …and the new run is a fresh conversation rather than a resume of nothing.
      await query.started(1);
      expect(query.sessions[0]?.resume).toBeNull();
    } finally {
      query.endAll();
      harness.close();
    }
  });

  it('refuses to continue a session that has not finished', async () => {
    const query = controllableQuery();
    const harness = makeLaunchHarness({
      dataRoot: dataRoot(),
      query: query.query,
      recoveryFs: recoveryFs(),
    });
    try {
      const seed = harness.seed();
      const started = await harness.service.startSession({
        assignmentId: seed.assignmentId,
        agentId: seed.agentId,
        projectId: seed.projectId,
        prompt: 'running now',
      });
      await query.started(1);
      await expect(harness.service.continueFrom(started.sessionId, 'x')).rejects.toMatchObject({
        code: 'session_control_refused',
        status: 409,
      });
    } finally {
      query.endAll();
      harness.close();
    }
  });

  it('satisfies orchestrator’s hasContinuation probe on the real service (§15.1-1)', () => {
    const harness = makeLaunchHarness({ dataRoot: dataRoot(), recoveryFs: recoveryFs() });
    try {
      // The exact predicates orchestrator's engine runs against whatever the
      // registry hands it (orchestrator `ports.ts`). Before M9 the third was
      // false and the engine logged a downgrade on every seat's later turn.
      //
      // The cast is what `ctx.require<RunnerPort>('runner')` does in production:
      // the registry stores `unknown` and each consumer narrows it. It is also
      // load-bearing here, and **raised rather than silently absorbed** —
      // orchestrator types `stop(): Promise<void>` from runner §11.2's pinned
      // signature, while runner's M6 `stop` additively returns the control
      // result. The two are runtime-compatible and nominally not; runner's
      // additive return is the deliberate one (§11.1's idempotency receipt).
      const port = harness.service as unknown as Parameters<typeof hasLauncher>[0];
      expect(hasLauncher(port)).toBe(true);
      expect(hasTranscriptTail(port)).toBe(true);
      expect(hasContinuation(port)).toBe(true);
    } finally {
      harness.close();
    }
  });
});

// ---------------------------------------------------------------------------

describe('graceful shutdown (§9.1)', () => {
  it('pauses every running session, leaves no live handle and keeps the leases', async () => {
    const query = controllableQuery();
    const harness = makeLaunchHarness({
      dataRoot: dataRoot(),
      query: query.query,
      config: { maxConcurrent: 2 },
    });
    try {
      const seed = harness.seed();
      const one = await harness.service.startSession({
        assignmentId: seed.assignmentId,
        agentId: seed.agentId,
        projectId: seed.projectId,
        prompt: 'first',
      });
      const two = await harness.service.startSession({
        assignmentId: seed.assignmentId,
        agentId: seed.agentId,
        projectId: seed.projectId,
        prompt: 'second',
      });
      await query.started(2);
      expect(harness.launch.liveSessionIds()).toHaveLength(2);

      await harness.launch.shutdown();

      for (const started of [one, two]) {
        const row = harness.sessions.require(started.sessionId);
        expect(row.status).toBe('paused');
        expect(row.exitReason).toBe('service_shutdown');
        expect(row.sdkSessionId).not.toBeNull();
      }
      // "no orphaned subprocess": every handle is gone, and every fake session
      // saw both an interrupt and a close.
      expect(harness.launch.liveSessionIds()).toEqual([]);
      for (const session of query.sessions) {
        expect(session.interrupts).toBeGreaterThanOrEqual(1);
        expect(session.closes).toBeGreaterThanOrEqual(1);
      }
      // §9.1 step 4: "Workspace leases are **kept**."
      expect(harness.projects.releases).toEqual([]);
    } finally {
      query.endAll();
      harness.close();
    }
  });

  it('forces a session that ignores the interrupt to interrupted / shutdown_forced', async () => {
    const query = controllableQuery({ ignoreControl: true });
    const harness = makeLaunchHarness({
      dataRoot: dataRoot(),
      query: query.query,
      config: { gracefulInterruptMs: 20 },
    });
    try {
      const seed = harness.seed();
      const started = await harness.service.startSession({
        assignmentId: seed.assignmentId,
        agentId: seed.agentId,
        projectId: seed.projectId,
        prompt: 'stubborn',
      });
      await query.started(1);

      await harness.launch.shutdown();

      const row = harness.sessions.require(started.sessionId);
      expect(row.status).toBe('interrupted');
      expect(row.exitReason).toBe('shutdown_forced');
      // The abort is what actually ended it, and it left no handle behind.
      expect(query.sessions[0]?.aborted).toBe(true);
      expect(harness.launch.liveSessionIds()).toEqual([]);
    } finally {
      query.endAll();
      harness.close();
    }
  });

  it('stops admitting first, so a queued session is still queued afterwards', async () => {
    const query = controllableQuery();
    const harness = makeLaunchHarness({
      dataRoot: dataRoot(),
      query: query.query,
      config: { maxConcurrent: 1 },
    });
    try {
      const seed = harness.seed();
      const running = await harness.service.startSession({
        assignmentId: seed.assignmentId,
        agentId: seed.agentId,
        projectId: seed.projectId,
        prompt: 'first',
      });
      const waiting = await harness.service.startSession({
        assignmentId: seed.assignmentId,
        agentId: seed.agentId,
        projectId: seed.projectId,
        prompt: 'second',
      });
      await query.started(1);

      await harness.launch.shutdown();

      expect(harness.sessions.require(running.sessionId).status).toBe('paused');
      // §9.1 step 1: "Queued sessions stay `queued` — a queue entry is pure
      // intent and loses nothing."
      expect(harness.sessions.require(waiting.sessionId).status).toBe('queued');
      expect(query.sessions).toHaveLength(1);
    } finally {
      query.endAll();
      harness.close();
    }
  });
});

// ---------------------------------------------------------------------------

describe('§9.3 read directly', () => {
  it('detects a tool_use with no tool_result, and reports none when the pair closed', () => {
    const harness = makeLaunchHarness({ dataRoot: dataRoot(), recoveryFs: recoveryFs() });
    try {
      const seed = harness.seed();
      const open = leaveRunningSession(harness, seed);
      expect(harness.recovery.interruption(open.id).pendingTool).toMatchObject({
        toolUseId: 'tu_9',
        name: 'Edit',
      });

      const closed = leaveRunningSession(harness, seed, { pendingTool: false });
      expect(harness.recovery.interruption(closed.id).pendingTool).toBeUndefined();
      expect(harness.recovery.interruption(closed.id).lastSeq).toBeGreaterThan(0);
    } finally {
      harness.close();
    }
  });

  it('never claims a running session was interrupted by something it can see', async () => {
    const script = scriptedQuery({
      messages: [...successScript(), fakeAssistant({ text: 'trailing' })],
    });
    const harness = makeLaunchHarness({
      dataRoot: dataRoot(),
      query: script.query,
      recoveryFs: recoveryFs(),
    });
    try {
      const seed = harness.seed();
      const started = await harness.service.startSession({
        assignmentId: seed.assignmentId,
        agentId: seed.agentId,
        projectId: seed.projectId,
        prompt: 'clean run',
      });
      const settled = await harness.service.awaitSettled(started.sessionId);
      expect(settled.status).toBe('done');
      expect(harness.recovery.interruption(started.sessionId).pendingTool).toBeUndefined();
      expect(harness.recovery.resumability(settled).resumable).toBe(true);
    } finally {
      harness.close();
    }
  });
});
