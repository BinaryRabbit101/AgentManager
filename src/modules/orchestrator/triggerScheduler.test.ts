/**
 * WO8's acceptance list for the trigger scheduler (DESIGN §2.8).
 *
 * Every test here drives `fire()` or `tick()` by hand against real storage. The
 * clock is the harness's advanceable one and the timers are fake, so nothing
 * sleeps and nothing depends on how long a test took to run.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  aTemplate,
  flush,
  makeHarness,
  repoRoot,
  PROJECT_ID,
  type Harness,
} from './__tests__/helpers.js';
import { ORCHESTRATOR_CONFIG_DEFAULTS, type OrchestratorConfig } from './config.js';
import type { TriggerView } from './triggerScheduler.js';

let harness: Harness | undefined;

afterEach(() => {
  harness?.cleanup();
  harness = undefined;
});

function make(options: Parameters<typeof makeHarness>[0] = {}): Harness {
  harness = makeHarness({
    agents: [
      { id: 'ada', roles: ['implementer'] },
      { id: 'sam', roles: ['skeptic'] },
    ],
    ...options,
  });
  return harness;
}

function aTrigger(
  fixture: Harness,
  overrides: Partial<Parameters<Harness['triggers']['create']>[0]> = {},
): TriggerView {
  return fixture.triggers.create({
    projectId: PROJECT_ID,
    templateId: 'todo-ticket-replies',
    agentIds: ['ada'],
    everyMinutes: 60,
    ...overrides,
  });
}

/** §10's channel switched on, as `edition.home.json` switches it on. */
function notifying(): Partial<OrchestratorConfig> {
  return { notify: { ...ORCHESTRATOR_CONFIG_DEFAULTS.notify, enabled: true } };
}

/** Every `trigger.*` event the bus saw, in order. */
function triggerEvents(fixture: Harness): readonly { type: string; reason: unknown }[] {
  return fixture.events
    .filter((event) => event.type.startsWith('trigger.'))
    .map((event) => ({
      type: event.type,
      reason: (event.payload as { reason?: unknown } | undefined)?.reason ?? null,
    }));
}

// ---------------------------------------------------------------------------

describe('a green fire (§2.8)', () => {
  it('creates an assignment with origin: trigger and starts it like a Start-work launch', async () => {
    const fixture = make();
    const trigger = aTrigger(fixture, { variables: { source: 'the todo list' } });

    const result = await fixture.triggers.fire(trigger.id);
    await flush();

    expect(result.outcome).toBe('fired');
    expect(result.assignmentId).toBeDefined();

    const assignment = fixture.service.get(result.assignmentId as string);
    expect(assignment.origin).toBe('trigger');
    expect(assignment.triggerId).toBe(trigger.id);
    // WO5's provenance still rides alongside: the template is what ran, the
    // trigger is what started it, and the two answer different questions.
    expect(assignment.templateId).toBe('todo-ticket-replies');
    // The variables filled the template's placeholders, and the standing quiet-run
    // line came through untouched.
    expect(assignment.goal).toContain('the todo list');
    expect(assignment.goal).toContain('report done immediately');

    // A session was launched — a solo has no driver, so a trigger that created
    // the row without starting it would be a row that never runs.
    expect(fixture.runner.started).toHaveLength(1);
    expect(triggerEvents(fixture)).toEqual([{ type: 'trigger.fired', reason: null }]);
  });

  it('enters the runner queue in the background band, never the owner’s (§2, D2)', async () => {
    const fixture = make();
    await fixture.triggers.fire(aTrigger(fixture).id);
    await flush();

    expect(fixture.runner.started[0]?.priority).toBe('background');
  });

  it('arms the next fire one interval on', async () => {
    const fixture = make();
    const trigger = aTrigger(fixture, { everyMinutes: 90 });
    await fixture.triggers.fire(trigger.id);

    const after = fixture.triggers.get(trigger.id);
    expect(after.lastFiredAt).toBe(fixture.now().toISOString());
    expect(Date.parse(after.nextFireAt as string) - fixture.now().getTime()).toBe(90 * 60_000);
  });
});

