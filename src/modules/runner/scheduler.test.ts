/**
 * The scheduler (runner IMPLEMENTATION **M5**), one `describe` per acceptance
 * bullet, driven through the fake `query` of `__tests__/fakeQuery.ts`.
 *
 * Concurrency, priority and cool-down are all statements about sessions that
 * **overlap in time**, so most of these use `gatedQuery`: its sessions report
 * `system/init` and then stay running until the test finishes them, which is
 * where a real session waits too. Nothing here mocks the scheduler — every
 * assertion is made against session rows the launch chain actually wrote.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { coolDownSuite } from './__tests__/coolDownSuite.js';
import { makeTempDir, type TempDir } from './__tests__/helpers.js';
import {
  fakeInit,
  fakeRateLimitEvent,
  fakeResult,
  fakeSessionStateChanged,
  gatedQuery,
  scriptedQuery,
  successScript,
} from './__tests__/fakeQuery.js';
import {
  fakeProjects,
  fakeRoster,
  makeLaunchHarness,
  type LaunchHarness,
} from './__tests__/launchHarness.js';
import type { QueryFn } from './sdk.js';
import { CAPACITY_SETTING_KEY } from './scheduler.js';

let temp: TempDir;

beforeEach(() => {
  temp = makeTempDir('agentmanager-runner-sched-');
});

afterEach(() => {
  temp.cleanup();
});

function dataRoot(): string {
  return `${temp.path}\\data`;
}

const START = new Date('2026-08-16T10:00:00.000Z');

/** A clock a test can move, for the deadlines M5 measures in minutes. */
function movableClock(): { now: () => Date; advanceMinutes: (minutes: number) => void } {
  let ms = START.getTime();
  return {
    now: () => new Date(ms),
    advanceMinutes: (minutes) => {
      ms += minutes * 60_000;
    },
  };
}

/** Launches one session and returns its id. */
async function launch(
  harness: LaunchHarness,
  seed: { projectId: string; assignmentId: string; agentId: string },
  options: { priority?: 'interactive' | 'normal' | 'background' } = {},
): Promise<string> {
  const started = await harness.service.startSession({
    assignmentId: seed.assignmentId,
    agentId: seed.agentId,
    projectId: seed.projectId,
    prompt: 'Queue me.',
    ...(options.priority === undefined ? {} : { priority: options.priority }),
  });
  return started.sessionId;
}

function statusOf(harness: LaunchHarness, sessionId: string): string {
  return harness.sessions.require(sessionId).status;
}

/**
 * Lets every remaining session finish, including the ones the scheduler has not
 * admitted yet — a gated session nobody finishes outlives the test and then
 * touches a closed database.
 */
async function drain(
  harness: LaunchHarness,
  gate: ReturnType<typeof gatedQuery>,
  sessionIds: readonly string[],
): Promise<void> {
  gate.autoFinish();
  for (const sessionId of sessionIds) await harness.service.awaitSettled(sessionId);
}

// ---------------------------------------------------------------------------

