/**
 * The pattern abstraction and v1's two patterns (DESIGN §3.1, §3.3;
 * IMPLEMENTATION M5-1/M5-6 and M6-1..3).
 *
 * ## A pattern is a pure state machine over persisted state
 *
 * §3.1: "It never holds process memory, never calls runner, never touches the
 * database. The engine does all of that." That is what makes the loop survive a
 * restart — after a crash the engine reloads the assignment and its turns, calls
 * {@link PatternDef.plan} again, and gets the same answer it would have got had
 * nothing happened. It is also what makes convergence *testable*: a fixture of
 * turn rows in, an expected plan out. Convergence logic that lives inside an LLM
 * prompt cannot be tested; this can.
 *
 * ## One deviation from §3.1's type sketch, raised rather than hidden
 *
 * §3.1 types the return as `TurnPlan | Termination`, but §3.3's own table has a
 * third outcome — *"Last turn `blocked` … **Wait.** On `question.answered`,
 * re-plan the same seat"* — and a turn already in flight is the same shape. A
 * two-member union can only express that by lying (a `halt` that is not a halt,
 * or a plan that must not be launched), so {@link PlanResult} adds
 * {@link WaitPlan}. Nothing else about the sketch changes.
 *
 * ## Convergence: the LLM proposes, a deterministic rule decides
 *
 * The critic proposes `accept` or `revise`; {@link isConverged} converges only on
 * `accept` **with an empty blocking list**. "An 'accept, but these three things
 * are blocking' report is treated as `revise` — the words lose to the
 * structure." This is the answer to "two LLMs critiquing each other could loop
 * politely forever": politeness cannot terminate the loop early, and the round
 * cap terminates it late. Neither agent can extend the cap.
 */
import {
  artifactUnchanged,
  consecutiveFailures,
  roundsWouldExceedCap,
  unstructuredForSeat,
} from './breakers.js';
import type { AssignmentRow } from './repository.js';
import type { BlockingIssue, TurnRow } from './turns.js';
import type { AssignmentRole, AssignmentScope, CloseReason } from './types.js';

// ---------------------------------------------------------------------------
// Halt reasons (§8.1)
// ---------------------------------------------------------------------------

/**
 * §8.1's halt vocabulary, plus `question_expired` (§6.5, already written by M2).
 *
 * `budget` and `round_cap` are **not** here: a budget crossing sets
 * `phase: awaiting_user` (§7.3) and a round cap *terminates* with its own
 * close reason (§3.3). Both are outcomes, neither is a halt, and a halt reason
 * a phase never carries would be a value nothing can produce.
 */
export const HALT_REASONS = [
  'turn_failures',
  'no_report',
  'no_progress',
  'permission_fight',
  'tool_flood',
  'stale',
  'question_expired',
] as const;

export type HaltReason = (typeof HALT_REASONS)[number];

// ---------------------------------------------------------------------------
// Prompt specs — data, so `plan()` stays pure
// ---------------------------------------------------------------------------

/** Why a seat is being asked to take this turn — §3.2's section 2 and 3 inputs. */
export type TurnIntent = 'draft' | 'critique' | 'revise' | 'retry' | 'answered';

/**
 * Everything the composed prompt needs that only `plan()` knows.
 *
 * A *spec*, not a string: composing text inside `plan()` would make the pure
 * function's expected value a 16 KB blob, and every assertion about turn order
 * would be an assertion about prose. `prompt.ts` renders it.
 */
export interface PromptSpec {
  readonly intent: TurnIntent;
  readonly seat: string;
  readonly round: number;
  /** The counterpart's last structured headline plus a bounded excerpt (§3.2-3). */
  readonly handoff?:
    | {
        readonly seat: string;
        readonly agentId: string;
        readonly headline: string | null;
        readonly excerpt: string | null;
      }
    | undefined;
  /** Carried **verbatim** into the revise prompt (§3.3). */
  readonly blocking?: readonly BlockingIssue[] | undefined;
  /** Set when this turn re-runs a seat that produced no `report_status`. */
  readonly retryOfTurnId?: string | undefined;
  /** §3.3: the answer is prepended when a `blocked` seat is re-planned. */
  readonly answer?: { readonly question: string; readonly text: string } | undefined;
}

// ---------------------------------------------------------------------------
// The abstraction (§3.1)
// ---------------------------------------------------------------------------