describe('singleflight (§2.8)', () => {
  it('skips with reason still-running and writes no second assignment', async () => {
    const fixture = make();
    const trigger = aTrigger(fixture);

    const first = await fixture.triggers.fire(trigger.id);
    await flush();
    expect(first.outcome).toBe('fired');

    const second = await fixture.triggers.fire(trigger.id);
    expect(second).toMatchObject({ outcome: 'skipped', reason: 'still-running' });
    expect(fixture.service.list({ projectId: PROJECT_ID })).toHaveLength(1);
    expect(triggerEvents(fixture)).toEqual([
      { type: 'trigger.fired', reason: null },
      { type: 'trigger.skipped', reason: 'still-running' },
    ]);
  });

  it('fires again once the previous run has closed', async () => {
    const fixture = make();
    const trigger = aTrigger(fixture);
    const first = await fixture.triggers.fire(trigger.id);
    await flush();
    await fixture.service.closeAssignment(first.assignmentId as string, 'converged');

    const second = await fixture.triggers.fire(trigger.id);
    expect(second.outcome).toBe('fired');
  });
});

describe('unattended-strict preflight (§2.8)', () => {
  it('blocks on a needs-auth connector, notifies, and writes no assignment', async () => {
    const fixture = make({
      // §10's channel is off in the shipped config; a trigger that could not
      // tell anybody it was blocked is the whole failure this pushes against,
      // so the fixture turns it on the way `edition.home.json` does.
      config: notifying(),
      preflight: {
        integrations: {
          ada: [
            {
              integration: 'gmail',
              state: 'needs-auth',
              required: true,
              detail: 'the OAuth grant has not been made',
            },
          ],
        },
      },
    });

    const trigger = aTrigger(fixture);
    const result = await fixture.triggers.fire(trigger.id);
    await flush();

    expect(result).toMatchObject({ outcome: 'blocked', reason: 'connector-needs-auth:gmail' });
    expect(fixture.service.list({ projectId: PROJECT_ID })).toHaveLength(0);
    expect(fixture.triggers.get(trigger.id).lastOutcomeReason).toBe('connector-needs-auth:gmail');
    expect(fixture.posts).toHaveLength(1);
    expect(fixture.posts[0]?.body).toContain('connector-needs-auth:gmail');
    expect(triggerEvents(fixture)).toEqual([
      { type: 'trigger.blocked', reason: 'connector-needs-auth:gmail' },
    ]);
  });

  it('succeeds on Run now once the connector is authenticated', async () => {
    // The projection is read *at fire time*, so the fixture is a mutable table
    // rather than a constant: authenticating changes what roster answers, and
    // nothing about the trigger row changes at all.
    const gmail: { state: 'ready' | 'needs-auth' } = { state: 'needs-auth' };
    const integrations: Record<
      string,
      { integration: string; state: 'ready' | 'needs-auth'; required: boolean; detail: string }[]
    > = { ada: [{ integration: 'gmail', state: gmail.state, required: true, detail: '' }] };
    const fixture = make({ preflight: { integrations } });
    const trigger = aTrigger(fixture);
    expect((await fixture.triggers.fire(trigger.id)).outcome).toBe('blocked');

    integrations['ada'] = [{ integration: 'gmail', state: 'ready', required: true, detail: '' }];
    const rerun = await fixture.triggers.fire(trigger.id);
    await flush();
    expect(rerun.outcome).toBe('fired');
  });

  it('blocks on a tool the run would have to stop and ask about', async () => {
    const fixture = make({
      preflight: { gateLiable: { ada: [{ tool: 'Bash', remembered: false }] } },
    });
    const result = await fixture.triggers.fire(aTrigger(fixture).id);
    expect(result).toMatchObject({ outcome: 'blocked', reason: 'permission-gate:Bash' });
  });

  it('does not block on a gate the template already pre-grants (WO4 §2)', async () => {
    const fixture = make({
      preflight: {
        templates: [aTemplate({ preGrantTools: ['Bash'] })],
        gateLiable: { ada: [{ tool: 'Bash', remembered: false }] },
      },
    });
    expect((await fixture.triggers.fire(aTrigger(fixture).id)).outcome).toBe('fired');
  });

  it('does not block on a gate roster already remembers an answer for', async () => {
    const fixture = make({
      preflight: { gateLiable: { ada: [{ tool: 'Bash', remembered: true }] } },
    });
    expect((await fixture.triggers.fire(aTrigger(fixture).id)).outcome).toBe('fired');
  });

  it('blocks when the template is gone rather than failing to list', async () => {
    const fixture = make();
    const trigger = aTrigger(fixture, { templateId: 'a-template-somebody-deleted' });
    expect(await fixture.triggers.fire(trigger.id)).toMatchObject({
      outcome: 'blocked',
      reason: 'template-missing',
    });
    // The row is still readable, which is the point: a schedule you cannot see
    // is a schedule you cannot switch off.
    expect(fixture.triggers.get(trigger.id).lastOutcome).toBe('blocked');
  });

  it('blocks when this build’s roster cannot answer the preflight at all', async () => {
    const fixture = make({ withoutPreflight: true });
    expect(await fixture.triggers.fire(aTrigger(fixture).id)).toMatchObject({
      outcome: 'blocked',
    });
    expect(fixture.service.list({ projectId: PROJECT_ID })).toHaveLength(0);
  });

  it('blocks when the project has been archived under the schedule', async () => {
    const fixture = make();
    const trigger = aTrigger(fixture);
    fixture.projects.setStatus(PROJECT_ID, 'archived');
    expect(await fixture.triggers.fire(trigger.id)).toMatchObject({
      outcome: 'blocked',
      reason: 'project-archived',
    });
  });
});

