/**
 * The event → cache invalidation map (DESIGN §3.4).
 *
 * The interesting entries of §3.4's table, one test each, plus the rule that
 * makes the whole architecture hold: **no screen polls**, so an event type with
 * no entry here is a fact the UI will never notice changed.
 */

import { describe, expect, it } from 'vitest';

import { queryKeys } from '../api/queries';
import type { EventFrame } from '../api/types';

import { PER_SESSION_DETAIL_TYPES, plan, SESSION_LIFECYCLE_TYPES } from './invalidation';

function frame(type: string, extra: Partial<EventFrame> = {}): EventFrame {
  return {
    ts: '2026-08-17T09:00:00.000Z',
    type,
    ids: {},
    payload: undefined,
    persist: true,
    ...extra,
  };
}

describe('the invalidation map (§3.4)', () => {
  it('roster.changed refetches the roster list', () => {
    expect(plan(frame('roster.changed')).invalidate).toEqual([queryKeys.roster]);
  });

  it('roster.changed with reason "avatar" also drops that agent’s object URL', () => {
    const outcome = plan(
      frame('roster.changed', { ids: { agentId: 'priya' }, payload: { reason: 'avatar' } }),
    );
    expect(outcome.avatars).toEqual(['priya']);

    // Any other reason leaves the memo alone — a re-read `agent.json` did not
    // change the face, and revoking the URL would refetch it for nothing.
    expect(
      plan(frame('roster.changed', { ids: { agentId: 'priya' }, payload: { reason: 'edited' } }))
        .avatars,
    ).toEqual([]);
  });

  it('every session lifecycle event is a board fact, and invalidates the projects list', () => {
    for (const type of SESSION_LIFECYCLE_TYPES) {
      const outcome = plan(frame(type));
      expect(outcome.sessionLifecycle, type).toBe(true);
      // Since ui M6 the fleet status is orchestrator's own
      // `GET /api/orchestrator/status` (§2.2's badge reads `questions.open` from
      // it), so a lifecycle event invalidates that too — not just the project
      // list whose `lastActivityAt` moved. `['sessions']` is there because home
      // (§2.4) and the sessions index (§9.5) list sessions *by status*, and a
      // start or an end is precisely a status changing; without it those screens
      // would have to poll, which §16 forbids.
      expect(outcome.invalidate, type).toEqual([
        ['sessions'],
        ['projects'],
        ['orchestrator', 'status'],
      ]);
    }
  });

  it('per-session detail never touches the query cache', () => {
    // §3.4: "append to the per-session ring buffer only (never the query
    // cache)". These should not arrive on the global feed at all (§3.3), and if
    // one does, the plan says so rather than acting on it.
    for (const type of [
      ...PER_SESSION_DETAIL_TYPES,
      'session.tool.started',
      'session.tool.result',
    ]) {
      const outcome = plan(frame(type));
      expect(outcome.perSessionDetail, type).toBe(true);
      expect(outcome.invalidate, type).toEqual([]);
      expect(outcome.sessionLifecycle, type).toBe(false);
    }
  });

  it('question and assignment events invalidate the inbox and the conversation', () => {
    for (const type of [
      'assignment.question.raised',
      'assignment.question.answered',
      'assignment.round.completed',
      'assignment.halted',
    ]) {
      expect(plan(frame(type)).invalidate, type).toEqual([
        ['questions'],
        ['assignments'],
        ['orchestrator', 'status'],
      ]);
    }
  });

  it('project, workspace and clone events invalidate the project list', () => {
    for (const type of [
      'project.created',
      'project.clone.progress',
      'workspace.acquired',
      'project.scope.overlap',
    ]) {
      expect(plan(frame(type)).invalidate, type).toEqual([['projects']]);
    }
  });

  it('a remote grant patches the card as well as the remote panel', () => {
    // §3.4: "patch the card's remote badge live (remote §12.4)".
    expect(plan(frame('remote.agent.access.granted')).invalidate).toEqual([
      ['remote'],
      queryKeys.roster,
    ]);
  });

  it('runner events reach the queue panel', () => {
    expect(plan(frame('runner.queue.changed')).invalidate).toEqual([['runner']]);
    expect(plan(frame('runner.ratelimited')).invalidate).toEqual([['runner']]);
  });

  it('a module restarting re-reads both feature-detection facts (§3.5)', () => {
    expect(plan(frame('service.module.started')).invalidate).toEqual([
      queryKeys.health,
      queryKeys.config,
    ]);
  });

  it('an unmapped type does nothing at all, rather than refetching everything', () => {
    const outcome = plan(frame('something.nobody.mapped'));
    expect(outcome.invalidate).toEqual([]);
    expect(outcome.avatars).toEqual([]);
    expect(outcome.sessionLifecycle).toBe(false);
    expect(outcome.perSessionDetail).toBe(false);
  });
});
