/**
 * Usage metering (runner IMPLEMENTATION **M4**), one `describe` per acceptance
 * bullet, every session driven through the fake `query` of
 * `__tests__/fakeQuery.ts`.
 *
 * The two facts these tests exist to pin, both of them SDK behaviours rather
 * than runner choices:
 *
 * - parallel tool calls emit several assistant messages **sharing one
 *   `message.id`**, so a live delta must be keyed and deduped rather than
 *   summed;
 * - `result.modelUsage` and `result.total_cost_usd` are cumulative **per
 *   `query()` call** and restart at zero on a resume (SDK-NOTES **C1**), so the
 *   reconciliation baseline is per run and a negative delta is a bug rather than
 *   a refund.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeHarness, makeTempDir, openTestStorage, type TempDir } from './__tests__/helpers.js';
import {
  fakeAssistant,
  fakeInit,
  fakeResult,
  fakeSessionStateChanged,
  scriptedQuery,
} from './__tests__/fakeQuery.js';
import { makeLaunchHarness, type LaunchHarness } from './__tests__/launchHarness.js';
import { NegativeUsageDeltaError } from './errors.js';
import { readResult, type ResultFacts } from './messages.js';
import { createRunMeter, createUsageRepository, ZERO_TOKENS } from './usage.js';

let temp: TempDir;

beforeEach(() => {
  temp = makeTempDir('agentmanager-runner-usage-');
});

afterEach(() => {
  temp.cleanup();
});

function dataRoot(): string {
  return `${temp.path}\\data`;
}

const MODEL = 'claude-sonnet-4-5';

/** Runs one session to completion and hands back its id. */
async function runSession(harness: LaunchHarness): Promise<string> {
  const seed = harness.seed();
  const started = await harness.service.startSession({
    assignmentId: seed.assignmentId,
    agentId: seed.agentId,
    projectId: seed.projectId,
    prompt: 'Meter this.',
  });
  await harness.service.awaitSettled(started.sessionId);
  return started.sessionId;
}

// ---------------------------------------------------------------------------

describe('the rollup, the deltas and result.modelUsage agree (M4)', () => {
  it('makes SUM(usage_events) equal session_usage and both equal the final modelUsage', async () => {
    const messages = [
      fakeInit(),
      fakeAssistant({ messageId: 'msg_a', usage: { input: 100, output: 20 } }),
      fakeAssistant({ messageId: 'msg_b', usage: { input: 40, output: 10, cacheRead: 5 } }),
      fakeResult({
        modelUsage: { [MODEL]: { input: 150, output: 35, cacheRead: 5 } },
        costUsd: 0.5,
      }),
      fakeSessionStateChanged('idle'),
    ];
    const harness = makeLaunchHarness({
      dataRoot: dataRoot(),
      query: scriptedQuery({ messages }).query,
    });
    try {
      const sessionId = await runSession(harness);
      const totals = harness.usage.totals(sessionId);
      const sums = harness.usage.eventSums(sessionId);

      // The final `modelUsage`, exactly — which is the invariant §7.1 states.
      expect(totals?.inputTokens).toBe(150);
      expect(totals?.outputTokens).toBe(35);
      expect(totals?.cacheReadTokens).toBe(5);
      expect(totals?.turns).toBe(1);

      expect(sums.input).toBe(totals?.inputTokens);
      expect(sums.output).toBe(totals?.outputTokens);
      expect(sums.cacheRead).toBe(totals?.cacheReadTokens);
      expect(sums.cacheCreation).toBe(totals?.cacheCreationTokens);
      expect(sums.events).toBe(totals?.events);
    } finally {
      harness.close();
    }
  });
});

