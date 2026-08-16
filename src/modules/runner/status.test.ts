/**
 * The status machine (runner DESIGN §2.2, §2.3) — M1's third and fourth
 * acceptance criteria.
 *
 * > "A transition-table test drives **every arrow** in §2.2 and asserts that
 * > every arrow **not** in the table is rejected — in particular
 * > `paused → orphaned`, `orphaned → *`, and any exit from a terminal status."
 *
 * > "Every terminal or paused transition writes an `exit_reason` from the closed
 * > §2.3 set; a write without one throws."
 *
 * Driven here against the pure rules and again, through a real database, in
 * `repository.test.ts` — the rules are worth testing without SQL in the way, and
 * worth proving are the ones the `UPDATE` actually passes through.
 */
import { describe, expect, it } from 'vitest';

import type { SessionStatus } from '../../storage/index.js';

import {
  InvalidExitReasonError,
  InvalidTransitionError,
  MissingExitReasonError,
} from './errors.js';
import {
  assertTransition,
  EXIT_REASONS,
  isTransitionAllowed,
  requiresExitReason,
  SESSION_STATUSES,
  SESSION_TRANSITIONS,
  TERMINAL_STATUSES,
} from './status.js';

/** An exit reason that satisfies §2.3 wherever one is required. */
const ANY_REASON = 'completed';

function optionsFor(to: SessionStatus): { exitReason?: string; boot?: boolean } {
  return {
    ...(requiresExitReason(to) ? { exitReason: ANY_REASON } : {}),
    ...(to === 'orphaned' ? { boot: true } : {}),
  };
}

describe('§2.2 — every arrow in the table', () => {
  it.each(SESSION_TRANSITIONS.map((t) => [`${t.from} → ${t.to}`, t] as const))(
    'allows %s',
    (_name, transition) => {
      expect(
        assertTransition(transition.from, transition.to, optionsFor(transition.to)),
      ).toMatchObject({ from: transition.from, to: transition.to });
    },
  );

  it('covers the eleven arrows §2.2 lists, and no more', () => {
    // The table is the design's; a twelfth arrow appearing here without a design
    // change is exactly the drift this asserts against.
    expect(SESSION_TRANSITIONS).toHaveLength(11);
  });
});

describe('§2.2 — every arrow not in the table is rejected', () => {
  const pairs: [SessionStatus, SessionStatus][] = SESSION_STATUSES.flatMap((from) =>
    SESSION_STATUSES.map((to) => [from, to] as [SessionStatus, SessionStatus]),
  );
  const missing = pairs.filter(([from, to]) => !isTransitionAllowed(from, to));

  it.each(missing.map(([from, to]) => [`${from} → ${to}`, from, to] as const))(
    'refuses %s',
    (_name, from, to) => {
      expect(() => assertTransition(from, to, optionsFor(to))).toThrow(InvalidTransitionError);
    },
  );

  it('refuses paused → orphaned, naming the reason', () => {
    expect(() =>
      assertTransition('paused', 'orphaned', { exitReason: 'core_restart', boot: true }),
    ).toThrow(/deliberate state and survives restarts/u);
  });

  it('refuses every exit from orphaned', () => {
    for (const to of SESSION_STATUSES) {
      expect(() => assertTransition('orphaned', to, optionsFor(to))).toThrow(
        /"orphaned" is terminal/u,
      );
    }
  });

  it('refuses every exit from done, failed and interrupted', () => {
    for (const from of ['done', 'failed', 'interrupted'] as const) {
      for (const to of SESSION_STATUSES) {
        expect(() => assertTransition(from, to, optionsFor(to))).toThrow(InvalidTransitionError);
      }
    }
  });
});

describe('§2.2 — orphaned is only ever assigned by the boot task', () => {
  it('allows running → orphaned from the boot task', () => {
    expect(
      assertTransition('running', 'orphaned', { exitReason: 'core_restart', boot: true }),
    ).toMatchObject({ bootOnly: true });
  });

  it('refuses running → orphaned from a live process', () => {
    expect(() => assertTransition('running', 'orphaned', { exitReason: 'core_restart' })).toThrow(
      /only the boot reconciliation task may orphan a session/u,
    );
  });
});

describe('§2.3 — exit reasons', () => {
  const requiring = SESSION_STATUSES.filter((status) => requiresExitReason(status));

  it('requires one on every terminal status and on paused', () => {
    expect(new Set(requiring)).toEqual(new Set([...TERMINAL_STATUSES, 'paused']));
  });

  it.each(
    SESSION_TRANSITIONS.filter((t) => requiresExitReason(t.to)).map(
      (t) => [`${t.from} → ${t.to}`, t] as const,
    ),
  )('throws when %s carries no exit_reason', (_name, transition) => {
    expect(() =>
      assertTransition(transition.from, transition.to, {
        ...(transition.to === 'orphaned' ? { boot: true } : {}),
      }),
    ).toThrow(MissingExitReasonError);
  });

  it('throws on a reason outside the closed set', () => {
    expect(() => assertTransition('running', 'done', { exitReason: 'finished-ok' })).toThrow(
      InvalidExitReasonError,
    );
  });

  it('accepts every member of the closed set', () => {
    for (const reason of EXIT_REASONS) {
      expect(() => assertTransition('running', 'failed', { exitReason: reason })).not.toThrow();
    }
  });

  it('pins §2.3 verbatim', () => {
    expect([...EXIT_REASONS]).toEqual([
      'completed',
      'user_stopped',
      'user_cancelled',
      'max_turns',
      'max_budget_usd',
      'error_during_execution',
      'error_structured_output',
      'launch_failed',
      'secret_unresolved',
      'workspace_unavailable',
      'start_timeout',
      'idle_timeout',
      'wall_clock_timeout',
      'question_expired',
      'awaiting_answer',
      'budget_halt',
      'service_shutdown',
      'shutdown_forced',
      'stale_queue',
      'core_restart',
      'transcript_cap',
    ]);
  });

  it('does not require one where §2.2 does not', () => {
    for (const to of ['queued', 'running'] as const) {
      expect(requiresExitReason(to)).toBe(false);
    }
  });
});
