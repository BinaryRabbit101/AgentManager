/**
 * The arithmetic of *when*, and the `triggers` table (DESIGN §2.8, WO8).
 *
 * Everything interesting about a schedule is a property of two pure functions,
 * so they are tested as functions rather than by waiting an hour for a timer.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Storage } from '../../storage/index.js';

import { makeTempDir, openTestStorage, type TempDir } from './__tests__/helpers.js';
import {
  createTriggerRepository,
  intoActiveHours,
  nextFireAfter,
  recomputedNextFire,
  startOfLocalDay,
  withinActiveHours,
  type TriggerRepository,
  type TriggerRow,
} from './triggers.js';

/** A local-time date, so the window assertions read the way the owner states them. */
function at(hour: number, minute = 0, day = 16): Date {
  return new Date(2026, 7, day, hour, minute, 0, 0);
}

describe('active hours (§2.8)', () => {
  it('treats a null window as always', () => {
    expect(withinActiveHours(at(3), null)).toBe(true);
    expect(withinActiveHours(at(23), null)).toBe(true);
  });

  it('is `from` inclusive and `to` exclusive', () => {
    const hours = { from: 8, to: 22 };
    expect(withinActiveHours(at(7, 59), hours)).toBe(false);
    expect(withinActiveHours(at(8), hours)).toBe(true);
    expect(withinActiveHours(at(21, 59), hours)).toBe(true);
    expect(withinActiveHours(at(22), hours)).toBe(false);
  });

  it('reads a `to` before `from` as one window across midnight, not two', () => {
    const overnight = { from: 22, to: 6 };
    expect(withinActiveHours(at(23), overnight)).toBe(true);
    expect(withinActiveHours(at(2), overnight)).toBe(true);
    expect(withinActiveHours(at(6), overnight)).toBe(false);
    expect(withinActiveHours(at(12), overnight)).toBe(false);
  });
});

describe('pushing a fire into its window (§2.8)', () => {
  it('leaves an instant that is already inside alone', () => {
    const inside = at(10, 17);
    expect(intoActiveHours(inside, { from: 8, to: 22 }).getTime()).toBe(inside.getTime());
  });

  it('moves a fire before the window to the hour it opens, the same day', () => {
    expect(intoActiveHours(at(6, 30), { from: 8, to: 22 }).getTime()).toBe(at(8).getTime());
  });

  it('moves a fire after the window to the next day’s opening', () => {
    expect(intoActiveHours(at(23, 5), { from: 8, to: 22 }).getTime()).toBe(at(8, 0, 17).getTime());
  });

  it('adds the interval first, then pushes — so a window opens on the hour', () => {
    // 07:30 + 60 minutes is 08:30, which is inside the window and stays there;
    // 06:30 + 60 minutes is 07:30, which is not, and lands on 08:00 rather than
    // on "whatever multiple of the interval came after it".
    expect(nextFireAfter(at(7, 30), 60, { from: 8, to: 22 }).getTime()).toBe(at(8, 30).getTime());
    expect(nextFireAfter(at(6, 30), 60, { from: 8, to: 22 }).getTime()).toBe(at(8).getTime());
  });

  it('adds the interval and nothing else when there is no window', () => {
    expect(nextFireAfter(at(3), 90, null).getTime()).toBe(at(4, 30).getTime());
  });
});

describe('the boot recomputation (§2.8)', () => {
  function row(overrides: Partial<TriggerRow> = {}): TriggerRow {
    return {
      id: 't1',
      projectId: 'p1',
      templateId: 'todo-ticket-replies',
      agentIds: ['ada'],
      everyMinutes: 60,
      activeHours: null,
      enabled: true,
      variables: {},
      maxRunsPerDay: null,
      lastFiredAt: null,
      nextFireAt: null,
      consecutiveFailures: 0,
      lastOutcome: null,
      lastOutcomeReason: null,
      lastOutcomeAt: null,
      createdAt: '2026-08-16T00:00:00.000Z',
      updatedAt: null,
      ...overrides,
    };
  }

  it('leaves a fire that is still ahead exactly where it was', () => {
    const ahead = at(12).toISOString();
    expect(recomputedNextFire(row({ nextFireAt: ahead }), at(11))).toBe(ahead);
  });

  it('collapses every fire missed while the core was down into one, at now', () => {
    // Down from 08:00 to 15:00 with an hourly schedule is seven missed fires.
    // The row holds one `next_fire_at`, so there is one moment to catch up on —
    // the collapse is structural, and this pins that it is not undone here.
    const recomputed = recomputedNextFire(row({ nextFireAt: at(8).toISOString() }), at(15));
    expect(recomputed).toBe(at(15).toISOString());
  });

  it('lands the catch-up at the window’s opening when now is outside it', () => {
    // Last night's 20:00 fire was missed; the core came back at 03:00, which is
    // outside the window — so the catch-up waits for it to open rather than
    // running an unattended job at three in the morning.
    const recomputed = recomputedNextFire(
      row({ nextFireAt: at(20, 0, 15).toISOString(), activeHours: { from: 8, to: 22 } }),
      at(3),
    );
    expect(recomputed).toBe(at(8).toISOString());
  });

  it('invents a fire for an enabled trigger that has none', () => {
    expect(recomputedNextFire(row({ nextFireAt: null }), at(9))).toBe(at(9).toISOString());
  });

  it('leaves a disabled trigger unarmed', () => {
    expect(recomputedNextFire(row({ enabled: false, nextFireAt: null }), at(9))).toBeNull();
  });
});