describe('the weighted concurrency cap (M5, §6.1)', () => {
  it('runs two and queues one at maxConcurrent: 2, and starts the third when one finishes', async () => {
    const gate = gatedQuery();
    const harness = makeLaunchHarness({
      dataRoot: dataRoot(),
      query: gate.query,
      config: { maxConcurrent: 2 },
    });
    try {
      const seed = harness.seed();
      const first = await launch(harness, seed);
      const second = await launch(harness, seed);
      const third = await launch(harness, seed);
      await gate.started(2);

      expect(statusOf(harness, first)).toBe('running');
      expect(statusOf(harness, second)).toBe('running');
      expect(statusOf(harness, third)).toBe('queued');
      expect(harness.service.queueState()).toMatchObject({
        running: 2,
        queued: 1,
        blocked: 0,
        capacity: 2,
        usedWeight: 2,
      });

      // Either finishing releases the slot.
      gate.sessions[0]?.finish();
      await harness.service.awaitSettled(first);
      await gate.started(3);
      expect(statusOf(harness, third)).toBe('running');

      await drain(harness, gate, [second, third]);
    } finally {
      harness.close();
    }
  });

  it('lets an agent with concurrencyWeight: 2 occupy the whole cap', async () => {
    const gate = gatedQuery();
    const harness = makeLaunchHarness({
      dataRoot: dataRoot(),
      query: gate.query,
      config: { maxConcurrent: 2 },
      roster: fakeRoster({ weights: { heavy: 2 } }),
    });
    try {
      const heavySeed = harness.seed({ agentId: 'heavy' });
      const lightSeed = harness.seed({ agentId: 'light' });

      const heavy = await launch(harness, heavySeed);
      await gate.started(1);
      const light = await launch(harness, lightSeed);

      expect(harness.sessions.require(heavy).weight).toBe(2);
      expect(harness.sessions.require(light).weight).toBe(1);
      expect(statusOf(harness, heavy)).toBe('running');
      expect(statusOf(harness, light)).toBe('queued');
      expect(harness.service.queueState().usedWeight).toBe(2);

      gate.sessions[0]?.finish();
      await harness.service.awaitSettled(heavy);
      await gate.started(2);
      expect(statusOf(harness, light)).toBe('running');

      await drain(harness, gate, [light]);
    } finally {
      harness.close();
    }
  });
});

describe('the two priority bands (M5, §6.2)', () => {
  it('admits an interactive session enqueued after a normal one first', async () => {
    const gate = gatedQuery();
    const harness = makeLaunchHarness({
      dataRoot: dataRoot(),
      query: gate.query,
      config: { maxConcurrent: 1 },
    });
    try {
      const seed = harness.seed();
      const running = await launch(harness, seed);
      await gate.started(1);

      const normal = await launch(harness, seed, { priority: 'normal' });
      const interactive = await launch(harness, seed, { priority: 'interactive' });
      expect(statusOf(harness, normal)).toBe('queued');
      expect(statusOf(harness, interactive)).toBe('queued');

      gate.sessions[0]?.finish();
      await harness.service.awaitSettled(running);
      await gate.started(2);

      // The person who just answered does not sit behind a batch (§6.2).
      expect(statusOf(harness, interactive)).toBe('running');
      expect(statusOf(harness, normal)).toBe('queued');

      await drain(harness, gate, [interactive, normal]);
    } finally {
      harness.close();
    }
  });

  it('admits two sessions of one band in queued_at order', async () => {
    const gate = gatedQuery();
    const harness = makeLaunchHarness({
      dataRoot: dataRoot(),
      query: gate.query,
      config: { maxConcurrent: 1 },
    });
    try {
      const seed = harness.seed();
      const running = await launch(harness, seed);
      await gate.started(1);

      const older = await launch(harness, seed);
      const newer = await launch(harness, seed);

      const entries = harness.service.queueEntries().filter((entry) => entry.status === 'queued');
      expect(entries.map((entry) => entry.sessionId)).toEqual([older, newer]);
      expect(entries.map((entry) => entry.position)).toEqual([1, 2]);

      gate.sessions[0]?.finish();
      await harness.service.awaitSettled(running);
      await gate.started(2);
      expect(statusOf(harness, older)).toBe('running');
      expect(statusOf(harness, newer)).toBe('queued');

      await drain(harness, gate, [older, newer]);
    } finally {
      harness.close();
    }
  });
});

