/**
 * Session control (runner IMPLEMENTATION **M6**), one `describe` per acceptance
 * bullet, driven through the fake `query` of `__tests__/fakeQuery.ts`.
 *
 * Every criterion here is a statement about a session the test drives **turn by
 * turn** — a steer lands between two turns, a pause happens during one, a guard
 * fires because nothing happened for a while — so `controllableQuery` is the
 * fake throughout. Nothing mocks the launch chain: every assertion is made
 * against session rows, transcript lines and bus events the real chain wrote.
 *
 * The one thing that genuinely needs the engine — "never leaves a live
 * subprocess, asserted by process count before and after" — is a live check and
 * stays token-gated in `__spike__/sdk.spike.test.ts` (M6-L2). What is asserted
 * here is the mechanism that criterion rests on: `interrupt()` then `close()`
 * then, if it did not wind down, the abort — and no live handle left behind.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeTempDir, type TempDir } from './__tests__/helpers.js';
import {
  controllableQuery,
  fakeAssistant,
  fakeResult,
  fakeSessionStateChanged,
  fakeToolResult,
  type ControllableQuery,
  type ControllableSession,
} from './__tests__/fakeQuery.js';
import { makeLaunchHarness, type LaunchHarness } from './__tests__/launchHarness.js';
import { RESUME_CONTINUATION } from './launch.js';
import { INTERRUPT_RECEIPT_CAPABILITY } from './liveSessions.js';
import type { RunnerConfig } from './config.js';

let temp: TempDir;

beforeEach(() => {
  temp = makeTempDir('agentmanager-runner-control-');
});

afterEach(() => {
  temp.cleanup();
});

interface Fixture {
  readonly harness: LaunchHarness;
  readonly query: ControllableQuery;
  readonly seed: { projectId: string; assignmentId: string; agentId: string };
  /** Launches a session and waits for its `system/init` to be processed. */
  start(prompt?: string, options?: { priority?: 'interactive' | 'normal' }): Promise<string>;
  close(): void;
}

function fixture(
  options: {
    readonly config?: Partial<RunnerConfig>;
    readonly capabilities?: readonly string[];
    readonly interruptReceipt?: (index: number) => unknown;
    readonly ignoreControl?: boolean;
  } = {},
): Fixture {
  const query = controllableQuery({
    ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }),
    ...(options.interruptReceipt === undefined
      ? {}
      : { interruptReceipt: options.interruptReceipt }),
    ...(options.ignoreControl === undefined ? {} : { ignoreControl: options.ignoreControl }),
  });
  const harness = makeLaunchHarness({
    dataRoot: `${temp.path}\\data`,
    query: query.query,
    // gracefulInterruptMs is short so the "did not wind down" branch is a fast
    // test rather than a ten-second one; every other default is the shipped one.
    config: { gracefulInterruptMs: 60, ...options.config },
  });
  const seed = harness.seed();

  return {
    harness,
    query,
    seed,
    async start(prompt = 'Do the thing.', startOptions = {}) {
      const before = query.sessions.length;
      const started = await harness.service.startSession({
        assignmentId: seed.assignmentId,
        agentId: seed.agentId,
        projectId: seed.projectId,
        prompt,
        ...(startOptions.priority === undefined ? {} : { priority: startOptions.priority }),
      });
      await query.started(before + 1);
      return started.sessionId;
    },
    close() {
      query.endAll();
      harness.close();
    },
  };
}

function sessionAt(fix: Fixture, index: number): ControllableSession {
  const session = fix.query.sessions[index];
  if (session === undefined) throw new Error(`no query() call at index ${String(index)}`);
  return session;
}

function lineTypes(harness: LaunchHarness, sessionId: string): string[] {
  return harness.transcriptLines(sessionId).map((line) => String(line['type']));
}

function lineOfType(
  harness: LaunchHarness,
  sessionId: string,
  type: string,
): Record<string, unknown> | undefined {
  return harness.transcriptLines(sessionId).find((line) => line['type'] === type);
}

