/**
 * The drag gesture's decisions (DESIGN §5.3; IMPLEMENTATION §3).
 *
 * These are the criteria that are *about* the decision rather than about the
 * pointer: what a drop means, which projects are refused and why, and what the
 * live region says on every target change. Driving them through the pure module
 * is what makes them exact — a geometry-dependent test of the same rules would
 * assert pixels and prove less.
 */

import { describe, expect, it } from 'vitest';

import { aProject } from '../../test/harness';

import {
  agentTarget,
  buildRing,
  cancelled,
  dropOutcome,
  droppedOn,
  overTarget,
  pickedUp,
  projectTarget,
  stepRing,
  workItemTarget,
} from './dnd';

const priya = agentTarget('priya', 'Priya');
const sam = agentTarget('sam', 'Sam');
const lpm = projectTarget(aProject({ id: 'lpm', name: 'littlepocketmuseum' }));

describe('a project that cannot be launched against is not a valid target (§5.3)', () => {
  it('accepts an active, healthy project', () => {
    expect(lpm.refusal).toBeUndefined();
    expect(dropOutcome('priya', lpm)).toEqual({
      kind: 'launch',
      agentId: 'priya',
      projectId: 'lpm',
    });
  });

  it('refuses provisioning, archived and health:missing, each with its own reason', () => {
    const provisioning = projectTarget(
      aProject({ id: 'p', name: 'Cloning', status: 'provisioning' }),
    );
    const archived = projectTarget(aProject({ id: 'a', name: 'Old', status: 'archived' }));
    const missing = projectTarget(
      aProject({
        id: 'm',
        name: 'Gone',
        health: [{ code: 'missing', level: 'error', message: 'C:\\Code\\Gone is gone.' }],
      }),
    );

    expect(provisioning.refusal).toContain('still being set up');
    expect(archived.refusal).toContain('archived');
    expect(missing.refusal).toContain('folder is missing');

    // "Refusing at the drop is better than a launch flow that fails on submit."
    for (const target of [provisioning, archived, missing]) {
      const outcome = dropOutcome('priya', target);
      expect(outcome.kind).toBe('refused');
      if (outcome.kind !== 'refused') throw new Error('unreachable');
      expect(outcome.reason).toContain(target.label);
    }
  });

  it('reads foundation’s archivedAt as well as projects’ status', () => {
    // Both halves are checked server-side for the same reason (projects §2.3): a
    // project archived through foundation keeps `status: 'active'`.
    const target = projectTarget({
      ...aProject({ id: 'x', name: 'Shelved' }),
      archivedAt: '2026-07-01T00:00:00.000Z',
    });
    expect(target.refusal).toContain('archived');
  });
});

describe('what a drop means (§5.3’s table)', () => {
  it('a project opens the launch flow and starts nothing', () => {
    // The outcome names the flow, not a session: "Nothing is started by the drop
    // itself." Nothing in this module can start one — there is no client here.
    expect(dropOutcome('priya', lpm).kind).toBe('launch');
  });

  /**
   * §5.3's rows 3 and 4 describe the same pointer gesture, and Reorder mode is
   * what tells them apart (see `dropOutcome`'s comment). Both are asserted here
   * because the ambiguity is the interesting part, not the two outcomes.
   */
  it('another agent card opens the pair dialog', () => {
    expect(dropOutcome('priya', sam)).toEqual({
      kind: 'pair',
      agentId: 'priya',
      withAgentId: 'sam',
    });
  });

  it('…and reorders the board instead while Reorder mode is on', () => {
    expect(dropOutcome('priya', sam, true)).toEqual({
      kind: 'reorder',
      agentId: 'priya',
      overAgentId: 'sam',
    });
  });

  it('itself and nothing both cancel silently', () => {
    expect(dropOutcome('priya', priya)).toEqual({ kind: 'none' });
    expect(dropOutcome('priya', undefined)).toEqual({ kind: 'none' });
  });
});