export interface SeatDef {
  readonly key: string;
  readonly roles: readonly AssignmentRole[];
  readonly required: boolean;
  /** Ranks candidates in the create dialog only — never a runtime substitution. */
  readonly preferredTier?: 'fast' | 'balanced' | 'max';
  readonly write: boolean;
}

export interface TurnPlan {
  readonly seat: string;
  readonly agentId: string;
  readonly round: number;
  readonly prompt: PromptSpec;
  /** Present for a seat's second and later turns (§3.2). */
  readonly continueFromSessionId?: string | undefined;
  readonly priority: 'normal';
}

export type Termination =
  | { readonly done: true; readonly closeReason: CloseReason; readonly summary: string }
  | { readonly halt: true; readonly haltReason: HaltReason };

/** The third outcome §3.3's table needs and §3.1's sketch cannot express. */
export interface WaitPlan {
  readonly wait: true;
  readonly reason:
    'turn_in_flight' | 'awaiting_answer' | 'no_driver' | 'no_members' | 'not_running';
}

export type PlanResult = TurnPlan | Termination | WaitPlan;

export function isTurnPlan(result: PlanResult): result is TurnPlan {
  return 'seat' in result;
}

export function isWait(result: PlanResult): result is WaitPlan {
  return 'wait' in result;
}

export function isDone(
  result: PlanResult,
): result is { done: true; closeReason: CloseReason; summary: string } {
  return 'done' in result;
}

export function isHalt(result: PlanResult): result is { halt: true; haltReason: HaltReason } {
  return 'halt' in result;
}

export interface StateMember {
  readonly agentId: string;
  readonly role: AssignmentRole;
  readonly seatOrder: number;
}

/** Everything `plan()` may see — all of it from the database (§3.1). */
export interface AssignmentState {
  readonly assignment: AssignmentRow;
  readonly scope: AssignmentScope | null;
  readonly members: readonly StateMember[];
  readonly turns: readonly TurnRow[];
  readonly roundsUsed: number;
  readonly tokensUsed: number;
  readonly budget: number | null;
  readonly roundCap: number | null;
  /** The open card for this assignment, and its answer once one lands (§3.3). */
  readonly openQuestion?:
    | {
        readonly id: string;
        readonly seat: string;
        readonly prompt: string;
        readonly answerText?: string | undefined;
        /** So a re-plan uses an answer that landed *after* the seat blocked. */
        readonly answeredAt?: string | undefined;
      }
    | undefined;
  /** §8.1's counters. A no-op input until M7 fills them. */
  readonly breakers: BreakerCounters;
  /**
   * The user asked to continue past a halt (§8.1's "Continue anyway", §11.1's
   * `/advance`).
   *
   * Without it the pattern would re-halt on the same evidence the instant the
   * loop is re-entered, because §8.1's counters are *re-derived from
   * `assignment_turns`* rather than reset — which is the right property
   * everywhere except here. It is a field of the state rather than a stored flag
   * so it stays exactly one advance long: the user pressed the button once.
   */
  readonly resumeRequested?: boolean | undefined;
}

export interface BreakerCounters {
  readonly consecutiveFailures: number;
  readonly unstructuredBySeat: Readonly<Record<string, number>>;
  readonly denialsPerSession: number;
}

export const NO_BREAKERS: BreakerCounters = {
  consecutiveFailures: 0,
  unstructuredBySeat: {},
  denialsPerSession: 0,
};

export interface Diagnostic {
  readonly level: 'error' | 'warn';
  readonly code: string;
  readonly message: string;
}

/** What the pattern's `pattern_config_json` may carry (§3.3). */
export interface PatternConfig {
  readonly roundCap?: number;
  readonly seats?: Readonly<Record<string, string>>;
  readonly convergence?: string;
  readonly requireArtifact?: boolean;
}

export interface PatternDef {
  readonly id: string;
  readonly driver: 'none' | 'sequential';
  readonly seats: readonly SeatDef[];
  readonly requires?:
    | {
        readonly artifactPath?: boolean;
        readonly roundCap?: boolean;
        readonly tokenBudget?: boolean;
      }
    | undefined;
  validate(config: PatternConfig, members: readonly StateMember[]): readonly Diagnostic[];
  plan(state: AssignmentState): PlanResult;
}