describe('the background band (§6.2, WO8)', () => {
  it('admits a trigger-launched session second when an interactive one is waiting', async () => {
    const gate = gatedQuery();
    const harness = makeLaunchHarness({
      dataRoot: dataRoot(),
      query: gate.query,
      config: { maxConcurrent: 1 },
    });
    try {
      const seed = harness.seed();
      const running = await launch(harness, seed);
      await gate.started(1);

      // The background one is enqueued *first*; the owner's launch arrives
      // after it and must still go first — unattended work never starves the
      // owner's own usage (D2).
      const background = await launch(harness, seed, { priority: 'background' });
      const interactive = await launch(harness, seed, { priority: 'interactive' });

      gate.sessions[0]?.finish();
      await harness.service.awaitSettled(running);
      await gate.started(2);

      expect(statusOf(harness, interactive)).toBe('running');
      expect(statusOf(harness, background)).toBe('queued');

      await drain(harness, gate, [interactive, background]);
    } finally {
      harness.close();
    }
  });

  it('holds a background session back while an interactive one is blocked, not merely queued', async () => {
    const gate = gatedQuery();
    const harness = makeLaunchHarness({
      dataRoot: dataRoot(),
      query: gate.query,
      config: { maxConcurrent: 1 },
    });
    try {
      const seed = harness.seed();
      const running = await launch(harness, seed);
      await gate.started(1);

      const interactive = await launch(harness, seed, { priority: 'interactive' });
      const background = await launch(harness, seed, { priority: 'background' });
      // A blocked entry is `continue`d over by the admission loop, so band
      // ordering alone would let the background session start ahead of a human
      // waiting for a workspace. This is the gate that does not.
      harness.sessions.patch(interactive, { blockedReason: 'a write lease is held' });

      gate.sessions[0]?.finish();
      await harness.service.awaitSettled(running);
      harness.launch.admitQueued();
      expect(statusOf(harness, background)).toBe('queued');

      harness.launch.onWorkspaceReleased();
      await gate.started(2);
      expect(statusOf(harness, interactive)).toBe('running');

      await drain(harness, gate, [interactive, background]);
    } finally {
      harness.close();
    }
  });

  it('keeps the band on the row, read back as one value', async () => {
    const gate = gatedQuery();
    const harness = makeLaunchHarness({
      dataRoot: dataRoot(),
      query: gate.query,
      config: { maxConcurrent: 1 },
    });
    try {
      const seed = harness.seed();
      const session = await launch(harness, seed, { priority: 'background' });
      // 0004 stores the band as `(priority, background)`; every reader above the
      // repository sees the one value it was enqueued with.
      expect(harness.sessions.require(session).priority).toBe('background');
      await drain(harness, gate, [session]);
    } finally {
      harness.close();
    }
  });
});

describe('the queue limit (M5, §6.2)', () => {
  it('refuses the session past queueLimit with queue_full and writes no row', async () => {
    const gate = gatedQuery();
    const harness = makeLaunchHarness({
      dataRoot: dataRoot(),
      query: gate.query,
      config: { maxConcurrent: 1, queueLimit: 3 },
    });
    try {
      const seed = harness.seed();
      const running = await launch(harness, seed);
      await gate.started(1);
      await launch(harness, seed);
      await launch(harness, seed);
      await launch(harness, seed);

      const before = harness.sessions.list().length;
      await expect(
        harness.service.startSession({
          assignmentId: seed.assignmentId,
          agentId: seed.agentId,
          projectId: seed.projectId,
          prompt: 'One too many.',
        }),
      ).rejects.toMatchObject({ code: 'queue_full', status: 429 });

      // "and **no session row**" — a queued row that was never really accepted
      // would pollute the timeline.
      expect(harness.sessions.list()).toHaveLength(before);

      await drain(harness, gate, [running]);
    } finally {
      harness.close();
    }
  });
});