describe('parallel tool calls are counted once (M4)', () => {
  it('makes a repeated assistant message id a no-op insert rather than an error', async () => {
    const messages = [
      fakeInit(),
      // SDK-NOTES §6.3: "one API assistant turn may produce several assistant
      // messages sharing a `message.id`… with identical usage".
      fakeAssistant({ messageId: 'msg_par', usage: { input: 120, output: 30 } }),
      fakeAssistant({ messageId: 'msg_par', usage: { input: 120, output: 30 } }),
      fakeAssistant({ messageId: 'msg_par', usage: { input: 120, output: 30 } }),
      fakeResult({ modelUsage: { [MODEL]: { input: 120, output: 30 } } }),
      fakeSessionStateChanged('idle'),
    ];
    const harness = makeLaunchHarness({
      dataRoot: dataRoot(),
      query: scriptedQuery({ messages }).query,
    });
    try {
      const sessionId = await runSession(harness);
      const settled = harness.sessions.require(sessionId);
      // The duplicate was absorbed, not raised: the session still completed.
      expect(settled.status).toBe('done');

      const live = harness.usage.listEvents(sessionId).filter((row) => row.source === 'turn');
      expect(live).toHaveLength(1);
      expect(harness.usage.totals(sessionId)?.inputTokens).toBe(120);
      // No reconciliation was needed, because the deduped live row already was
      // the whole truth.
      expect(harness.usage.listEvents(sessionId).filter((r) => r.source === 'reconcile')).toEqual(
        [],
      );
    } finally {
      harness.close();
    }
  });
});

describe('the reconciliation row (M4)', () => {
  it('appears with source: reconcile when the live estimate differs, and warns when large', async () => {
    const messages = [
      fakeInit(),
      // The live estimate is a placeholder count taken at `message_start` [V].
      fakeAssistant({ messageId: 'msg_low', usage: { input: 10, output: 2 } }),
      fakeResult({ modelUsage: { [MODEL]: { input: 1000, output: 300 } } }),
      fakeSessionStateChanged('idle'),
    ];
    const harness = makeLaunchHarness({
      dataRoot: dataRoot(),
      query: scriptedQuery({ messages }).query,
    });
    try {
      const sessionId = await runSession(harness);
      const rows = harness.usage.listEvents(sessionId);
      const reconcile = rows.filter((row) => row.source === 'reconcile');

      expect(reconcile).toHaveLength(1);
      expect(reconcile[0]?.model).toBe(MODEL);
      expect(reconcile[0]?.messageId).toBeNull();
      expect(reconcile[0]?.tokens.input).toBe(990);
      expect(reconcile[0]?.tokens.output).toBe(298);
      expect(harness.usage.totals(sessionId)?.inputTokens).toBe(1000);

      const warned = harness.logs.filter(
        (line) => line.level === 'warn' && line.message.includes('reconciled session usage'),
      );
      expect(warned).toHaveLength(1);
    } finally {
      harness.close();
    }
  });

  it('logs a small adjustment at debug rather than warn', async () => {
    const messages = [
      fakeInit(),
      fakeAssistant({ messageId: 'msg_close', usage: { input: 1000, output: 300 } }),
      fakeResult({ modelUsage: { [MODEL]: { input: 1005, output: 300 } } }),
      fakeSessionStateChanged('idle'),
    ];
    const harness = makeLaunchHarness({
      dataRoot: dataRoot(),
      query: scriptedQuery({ messages }).query,
    });
    try {
      const sessionId = await runSession(harness);
      expect(harness.usage.totals(sessionId)?.inputTokens).toBe(1005);
      expect(
        harness.logs.filter(
          (line) => line.level === 'warn' && line.message.includes('reconciled session usage'),
        ),
      ).toEqual([]);
      expect(
        harness.logs.filter(
          (line) => line.level === 'debug' && line.message.includes('reconciled session usage'),
        ),
      ).toHaveLength(1);
    } finally {
      harness.close();
    }
  });
});

