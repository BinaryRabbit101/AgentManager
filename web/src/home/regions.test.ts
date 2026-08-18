/**
 * The home screen's selection rules (DESIGN §2.4, §4).
 *
 * The screen's own test proves what is on it; this proves the three decisions
 * behind it — what counts as finished, how the "last handful" is chosen, and
 * that neither choice reorders what the server sent.
 */

import { describe, expect, it } from 'vitest';

import type { AssignmentPhase, AssignmentView, SessionRecord, SessionStatus } from '../api/types';

import { attentionAssignments, elapsedLabel, recentlyFinished, RECENT_LIMIT } from './regions';

function session(id: string, status: SessionStatus): SessionRecord {
  return {
    id,
    assignmentId: 'asg_1',
    agentId: 'ada',
    projectId: 'lpm',
    status,
    sdkSessionId: null,
    model: null,
    permissionMode: null,
    origin: 'local',
    transcriptPath: null,
    transcriptBytes: 0,
    summary: null,
    pinned: false,
    startedAt: null,
    endedAt: null,
    exitReason: null,
    role: null,
    resumedFrom: null,
    blockedReason: null,
    turns: 0,
  };
}

function assignment(id: string, phase: AssignmentPhase): AssignmentView {
  return {
    id,
    projectId: 'lpm',
    pattern: 'solo',
    status: 'open',
    phase,
    goal: null,
    scope: null,
    write: false,
    createdBy: 'user',
    parentAssignmentId: null,
    leadAgentId: null,
    artifactPath: null,
    tokenBudget: null,
    tokensUsed: 0,
    roundCap: null,
    roundsUsed: 0,
    haltReason: null,
    closeReason: null,
    createdAt: '2026-08-17T09:00:00.000Z',
    updatedAt: null,
    closedAt: null,
    members: [],
  };
}

describe('the recently-finished region (§2.4)', () => {
  it('keeps only the outcomes, in the order the server sent them', () => {
    const found = recentlyFinished([
      session('a', 'running'),
      session('b', 'done'),
      session('c', 'queued'),
      session('d', 'failed'),
      session('e', 'interrupted'),
      session('f', 'orphaned'),
      session('g', 'paused'),
    ]);
    // No sort of its own: `b` came before `d` on the wire and stays there.
    expect(found.map((one) => one.id)).toEqual(['b', 'd', 'e', 'f']);
  });

  it('shows a handful and no more, taken from the head of the list', () => {
    const many = Array.from({ length: 12 }, (_unused, index) =>
      session(`s${String(index)}`, 'done'),
    );
    const found = recentlyFinished(many);
    expect(found).toHaveLength(RECENT_LIMIT);
    // The head, because the list is newest-first (runner §11.1).
    expect(found[0]?.id).toBe('s0');
  });
});

describe('the needs-you region (§2.4, §10.2)', () => {
  it('takes the two phases that mean a person has to act, and no others', () => {
    const found = attentionAssignments([
      assignment('a', 'running'),
      assignment('b', 'halted'),
      assignment('c', 'planned'),
      assignment('d', 'awaiting_user'),
      assignment('e', 'converged'),
    ]);
    expect(found.map((one) => one.id)).toEqual(['b', 'd']);
  });
});

describe('elapsed time is phrased, never formatted (§9.2)', () => {
  const now = Date.parse('2026-08-17T12:00:00.000Z');

  it('says how long in words, at every scale', () => {
    expect(elapsedLabel('2026-08-17T11:59:40.000Z', now)).toBe('just started');
    expect(elapsedLabel('2026-08-17T11:45:00.000Z', now)).toBe('15 min');
    expect(elapsedLabel('2026-08-17T09:30:00.000Z', now)).toBe('2h 30m');
    expect(elapsedLabel('2026-08-15T06:00:00.000Z', now)).toBe('2d 6h');
  });

  it('says nothing rather than NaN when there is no start', () => {
    // A queued session has no `startedAt`; the caller says "waiting for a slot".
    expect(elapsedLabel(null, now)).toBeNull();
    expect(elapsedLabel('not a date', now)).toBeNull();
  });

  it('never runs backwards on a clock that disagrees with the server', () => {
    expect(elapsedLabel('2026-08-17T12:05:00.000Z', now)).toBe('just started');
  });
});
