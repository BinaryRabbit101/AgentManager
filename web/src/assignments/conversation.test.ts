/**
 * The collaboration view's decisions, without a DOM (DESIGN §10.2).
 *
 * Everything here is a *word* or a *count*: which sentence stands for a halt
 * reason, what an undelivered message is called, how many pips a round strip
 * has. They are asserted separately from the screen because they are what the
 * screen is required to say — IMPLEMENTATION §9 quotes several of them — and a
 * sentence asserted through three levels of markup is a sentence nobody can
 * find when it changes.
 */

import { describe, expect, it } from 'vitest';

import {
  attribution,
  budgetLine,
  bannerFor,
  closeWord,
  deliveryWord,
  entryKey,
  formatTokens,
  haltWord,
  isSolo,
  isUnseen,
  currentRound,
  hasTurnInFlight,
  phaseInFlight,
  phaseWord,
  roundLabel,
  roundPips,
  seatColumn,
  seatsOf,
  turnStatusNote,
  turnsOf,
} from './conversation';
import { aConversation, anAssignment, aSoloAssignment } from './fixtures';

describe('phase, rendered as the word (§10.2)', () => {
  it('has a word for every phase orchestrator can be in', () => {
    for (const phase of [
      'planned',
      'running',
      'awaiting_user',
      'halted',
      'converged',
      'closed',
    ] as const) {
      expect(phaseWord(phase)).not.toBe('');
    }
    expect(phaseWord('awaiting_user')).toBe('waiting for you');
  });
});

describe('delivery, distinctly (§10.2, orchestrator §16.5)', () => {
  it('gives inlined, read and undelivered three different words', () => {
    const words = new Set([
      deliveryWord('inlined'),
      deliveryWord('read'),
      deliveryWord('undelivered'),
    ]);
    expect(words.size).toBe(3);
  });

  it('labels undelivered as never seen by the recipient', () => {
    expect(deliveryWord('undelivered')).toContain('never seen by the recipient');
  });

  it('treats orchestrator’s fourth value as the same failure, made permanent', () => {
    // `undeliverable` is an undelivered message on an assignment that has since
    // closed. The recipient will now never see it, so it carries the same label.
    expect(deliveryWord('undeliverable')).toContain('never seen by the recipient');
    expect(deliveryWord('undeliverable')).not.toBe(deliveryWord('undelivered'));
    expect(isUnseen('undeliverable')).toBe(true);
    expect(isUnseen('undelivered')).toBe(true);
    expect(isUnseen('read')).toBe(false);
    expect(isUnseen('inlined')).toBe(false);
  });
});

describe('turn status is shown only when it is not the happy path (§10.2)', () => {
  const turn = (
    status: string,
    exitReason: string | null = null,
  ): Parameters<typeof turnStatusNote>[0] =>
    ({ status, exitReason }) as unknown as Parameters<typeof turnStatusNote>[0];

  it('says nothing for a reported or running turn', () => {
    expect(turnStatusNote(turn('reported'))).toBeUndefined();
    expect(turnStatusNote(turn('running'))).toBeUndefined();
  });

  it('uses §10.2’s own sentences for the unhappy ones', () => {
    expect(turnStatusNote(turn('unstructured'))).toBe('finished without a structured report');
    expect(turnStatusNote(turn('blocked'))).toBe('waiting on a decision');
    expect(turnStatusNote(turn('failed'))).toContain('failed');
    expect(turnStatusNote(turn('orphaned'))).toContain('orphaned');
  });

  // orchestrator WO1: a failed row with no cause is the one the user cannot act
  // on, and `launch_failed` has no session to click through to at all.
  it('names why a turn failed when the server recorded a reason', () => {
    expect(turnStatusNote(turn('failed', 'launch_failed'))).toBe(
      'failed — the session could not be started',
    );
    expect(turnStatusNote(turn('failed', 'workspace_unavailable'))).toContain('workspace');
  });

  it('falls back to the code, opened out, rather than inventing a diagnosis', () => {
    expect(turnStatusNote(turn('failed', 'some_new_reason'))).toBe('failed — some new reason');
  });

  it('still says just "failed" when nothing recorded a reason', () => {
    expect(turnStatusNote(turn('failed'))).toBe('failed');
  });
});

