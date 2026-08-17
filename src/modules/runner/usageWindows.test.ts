/**
 * Usage windows and plan-window honesty (runner IMPLEMENTATION **M11**), one
 * `describe` per acceptance bullet.
 *
 * The acceptance list, restated so each `describe` below can be read against it:
 *
 * 1. the 5-hour and 7-day windows are computed by **indexed queries** over
 *    `usage_events` and **stay correct across a restart**;
 * 2. the response carries `source: 'local-estimate'` and the disclaimer, and
 *    **no field in the payload can be read as "plan remaining"**;
 * 3. a `rate_limit_event` is parsed **permissively** into
 *    `settings['runner.rateLimit.lastEvent']`, a synthetic event with unexpected
 *    fields is stored **without throwing**, and **no scheduling decision changes
 *    as a result of its contents**;
 * 4. **removing `rate_limit_event` handling entirely leaves scheduling behaviour
 *    identical** — asserted by running M5's cool-down suite with the handler
 *    disabled.
 *
 * Everything here is driven through the fake `query` of `__tests__/fakeQuery.ts`
 * or through the real repositories. The one thing that genuinely needs a live
 * account — what the CLI actually emits, and what the experimental usage API
 * returns under subscription auth — is SDK-NOTES **L13**, and it stays where the
 * other live checks are: token-gated, in `__spike__/sdk.spike.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { coolDownSuite } from './__tests__/coolDownSuite.js';
import {
  fakeInit,
  fakeRateLimitEvent,
  fakeResult,
  fakeSessionStateChanged,
  gatedQuery,
  scriptedQuery,
} from './__tests__/fakeQuery.js';
import { makeTempDir, type TempDir } from './__tests__/helpers.js';
import { makeLaunchHarness, type LaunchHarness } from './__tests__/launchHarness.js';
import type { SDKMessage } from './sdk.js';
import {
  RATE_LIMIT_EVENT_SETTING_KEY,
  USAGE_DISCLAIMER,
  WINDOW_5H_MS,
  WINDOW_7D_MS,
  readStoredRateLimitEvent,
  type CliReportedRateLimit,
  type UsageWindows,
} from './usageWindows.js';

let temp: TempDir;

beforeEach(() => {
  temp = makeTempDir('agentmanager-runner-usagewin-');
});

afterEach(() => {
  temp.cleanup();
});

function dataRoot(): string {
  return `${temp.path}\\data`;
}

/** `launchHarness`'s FIXED_NOW — every clock here is pinned to it. */
const NOW = new Date('2026-08-16T10:00:00.000Z');

function ago(ms: number): string {
  return new Date(NOW.getTime() - ms).toISOString();
}

const MODEL = 'claude-sonnet-4-5';

/**
 * A session row with usage deltas at chosen instants.
 *
 * `recordDelta`'s `at` is what makes a window testable at all: the rows have to
 * straddle the cut-off, and waiting five hours is not a test.
 */
function spend(
  harness: LaunchHarness,
  seed: { projectId: string; assignmentId: string; agentId: string },
  deltas: readonly { at: string; input: number; output: number; cache?: number }[],
): string {
  const session = harness.sessions.enqueue({
    assignmentId: seed.assignmentId,
    agentId: seed.agentId,
    projectId: seed.projectId,
    prompt: 'Spend a little.',
  });
  deltas.forEach((delta, index) => {
    harness.usage.recordDelta({
      sessionId: session.id,
      assignmentId: seed.assignmentId,
      runId: 'run-1',
      at: delta.at,
      delta: {
        source: 'turn',
        messageId: `msg_${session.id}_${String(index)}`,
        model: MODEL,
        tokens: {
          input: delta.input,
          output: delta.output,
          cacheRead: delta.cache ?? 0,
          cacheCreation: 0,
        },
      },
    });
  });
  return session.id;
}

/** Runs one session with a scripted message list and settles it. */
async function runWith(harness: LaunchHarness, sessionId: string): Promise<void> {
  await harness.service.awaitSettled(sessionId);
}

async function launch(
  harness: LaunchHarness,
  seed: { projectId: string; assignmentId: string; agentId: string },
): Promise<string> {
  const started = await harness.service.startSession({
    assignmentId: seed.assignmentId,
    agentId: seed.agentId,
    projectId: seed.projectId,
    prompt: 'Report a rate limit.',
  });
  return started.sessionId;
}

/** Every key path in a payload, so a scan can be exhaustive rather than hopeful. */
function keyPaths(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    return [path, ...keyPaths(child, path)];
  });
}