describe('the assignment total (M4, §7.2)', () => {
  it('advances tokens_used by exactly input + output and excludes cache tokens', async () => {
    const messages = [
      fakeInit(),
      fakeAssistant({
        messageId: 'msg_cache',
        usage: { input: 100, output: 20, cacheRead: 500, cacheCreation: 700 },
      }),
      fakeResult({
        modelUsage: { [MODEL]: { input: 100, output: 20, cacheRead: 500, cacheCreation: 700 } },
      }),
      fakeSessionStateChanged('idle'),
    ];
    const harness = makeLaunchHarness({
      dataRoot: dataRoot(),
      query: scriptedQuery({ messages }).query,
    });
    try {
      const seed = harness.seed();
      const started = await harness.service.startSession({
        assignmentId: seed.assignmentId,
        agentId: seed.agentId,
        projectId: seed.projectId,
        prompt: 'Meter this.',
      });
      await harness.service.awaitSettled(started.sessionId);

      const assignment = harness.storage.store.assignments.get(seed.assignmentId);
      expect(assignment?.tokensUsed).toBe(120);
      // The cache counters are still metered — for cost display, not for budget.
      expect(harness.usage.totals(started.sessionId)?.totalTokens).toBe(1320);
    } finally {
      harness.close();
    }
  });

  it('applies neither the usage rows nor the assignment total when the transaction aborts', () => {
    const harness = makeHarness({ dataRoot: dataRoot() });
    try {
      const seed = harness.seed();
      const session = harness.sessions.enqueue({
        assignmentId: seed.assignmentId,
        agentId: seed.agentId,
        projectId: seed.projectId,
        prompt: 'Meter this.',
      });

      const usage = createUsageRepository({
        db: harness.storage.db,
        assignments: {
          addTokensUsed: () => {
            throw new Error('the assignment update failed');
          },
        },
        clock: () => new Date('2026-08-16T10:00:00.000Z'),
      });

      expect(() =>
        usage.recordDelta({
          sessionId: session.id,
          assignmentId: seed.assignmentId,
          runId: 'run-1',
          delta: {
            source: 'turn',
            messageId: 'msg_1',
            model: MODEL,
            tokens: { input: 10, output: 5, cacheRead: 0, cacheCreation: 0 },
          },
        }),
      ).toThrow('the assignment update failed');

      // Neither side: the event row and the rollup went back with it.
      expect(usage.eventSums(session.id).events).toBe(0);
      expect(usage.totals(session.id)).toBeUndefined();
      expect(harness.storage.store.assignments.get(seed.assignmentId)?.tokensUsed).toBe(0);
    } finally {
      harness.close();
    }
  });
});

describe('cost is an estimate, and is labelled as one (M4, §7.3)', () => {
  it('surfaces cost_usd through the API as costUsdEstimate', async () => {
    const messages = [
      fakeInit(),
      fakeAssistant({ messageId: 'msg_cost', usage: { input: 100, output: 20 } }),
      fakeResult({ modelUsage: { [MODEL]: { input: 100, output: 20 } }, costUsd: 0.25 }),
      fakeSessionStateChanged('idle'),
    ];
    const harness = makeLaunchHarness({
      dataRoot: dataRoot(),
      query: scriptedQuery({ messages }).query,
    });
    try {
      const sessionId = await runSession(harness);
      const response = await harness.call('GET', '/api/sessions/:id', {
        params: { id: sessionId },
      });

      expect(response.status).toBe(200);
      const usage = response.body['usage'] as Record<string, unknown>;
      expect(usage['costUsdEstimate']).toBeCloseTo(0.25, 6);
      // Nothing on the payload can be read as spend.
      expect(JSON.stringify(usage)).not.toContain('"costUsd"');
    } finally {
      harness.close();
    }
  });

  it('leaves cost_usd null when no result has reported an estimate', () => {
    const harness = makeHarness({ dataRoot: dataRoot() });
    try {
      const seed = harness.seed();
      const session = harness.sessions.enqueue({
        assignmentId: seed.assignmentId,
        agentId: seed.agentId,
        projectId: seed.projectId,
        prompt: 'Meter this.',
      });
      harness.usage.recordDelta({
        sessionId: session.id,
        assignmentId: seed.assignmentId,
        runId: 'run-1',
        delta: {
          source: 'turn',
          messageId: 'msg_1',
          model: MODEL,
          tokens: { input: 10, output: 5, cacheRead: 0, cacheCreation: 0 },
        },
      });

      expect(harness.usage.totals(session.id)?.costUsdEstimate).toBeNull();
    } finally {
      harness.close();
    }
  });
});