describe('attribution — who spoke, in which seat (§10.2)', () => {
  it('reads "Sam · skeptic"', () => {
    const turn = turnsOf(aConversation()).find((one) => one.agentId === 'sam');
    expect(turn).toBeDefined();
    expect(attribution(turn!, 'Sam').line).toBe('Sam · skeptic');
  });

  it('falls back to the id when the agent has been deleted', () => {
    const turn = turnsOf(aConversation())[0]!;
    expect(attribution(turn, undefined).name).toBe('ada');
  });
});

describe('the round strip (§10.2)', () => {
  it('is `Round 2 of 3` as three pips, two of them done', () => {
    const pips = roundPips(2, 3);
    expect(pips).toHaveLength(3);
    expect(pips.filter((pip) => pip.done)).toHaveLength(2);
  });

  it('has no pips at all without a cap — a bar with no end is a lie', () => {
    expect(roundPips(4, null)).toEqual([]);
    expect(roundPips(0, 0)).toEqual([]);
  });

  /**
   * `rounds_used` counts *finished* rounds, so on its own it reads `Round 0 of
   * 3` for the whole of round 1 — the stretch the user is most likely watching.
   */
  it('counts the round in flight, not the last one finished', () => {
    expect(roundLabel(0, 3, true)).toBe('Round 1 of 3');
    expect(roundLabel(0, 3, false)).toBe('Round 0 of 3');
    expect(roundLabel(1, 3, false)).toBe('Round 1 of 3');
    expect(roundLabel(1, 3, true)).toBe('Round 2 of 3');
    expect(roundLabel(2, null, true)).toBe('Round 3');
  });

  it('never counts past the cap: `Round 4 of 3` would contradict its own second half', () => {
    expect(currentRound(3, 3, true)).toBe(3);
    expect(roundLabel(3, 3, true)).toBe('Round 3 of 3');
  });

  it('marks the round in flight as a third pip state — neither empty nor filled', () => {
    const running = roundPips(0, 3, true);
    expect(running.map((pip) => [pip.done, pip.inProgress])).toEqual([
      [false, true],
      [false, false],
      [false, false],
    ]);

    // The critic reported: the same round is finished, and no pip is in flight.
    const idle = roundPips(1, 3, false);
    expect(idle.map((pip) => [pip.done, pip.inProgress])).toEqual([
      [true, false],
      [false, false],
      [false, false],
    ]);

    // Round 2 in flight: one done, one working, one empty. Never both on a pip.
    expect(roundPips(1, 3, true).map((pip) => [pip.done, pip.inProgress])).toEqual([
      [true, false],
      [false, true],
      [false, false],
    ]);
    expect(roundPips(3, 3, true).every((pip) => !pip.inProgress)).toBe(true);
  });

  it('reads "in flight" off the turn statuses the server sent, never off a guess', () => {
    expect(hasTurnInFlight(undefined)).toBe(false);
    // The default fixture is a finished three-round pair.
    expect(hasTurnInFlight(aConversation())).toBe(false);
    expect(
      hasTurnInFlight(
        aConversation({
          rounds: [
            {
              round: 1,
              entries: [
                {
                  type: 'turn',
                  turnId: 't1',
                  seat: 'drafter',
                  agentId: 'ada',
                  role: 'architect',
                  sessionId: 'ses_1',
                  status: 'running',
                  report: null,
                  excerpt: null,
                  startedAt: '2026-08-17T09:05:00.000Z',
                  endedAt: null,
                  retryOfTurnId: null,
                },
              ],
            },
          ],
        }),
      ),
    ).toBe(true);
  });

  it('uses the phase where a list row has no turn table to read', () => {
    expect(phaseInFlight(anAssignment({ status: 'open', phase: 'running' }))).toBe(true);
    expect(phaseInFlight(anAssignment({ status: 'open', phase: 'awaiting_user' }))).toBe(false);
    expect(phaseInFlight(anAssignment({ status: 'open', phase: 'halted' }))).toBe(false);
    // A closed assignment is never mid-turn, whatever phase word it kept.
    expect(phaseInFlight(anAssignment({ status: 'closed', phase: 'running' }))).toBe(false);
  });
});