// ---------------------------------------------------------------------------
// `solo` — driver `none`, and that is the whole point (M5-6)
// ---------------------------------------------------------------------------

/**
 * The trivial assignment as a first-class pattern.
 *
 * §2.3: "The solo pattern has **no driver** — no turn loop, no convergence
 * check, no round accounting. That is what makes solo genuinely trivial rather
 * than a special case threaded through the engine." Registering it here with
 * `driver: 'none'` proves the abstraction: the engine asks every pattern the same
 * question and this one always answers "nothing to do".
 */
export const SOLO_PATTERN: PatternDef = {
  id: 'solo',
  driver: 'none',
  seats: [
    {
      key: 'solo',
      roles: ['implementer', 'architect', 'skeptic', 'reviewer', 'overseer'],
      required: true,
      write: true,
    },
  ],
  validate: () => [],
  plan: () => ({ wait: true, reason: 'no_driver' }),
};

// ---------------------------------------------------------------------------
// `pair` — the adversarial pair (§3.3, M6)
// ---------------------------------------------------------------------------

export const DRAFTER_SEAT = 'drafter';
export const CRITIC_SEAT = 'critic';

/**
 * §3.3's two seats.
 *
 * `drafter` produces the artifact and is the lead (§2.4: "for `pair` the lead is
 * the drafting seat"); `critic` attacks it. Seat order is the pattern's, not
 * insertion order, and it is also the card's tie-break order (§6.2: "for the
 * pair, critic before drafter on a risk question, because the seat that exists to
 * find problems is the seat whose objection you want at the top") — which is why
 * {@link cardSeatOrder} is stated separately from the launch order rather than
 * being assumed to be the same list.
 */
export const PAIR_SEATS: readonly SeatDef[] = [
  {
    key: DRAFTER_SEAT,
    roles: ['architect', 'implementer'],
    required: true,
    preferredTier: 'max',
    write: true,
  },
  { key: CRITIC_SEAT, roles: ['skeptic'], required: true, preferredTier: 'balanced', write: false },
];

/** §6.2's "then the pattern's declared seat order" for the pair. */
export const PAIR_CARD_SEAT_ORDER: readonly string[] = [CRITIC_SEAT, DRAFTER_SEAT];

export function cardSeatOrder(patternId: string): readonly string[] {
  return patternId === 'pair' ? PAIR_CARD_SEAT_ORDER : [];
}

/** §3.3's structural convergence rule, in one place so nothing re-derives it. */
export function isConverged(turn: TurnRow): boolean {
  const verdict = turn.report?.verdict;
  if (verdict === undefined) return false;
  return verdict.decision === 'accept' && (verdict.blocking ?? []).length === 0;
}