describe('metering survives a restart (M4)', () => {
  it('does not double-count on any subsequent read after the process is killed', async () => {
    const messages = [
      fakeInit(),
      fakeAssistant({ messageId: 'msg_x', usage: { input: 100, output: 20 } }),
      fakeResult({ modelUsage: { [MODEL]: { input: 140, output: 30 } }, costUsd: 0.4 }),
      fakeSessionStateChanged('idle'),
    ];
    const harness = makeLaunchHarness({
      dataRoot: dataRoot(),
      query: scriptedQuery({ messages }).query,
    });
    let sessionId: string;
    try {
      sessionId = await runSession(harness);
      const before = harness.usage.totals(sessionId);
      expect(before?.inputTokens).toBe(140);
      // Reading twice in one life must not move it either — the rollup is
      // stored, never recomputed from the stream.
      expect(harness.usage.totals(sessionId)).toEqual(before);
    } finally {
      harness.close();
    }

    // The kill: a brand-new process over the same data root.
    const reopened = openTestStorage(dataRoot());
    try {
      const usage = createUsageRepository({
        db: reopened.db,
        assignments: reopened.store.assignments,
        clock: () => new Date('2026-08-16T11:00:00.000Z'),
      });
      const totals = usage.totals(sessionId);
      expect(totals?.inputTokens).toBe(140);
      expect(totals?.outputTokens).toBe(30);
      expect(usage.eventSums(sessionId).input).toBe(140);
      expect(usage.eventSums(sessionId).events).toBe(totals?.events);
      expect(totals?.costUsdEstimate).toBeCloseTo(0.4, 6);
    } finally {
      reopened.close();
    }
  });
});

// ---------------------------------------------------------------------------
// SDK-NOTES C1 — the per-run baseline, driven through the meter directly
// ---------------------------------------------------------------------------

function resultFacts(options: Parameters<typeof fakeResult>[0]): ResultFacts {
  return readResult(fakeResult(options));
}