describe('the budget line is tokens (§10.2, orchestrator §16.8)', () => {
  it('reads used / budget / left, in tokens, with no currency anywhere', () => {
    const line = budgetLine(120_000, 400_000);
    expect(line.text).toBe('120,000 of 400,000 tokens · 280,000 left');
    expect(line.text).not.toMatch(/[$£€]|usd|cost|spend/iu);
    expect(line.fraction).toBeCloseTo(0.3, 5);
  });

  it('says so plainly when no budget is set, and offers no fraction', () => {
    expect(budgetLine(500, null)).toEqual({
      text: '500 tokens used · no budget set',
      fraction: null,
    });
  });

  it('never reports more than a full bar, however far over it went', () => {
    expect(budgetLine(900, 100).fraction).toBe(1);
  });

  it('formats a token count as a number, never abbreviated', () => {
    expect(formatTokens(1_234_567)).toBe('1,234,567');
  });
});

describe('a solo assignment is not a special case (§10.3)', () => {
  it('is recognised by pattern and by seat count', () => {
    expect(isSolo(aSoloAssignment())).toBe(true);
    expect(isSolo(anAssignment())).toBe(false);
  });

  it('still has a seat list, in the server’s seat order', () => {
    expect(seatsOf(aSoloAssignment()).map((member) => member.agentId)).toEqual(['ada']);
    expect(
      seatsOf(anAssignment({ members: anAssignment().members.slice().reverse() })).map(
        (member) => member.seatOrder,
      ),
    ).toEqual([0, 1]);
  });
});

describe('the banner (§10.2)', () => {
  it('names the halt reason and sends the user to the card that resolves it', () => {
    const banner = bannerFor(anAssignment({ phase: 'halted', haltReason: 'question_expired' }));
    expect(banner?.heading).toContain('a question expired unanswered');
    expect(banner?.linkToQuestions).toBe(true);
  });

  it('says an awaiting_user assignment is waiting for an answer', () => {
    expect(bannerFor(anAssignment({ phase: 'awaiting_user' }))?.linkToQuestions).toBe(true);
  });

  it('shows the completion summary with the artifact when it converged', () => {
    expect(bannerFor(anAssignment())?.detail).toContain('docs/decision.md');
  });

  it('is absent on the happy path', () => {
    expect(bannerFor(anAssignment({ phase: 'running', status: 'open' }))).toBeUndefined();
  });

  it('has a sentence for every halt and close reason orchestrator declares', () => {
    for (const reason of [
      'turn_failures',
      'no_report',
      'no_progress',
      'permission_fight',
      'tool_flood',
      'stale',
      'question_expired',
    ]) {
      expect(haltWord(reason)).not.toBe(reason);
    }
    for (const reason of [
      'converged',
      'round_cap',
      'budget_exhausted',
      'user_closed',
      'gate_denied',
      'gate_expired',
      'breaker',
      'failed',
      'project_archived',
    ]) {
      expect(closeWord(reason)).not.toBe(reason);
    }
    // An unknown code is shown as itself rather than swallowed.
    expect(haltWord('something_new')).toBe('something_new');
  });
});

describe('the column is an affordance, not an ordering (§10.2)', () => {
  it('puts a seat on the same side every time, whatever order entries arrive in', () => {
    const order = ['critic', 'drafter'];
    expect(seatColumn('critic', order)).toBe(seatColumn('critic', order));
    expect(seatColumn('critic', order)).not.toBe(seatColumn('drafter', order));
  });

  it('has a side for a seat the pattern never declared', () => {
    expect(['left', 'right']).toContain(seatColumn('overseer', []));
  });
});

describe('entry keys are the server’s ids', () => {
  it('never invents one', () => {
    const rounds = aConversation().rounds;
    const keys = rounds.flatMap((round) => round.entries.map(entryKey));
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain('question-q1');
    expect(keys).toContain('message-m3');
  });
});