export const PAIR_PATTERN: PatternDef = {
  id: 'pair',
  driver: 'sequential',
  seats: PAIR_SEATS,
  requires: { artifactPath: true, roundCap: true, tokenBudget: true },

  validate(config, members) {
    const diagnostics: Diagnostic[] = [];
    const bySeat = seatsOf(members);
    if (bySeat.drafter === undefined) {
      diagnostics.push({
        level: 'error',
        code: 'seat_unfilled',
        message: 'The pair needs a drafting seat held by an architect or an implementer.',
      });
    }
    if (bySeat.critic === undefined) {
      diagnostics.push({
        level: 'error',
        code: 'seat_unfilled',
        message: 'The pair needs a critic seat held by a skeptic.',
      });
    }
    if (config.convergence !== undefined && config.convergence !== 'critic-accepts') {
      diagnostics.push({
        level: 'error',
        code: 'unsupported_convergence',
        message: `"${config.convergence}" is not a convergence rule this build ships; v1's only value is "critic-accepts".`,
      });
    }
    return diagnostics;
  },

  plan(state) {
    const seats = seatsOf(state.members);
    const drafter = seats.drafter;
    const critic = seats.critic;
    if (drafter === undefined || critic === undefined) {
      return { wait: true, reason: 'no_members' };
    }

    const turns = state.turns;
    const last = turns.at(-1);

    // No turns → round 1, drafter, a fresh session.
    if (last === undefined) {
      return {
        seat: DRAFTER_SEAT,
        agentId: drafter.agentId,
        round: 1,
        prompt: { intent: 'draft', seat: DRAFTER_SEAT, round: 1 },
        priority: 'normal',
      };
    }

    // A turn is already planned or running: the sequential driver has nothing to
    // add, and the partial unique index would refuse the insert anyway.
    if (last.status === 'planned' || last.status === 'running') {
      return { wait: true, reason: 'turn_in_flight' };
    }

    const seatOf = (key: string): StateMember => (key === DRAFTER_SEAT ? drafter : critic);

    // §3.3: a `blocked` seat waits for the answer, then re-runs the same seat and
    // round with the answer prepended. Orchestrator never resumes the session
    // itself (§4.4, R6) — the turn ended cleanly and the engine re-drives it.
    if (last.status === 'blocked') {
      const decision = state.openQuestion;
      const answer = decision?.answerText;
      const stale =
        decision?.answeredAt !== undefined &&
        last.endedAt !== null &&
        decision.answeredAt < last.endedAt;
      if (answer === undefined || stale) return { wait: true, reason: 'awaiting_answer' };
      return {
        seat: last.seat,
        agentId: seatOf(last.seat).agentId,
        round: last.round,
        prompt: {
          intent: 'answered',
          seat: last.seat,
          round: last.round,
          answer: { question: state.openQuestion?.prompt ?? '', text: answer },
        },
        ...continuation(turns, last.seat),
        priority: 'normal',
      };
    }

    // §8.1 `unstructured`: the same seat producing two turns with no
    // `report_status` halts `no_report`. The first one is re-planned once with a
    // stricter instruction, because a wiring bug and a disobedient model look
    // identical from here and one retry distinguishes them cheaply.
    if (last.status === 'unstructured') {
      // The counter is `breakers.ts`'s, so §8.1's "re-derived from
      // `assignment_turns`" has exactly one implementation (see that file's
      // ownership table for why the *action* is here rather than there).
      const unstructured = unstructuredForSeat(turns, last.seat);
      if (unstructured >= 2 && state.resumeRequested !== true) {
        return { halt: true, haltReason: 'no_report' };
      }
      return {
        seat: last.seat,
        agentId: seatOf(last.seat).agentId,
        round: last.round,
        prompt: {
          intent: 'retry',
          seat: last.seat,
          round: last.round,
          retryOfTurnId: last.id,
        },
        ...continuation(turns, last.seat),
        priority: 'normal',
      };
    }

    // §8.1 `turn_failures`: two consecutive failed/orphaned turn sessions.
    if (last.status === 'failed') {
      if (consecutiveFailures(turns) >= 2 && state.resumeRequested !== true) {
        return { halt: true, haltReason: 'turn_failures' };
      }
      return {
        seat: last.seat,
        agentId: seatOf(last.seat).agentId,
        round: last.round,
        prompt: { intent: 'retry', seat: last.seat, round: last.round, retryOfTurnId: last.id },
        ...continuation(turns, last.seat),
        priority: 'normal',
      };
    }

    // --- last.status === 'reported' ---

    if (last.seat === DRAFTER_SEAT) {
      // §8.1 `no_progress`: two consecutive drafter turns with an unchanged
      // artifact hash while claiming a revision. This is the "politely looping
      // forever" guard the round cap alone does not catch — the cap would still
      // burn every remaining round first.
      const previousDrafter = turns
        .filter((turn) => turn.seat === DRAFTER_SEAT && turn.id !== last.id && turn.report !== null)
        .at(-1);
      if (
        artifactUnchanged(last, previousDrafter) &&
        claimsRevision(last) &&
        state.resumeRequested !== true
      ) {
        return { halt: true, haltReason: 'no_progress' };
      }

      return {
        seat: CRITIC_SEAT,
        agentId: critic.agentId,
        round: last.round,
        prompt: {
          intent: 'critique',
          seat: CRITIC_SEAT,
          round: last.round,
          handoff: handoffFrom(last),
        },
        ...continuation(turns, CRITIC_SEAT),
        priority: 'normal',
      };
    }

    // The critic reported: converge, cap out, or run another round.
    if (isConverged(last)) {
      return {
        done: true,
        closeReason: 'converged',
        summary: `The critic accepted the artifact with no blocking issues after ${String(last.round)} round(s).`,
      };
    }

    const cap = state.roundCap;
    if (roundsWouldExceedCap(last.round + 1, cap)) {
      return {
        done: true,
        closeReason: 'round_cap',
        summary: `The pair reached its ${String(cap)}-round cap without the critic accepting.`,
      };
    }

    const nextRound = last.round + 1;
    return {
      seat: DRAFTER_SEAT,
      agentId: drafter.agentId,
      round: nextRound,
      prompt: {
        intent: 'revise',
        seat: DRAFTER_SEAT,
        round: nextRound,
        handoff: handoffFrom(last),
        blocking: last.report?.verdict?.blocking ?? [],
      },
      ...continuation(turns, DRAFTER_SEAT),
      priority: 'normal',
    };
  },
};