describe('the caps (§2.8)', () => {
  it('honours maxRunsPerDay', async () => {
    const fixture = make();
    const trigger = aTrigger(fixture, { maxRunsPerDay: 1 });

    const first = await fixture.triggers.fire(trigger.id);
    await flush();
    await fixture.service.closeAssignment(first.assignmentId as string, 'converged');

    expect(await fixture.triggers.fire(trigger.id)).toMatchObject({
      outcome: 'skipped',
      reason: 'daily-cap',
    });
    expect(fixture.service.list({ projectId: PROJECT_ID })).toHaveLength(1);
  });

  it('skips everything while the global kill switch is off, and disables nothing', async () => {
    const fixture = make({
      config: { triggers: { enabled: false, maxConsecutiveFailures: 3, tickMs: 60_000 } },
    });
    const trigger = aTrigger(fixture);

    expect(await fixture.triggers.fire(trigger.id)).toMatchObject({
      outcome: 'skipped',
      reason: 'triggers-disabled',
    });
    expect(fixture.triggers.get(trigger.id).enabled).toBe(true);
    expect(await fixture.triggers.tick()).toEqual([]);
  });

  it('only fires what is due, and never a trigger outside its window', async () => {
    const fixture = make();
    // Armed for an hour's time: the tick must not reach it.
    aTrigger(fixture);
    expect(await fixture.triggers.tick()).toEqual([]);

    fixture.advance(61 * 60_000);
    const fired = await fixture.triggers.tick();
    await flush();
    expect(fired.map((one) => one.outcome)).toEqual(['fired']);
  });
});

describe('the failure backoff (§2.8)', () => {
  it('disables the trigger after three failed assignments and says so', async () => {
    const fixture = make({ config: notifying() });
    const trigger = aTrigger(fixture);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const fired = await fixture.triggers.fire(trigger.id);
      await flush();
      expect(fired.outcome).toBe('fired');
      await fixture.service.closeAssignment(fired.assignmentId as string, 'failed');
      await flush();
    }

    const disabled = fixture.triggers.get(trigger.id);
    expect(disabled.enabled).toBe(false);
    expect(disabled.nextFireAt).toBeNull();
    expect(disabled.consecutiveFailures).toBe(3);
    expect(triggerEvents(fixture).at(-1)).toEqual({
      type: 'trigger.disabled',
      reason: 'disabled-after-3-failures',
    });
    expect(fixture.posts.some((post) => post.body.includes('failed 3 times in a row'))).toBe(true);
  });

  it('resets the counter on the first assignment that does not fail', async () => {
    const fixture = make();
    const trigger = aTrigger(fixture);

    const first = await fixture.triggers.fire(trigger.id);
    await flush();
    await fixture.service.closeAssignment(first.assignmentId as string, 'failed');
    await flush();
    expect(fixture.triggers.get(trigger.id).consecutiveFailures).toBe(1);

    const second = await fixture.triggers.fire(trigger.id);
    await flush();
    await fixture.service.closeAssignment(second.assignmentId as string, 'converged');
    await flush();
    expect(fixture.triggers.get(trigger.id).consecutiveFailures).toBe(0);
  });

  it('re-arms a re-enabled trigger, so switching it back on is one toggle', () => {
    const fixture = make();
    const trigger = aTrigger(fixture);
    fixture.triggers.update(trigger.id, { enabled: false });
    expect(fixture.triggers.get(trigger.id).nextFireAt).toBeNull();

    const back = fixture.triggers.update(trigger.id, { enabled: true });
    expect(back.nextFireAt).not.toBeNull();
  });
});