describe('blocked entries wait for a workspace (M5, §6.2, §3.2)', () => {
  it('keeps the session queued with blocked_reason, consuming no slot, and starts it on workspace.released', async () => {
    const projects = fakeProjects({
      refusal: {
        code: 'write_lease_held',
        reason: 'another write assignment holds the tree',
        retryable: true,
      },
    });
    const harness = makeLaunchHarness({
      dataRoot: dataRoot(),
      query: scriptedQuery({ messages: successScript() }).query,
      projects,
      config: { maxConcurrent: 1 },
    });
    try {
      const seed = harness.seed();
      const blocked = await launch(harness, seed);
      await harness.service.awaitSettled(blocked);

      const row = harness.sessions.require(blocked);
      expect(row.status).toBe('queued');
      expect(row.blockedReason).toBe('another write assignment holds the tree');
      expect(harness.service.queueState()).toMatchObject({ running: 0, queued: 0, blocked: 1 });

      projects.clearRefusal();
      harness.launch.onWorkspaceReleased();
      const settled = await harness.service.awaitSettled(blocked);
      expect(settled.status).toBe('done');
      expect(settled.blockedReason).toBeNull();
    } finally {
      harness.close();
    }
  });

  it('fails the session workspace_unavailable once it has waited workspaceWaitMinutes', async () => {
    const clock = movableClock();
    const projects = fakeProjects({
      refusal: {
        code: 'write_lease_held',
        reason: 'another write assignment holds the tree',
        retryable: true,
      },
    });
    const harness = makeLaunchHarness({
      dataRoot: dataRoot(),
      query: scriptedQuery({ messages: successScript() }).query,
      projects,
      clock: clock.now,
      config: { maxConcurrent: 1, workspaceWaitMinutes: 30 },
    });
    try {
      const seed = harness.seed();
      const blocked = await launch(harness, seed);
      await harness.service.awaitSettled(blocked);
      expect(statusOf(harness, blocked)).toBe('queued');

      // Still inside the window: another release attempt changes nothing.
      clock.advanceMinutes(29);
      harness.launch.onWorkspaceReleased();
      await harness.service.awaitSettled(blocked);
      expect(statusOf(harness, blocked)).toBe('queued');

      clock.advanceMinutes(2);
      harness.launch.onWorkspaceReleased();
      const settled = await harness.service.awaitSettled(blocked);
      expect(settled.status).toBe('failed');
      expect(settled.exitReason).toBe('workspace_unavailable');
      expect(harness.events.some((event) => event.type === 'session.ended')).toBe(true);
    } finally {
      harness.close();
    }
  });
});

describe('the rate-limit cool-down (M5, §6.4)', () => {
  // The suite itself lives in `__tests__/coolDownSuite.ts` so M11 can run the
  // *same* two tests with `rate_limit_event` handling switched off and assert
  // that scheduling is identical (`usageWindows.test.ts`). Nothing inside it
  // changed when it moved.
  coolDownSuite({ dataRoot });
});

describe('a CLI-reported rate limit (M5, §6.4, §7.4)', () => {
  it('takes its reset time from a rate_limit_event instead of the backoff, and parses it permissively', async () => {
    const resetsAt = new Date(START.getTime() + 45 * 60_000);
    const harness = makeLaunchHarness({
      dataRoot: dataRoot(),
      clock: () => START,
      query: scriptedQuery({
        messages: [
          fakeInit(),
          // Unexpected extra fields and a seconds-epoch reset: §7.4's permissive
          // parse must not throw, and no scheduling decision reads the numbers.
          fakeRateLimitEvent({
            status: 'rejected',
            rateLimitType: 'five_hour',
            resetsAt: Math.floor(resetsAt.getTime() / 1000),
            somethingNew: { nested: true },
          }),
          fakeResult(),
          fakeSessionStateChanged('idle'),
        ],
      }).query,
    });
    try {
      const seed = harness.seed();
      const sessionId = await launch(harness, seed);
      const settled = await harness.service.awaitSettled(sessionId);

      // The event is a display and a cool-down input, never a session failure.
      expect(settled.status).toBe('done');
      const emitted = harness.events.filter((event) => event.type === 'runner.ratelimited');
      expect(emitted).toHaveLength(1);
      expect(emitted[0]?.payload).toMatchObject({
        source: 'rate_limit_event',
        until: resetsAt.toISOString(),
      });
      expect(harness.service.queueState().coolingUntil).toBe(resetsAt.toISOString());
    } finally {
      harness.close();
    }
  });
});