/** The registry of patterns this build ships (M5-1). */
export const PATTERNS: readonly PatternDef[] = [SOLO_PATTERN, PAIR_PATTERN];

export function patternFor(id: string): PatternDef | undefined {
  return PATTERNS.find((pattern) => pattern.id === id);
}

/** What `GET /api/patterns` serves — seats, defaults, and what a pattern requires. */
/**
 * One agent the create dialog may put in a seat (§16-9, M9-4).
 *
 * Ranking, not filtering: an agent at its concurrency cap is still shown, marked
 * unavailable, because "why can I not pick Sam" is a question the dialog should
 * answer rather than raise.
 */
export interface SeatCandidate {
  readonly agentId: string;
  readonly name: string;
  readonly roles: readonly string[];
  readonly openAssignments: number;
  readonly available: boolean;
}

export interface PatternSummary {
  readonly id: string;
  readonly driver: 'none' | 'sequential';
  readonly seats: readonly SeatDef[];
  readonly requires: {
    readonly artifactPath: boolean;
    readonly roundCap: boolean;
    readonly tokenBudget: boolean;
  };
  readonly defaults: { readonly roundCap: number | null; readonly tokenBudget: number | null };
  readonly maxRoundCap: number | null;
  /** §6.2's card ordering, so the UI never has to know a pattern's internals. */
  readonly cardSeatOrder: readonly string[];
  /**
   * Who could fill each seat, keyed by seat (§16-9, M9-4).
   *
   * Absent in a build whose roster cannot be read — the dialog then falls back
   * to its own agent list, which it has anyway; an empty object would say
   * "nobody is eligible", which is a different and wrong claim.
   */
  readonly candidates?: Readonly<Record<string, readonly SeatCandidate[]>>;
}

// ---------------------------------------------------------------------------
// Helpers — all pure
// ---------------------------------------------------------------------------

/**
 * Members → seats, by role, deterministically.
 *
 * §2.4 pins the mapping: the drafting seat is the `architect` or `implementer`
 * member and the critic is the `skeptic`. Two seats may never be the same agent
 * (an adversarial pair where both sides are one identity "is theatre, not
 * review"), which the create validator already refuses — so a lookup by role is
 * unambiguous here.
 */
export function seatsOf(members: readonly StateMember[]): {
  drafter?: StateMember;
  critic?: StateMember;
} {
  const ordered = [...members].sort((a, b) => a.seatOrder - b.seatOrder);
  const drafter = ordered.find(
    (member) => member.role === 'architect' || member.role === 'implementer',
  );
  const critic = ordered.find((member) => member.role === 'skeptic');
  return {
    ...(drafter === undefined ? {} : { drafter }),
    ...(critic === undefined ? {} : { critic }),
  };
}

/** The seat's previous session, which is what `continueFrom` resumes (§3.2). */
function continuation(turns: readonly TurnRow[], seat: string): { continueFromSessionId?: string } {
  const previous = turns
    .filter((turn) => turn.seat === seat && turn.sessionId !== null)
    .at(-1)?.sessionId;
  return previous === undefined || previous === null ? {} : { continueFromSessionId: previous };
}

function handoffFrom(turn: TurnRow): NonNullable<PromptSpec['handoff']> {
  return {
    seat: turn.seat,
    agentId: turn.agentId,
    headline: turn.report?.headline ?? null,
    excerpt: turn.outputText,
  };
}

/**
 * "while claiming a revision" (§8.1) — the structural reading.
 *
 * A drafter turn past round 1 whose report says it finished (`done` or
 * `needs_review`) is claiming it revised the artifact. `working` and `blocked`
 * are not claims of completion, so an unchanged hash under either is not the
 * breaker's case.
 */
function claimsRevision(turn: TurnRow): boolean {
  const state = turn.report?.state;
  return turn.round > 1 && (state === 'done' || state === 'needs_review');
}