describe('the daily boundary (§2.8)', () => {
  it('is local midnight, which is what "runs per day" means to the owner', () => {
    const start = startOfLocalDay(at(23, 45));
    expect(start.getHours()).toBe(0);
    expect(start.getDate()).toBe(16);
  });
});

describe('the triggers table (migration 0007)', () => {
  let dir: TempDir;
  let storage: Storage;
  let repository: TriggerRepository;
  let now = new Date('2026-08-16T10:00:00.000Z');

  beforeEach(() => {
    now = new Date('2026-08-16T10:00:00.000Z');
    dir = makeTempDir('agentmanager-orchestrator-triggers-');
    storage = openTestStorage(dir.path);
    storage.store.projects.create({ id: 'p1', slug: 'p', name: 'P', status: 'active' });
    repository = createTriggerRepository({ db: storage.db, clock: () => now });
  });

  afterEach(() => {
    storage.close();
    dir.cleanup();
  });

  function create(overrides: Partial<Parameters<TriggerRepository['create']>[0]> = {}): TriggerRow {
    return repository.create({
      projectId: 'p1',
      templateId: 'todo-ticket-replies',
      agentIds: ['ada'],
      everyMinutes: 60,
      ...overrides,
    });
  }

  it('round-trips every field, JSON columns included', () => {
    const row = create({
      agentIds: ['ada', 'sam'],
      activeHours: { from: 8, to: 22 },
      variables: { source: 'the todo list' },
      maxRunsPerDay: 12,
      nextFireAt: '2026-08-16T11:00:00.000Z',
    });
    expect(row.agentIds).toEqual(['ada', 'sam']);
    expect(row.activeHours).toEqual({ from: 8, to: 22 });
    expect(row.variables).toEqual({ source: 'the todo list' });
    expect(row.maxRunsPerDay).toBe(12);
    expect(row.enabled).toBe(true);
    expect(row.consecutiveFailures).toBe(0);
    expect(repository.get(row.id)).toEqual(row);
  });

  it('serves only enabled, due triggers to the scheduler, oldest first', () => {
    const due = create({ nextFireAt: '2026-08-16T09:00:00.000Z' });
    const earlier = create({ nextFireAt: '2026-08-16T08:00:00.000Z' });
    create({ nextFireAt: '2026-08-16T23:00:00.000Z' }); // not yet
    create({ nextFireAt: '2026-08-16T09:00:00.000Z', enabled: false }); // switched off
    create({}); // never armed

    expect(repository.due(now.toISOString()).map((row) => row.id)).toEqual([earlier.id, due.id]);
  });

  it('keeps a patch to one field from clearing the others', () => {
    const row = create({ activeHours: { from: 8, to: 22 }, variables: { source: 'x' } });
    const patched = repository.update(row.id, { everyMinutes: 30 });
    expect(patched.everyMinutes).toBe(30);
    expect(patched.activeHours).toEqual({ from: 8, to: 22 });
    expect(patched.variables).toEqual({ source: 'x' });
  });

  it('reads a window back as null when a patch clears it', () => {
    const row = create({ activeHours: { from: 8, to: 22 } });
    expect(repository.update(row.id, { activeHours: null }).activeHours).toBeNull();
  });

  it('records the last outcome so the UI can say why nothing is happening', () => {
    const row = create();
    const marked = repository.recordOutcome(
      row.id,
      'blocked',
      'connector-needs-auth:gmail',
      now.toISOString(),
    );
    expect(marked.lastOutcome).toBe('blocked');
    expect(marked.lastOutcomeReason).toBe('connector-needs-auth:gmail');
  });

  it('does not treat deleting a deleted trigger as an error', () => {
    const row = create();
    expect(repository.remove(row.id)).toBe(true);
    expect(repository.remove(row.id)).toBe(false);
  });
});