// ---------------------------------------------------------------------------
// Acceptance 1 — indexed windows, correct across a restart
// ---------------------------------------------------------------------------

describe('the rolling windows are indexed queries over usage_events (M11, §7.4)', () => {
  it('sums only the events inside each window and counts the distinct sessions that spent', () => {
    const harness = makeLaunchHarness({ dataRoot: dataRoot(), clock: () => NOW });
    try {
      const seed = harness.seed();
      // Inside both windows.
      spend(harness, seed, [
        { at: ago(60 * 60_000), input: 100, output: 10 },
        { at: ago(30 * 60_000), input: 50, output: 5, cache: 7 },
      ]);
      // Inside 7d only — four hours older than the 5-hour cut-off.
      spend(harness, seed, [{ at: ago(WINDOW_5H_MS + 4 * 60 * 60_000), input: 1000, output: 200 }]);
      // Outside both.
      spend(harness, seed, [{ at: ago(WINDOW_7D_MS + 60_000), input: 999_999, output: 999_999 }]);

      const usage = harness.service.usageWindows();

      expect(usage.own.window5h).toMatchObject({
        since: ago(WINDOW_5H_MS),
        inputTokens: 150,
        outputTokens: 15,
        cacheReadTokens: 7,
        // One session spent inside five hours, across two events.
        sessions: 1,
      });
      expect(usage.own.window7d).toMatchObject({
        since: ago(WINDOW_7D_MS),
        inputTokens: 1150,
        outputTokens: 215,
        sessions: 2,
      });
    } finally {
      harness.close();
    }
  });

  it('reads them through the usage_events_window index rather than scanning the table', () => {
    const harness = makeLaunchHarness({ dataRoot: dataRoot(), clock: () => NOW });
    try {
      const index = harness.storage.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
        .get('usage_events_window') as { name: string } | undefined;
      expect(index?.name).toBe('usage_events_window');

      // The window's own predicate: one range over `ts`, every session. The
      // per-session index is `(session_id, ts)` and cannot serve it — which is
      // the whole reason `0003_usage_windows.sql` exists.
      const plan = harness.storage.db
        .prepare(
          `EXPLAIN QUERY PLAN
           SELECT COUNT(*), COUNT(DISTINCT session_id), SUM(input_tokens), SUM(output_tokens)
           FROM usage_events WHERE ts >= ?`,
        )
        .all(ago(WINDOW_5H_MS)) as { detail: string }[];
      const detail = plan.map((row) => row.detail).join(' | ');
      expect(detail).toContain('usage_events_window');
      expect(detail).not.toContain('SCAN usage_events\n');
    } finally {
      harness.close();
    }
  });

  it('stays correct across a restart, because the windows are derived and never counted', async () => {
    const root = dataRoot();
    let before: UsageWindows;
    const first = makeLaunchHarness({ dataRoot: root, clock: () => NOW });
    try {
      const seed = first.seed();
      spend(first, seed, [
        { at: ago(10 * 60_000), input: 400, output: 40 },
        { at: ago(2 * 24 * 60 * 60_000), input: 7000, output: 700 },
      ]);
      before = first.service.usageWindows();
      expect(before.own.window5h.inputTokens).toBe(400);
      expect(before.own.window7d.inputTokens).toBe(7400);
    } finally {
      first.close();
    }

    // A brand-new process over the same data root: new repositories, new
    // service, no in-memory accumulator that could have survived.
    const second = makeLaunchHarness({ dataRoot: root, clock: () => NOW });
    try {
      expect(second.service.usageWindows().own).toStrictEqual(before.own);
    } finally {
      second.close();
    }
    await Promise.resolve();
  });
});

// ---------------------------------------------------------------------------
// Acceptance 2 — labelled, and unreadable as a plan window
// ---------------------------------------------------------------------------