describe('the reconciliation baseline is a run, not a session (M4, SDK-NOTES C1)', () => {
  it('adds a resumed run’s usage instead of shrinking the rollup to it', () => {
    const harness = makeHarness({ dataRoot: dataRoot() });
    try {
      const seed = harness.seed();
      const session = harness.sessions.enqueue({
        assignmentId: seed.assignmentId,
        agentId: seed.agentId,
        projectId: seed.projectId,
        prompt: 'Meter this.',
      });

      const first = createRunMeter({
        usage: harness.usage,
        sessionId: session.id,
        assignmentId: seed.assignmentId,
        runId: 'run-1',
      });
      first.recordResult(
        resultFacts({ modelUsage: { [MODEL]: { input: 100, output: 50 } }, costUsd: 1 }),
      );
      expect(harness.usage.totals(session.id)?.inputTokens).toBe(100);

      // §9.4's pause/resume: the same session row, a new `query()` call, and a
      // `modelUsage` that has restarted from zero.
      const second = createRunMeter({
        usage: harness.usage,
        sessionId: session.id,
        assignmentId: seed.assignmentId,
        runId: 'run-2',
      });
      second.recordResult(
        resultFacts({ modelUsage: { [MODEL]: { input: 40, output: 20 } }, costUsd: 0.5 }),
      );

      const totals = harness.usage.totals(session.id);
      expect(totals?.inputTokens).toBe(140);
      expect(totals?.outputTokens).toBe(70);
      expect(totals?.turns).toBe(2);
      // Cost is Σ over runs of that run's latest total, never the last result's.
      expect(totals?.costUsdEstimate).toBeCloseTo(1.5, 6);
      expect(harness.storage.store.assignments.get(seed.assignmentId)?.tokensUsed).toBe(210);
    } finally {
      harness.close();
    }
  });

  it('refuses a negative delta rather than clamping it', () => {
    const harness = makeHarness({ dataRoot: dataRoot() });
    try {
      const seed = harness.seed();
      const session = harness.sessions.enqueue({
        assignmentId: seed.assignmentId,
        agentId: seed.agentId,
        projectId: seed.projectId,
        prompt: 'Meter this.',
      });
      const meter = createRunMeter({
        usage: harness.usage,
        sessionId: session.id,
        assignmentId: seed.assignmentId,
        runId: 'run-1',
      });

      meter.recordResult(
        resultFacts({ modelUsage: { [MODEL]: { input: 100, output: 50 } }, costUsd: 1 }),
      );
      // The same run reporting *less* than it already has can only mean the run
      // boundary was missed — which is the one thing the assertion exists for.
      expect(() =>
        meter.recordResult(
          resultFacts({ modelUsage: { [MODEL]: { input: 40, output: 20 } }, costUsd: 1 }),
        ),
      ).toThrow(NegativeUsageDeltaError);

      // Nothing was written by the refused turn.
      expect(harness.usage.totals(session.id)?.inputTokens).toBe(100);
      expect(harness.usage.totals(session.id)?.turns).toBe(1);
    } finally {
      harness.close();
    }
  });

  it('skips an all-zero modelUsage rather than correcting down to zero', () => {
    const harness = makeHarness({ dataRoot: dataRoot() });
    try {
      const seed = harness.seed();
      const session = harness.sessions.enqueue({
        assignmentId: seed.assignmentId,
        agentId: seed.agentId,
        projectId: seed.projectId,
        prompt: 'Meter this.',
      });
      const meter = createRunMeter({
        usage: harness.usage,
        sessionId: session.id,
        assignmentId: seed.assignmentId,
        runId: 'run-1',
      });

      meter.recordResult(
        resultFacts({ modelUsage: { [MODEL]: { input: 100, output: 50 } }, costUsd: 1 }),
      );
      // C1: "crash/startup-error results may carry zeroed usage".
      meter.recordResult(
        resultFacts({
          subtype: 'error_during_execution',
          modelUsage: { [MODEL]: { input: 0, output: 0, costUsd: 0 } },
          costUsd: 0,
        }),
      );

      const totals = harness.usage.totals(session.id);
      expect(totals?.inputTokens).toBe(100);
      expect(totals?.outputTokens).toBe(50);
      expect(totals?.costUsdEstimate).toBeCloseTo(1, 6);
      // The turn still happened, so it is still counted.
      expect(totals?.turns).toBe(2);
    } finally {
      harness.close();
    }
  });

  it('treats an unkeyed or empty assistant message as nothing to meter', () => {
    const harness = makeHarness({ dataRoot: dataRoot() });
    try {
      const seed = harness.seed();
      const session = harness.sessions.enqueue({
        assignmentId: seed.assignmentId,
        agentId: seed.agentId,
        projectId: seed.projectId,
        prompt: 'Meter this.',
      });
      const meter = createRunMeter({
        usage: harness.usage,
        sessionId: session.id,
        assignmentId: seed.assignmentId,
        runId: 'run-1',
      });

      expect(meter.recordAssistantMessage(fakeAssistant({ usage: ZERO_TOKENS }))).toBeUndefined();
      expect(harness.usage.totals(session.id)).toBeUndefined();
    } finally {
      harness.close();
    }
  });
});