describe('the runtime capacity override (M5, §6.1)', () => {
  it('changes the effective cap without a restart, persists in settings, and clamps to 1..8', async () => {
    const gate = gatedQuery();
    const harness = makeLaunchHarness({
      dataRoot: dataRoot(),
      query: gate.query,
      config: { maxConcurrent: 2 },
    });
    try {
      const seed = harness.seed();
      const lowered = await harness.call('PUT', '/api/runner/capacity', {
        body: { maxConcurrent: 1 },
      });
      expect(lowered.status).toBe(200);
      expect(lowered.body['maxConcurrent']).toBe(1);
      expect(harness.storage.store.settings.get<number>(CAPACITY_SETTING_KEY)).toBe(1);

      const running = await launch(harness, seed);
      await gate.started(1);
      const waiting = await launch(harness, seed);
      // The config still says 2; the override is what the scheduler reads.
      expect(harness.config.maxConcurrent).toBe(2);
      expect(harness.service.queueState().capacity).toBe(1);
      expect(statusOf(harness, waiting)).toBe('queued');

      const tooHigh = await harness.call('PUT', '/api/runner/capacity', {
        body: { maxConcurrent: 40 },
      });
      expect(tooHigh.body['maxConcurrent']).toBe(8);
      const tooLow = await harness.call('PUT', '/api/runner/capacity', {
        body: { maxConcurrent: 0 },
      });
      expect(tooLow.body['maxConcurrent']).toBe(1);

      const malformed = await harness.call('PUT', '/api/runner/capacity', { body: {} });
      expect(malformed.status).toBe(400);
      expect(malformed.body['error']).toBe('invalid_request');

      await drain(harness, gate, [running, waiting]);
    } finally {
      harness.close();
    }
  });

  it('survives a restart, because the override lives in settings rather than config', async () => {
    const first = makeLaunchHarness({ dataRoot: dataRoot(), config: { maxConcurrent: 2 } });
    try {
      await first.call('PUT', '/api/runner/capacity', { body: { maxConcurrent: 5 } });
    } finally {
      first.close();
    }

    const restarted = makeLaunchHarness({ dataRoot: dataRoot(), config: { maxConcurrent: 2 } });
    try {
      expect(restarted.service.queueState().capacity).toBe(5);
    } finally {
      restarted.close();
    }
  });
});

describe('the queue is observable (M5, §10, §11.1)', () => {
  it('reports running and queued sessions on GET /api/runner/queue', async () => {
    const gate = gatedQuery();
    const harness = makeLaunchHarness({
      dataRoot: dataRoot(),
      query: gate.query,
      config: { maxConcurrent: 1 },
    });
    try {
      const seed = harness.seed();
      const running = await launch(harness, seed);
      await gate.started(1);
      const queued = await launch(harness, seed, { priority: 'interactive' });

      const response = await harness.call('GET', '/api/runner/queue');
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ running: 1, queued: 1, blocked: 0, capacity: 1 });

      const entries = response.body['entries'] as { sessionId: string; status: string }[];
      expect(entries.find((entry) => entry.sessionId === running)?.status).toBe('running');
      expect(entries.find((entry) => entry.sessionId === queued)?.status).toBe('queued');

      await drain(harness, gate, [running, queued]);
    } finally {
      harness.close();
    }
  });

  it('emits runner.queue.changed without persisting it', async () => {
    const harness = makeLaunchHarness({
      dataRoot: dataRoot(),
      query: scriptedQuery({ messages: successScript() }).query,
    });
    try {
      const seed = harness.seed();
      const sessionId = await launch(harness, seed);
      await harness.service.awaitSettled(sessionId);

      const changes = harness.events.filter((event) => event.type === 'runner.queue.changed');
      expect(changes.length).toBeGreaterThan(0);
      expect(changes.every((event) => !event.persist)).toBe(true);
      expect(changes[0]?.payload).toMatchObject({ capacity: expect.any(Number) as number });
    } finally {
      harness.close();
    }
  });
});

/** Kept honest: the seam every test above drives is the same one production uses. */
describe('the scheduler is the only admission path', () => {
  it('never admits more weight than the cap while sessions overlap', async () => {
    const gate = gatedQuery();
    const seen: number[] = [];
    const query: QueryFn = (args) => {
      seen.push(seen.length + 1);
      return gate.query(args);
    };
    const harness = makeLaunchHarness({
      dataRoot: dataRoot(),
      query,
      config: { maxConcurrent: 2 },
    });
    try {
      const seed = harness.seed();
      const ids = [
        await launch(harness, seed),
        await launch(harness, seed),
        await launch(harness, seed),
        await launch(harness, seed),
      ];
      await gate.started(2);
      // Four launches, two subprocesses: the cap is a cap on `query()` calls,
      // not merely on a status column.
      expect(seen).toHaveLength(2);
      expect(harness.service.queueState().usedWeight).toBeLessThanOrEqual(2);

      await drain(harness, gate, ids);
    } finally {
      harness.close();
    }
  });
});
