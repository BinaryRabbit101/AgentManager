/**
 * `assignment_turns` and its partial unique index (DESIGN §2.1, §3.2;
 * IMPLEMENTATION M5-2).
 *
 * Against **real storage**, because the whole point of `assignment_turns_active`
 * is that the *database* refuses a second in-flight turn — a fake repository
 * would prove only that this file believes it does.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  boundedUtf8,
  createTurnRepository,
  TurnAlreadyActiveError,
  type TurnRepository,
} from './turns.js';
import { makeTempDir, openTestStorage, type TempDir } from './__tests__/helpers.js';
import type { Storage } from '../../storage/index.js';

let dir: TempDir;
let storage: Storage;
let turns: TurnRepository;
let assignmentId: string;
let otherAssignmentId: string;

beforeEach(() => {
  dir = makeTempDir('agentmanager-orchestrator-turns-');
  storage = openTestStorage(dir.path);
  const project = storage.store.projects.create({ slug: 'p', name: 'P' });
  assignmentId = storage.store.assignments.create({ projectId: project.id, pattern: 'pair' }).id;
  otherAssignmentId = storage.store.assignments.create({
    projectId: project.id,
    pattern: 'pair',
  }).id;
  turns = createTurnRepository({ db: storage.db, clock: () => new Date('2026-08-16T10:00:00Z') });
});

afterEach(() => {
  storage.close();
  dir.cleanup();
});

describe('planning a turn', () => {
  it('inserts a planned row carrying the seat, the round and the previous session', () => {
    const turn = turns.plan({
      assignmentId,
      round: 2,
      seat: 'drafter',
      agentId: 'ada',
      prevSessionId: 'session-1',
    });
    expect(turn).toMatchObject({
      assignmentId,
      round: 2,
      seat: 'drafter',
      agentId: 'ada',
      status: 'planned',
      sessionId: null,
      prevSessionId: 'session-1',
    });
    expect(turns.active(assignmentId)?.id).toBe(turn.id);
  });

  it('refuses a second planned-or-running turn — the index is the guard, not a flag', () => {
    turns.plan({ assignmentId, round: 1, seat: 'drafter', agentId: 'ada' });
    expect(() => turns.plan({ assignmentId, round: 1, seat: 'critic', agentId: 'sam' })).toThrow(
      TurnAlreadyActiveError,
    );

    // Still refused once it is *running* rather than merely planned.
    const active = turns.active(assignmentId);
    turns.start(active?.id ?? '', 'session-1');
    expect(() => turns.plan({ assignmentId, round: 1, seat: 'critic', agentId: 'sam' })).toThrow(
      TurnAlreadyActiveError,
    );
  });

  it('scopes the refusal to one assignment: two assignments each get a turn', () => {
    turns.plan({ assignmentId, round: 1, seat: 'drafter', agentId: 'ada' });
    expect(() =>
      turns.plan({ assignmentId: otherAssignmentId, round: 1, seat: 'drafter', agentId: 'ada' }),
    ).not.toThrow();
  });

  it('admits the next turn once the previous one is complete', () => {
    const first = turns.plan({ assignmentId, round: 1, seat: 'drafter', agentId: 'ada' });
    turns.start(first.id, 'session-1');
    turns.complete(first.id, { status: 'reported' });
    expect(turns.active(assignmentId)).toBeUndefined();
    expect(() =>
      turns.plan({ assignmentId, round: 1, seat: 'critic', agentId: 'sam' }),
    ).not.toThrow();
  });

  it('names the assignment in the refusal, as a 409 rather than a crash', () => {
    turns.plan({ assignmentId, round: 1, seat: 'drafter', agentId: 'ada' });
    try {
      turns.plan({ assignmentId, round: 1, seat: 'critic', agentId: 'sam' });
      expect.unreachable('the index should have refused');
    } catch (error) {
      expect(error).toBeInstanceOf(TurnAlreadyActiveError);
      expect((error as TurnAlreadyActiveError).status).toBe(409);
      expect((error as TurnAlreadyActiveError).code).toBe('turn_already_active');
      expect((error as TurnAlreadyActiveError).assignmentId).toBe(assignmentId);
    }
  });
});

describe('recording what a turn produced', () => {
  function planned(seat = 'drafter'): string {
    const turn = turns.plan({ assignmentId, round: 1, seat, agentId: 'ada' });
    return turns.start(turn.id, `session-${seat}`).id;
  }

  it('records a report and reads it back structured', () => {
    const id = planned();
    const stored = turns.report(id, {
      state: 'done',
      headline: 'Draft complete',
      artifacts: [{ path: 'docs/x/DESIGN.md', kind: 'doc' }],
      verdict: {
        decision: 'revise',
        blocking: [{ severity: 'high', summary: 'no rollback' }],
        nonBlocking: [],
      },
      at: '2026-08-16T10:05:00.000Z',
    });
    expect(stored.report?.verdict?.blocking).toEqual([
      { severity: 'high', summary: 'no rollback' },
    ]);
    expect(turns.findBySession('session-drafter')?.id).toBe(id);
  });

  it('bounds the live output capture in bytes, not characters', () => {
    const id = planned();
    const stored = turns.setOutput(id, '日本語'.repeat(100), 16);
    expect(Buffer.byteLength(stored.outputText ?? '', 'utf8')).toBeLessThanOrEqual(16);
    // And it never stores a half code point.
    expect(stored.outputText).not.toContain('�');
  });

  it('completes into each of the four terminal statuses', () => {
    for (const status of ['reported', 'unstructured', 'blocked', 'failed'] as const) {
      const id = planned(`seat-${status}`);
      const done = turns.complete(id, { status });
      expect(done.status).toBe(status);
      expect(done.endedAt).not.toBeNull();
    }
  });

  it('lists a whole assignment by round then insertion order', () => {
    const order: string[] = [];
    for (const [round, seat] of [
      [1, 'drafter'],
      [1, 'critic'],
      [2, 'drafter'],
    ] as const) {
      const turn = turns.plan({ assignmentId, round, seat, agentId: 'ada' });
      order.push(turn.id);
      turns.complete(turn.id, { status: 'reported' });
    }
    expect(turns.list(assignmentId).map((turn) => turn.id)).toEqual(order);
  });
});

describe('retryOf is derived, never stored', () => {
  it('points a re-planned seat/round at the turn it re-runs', () => {
    const first = turns.plan({ assignmentId, round: 1, seat: 'drafter', agentId: 'ada' });
    turns.complete(first.id, { status: 'unstructured' });
    const retry = turns.plan({ assignmentId, round: 1, seat: 'drafter', agentId: 'ada' });

    const listed = turns.list(assignmentId);
    expect(listed[0]?.retryOfTurnId).toBeNull();
    expect(listed[1]?.retryOfTurnId).toBe(first.id);
    // The same fact read one row at a time.
    expect(turns.get(retry.id)?.retryOfTurnId).toBe(first.id);
  });

  it('does not treat a different seat in the same round as a retry', () => {
    const drafter = turns.plan({ assignmentId, round: 1, seat: 'drafter', agentId: 'ada' });
    turns.complete(drafter.id, { status: 'reported' });
    const critic = turns.plan({ assignmentId, round: 1, seat: 'critic', agentId: 'sam' });
    expect(turns.get(critic.id)?.retryOfTurnId).toBeNull();
  });
});

describe('boundedUtf8', () => {
  it('returns short text untouched and never splits a code point', () => {
    expect(boundedUtf8('hello', 32)).toBe('hello');
    expect(boundedUtf8('😀😀😀', 5)).toBe('😀');
  });
});