describe('the keyboard ring (§5.4)', () => {
  it('is every card then every project, in board order', () => {
    expect(buildRing([priya, sam], [lpm]).map((one) => one.id)).toEqual(['priya', 'sam', 'lpm']);
  });

  it('wraps in both directions, so a keyboard user is never stranded', () => {
    expect(stepRing(3, 2, 1)).toBe(0);
    expect(stepRing(3, 0, -1)).toBe(2);
    expect(stepRing(0, 0, 1)).toBe(0);
  });
});

describe('the live region says the same sentence the floating label does (§5.3, §15)', () => {
  it('announces the pick-up with the keys that work', () => {
    const announcement = pickedUp('Priya');
    expect(announcement).toContain('Priya');
    expect(announcement).toContain('arrow keys');
    expect(announcement).toContain('escape');
  });

  it('reads "Launch Priya on littlepocketmuseum" over a valid project', () => {
    expect(overTarget('Priya', lpm)).toBe('Launch Priya on littlepocketmuseum.');
  });

  it('says why a refused project cannot take the drop', () => {
    const archived = projectTarget(aProject({ id: 'a', name: 'Old', status: 'archived' }));
    const announcement = overTarget('Priya', archived);
    expect(announcement).toContain('Old');
    expect(announcement).toContain("can't be launched on");
    expect(announcement).toContain('archived');
  });

  it('describes an agent target as a pair, and as a move while reordering', () => {
    expect(overTarget('Priya', sam)).toBe('Start a pair: Priya drafting, Sam reviewing.');
    expect(overTarget('Priya', sam, true)).toBe("Move Priya to Sam's place.");
    expect(overTarget('Priya', priya)).toContain('back in its own place');
  });

  it('says nothing was started on a drop and on a cancel', () => {
    expect(droppedOn('Priya', dropOutcome('priya', lpm), 'littlepocketmuseum')).toContain(
      'Nothing has started yet',
    );
    const archived = projectTarget(aProject({ id: 'a', name: 'Old', status: 'archived' }));
    expect(droppedOn('Priya', dropOutcome('priya', archived), 'Old')).toContain(
      'Nothing was started',
    );
    expect(cancelled('Priya')).toContain('stayed where it was');
  });
});

// ---------------------------------------------------------------------------
// The work item row (§5.3 row 2, added with the project page in M7)
// ---------------------------------------------------------------------------

describe('dropping an agent on a work item', () => {
  const open = workItemTarget({
    id: 'w1',
    projectId: 'lpm',
    title: 'Fix the 500 on /invoices',
    status: 'open',
  });

  it('opens the launch flow with the item attached, and starts nothing', () => {
    expect(dropOutcome('priya', open)).toEqual({
      kind: 'launch-work-item',
      agentId: 'priya',
      projectId: 'lpm',
      workItemId: 'w1',
    });
    expect(droppedOn('Priya', dropOutcome('priya', open), open.label)).toContain(
      'Nothing has started yet',
    );
  });

  it('refuses an item the user has already closed, and says which', () => {
    // The same rule an archived project follows: refusing at the drop beats a
    // flow that surprises on submit.
    for (const status of ['done', 'dropped'] as const) {
      const closed = workItemTarget({ id: 'w2', projectId: 'lpm', title: 'Old', status });
      const outcome = dropOutcome('priya', closed);
      expect(outcome.kind).toBe('refused');
      expect(overTarget('Priya', closed)).toContain("can't be launched on");
    }
  });

  it('announces the item by name while it is under the cursor', () => {
    expect(overTarget('Priya', open)).toBe(
      'Launch Priya on the work item “Fix the 500 on /invoices”.',
    );
  });

  it('sits after the projects in the keyboard ring', () => {
    // The arrows walk cards, then projects, then work items — one deterministic
    // order on every viewport, which is what the live region reads out.
    expect(buildRing([priya], [lpm], [open]).map((target) => target.id)).toEqual([
      'priya',
      'lpm',
      'w1',
    ]);
  });
});