describe('across a restart (§2.8)', () => {
  it('collapses a missed window into exactly one catch-up run', async () => {
    const fixture = make();
    const trigger = aTrigger(fixture);

    // Seven hours pass with the core down; an hourly schedule missed seven fires.
    fixture.advance(7 * 3_600_000);
    const reconciled = fixture.triggers.reconcileOnBoot();
    expect(reconciled.rearmed).toEqual([trigger.id]);

    const first = await fixture.triggers.tick();
    await flush();
    expect(first.map((one) => one.outcome)).toEqual(['fired']);

    // The very next tick has nothing to catch up on — the backfill storm the
    // collapse exists to prevent would show up right here.
    await fixture.service.closeAssignment(first[0]?.assignmentId as string, 'converged');
    expect(await fixture.triggers.tick()).toEqual([]);
    expect(fixture.service.list({ projectId: PROJECT_ID })).toHaveLength(1);
  });

  it('does not bring a future fire forward just because the core restarted', () => {
    const fixture = make();
    const trigger = aTrigger(fixture);
    const armed = fixture.triggers.get(trigger.id).nextFireAt;

    expect(fixture.triggers.reconcileOnBoot().rearmed).toEqual([]);
    expect(fixture.triggers.get(trigger.id).nextFireAt).toBe(armed);
  });
});

describe('the shape of a trigger (§2.8, §11.1)', () => {
  it('refuses a window that neither opens nor closes', () => {
    const fixture = make();
    expect(() => aTrigger(fixture, { activeHours: { from: 8, to: 8 } })).toThrow(/must differ/);
  });

  it('refuses an interval of zero and a cap of zero', () => {
    const fixture = make();
    expect(() => aTrigger(fixture, { everyMinutes: 0 })).toThrow(/everyMinutes/);
    expect(() => aTrigger(fixture, { maxRunsPerDay: 0 })).toThrow(/maxRunsPerDay/);
  });

  it('refuses a trigger with no seats', () => {
    const fixture = make();
    expect(() => aTrigger(fixture, { agentIds: [] })).toThrow(/at least one agent/);
  });

  it('serves the last run so the row can link to it', async () => {
    const fixture = make();
    const trigger = aTrigger(fixture);
    const fired = await fixture.triggers.fire(trigger.id);
    await flush();

    const view = fixture.triggers.get(trigger.id);
    expect(view.lastRun?.assignmentId).toBe(fired.assignmentId);
    expect(view.runsToday).toBe(1);
  });
});

describe('editions do not differ (D6, §2.8)', () => {
  it('ships the same trigger configuration in both editions', () => {
    const home: unknown = JSON.parse(
      readFileSync(resolve(repoRoot, 'config/edition.home.json'), 'utf8'),
    );
    const work: unknown = JSON.parse(
      readFileSync(resolve(repoRoot, 'config/edition.work.json'), 'utf8'),
    );
    // Neither edition overrides `orchestrator.triggers`, so both inherit layer
    // 1's `enabled: true`. Triggers are outbound-only and involve no listener,
    // so an edition fork here would be a fork for its own sake.
    const triggersOf = (config: unknown): unknown =>
      (config as { orchestrator?: { triggers?: unknown } }).orchestrator?.triggers;
    expect(triggersOf(home)).toBeUndefined();
    expect(triggersOf(work)).toBeUndefined();
  });
});