function eventsOfType(harness: LaunchHarness, type: string): Record<string, unknown>[] {
  return harness.events
    .filter((event) => event.type === type)
    .map((event) => event.payload as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// "Steering without interrupt delivers the message at the next turn boundary;
//  with interrupt: true the current turn stops within gracefulInterruptMs and
//  the steered message is the next thing the agent sees. Both appear in the
//  transcript as steer lines."
// ---------------------------------------------------------------------------

describe('steer (§4.3)', () => {
  it('without interrupt: the session continues past the turn boundary into the steered turn', async () => {
    const fix = fixture();
    try {
      const sessionId = await fix.start('Draft the plan.');
      const live = sessionAt(fix, 0);
      await live.emit(fakeAssistant({ text: 'Drafting.' }));

      const steered = await fix.harness.service.steer(sessionId, 'Also check the tests.');
      expect(steered.interrupted).toBe(false);
      expect(steered.status).toBe('running');

      // The first turn ends. Without M6's `pushed > turns` rule the reader loop
      // would close the input here and the steer would never get a turn.
      await live.emit(fakeResult({ text: 'Plan drafted.', turns: 1 }));
      expect(fix.harness.sessions.require(sessionId).status).toBe('running');

      // The steered turn: the agent sees the message and answers it.
      await live.emit(
        fakeAssistant({ text: 'Tests checked.' }),
        fakeResult({ text: 'Tests checked.', turns: 2 }),
        fakeSessionStateChanged('idle'),
      );
      live.end();

      const settled = await fix.harness.service.awaitSettled(sessionId);
      expect(settled.status).toBe('done');
      expect(settled.turns).toBe(2);
      // The agent really did receive it, in the order it was sent.
      expect(live.log.filter((entry) => entry.startsWith('input:'))).toEqual([
        'input:Draft the plan.',
        'input:Also check the tests.',
      ]);
      expect(live.interrupts).toBe(0);
    } finally {
      fix.close();
    }
  });

  it('with interrupt: the turn is stopped first and the steer is the next thing the agent sees', async () => {
    const fix = fixture({ capabilities: [INTERRUPT_RECEIPT_CAPABILITY] });
    try {
      const sessionId = await fix.start('Count to a thousand.');
      const live = sessionAt(fix, 0);
      await live.emit(fakeAssistant({ text: '1, 2, 3…' }));

      // The interrupted turn's result arrives while `steer` is waiting for it —
      // which is exactly the window §4.3 bounds by gracefulInterruptMs.
      const steering = fix.harness.service.steer(sessionId, 'Stop counting; summarise instead.', {
        interrupt: true,
      });
      await live.emit(
        fakeResult({ subtype: 'error_during_execution', errors: ['interrupted'], turns: 1 }),
      );
      const steered = await steering;

      expect(steered.interrupted).toBe(true);
      await live.awaitInput(2);
      // The sequence is the claim: interrupt, *then* the message.
      expect(live.log).toEqual([
        'input:Count to a thousand.',
        'interrupt',
        'input:Stop counting; summarise instead.',
      ]);

      await live.emit(
        fakeAssistant({ text: 'Summary.' }),
        fakeResult({ text: 'Summary.', turns: 2 }),
      );
      live.end();
      const settled = await fix.harness.service.awaitSettled(sessionId);
      // The interrupted turn's error result is not what the session settles on:
      // a deliberate interrupt is evidence the interrupt landed, not a failure.
      expect(settled.status).toBe('done');
    } finally {
      fix.close();
    }
  });

  it('bounds the interrupt wait by gracefulInterruptMs and pushes anyway', async () => {
    const fix = fixture({ config: { gracefulInterruptMs: 40 } });
    try {
      const sessionId = await fix.start();
      const live = sessionAt(fix, 0);
      await live.emit(fakeAssistant({ text: 'working' }));

      // No result is emitted: the turn never winds down. The steer must still
      // resolve, bounded, rather than hanging on a boundary that never comes.
      const started = Date.now();
      const steered = await fix.harness.service.steer(sessionId, 'Change course.', {
        interrupt: true,
      });
      const elapsed = Date.now() - started;

      expect(steered.interrupted).toBe(true);
      expect(elapsed).toBeGreaterThanOrEqual(30);
      expect(elapsed).toBeLessThan(3000);
      await live.awaitInput(2);
      expect(live.log).toContain('input:Change course.');

      await live.emit(fakeResult({ turns: 1 }), fakeResult({ turns: 2 }));
      live.end();
      await fix.harness.service.awaitSettled(sessionId);
    } finally {
      fix.close();
    }
  });

  it('writes a steer transcript line and a session.steered event for both forms', async () => {
    const fix = fixture({ capabilities: [INTERRUPT_RECEIPT_CAPABILITY] });
    try {
      const sessionId = await fix.start();
      const live = sessionAt(fix, 0);
      await live.emit(fakeAssistant({ text: 'a' }));
      await fix.harness.service.steer(sessionId, 'queued steer');
      const steering = fix.harness.service.steer(sessionId, 'interrupting steer', {
        interrupt: true,
      });
      await live.emit(fakeResult({ turns: 1 }));
      await steering;

      const steers = fix.harness
        .transcriptLines(sessionId)
        .filter((line) => line['type'] === 'steer');
      expect(steers.map((line) => line['text'])).toEqual(['queued steer', 'interrupting steer']);
      expect(steers.map((line) => line['interrupted'])).toEqual([false, true]);
      expect(typeof steers[0]?.['messageUuid']).toBe('string');

      const events = eventsOfType(fix.harness, 'session.steered');
      expect(events.map((payload) => payload['text'])).toEqual([
        'queued steer',
        'interrupting steer',
      ]);
      expect(fix.harness.events.filter((e) => e.type === 'session.steered')[0]?.persist).toBe(true);

      await live.emit(fakeResult({ turns: 2 }), fakeResult({ turns: 3 }));
      live.end();
      await fix.harness.service.awaitSettled(sessionId);
    } finally {
      fix.close();
    }
  });

  // SDK-NOTES G4: "a queued steer can outlive the interrupt meant to supersede it".
  it('surfaces the interrupt receipt’s still_queued uuids rather than swallowing them (G4)', async () => {
    const survivor = '00000000-0000-4000-8000-0000000000ff';
    const fix = fixture({
      capabilities: [INTERRUPT_RECEIPT_CAPABILITY],
      interruptReceipt: () => ({ still_queued: [survivor] }),
    });
    try {
      const sessionId = await fix.start();
      const live = sessionAt(fix, 0);
      await live.emit(fakeAssistant({ text: 'a' }));

      const steering = fix.harness.service.steer(sessionId, 'supersede that', { interrupt: true });
      await live.emit(fakeResult({ turns: 1 }));
      const steered = await steering;

      expect(steered.receiptSupported).toBe(true);
      expect(steered.stillQueued).toEqual([survivor]);
      expect(lineOfType(fix.harness, sessionId, 'steer')?.['stillQueued']).toEqual([survivor]);
      expect(
        fix.harness.logs.some((entry) =>
          entry.message.includes('queued user messages that will still run'),
        ),
      ).toBe(true);

      await live.emit(fakeResult({ turns: 2 }));
      live.end();
      await fix.harness.service.awaitSettled(sessionId);
    } finally {
      fix.close();
    }
  });

  it('reports receiptSupported: false when the CLI does not advertise interrupt_receipt_v1 (G4)', async () => {
    // An older CLI resolves `undefined`, which is indistinguishable from
    // "nothing survived" unless the capability is read.
    const fix = fixture({ capabilities: [] });
    try {
      const sessionId = await fix.start();
      const live = sessionAt(fix, 0);
      await live.emit(fakeAssistant({ text: 'a' }));

      const steering = fix.harness.service.steer(sessionId, 'change course', { interrupt: true });
      await live.emit(fakeResult({ turns: 1 }));
      const steered = await steering;

      expect(steered.receiptSupported).toBe(false);
      expect(steered.stillQueued).toEqual([]);
      expect(lineOfType(fix.harness, sessionId, 'steer')?.['receiptSupported']).toBe(false);

      await live.emit(fakeResult({ turns: 2 }));
      live.end();
      await fix.harness.service.awaitSettled(sessionId);
    } finally {
      fix.close();
    }
  });
});

// ---------------------------------------------------------------------------
// "Steering a non-running session returns a typed 409."
// ---------------------------------------------------------------------------

describe('steering a non-running session (§4.3)', () => {
  it('refuses a queued session with a typed 409 over HTTP', async () => {
    const fix = fixture({ config: { maxConcurrent: 1 } });
    try {
      const first = await fix.start('hold the slot');
      const second = await fix.harness.service.startSession({
        assignmentId: fix.seed.assignmentId,
        agentId: fix.seed.agentId,
        projectId: fix.seed.projectId,
        prompt: 'wait your turn',
      });
      expect(fix.harness.sessions.require(second.sessionId).status).toBe('queued');

      const answer = await fix.harness.call('POST', '/api/sessions/:id/steer', {
        params: { id: second.sessionId },
        body: { text: 'too early' },
      });
      expect(answer.status).toBe(409);
      expect(answer.body['error']).toBe('session_control_refused');
      expect(String(answer.body['message'])).toContain('queued');

      sessionAt(fix, 0).end();
      await fix.harness.service.awaitSettled(first);
    } finally {
      fix.close();
    }
  });

  it('refuses a finished session with a typed 409', async () => {
    const fix = fixture();
    try {
      const sessionId = await fix.start();
      const live = sessionAt(fix, 0);
      await live.emit(fakeResult({ turns: 1 }));
      live.end();
      await fix.harness.service.awaitSettled(sessionId);

      const answer = await fix.harness.call('POST', '/api/sessions/:id/steer', {
        params: { id: sessionId },
        body: { text: 'too late' },
      });
      expect(answer.status).toBe(409);
      expect(answer.body['error']).toBe('session_control_refused');
    } finally {
      fix.close();
    }
  });

  it('refuses a paused session and says to resume it first', async () => {
    const fix = fixture();
    try {
      const sessionId = await fix.start();
      await sessionAt(fix, 0).emit(fakeAssistant({ text: 'a' }));
      await fix.harness.service.pause(sessionId);

      await expect(fix.harness.service.steer(sessionId, 'nope')).rejects.toThrow(
        /Resume it first/u,
      );
    } finally {
      fix.close();
    }
  });
});

// ---------------------------------------------------------------------------
// "Pause on a running session yields paused, releases the slot (a queued session
//  starts), keeps the lease, and records sdk_session_id; resume continues on the
//  same row and the same transcript with seq unbroken, and the agent demonstrably
//  retains prior context."
// ---------------------------------------------------------------------------

describe('pause (§2.2, §9.1)', () => {
  it('yields paused with a recorded sdk_session_id and a session.paused event', async () => {
    const fix = fixture();
    try {
      const sessionId = await fix.start();
      const live = sessionAt(fix, 0);
      await live.emit(fakeAssistant({ text: 'mid-work' }));

      const paused = await fix.harness.service.pause(sessionId);
      expect(paused).toMatchObject({ status: 'paused', changed: true });

      const row = fix.harness.sessions.require(sessionId);
      expect(row.status).toBe('paused');
      expect(row.exitReason).toBe('user_stopped');
      expect(row.sdkSessionId).toBe(live.sdkSessionId);
      // §9.1's sequence, in order: interrupt, then close.
      expect(live.log.filter((entry) => entry === 'interrupt' || entry === 'close')).toEqual([
        'interrupt',
        'close',
      ]);

      const [event] = eventsOfType(fix.harness, 'session.paused');
      expect(event).toMatchObject({ reason: 'user_stopped', resumable: true, forced: false });
    } finally {
      fix.close();
    }
  });

  it('releases the concurrency slot, so a queued session starts', async () => {
    const fix = fixture({ config: { maxConcurrent: 1 } });
    try {
      const first = await fix.start('first');
      const second = await fix.harness.service.startSession({
        assignmentId: fix.seed.assignmentId,
        agentId: fix.seed.agentId,
        projectId: fix.seed.projectId,
        prompt: 'second',
      });
      expect(fix.harness.sessions.require(second.sessionId).status).toBe('queued');
      expect(fix.query.sessions).toHaveLength(1);

      await fix.harness.service.pause(first);

      // The slot was freed by the pause, and the scheduler admitted the queue.
      await fix.query.started(2);
      expect(fix.harness.sessions.require(second.sessionId).status).toBe('running');
      expect(fix.harness.sessions.require(first).status).toBe('paused');

      sessionAt(fix, 1).end();
      await fix.harness.service.awaitSettled(second.sessionId);
    } finally {
      fix.close();
    }
  });

  it('keeps the workspace lease, because a resume lands in the same tree (§3.1)', async () => {
    const fix = fixture();
    try {
      const sessionId = await fix.start();
      await sessionAt(fix, 0).emit(fakeAssistant({ text: 'a' }));
      expect(fix.harness.projects.acquisitions).toHaveLength(1);

      await fix.harness.service.pause(sessionId);

      // Nothing was released, and the row still names the lease it holds.
      expect(fix.harness.projects.releases).toEqual([]);
      expect(fix.harness.sessions.require(sessionId).leaseId).toBe('lease-1');
    } finally {
      fix.close();
    }
  });
});

describe('resume (§9.4 path 1)', () => {
  it('continues on the same row, the same transcript with seq unbroken, and passes resume', async () => {
    const fix = fixture();
    try {
      const sessionId = await fix.start('Remember the word kestrel.');
      const first = sessionAt(fix, 0);
      await first.emit(fakeAssistant({ text: 'Noted: kestrel.' }));
      await fix.harness.service.pause(sessionId);

      const beforeLines = fix.harness.transcriptLines(sessionId);
      const lastSeqBefore = Number(beforeLines[beforeLines.length - 1]?.['seq']);

      const resumed = await fix.harness.service.resume(sessionId);
      expect(resumed).toMatchObject({ status: 'queued', changed: true });
      await fix.query.started(2);

      const second = sessionAt(fix, 1);
      // §9.4: the same row, and the SDK is told which conversation to replay.
      expect(second.resume).toBe(first.sdkSessionId);
      expect(fix.harness.sessions.require(sessionId).status).toBe('running');
      expect(fix.harness.sessions.list().map((row) => row.id)).toEqual([sessionId]);
      // The prompt is not re-sent; the resume says what happened instead.
      expect(second.log.filter((entry) => entry.startsWith('input:'))).toEqual([
        `input:${RESUME_CONTINUATION}`,
      ]);

      // "The agent demonstrably retains prior context": the resumed run answers
      // from the replayed conversation, which the reader loop must not re-write
      // as new history (SDK-NOTES G1's filter, already in place).
      await second.emit(
        fakeAssistant({ text: 'The word was kestrel.' }),
        fakeResult({ text: 'The word was kestrel.', turns: 1 }),
      );
      second.end();
      const settled = await fix.harness.service.awaitSettled(sessionId);
      expect(settled.status).toBe('done');
      expect(settled.summary).toContain('kestrel');

      // The same file, and `seq` continued rather than restarting.
      const afterLines = fix.harness.transcriptLines(sessionId);
      const seqs = afterLines.map((line) => Number(line['seq']));
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
      expect(new Set(seqs).size).toBe(seqs.length);
      expect(seqs[0]).toBe(1);
      expect(Math.max(...seqs)).toBeGreaterThan(lastSeqBefore);
      // Two `session.start` headers, one per run, on one file.
      expect(lineTypes(fix.harness, sessionId).filter((t) => t === 'session.start')).toHaveLength(
        2,
      );
      expect(
        afterLines.filter((line) => line['type'] === 'session.start')[1]?.['resumedSdkSessionId'],
      ).toBe(first.sdkSessionId);
    } finally {
      fix.close();
    }
  });

  it('emits session.resumed with both session ids (§10)', async () => {
    const fix = fixture();
    try {
      const sessionId = await fix.start();
      await sessionAt(fix, 0).emit(fakeAssistant({ text: 'a' }));
      await fix.harness.service.pause(sessionId);
      await fix.harness.service.resume(sessionId);
      await fix.query.started(2);

      const [event] = eventsOfType(fix.harness, 'session.resumed');
      expect(event).toMatchObject({
        mode: 'same-session',
        priorSdkSessionId: sessionAt(fix, 0).sdkSessionId,
      });
      expect(typeof event?.['sdkSessionId']).toBe('string');

      sessionAt(fix, 1).end();
      await fix.harness.service.awaitSettled(sessionId);
    } finally {
      fix.close();
    }
  });

  it('refuses to resume a terminal session, pointing at Continue (§9.4 path 2)', async () => {
    const fix = fixture();
    try {
      const sessionId = await fix.start();
      const live = sessionAt(fix, 0);
      await live.emit(fakeResult({ turns: 1 }));
      live.end();
      await fix.harness.service.awaitSettled(sessionId);

      const answer = await fix.harness.call('POST', '/api/sessions/:id/resume', {
        params: { id: sessionId },
      });
      expect(answer.status).toBe(409);
      expect(String(answer.body['message'])).toContain('resumed_from');
    } finally {
      fix.close();
    }
  });
});

// ---------------------------------------------------------------------------
// "Stop yields interrupted / user_stopped and never leaves a live subprocess."
// ---------------------------------------------------------------------------

describe('stop (§2.2, §9.1)', () => {
  it('yields interrupted / user_stopped and leaves no live session handle', async () => {
    const fix = fixture();
    try {
      const sessionId = await fix.start();
      const live = sessionAt(fix, 0);
      await live.emit(fakeAssistant({ text: 'working' }));
      expect(fix.harness.launch.liveSessionIds()).toEqual([sessionId]);

      const stopped = await fix.harness.service.stop(sessionId, 'user pressed Stop');
      expect(stopped).toMatchObject({ status: 'interrupted', exitReason: 'user_stopped' });

      // The subprocess-count criterion, in the terms this harness can state:
      // interrupt, then close, and no handle left holding a `Query`.
      expect(live.log.filter((e) => e === 'interrupt' || e === 'close')).toEqual([
        'interrupt',
        'close',
      ]);
      expect(fix.harness.launch.liveSessionIds()).toEqual([]);
      expect(lineTypes(fix.harness, sessionId)).toContain('session.end');
    } finally {
      fix.close();
    }
  });

  it('aborts a session that ignores interrupt() and close(), rather than hanging (§9.1 step 3)', async () => {
    const fix = fixture({ ignoreControl: true, config: { gracefulInterruptMs: 40 } });
    try {
      const sessionId = await fix.start();
      const live = sessionAt(fix, 0);
      await live.emit(fakeAssistant({ text: 'ignoring you' }));

      const stopped = await fix.harness.service.stop(sessionId);
      expect(stopped.status).toBe('interrupted');
      expect(stopped.exitReason).toBe('user_stopped');
      expect(live.aborted).toBe(true);
      expect(fix.harness.launch.liveSessionIds()).toEqual([]);
      expect(String(lineOfType(fix.harness, sessionId, 'session.end')?.['message'])).toContain(
        'did not wind down',
      );
    } finally {
      fix.close();
    }
  });

  it('cancels a queued session as interrupted / user_cancelled, with no session ever started', async () => {
    const fix = fixture({ config: { maxConcurrent: 1 } });
    try {
      const first = await fix.start('hold the slot');
      const second = await fix.harness.service.startSession({
        assignmentId: fix.seed.assignmentId,
        agentId: fix.seed.agentId,
        projectId: fix.seed.projectId,
        prompt: 'never runs',
      });

      const stopped = await fix.harness.service.stop(second.sessionId);
      expect(stopped).toMatchObject({ status: 'interrupted', exitReason: 'user_cancelled' });
      expect(fix.query.sessions).toHaveLength(1);

      sessionAt(fix, 0).end();
      await fix.harness.service.awaitSettled(first);
    } finally {
      fix.close();
    }
  });

  it('discards a paused session as interrupted / user_stopped', async () => {
    const fix = fixture();
    try {
      const sessionId = await fix.start();
      await sessionAt(fix, 0).emit(fakeAssistant({ text: 'a' }));
      await fix.harness.service.pause(sessionId);

      const stopped = await fix.harness.service.stop(sessionId);
      expect(stopped).toMatchObject({ status: 'interrupted', exitReason: 'user_stopped' });
    } finally {
      fix.close();
    }
  });
});

// ---------------------------------------------------------------------------
// "Pause/stop/resume are idempotent: repeating each returns 200 with the current
//  state."
// ---------------------------------------------------------------------------

describe('idempotency (§11.1)', () => {
  it('repeats pause, resume and stop over HTTP, each answering 200 with the current state', async () => {
    const fix = fixture();
    try {
      const sessionId = await fix.start();
      await sessionAt(fix, 0).emit(fakeAssistant({ text: 'a' }));

      const pauseOnce = await fix.harness.call('POST', '/api/sessions/:id/pause', {
        params: { id: sessionId },
      });
      expect(pauseOnce.status).toBe(200);
      expect(pauseOnce.body).toMatchObject({ status: 'paused', changed: true });

      const pauseAgain = await fix.harness.call('POST', '/api/sessions/:id/pause', {
        params: { id: sessionId },
      });
      expect(pauseAgain.status).toBe(200);
      expect(pauseAgain.body).toMatchObject({ status: 'paused', changed: false });

      const resumeOnce = await fix.harness.call('POST', '/api/sessions/:id/resume', {
        params: { id: sessionId },
      });
      expect(resumeOnce.status).toBe(200);
      expect(resumeOnce.body['changed']).toBe(true);
      await fix.query.started(2);

      // Resuming a running session is the second half of the same rule.
      const resumeAgain = await fix.harness.call('POST', '/api/sessions/:id/resume', {
        params: { id: sessionId },
      });
      expect(resumeAgain.status).toBe(200);
      expect(resumeAgain.body).toMatchObject({ status: 'running', changed: false });

      const stopOnce = await fix.harness.call('POST', '/api/sessions/:id/stop', {
        params: { id: sessionId },
      });
      expect(stopOnce.status).toBe(200);
      expect(stopOnce.body).toMatchObject({ status: 'interrupted', changed: true });

      const stopAgain = await fix.harness.call('POST', '/api/sessions/:id/stop', {
        params: { id: sessionId },
      });
      expect(stopAgain.status).toBe(200);
      expect(stopAgain.body).toMatchObject({
        status: 'interrupted',
        exitReason: 'user_stopped',
        changed: false,
      });
    } finally {
      fix.close();
    }
  });
});

// ---------------------------------------------------------------------------
// "idleTimeoutMs and wallClockMaxMinutes each terminate a session with their own
//  exit_reason; a long-running Bash call inside the idle window does not trigger
//  the idle guard."
// ---------------------------------------------------------------------------

describe('the idle and wall-clock guards (§12)', () => {
  it('idleTimeoutMs ends a silent session with failed / idle_timeout', async () => {
    const fix = fixture({ config: { idleTimeoutMs: 60 } });
    try {
      const sessionId = await fix.start();
      // Nothing is emitted after `init`, so the guard is the only thing that can
      // end this session — which is what makes waiting the assertion.
      const settled = await fix.harness.service.awaitSettled(sessionId);
      expect(settled.status).toBe('failed');
      expect(settled.exitReason).toBe('idle_timeout');
      expect(lineOfType(fix.harness, sessionId, 'error')?.['code']).toBe('idle_timeout');
    } finally {
      fix.close();
    }
  });

  it('does not fire while a long Bash call runs inside the idle window', async () => {
    // The window is *between* messages, not from the start of the turn: a tool
    // call that takes most of the window and then answers must survive.
    const fix = fixture({ config: { idleTimeoutMs: 900 } });
    try {
      const sessionId = await fix.start('Run the suite.');
      const live = sessionAt(fix, 0);
      await live.emit(
        fakeAssistant({
          text: 'Running.',
          toolUse: { id: 'toolu_1', name: 'Bash', input: { command: 'npm test' } },
        }),
      );

      // A single long gap, comfortably inside the window.
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(fix.harness.sessions.require(sessionId).status).toBe('running');

      await live.emit(
        fakeToolResult({ toolUseId: 'toolu_1', content: 'ok' }),
        fakeResult({ text: 'Suite green.', turns: 1 }),
      );
      live.end();

      const settled = await fix.harness.service.awaitSettled(sessionId);
      expect(settled.status).toBe('done');
      expect(settled.exitReason).toBe('completed');
    } finally {
      fix.close();
    }
  });

  it('wallClockMaxMinutes ends a talkative session with failed / wall_clock_timeout', async () => {
    // A fractional value the config schema would refuse, supplied straight to
    // the chain: the deadline under test is measured in minutes, and a test that
    // waited one would be a test nobody runs.
    const fix = fixture({ config: { wallClockMaxMinutes: 0.004, idleTimeoutMs: 60_000 } });
    try {
      const sessionId = await fix.start();
      const live = sessionAt(fix, 0);
      // Keeps talking, so the idle guard never arms — only the wall clock can
      // end this one.
      const chatter = (async (): Promise<void> => {
        for (let i = 0; i < 40; i += 1) {
          await live.emit(fakeAssistant({ text: `tick ${String(i)}` }));
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      })();

      const settled = await fix.harness.service.awaitSettled(sessionId);
      expect(settled.status).toBe('failed');
      expect(settled.exitReason).toBe('wall_clock_timeout');
      expect(lineOfType(fix.harness, sessionId, 'error')?.['code']).toBe('wall_clock_timeout');
      await chatter;
    } finally {
      fix.close();
    }
  });
});

// ---------------------------------------------------------------------------
// "The InputQueue never throws: an injected internal error closes it cleanly and
//  the session ends with a real error message, not 'Claude Code process aborted
//  by user'."
// ---------------------------------------------------------------------------

describe('the InputQueue never throws (§4.2)', () => {
  it('turns an injected internal error into a clean close and a real error message', async () => {
    const fix = fixture();
    try {
      const sessionId = await fix.start();
      const live = sessionAt(fix, 0);
      await live.emit(fakeAssistant({ text: 'a' }));

      // The injection, through the public path a message actually reaches the
      // queue by: an attachment whose encoding throws while the message is being
      // built. SDK-NOTES §2.2 shows the wrapper turning a throwing iterable into
      // `abortController.abort(e)`, which surfaces as the misleading "Claude
      // Code process aborted by user" — §4.2's rule exists to prevent exactly
      // that, and this asserts both halves of it.
      const exploding = {
        get mediaType(): never {
          throw new Error('the attachment could not be encoded');
        },
        data: '',
      };
      await expect(
        fix.harness.service.steer(sessionId, 'boom', { attachments: [exploding] }),
      ).resolves.toBeDefined();

      // The real cause reached the log, under runner's own message.
      expect(
        fix.harness.logs.some(
          (entry) =>
            entry.message.includes('input queue failed') &&
            String(entry.detail['error']).includes('could not be encoded'),
        ),
      ).toBe(true);
      // Nothing was aborted: the queue closed itself instead.
      expect(live.aborted).toBe(false);

      await live.emit(
        fakeResult({ subtype: 'error_during_execution', errors: ['the stream ended'] }),
      );
      live.end();
      const settled = await fix.harness.service.awaitSettled(sessionId);
      expect(settled.status).toBe('failed');
      expect(settled.exitReason).toBe('error_during_execution');
      const ended = fix.harness.transcriptLines(sessionId).map((line) => JSON.stringify(line));
      expect(ended.join('\n')).not.toContain('aborted by user');
    } finally {
      fix.close();
    }
  });
});

// ---------------------------------------------------------------------------
// pin — §11.1's retention exemption
// ---------------------------------------------------------------------------

describe('pin (§11.1)', () => {
  it('pins and unpins a finished session over HTTP', async () => {
    const fix = fixture();
    try {
      const sessionId = await fix.start();
      const live = sessionAt(fix, 0);
      await live.emit(fakeResult({ turns: 1 }));
      live.end();
      await fix.harness.service.awaitSettled(sessionId);

      const pinned = await fix.harness.call('POST', '/api/sessions/:id/pin', {
        params: { id: sessionId },
        body: { pinned: true },
      });
      expect(pinned.status).toBe(200);
      expect(fix.harness.sessions.require(sessionId).pinned).toBe(true);

      await fix.harness.call('POST', '/api/sessions/:id/pin', {
        params: { id: sessionId },
        body: { pinned: false },
      });
      expect(fix.harness.sessions.require(sessionId).pinned).toBe(false);

      const bad = await fix.harness.call('POST', '/api/sessions/:id/pin', {
        params: { id: sessionId },
        body: {},
      });
      expect(bad.status).toBe(400);
      expect(bad.body['error']).toBe('invalid_request');
    } finally {
      fix.close();
    }
  });
});
