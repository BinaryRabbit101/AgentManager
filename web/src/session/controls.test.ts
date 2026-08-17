/**
 * The control table (DESIGN §9.3; runner §11.1; IMPLEMENTATION §4).
 *
 * "A control that does not apply is **shown disabled with the reason**, not
 * hidden" — so the assertion that matters most is the boring one: for every
 * status, every disabled control carries a reason, and the *only* control ever
 * hidden is Resume on an `awaiting_answer` park.
 */

import { describe, expect, it } from 'vitest';

import { SESSION_STATUSES } from './statuses';

import { controlStates, isAwaitingAnswer, SESSION_CONTROLS } from './controls';

function byName(status: (typeof SESSION_STATUSES)[number], exitReason: string | null = null) {
  return new Map(controlStates(status, exitReason, false).map((one) => [one.control, one]));
}

describe('every disabled control carries its reason (§9.3)', () => {
  it('holds for all seven statuses and all seven controls', () => {
    for (const status of SESSION_STATUSES) {
      const states = controlStates(status, null, false);
      expect(states.map((one) => one.control)).toEqual([...SESSION_CONTROLS]);
      for (const state of states) {
        if (state.enabled) {
          expect(state.reason, `${status}/${state.control}`).toBeUndefined();
        } else {
          expect(state.reason, `${status}/${state.control}`).toBeTruthy();
        }
      }
    }
  });

  it('says "resume first" rather than just greying Steer on a paused session', () => {
    const steer = byName('paused').get('steer');
    expect(steer?.enabled).toBe(false);
    expect(steer?.reason).toBe('paused sessions can’t be steered; resume first');
  });

  it('offers Pin always — it is the retention exemption, not a state verb', () => {
    for (const status of SESSION_STATUSES) {
      expect(byName(status).get('pin')?.enabled, status).toBe(true);
    }
    expect(controlStates('running', null, false).at(-1)?.label).toBe('Keep this transcript');
    expect(controlStates('running', null, true).at(-1)?.label).toBe('Unpin transcript');
  });
});

describe('which controls apply, per runner’s §11.1 table', () => {
  it('Steer and Pause only while running', () => {
    expect(byName('running').get('steer')?.enabled).toBe(true);
    expect(byName('running').get('pause')?.enabled).toBe(true);
    for (const status of ['queued', 'paused', 'done', 'failed', 'orphaned'] as const) {
      expect(byName(status).get('steer')?.enabled, status).toBe(false);
    }
  });

  it('Stop across queued, running and paused, and never after', () => {
    for (const status of ['queued', 'running', 'paused'] as const) {
      expect(byName(status).get('stop')?.enabled, status).toBe(true);
    }
    for (const status of ['done', 'failed', 'interrupted', 'orphaned'] as const) {
      expect(byName(status).get('stop')?.enabled, status).toBe(false);
    }
  });

  it('Relaunch only for an orphaned session', () => {
    expect(byName('orphaned').get('relaunch')?.enabled).toBe(true);
    expect(byName('done').get('relaunch')?.enabled).toBe(false);
  });

  it('Continue is disabled with the reason its route is not in this build', () => {
    // runner's `/continue` is M10. §9.3's shape holds regardless: visible,
    // disabled, saying why — rather than enabled and 404ing.
    const state = byName('done').get('continue');
    expect(state?.enabled).toBe(false);
    expect(state?.hidden).toBe(false);
    expect(state?.reason).toContain('/continue');
  });
});

describe('an awaiting_answer park has no Resume (§9.3, runner §15.1 #7)', () => {
  it('recognises the park', () => {
    expect(isAwaitingAnswer('paused', 'awaiting_answer')).toBe(true);
    expect(isAwaitingAnswer('paused', 'user_paused')).toBe(false);
    expect(isAwaitingAnswer('running', 'awaiting_answer')).toBe(false);
  });

  it('hides Resume rather than disabling it — a second resumer is the bug', () => {
    const parked = byName('paused', 'awaiting_answer').get('resume');
    expect(parked?.hidden).toBe(true);

    // And it is the only control ever hidden, in any state.
    for (const status of SESSION_STATUSES) {
      for (const state of controlStates(status, 'awaiting_answer', false)) {
        if (state.control === 'resume') continue;
        expect(state.hidden, `${status}/${state.control}`).toBe(false);
      }
    }
  });

  it('still offers Resume on an ordinary pause', () => {
    const paused = byName('paused', 'user_paused').get('resume');
    expect(paused?.hidden).toBe(false);
    expect(paused?.enabled).toBe(true);
  });
});