describe('the response is labelled and cannot be read as a plan window (M11, §7.4)', () => {
  it('carries source: local-estimate and §7.4’s disclaimer, verbatim, over HTTP', async () => {
    const harness = makeLaunchHarness({ dataRoot: dataRoot(), clock: () => NOW });
    try {
      const response = await harness.call('GET', '/api/runner/usage');
      expect(response.status).toBe(200);
      const body = response.body as unknown as UsageWindows;
      expect(body.own.source).toBe('local-estimate');
      expect(body.rateLimit.source).toBe('observed');
      expect(body.rateLimit.cliSource).toBe('cli-reported');
      expect(body.disclaimer).toBe(USAGE_DISCLAIMER);
      // The disclaimer is the API's, not the client's: it must arrive whole.
      expect(body.disclaimer).toContain('Counts AgentManager sessions only.');
      expect(body.disclaimer).toContain('is not visible here.');
    } finally {
      harness.close();
    }
  });

  it('has no field anywhere that can be read as "plan remaining"', async () => {
    const harness = makeLaunchHarness({ dataRoot: dataRoot(), clock: () => NOW });
    try {
      const seed = harness.seed();
      spend(harness, seed, [{ at: ago(60_000), input: 10, output: 1 }]);
      const body = (await harness.call('GET', '/api/runner/usage')).body;

      // No key names a quota, a headroom, or a share of one.
      const paths = keyPaths(body);
      const forbidden =
        /remaining|left|quota|headroom|available|budget|limitTotal|allowance|percent|pct|ratio|share/iu;
      expect(paths.filter((path) => forbidden.test(path))).toEqual([]);

      // …and there is no plan total anywhere to derive one from. Every number
      // in the payload is a token count or a session count of **our own**
      // spend; §7.4's whole argument is that the denominator does not exist.
      const numbers = JSON.stringify(body).match(/:\s*-?\d+(\.\d+)?/gu) ?? [];
      expect(numbers.length).toBeGreaterThan(0);
      expect(Object.keys(body)).toStrictEqual(['own', 'rateLimit', 'disclaimer']);
      expect('plan' in body).toBe(false);
      expect('subscriptionType' in body).toBe(false);
    } finally {
      harness.close();
    }
  });

  it('serves the exact shape the usage screen consumes (ui §12’s RunnerUsage)', async () => {
    const harness = makeLaunchHarness({ dataRoot: dataRoot(), clock: () => NOW });
    try {
      const body = (await harness.call('GET', '/api/runner/usage')).body as unknown as UsageWindows;

      for (const window of [body.own.window5h, body.own.window7d]) {
        expect(typeof window.since).toBe('string');
        expect(typeof window.inputTokens).toBe('number');
        expect(typeof window.outputTokens).toBe('number');
        expect(typeof window.sessions).toBe('number');
        // A parseable instant, because the screen renders "since <t>".
        expect(Number.isNaN(Date.parse(window.since))).toBe(false);
      }
      expect(['ok', 'cooling']).toContain(body.rateLimit.state);
      expect(body.rateLimit.lastHitAt).toBeNull();
      expect(body.rateLimit.resetsAt).toBeNull();
      expect(body.rateLimit.cliReported).toBeNull();
    } finally {
      harness.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Acceptance 3 — permissive capture, and no scheduling consequence
// ---------------------------------------------------------------------------

/** A `rate_limit_event` with fields no parser was written for. */
function synthetic(overrides: Record<string, unknown> = {}): SDKMessage {
  return fakeRateLimitEvent({
    status: 'allowed_warning',
    rateLimitType: 'seven_day_opus',
    utilization: 42.5,
    // Seconds-epoch, which the SDK's own type calls a number and does not
    // otherwise pin.
    resetsAt: Math.floor((NOW.getTime() + 90 * 60_000) / 1000),
    // None of the following exist in the shape runner parses.
    overageStatus: { tier: 'none', nested: { deeper: true } },
    canUserPurchaseCredits: true,
    somethingNobodyHasSeen: [1, 2, 3],
    ...overrides,
  });
}

async function runWithRateLimitEvent(
  harness: LaunchHarness,
  seed: { projectId: string; assignmentId: string; agentId: string },
): Promise<string> {
  const sessionId = await launch(harness, seed);
  await runWith(harness, sessionId);
  return sessionId;
}

function scriptWith(event: SDKMessage): SDKMessage[] {
  return [fakeInit(), event, fakeResult(), fakeSessionStateChanged('idle')];
}

describe('rate_limit_event is captured permissively and decides nothing (M11, §7.4)', () => {
  it('stores a synthetic event with unexpected fields without throwing, keeping only what it recognised', async () => {
    const harness = makeLaunchHarness({
      dataRoot: dataRoot(),
      clock: () => NOW,
      query: scriptedQuery({ messages: scriptWith(synthetic()) }).query,
    });
    try {
      const sessionId = await runWithRateLimitEvent(harness, harness.seed());

      // An unrecognised shape is a display, never a session failure.
      expect(harness.sessions.require(sessionId).status).toBe('done');

      const stored = harness.storage.store.settings.get<CliReportedRateLimit>(
        RATE_LIMIT_EVENT_SETTING_KEY,
      );
      expect(stored).toStrictEqual({
        status: 'allowed_warning',
        rateLimitType: 'seven_day_opus',
        utilization: 42.5,
        resetsAt: new Date(NOW.getTime() + 90 * 60_000).toISOString(),
        observedAt: NOW.toISOString(),
      });
      // The unknown members are dropped rather than stored: a rate-limit notice
      // must not be able to grow the settings row without bound.
      expect(Object.keys(stored ?? {})).toStrictEqual([
        'status',
        'rateLimitType',
        'utilization',
        'resetsAt',
        'observedAt',
      ]);
    } finally {
      harness.close();
    }
  });

  it('stores nulls for fields of the wrong type, and nothing at all when rate_limit_info is not an object', async () => {
    const wrongTypes = makeLaunchHarness({
      dataRoot: `${temp.path}\\wrong`,
      clock: () => NOW,
      query: scriptedQuery({
        messages: scriptWith(
          synthetic({ status: 12_345, rateLimitType: null, utilization: 'lots', resetsAt: 'soon' }),
        ),
      }).query,
    });
    try {
      const sessionId = await runWithRateLimitEvent(wrongTypes, wrongTypes.seed());
      expect(wrongTypes.sessions.require(sessionId).status).toBe('done');
      expect(
        wrongTypes.storage.store.settings.get<CliReportedRateLimit>(RATE_LIMIT_EVENT_SETTING_KEY),
      ).toStrictEqual({
        status: null,
        rateLimitType: null,
        utilization: null,
        resetsAt: null,
        observedAt: NOW.toISOString(),
      });
    } finally {
      wrongTypes.close();
    }

    const malformed = makeLaunchHarness({
      dataRoot: `${temp.path}\\malformed`,
      clock: () => NOW,
      query: scriptedQuery({
        messages: scriptWith(fakeRateLimitEvent(null as unknown as Record<string, unknown>)),
      }).query,
    });
    try {
      const sessionId = await runWithRateLimitEvent(malformed, malformed.seed());
      expect(malformed.sessions.require(sessionId).status).toBe('done');
      // Nothing recognised, so nothing written — which is a different fact from
      // "written as all nulls" and is stored as such.
      expect(malformed.storage.store.settings.has(RATE_LIMIT_EVENT_SETTING_KEY)).toBe(false);
    } finally {
      malformed.close();
    }
  });

  it('reads a settings row of an unrecognised shape back without throwing', () => {
    const harness = makeLaunchHarness({ dataRoot: dataRoot(), clock: () => NOW });
    try {
      // A row an older — or newer — build wrote.
      harness.storage.store.settings.set(RATE_LIMIT_EVENT_SETTING_KEY, {
        utilisation: 'seventy',
        resetsAt: 99,
      });
      expect(readStoredRateLimitEvent(harness.storage.store.settings)).toStrictEqual({
        status: null,
        rateLimitType: null,
        utilization: null,
        resetsAt: null,
        observedAt: '',
      });

      harness.storage.store.settings.set(RATE_LIMIT_EVENT_SETTING_KEY, 'not an object at all');
      expect(readStoredRateLimitEvent(harness.storage.store.settings)).toBeNull();
    } finally {
      harness.close();
    }
  });

  it('makes no scheduling decision from its contents — only from an exhaustion’s presence', async () => {
    /** Runs one session whose only variable is the event's payload. */
    async function schedulingAfter(
      root: string,
      info: Record<string, unknown>,
    ): Promise<{ state: unknown; rateLimited: number; cliReported: CliReportedRateLimit | null }> {
      const harness = makeLaunchHarness({
        dataRoot: root,
        clock: () => NOW,
        query: scriptedQuery({ messages: scriptWith(fakeRateLimitEvent(info)) }).query,
      });
      try {
        await runWithRateLimitEvent(harness, harness.seed());
        return {
          state: harness.service.queueState(),
          rateLimited: harness.events.filter((event) => event.type === 'runner.ratelimited').length,
          cliReported: harness.service.usageWindows().rateLimit.cliReported,
        };
      } finally {
        harness.close();
      }
    }

    // Two events that differ in every number a scheduler could be tempted to
    // read — utilization at the ceiling, a reset an hour out, a different
    // window — and agree only in not being a refusal.
    const alarming = await schedulingAfter(`${temp.path}\\alarming`, {
      status: 'allowed_warning',
      rateLimitType: 'five_hour',
      utilization: 99.9,
      resetsAt: Math.floor((NOW.getTime() + 60 * 60_000) / 1000),
    });
    const calm = await schedulingAfter(`${temp.path}\\calm`, {
      status: 'allowed',
      rateLimitType: 'seven_day',
      utilization: 1,
    });

    expect(alarming.state).toStrictEqual(calm.state);
    expect(alarming.rateLimited).toBe(0);
    expect(calm.rateLimited).toBe(0);
    expect((alarming.state as { cooling: boolean }).cooling).toBe(false);
    // Both were still *recorded* — the display differs even though nothing else does.
    expect(alarming.cliReported?.utilization).toBe(99.9);
    expect(calm.cliReported?.utilization).toBe(1);
  });

  it('reports the captured event under cliReported, beside its own provenance label', async () => {
    const harness = makeLaunchHarness({
      dataRoot: dataRoot(),
      clock: () => NOW,
      query: scriptedQuery({ messages: scriptWith(synthetic()) }).query,
    });
    try {
      await runWithRateLimitEvent(harness, harness.seed());
      const body = (await harness.call('GET', '/api/runner/usage')).body as unknown as UsageWindows;
      expect(body.rateLimit.cliReported).toMatchObject({
        status: 'allowed_warning',
        rateLimitType: 'seven_day_opus',
      });
      // The two provenances never blur: everything outside `cliReported` is
      // ours and `observed`; `cliReported` is the CLI's and best-effort.
      expect(body.rateLimit.source).toBe('observed');
      expect(body.rateLimit.cliSource).toBe('cli-reported');
      // A warning is not a hit: our own classification still says nothing happened.
      expect(body.rateLimit.state).toBe('ok');
      expect(body.rateLimit.lastHitAt).toBeNull();
    } finally {
      harness.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Acceptance 4 — the handler removed changes nothing
// ---------------------------------------------------------------------------

describe('removing rate_limit_event handling leaves scheduling identical (M11)', () => {
  it('neither cools down nor records a thing when observeCliEvent is false', async () => {
    const harness = makeLaunchHarness({
      dataRoot: dataRoot(),
      clock: () => NOW,
      config: { rateLimit: { observeCliEvent: false } },
      query: scriptedQuery({
        // A **refusal** — the one payload §6.4 acts on — offered to a build
        // that is not listening.
        messages: scriptWith(
          fakeRateLimitEvent({
            status: 'rejected',
            rateLimitType: 'five_hour',
            resetsAt: Math.floor((NOW.getTime() + 45 * 60_000) / 1000),
          }),
        ),
      }).query,
    });
    try {
      const sessionId = await runWithRateLimitEvent(harness, harness.seed());
      expect(harness.sessions.require(sessionId).status).toBe('done');
      expect(harness.service.queueState()).toMatchObject({ cooling: false, coolingUntil: null });
      expect(harness.events.filter((event) => event.type === 'runner.ratelimited')).toHaveLength(0);
      expect(harness.storage.store.settings.has(RATE_LIMIT_EVENT_SETTING_KEY)).toBe(false);
      expect(harness.service.usageWindows().rateLimit.cliReported).toBeNull();
    } finally {
      harness.close();
    }
  });

  // The literal M5 suite, re-registered with the handler switched off. It is the
  // same file `scheduler.test.ts` runs, so the two cannot drift apart.
  describe('M5’s cool-down suite, with the handler disabled', () => {
    coolDownSuite({ dataRoot, config: { rateLimit: { observeCliEvent: false } } });
  });
});

// ---------------------------------------------------------------------------
// §7.4's third row — the observed state, the only authoritative one
// ---------------------------------------------------------------------------

describe('the observed rate-limit row (M11, §7.4)', () => {
  it('reports cooling with its lastHitAt and resetsAt, labelled observed', async () => {
    const gate = gatedQuery();
    const harness = makeLaunchHarness({
      dataRoot: dataRoot(),
      clock: () => NOW,
      query: gate.query,
      config: { maxConcurrent: 1, rateLimit: { cooldownMs: 300_000 } },
    });
    try {
      const seed = harness.seed();
      const limited = await launch(harness, seed);
      await gate.started(1);
      gate.sessions[0]?.finish([
        fakeResult({ subtype: 'error_during_execution', terminalReason: 'blocking_limit' }),
        fakeSessionStateChanged('idle'),
      ]);
      await harness.service.awaitSettled(limited);

      const rateLimit = harness.service.usageWindows().rateLimit;
      expect(rateLimit).toStrictEqual({
        state: 'cooling',
        lastHitAt: NOW.toISOString(),
        resetsAt: new Date(NOW.getTime() + 300_000).toISOString(),
        cliReported: null,
        source: 'observed',
        cliSource: 'cli-reported',
      });
    } finally {
      gate.autoFinish();
      harness.close();
    }
  });
});
