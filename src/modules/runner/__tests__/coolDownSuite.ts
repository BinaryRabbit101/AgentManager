/**
 * M5's rate-limit cool-down suite (runner DESIGN §6.4), factored out so it can
 * be run **twice**.
 *
 * M11's fourth acceptance bullet is "removing `rate_limit_event` handling
 * entirely leaves scheduling behaviour identical — asserted by running M5's
 * cool-down suite with the handler disabled". The only way that assertion means
 * anything is if it is literally the same suite: a re-written near-copy would
 * drift from the original the first time either changed, and the drift would be
 * invisible because both would still pass.
 *
 * So the two `it`s live here, parameterised by nothing but a config override,
 * and both call sites register them:
 *
 * - `scheduler.test.ts` — the shipped default, `observeCliEvent: true`;
 * - `usageWindows.test.ts` — `observeCliEvent: false`, the state in which the
 *   `rate_limit_event` handler is not constructed at all (`launch.ts`).
 *
 * Neither scenario below involves a `rate_limit_event`. That is the point:
 * §6.4's cool-down is driven by the **observed** error path — a typed
 * `terminal_reason` first, the SDK's own error text second (SDK-NOTES G7) — and
 * the CLI's volunteered telemetry is a display that may move a deadline, never
 * a behaviour anything depends on.
 */
import { expect, it } from 'vitest';

import { fakeResult, fakeSessionStateChanged, gatedQuery } from './fakeQuery.js';
import {
  makeLaunchHarness,
  type LaunchHarness,
  type PartialRunnerConfig,
} from './launchHarness.js';
import type { SDKMessage } from '../sdk.js';

/** The instant every clock in this suite starts at (`launchHarness`'s FIXED_NOW). */
export const COOL_DOWN_START = new Date('2026-08-16T10:00:00.000Z');

/** A rate-limited turn, classified from `terminal_reason` (SDK-NOTES G7). */
export function blockingLimitTail(): SDKMessage[] {
  return [
    fakeResult({ subtype: 'error_during_execution', terminalReason: 'blocking_limit' }),
    fakeSessionStateChanged('idle'),
  ];
}

/** A clock a test can move, for the deadlines M5 measures in minutes. */
export function movableClock(): { now: () => Date; advanceMinutes: (minutes: number) => void } {
  let ms = COOL_DOWN_START.getTime();
  return {
    now: () => new Date(ms),
    advanceMinutes: (minutes) => {
      ms += minutes * 60_000;
    },
  };
}

async function launch(
  harness: LaunchHarness,
  seed: { projectId: string; assignmentId: string; agentId: string },
): Promise<string> {
  const started = await harness.service.startSession({
    assignmentId: seed.assignmentId,
    agentId: seed.agentId,
    projectId: seed.projectId,
    prompt: 'Queue me.',
  });
  return started.sessionId;
}

function statusOf(harness: LaunchHarness, sessionId: string): string {
  return harness.sessions.require(sessionId).status;
}

async function drain(
  harness: LaunchHarness,
  gate: ReturnType<typeof gatedQuery>,
  sessionIds: readonly string[],
): Promise<void> {
  gate.autoFinish();
  for (const sessionId of sessionIds) await harness.service.awaitSettled(sessionId);
}

export interface CoolDownSuiteOptions {
  /** A fresh data root per test — the caller owns the temp directory. */
  readonly dataRoot: () => string;
  /** Merged over the defaults; M11 passes `{ rateLimit: { observeCliEvent: false } }`. */
  readonly config?: PartialRunnerConfig | undefined;
}

/** Registers M5's two cool-down `it`s inside the caller's `describe`. */
export function coolDownSuite(options: CoolDownSuiteOptions): void {
  const extra = options.config ?? {};

  it('blocks admissions while running sessions continue, and emits runner.ratelimited with a source', async () => {
    const gate = gatedQuery();
    const harness = makeLaunchHarness({
      dataRoot: options.dataRoot(),
      query: gate.query,
      config: { ...extra, maxConcurrent: 2 },
    });
    try {
      const seed = harness.seed();
      const survivor = await launch(harness, seed);
      const limited = await launch(harness, seed);
      await gate.started(2);

      gate.sessions[1]?.finish(blockingLimitTail());
      await harness.service.awaitSettled(limited);

      const queued = await launch(harness, seed);
      expect(harness.service.queueState().cooling).toBe(true);
      // "Running sessions are left alone; queued sessions stay queued."
      expect(statusOf(harness, survivor)).toBe('running');
      expect(statusOf(harness, queued)).toBe('queued');

      const emitted = harness.events.filter((event) => event.type === 'runner.ratelimited');
      expect(emitted).toHaveLength(1);
      expect(emitted[0]?.persist).toBe(true);
      expect(emitted[0]?.payload).toMatchObject({ source: 'terminal-reason' });

      // Only the survivor can be drained: the queued one is still waiting on a
      // cool-down that this test never lets expire, which is the point.
      await drain(harness, gate, [survivor]);
      expect(statusOf(harness, queued)).toBe('queued');
    } finally {
      harness.close();
    }
  });

  it('doubles the cool-down on a second consecutive hit and clears it on the next successful start', async () => {
    const clock = movableClock();
    const gate = gatedQuery();
    const harness = makeLaunchHarness({
      dataRoot: options.dataRoot(),
      query: gate.query,
      clock: clock.now,
      config: {
        ...extra,
        maxConcurrent: 2,
        rateLimit: { ...extra.rateLimit, cooldownMs: 300_000, maxCooldownMs: 1_800_000 },
      },
    });
    try {
      const seed = harness.seed();
      const first = await launch(harness, seed);
      const second = await launch(harness, seed);
      await gate.started(2);

      gate.sessions[0]?.finish(blockingLimitTail());
      await harness.service.awaitSettled(first);
      expect(harness.service.queueState().coolingUntil).toBe(
        new Date(COOL_DOWN_START.getTime() + 300_000).toISOString(),
      );

      gate.sessions[1]?.finish([
        fakeResult({
          subtype: 'error_during_execution',
          errors: ['API Error: 429 rate limit exceeded'],
        }),
        fakeSessionStateChanged('idle'),
      ]);
      await harness.service.awaitSettled(second);

      // Doubled, and classified from the error text this time (§6.4's fallback).
      expect(harness.service.queueState().coolingUntil).toBe(
        new Date(COOL_DOWN_START.getTime() + 600_000).toISOString(),
      );
      expect(
        harness.events
          .filter((event) => event.type === 'runner.ratelimited')
          .map((event) => (event.payload as { source: string }).source),
      ).toEqual(['terminal-reason', 'error-text']);

      // A session enqueued during the cool-down waits for it.
      const waiting = await launch(harness, seed);
      expect(statusOf(harness, waiting)).toBe('queued');

      // …and the cool-down is cleared by the next successful start, not by a timer.
      clock.advanceMinutes(11);
      harness.launch.onWorkspaceReleased();
      await gate.started(3);
      expect(statusOf(harness, waiting)).toBe('running');
      expect(harness.service.queueState()).toMatchObject({ cooling: false, coolingUntil: null });

      await drain(harness, gate, [waiting]);
    } finally {
      harness.close();
    }
  });
}
