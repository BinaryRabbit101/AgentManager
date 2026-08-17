/**
 * The status pill's six words, and where they come from until orchestrator M9
 * (DESIGN §5.2, IMPLEMENTATION §2).
 *
 * "The board derives the same six-word vocabulary from `session.*` events …
 * and swaps to the endpoint behind one accessor when it ships. The rendering,
 * the words and the tests do not change — only where the value is read."
 *
 * These tests are written to that promise: they assert the *words*, never the
 * derivation path, so the day `GET /api/orchestrator/status` lands they keep
 * passing against the endpoint's values with nothing edited.
 */

import { describe, expect, it } from 'vitest';

import { FLEET_STATES, type EventFrame, type FleetState } from '../api/types';

import {
  applySessionEvent,
  EMPTY_FLEET_STATUS,
  FLEET_STATE_LABELS,
  NEEDS_ATTENTION_STATES,
  statusFor,
  WORKING_STATES,
} from './fleetStatus';

function frame(
  type: string,
  options: {
    readonly agentId?: string;
    readonly payload?: unknown;
    readonly ids?: Record<string, string>;
    readonly ts?: string;
  } = {},
): EventFrame {
  return {
    ts: options.ts ?? '2026-08-17T09:00:00.000Z',
    type,
    ids: { ...(options.agentId === undefined ? {} : { agentId: options.agentId }), ...options.ids },
    payload: options.payload,
    persist: true,
  };
}

function stateAfter(type: string, payload?: unknown): FleetState {
  const map = applySessionEvent(EMPTY_FLEET_STATUS, frame(type, { agentId: 'priya', payload }));
  return statusFor(map, 'priya').state;
}

describe('the vocabulary is orchestrator’s, verbatim (§16.6)', () => {
  it('is exactly six words, and every one has a label', () => {
    expect([...FLEET_STATES]).toEqual([
      'idle',
      'queued',
      'working',
      'awaiting_user',
      'paused',
      'halted',
    ]);
    for (const state of FLEET_STATES) {
      expect(FLEET_STATE_LABELS[state], state).toBeTruthy();
    }
    // Colour is never the only carrier (§15): the word is what is rendered.
    expect(FLEET_STATE_LABELS.awaiting_user).toBe('awaiting user');
  });

  it('an agent nothing has been heard about is idle, not blank', () => {
    const status = statusFor(EMPTY_FLEET_STATUS, 'nobody');
    expect(status.state).toBe('idle');
    expect(status.headline).toBeNull();
    expect(status.sessionId).toBeNull();
  });
});

describe('deriving the six words from session lifecycle (M2’s deliberate degrade)', () => {
  it('maps each lifecycle event onto its word', () => {
    expect(stateAfter('session.queued')).toBe('queued');
    expect(stateAfter('session.started')).toBe('working');
    expect(stateAfter('session.resumed')).toBe('working');
    expect(stateAfter('session.paused')).toBe('paused');
    expect(stateAfter('session.ended')).toBe('idle');
  });

  it('a park on a question is awaiting_user, not paused', () => {
    // runner §11.1: `paused` with `exit_reason: awaiting_answer` is the one
    // pause the user has to do something about.
    expect(stateAfter('session.paused', { exitReason: 'awaiting_answer' })).toBe('awaiting_user');
    expect(stateAfter('session.paused', { reason: 'awaiting_answer' })).toBe('awaiting_user');
  });

  it('a budget halt is halted, whether it paused or ended', () => {
    expect(stateAfter('session.paused', { exitReason: 'budget_halt' })).toBe('halted');
    expect(stateAfter('session.ended', { exitReason: 'budget_halt' })).toBe('halted');
  });

  it('an orphaned session is halted, because something has to be done about it', () => {
    expect(stateAfter('session.orphaned')).toBe('halted');
  });

  it('carries the headline, the project and the session through', () => {
    const map = applySessionEvent(
      EMPTY_FLEET_STATUS,
      frame('session.started', {
        agentId: 'priya',
        ids: { projectId: 'lpm', sessionId: '01SESSION' },
        payload: { summary: 'Reproducing the 500 on /invoices' },
        ts: '2026-08-17T10:30:00.000Z',
      }),
    );
    expect(statusFor(map, 'priya')).toEqual({
      agentId: 'priya',
      state: 'working',
      headline: 'Reproducing the 500 on /invoices',
      since: '2026-08-17T10:30:00.000Z',
      projectId: 'lpm',
      sessionId: '01SESSION',
    });
  });

  it('is keyed by agent, so the newest event is what the card shows', () => {
    let map = applySessionEvent(EMPTY_FLEET_STATUS, frame('session.started', { agentId: 'priya' }));
    map = applySessionEvent(map, frame('session.started', { agentId: 'sam' }));
    map = applySessionEvent(map, frame('session.ended', { agentId: 'priya' }));
    expect(statusFor(map, 'priya').state).toBe('idle');
    expect(statusFor(map, 'sam').state).toBe('working');
  });

  it('ignores an event with no agent, and one that is not lifecycle', () => {
    expect(applySessionEvent(EMPTY_FLEET_STATUS, frame('session.started'))).toBe(
      EMPTY_FLEET_STATUS,
    );
    expect(
      applySessionEvent(EMPTY_FLEET_STATUS, frame('roster.changed', { agentId: 'priya' })),
    ).toBe(EMPTY_FLEET_STATUS);
  });

  it('is pure — the previous map is never mutated', () => {
    const before = applySessionEvent(
      EMPTY_FLEET_STATUS,
      frame('session.started', { agentId: 'priya' }),
    );
    const after = applySessionEvent(before, frame('session.ended', { agentId: 'priya' }));
    expect(statusFor(before, 'priya').state).toBe('working');
    expect(statusFor(after, 'priya').state).toBe('idle');
  });
});

describe('the filter sets (§5.1)', () => {
  it('"working now" is the two busy words and "needs attention" the two blocked ones', () => {
    expect([...WORKING_STATES]).toEqual(['queued', 'working']);
    expect([...NEEDS_ATTENTION_STATES]).toEqual(['awaiting_user', 'halted']);
    for (const state of [...WORKING_STATES, ...NEEDS_ATTENTION_STATES]) {
      expect(FLEET_STATES, state).toContain(state);
    }
  });
});
