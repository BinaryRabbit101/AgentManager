/**
 * The pattern abstraction and the three patterns this build ships (DESIGN §3.1,
 * §3.3, §3.5; IMPLEMENTATION M5-1/M5-6, M6-1..3 and M10-1..3).
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
  artifactMissingTurns,
  artifactUnchanged,
  consecutiveFailures,
  roundsWouldExceedCap,
  unstructuredForSeat,
} from './breakers.js';
import type { AssignmentRow } from './repository.js';
import type { BlockingIssue, TurnReport, TurnRow } from './turns.js';
import type {
  AssignmentPhase,
  AssignmentRole,
  AssignmentScope,
  AssignmentStatus,
  CloseReason,
} from './types.js';

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
  /**
   * §3.3/§8.1: the drafting seat reported twice in one round without a file
   * existing at `scope.artifactPath`.
   *
   * Distinct from `no_progress`, which is about an artifact that stopped
   * *changing*: this one is about an artifact that never existed, and the two
   * want different cards and different next moves. Distinct from `no_report`
   * too — the seat did call `report_status`; it simply reported work nobody can
   * read. Sending the critic in to review nothing spends a quarter of the
   * default budget's estimate discovering the same fact the engine already has.
   */
  'no_artifact',
  'permission_fight',
  'tool_flood',
  'stale',
  'question_expired',
  /**
   * §3.5: the overseer's lead finished a review round without accepting the
   * work and without delegating the follow-up it asked for.
   *
   * A halt rather than a close, because there is nothing left for the engine to
   * drive and nothing that says the work failed — only a human can say whether
   * "revise, but I delegated nothing" means *give it another round* or *stop*.
   * The vocabulary gains one value rather than reusing `no_report`, which is a
   * claim about a missing tool call and would be a wrong diagnosis on a card.
   */
  'review_unresolved',
] as const;

export type HaltReason = (typeof HALT_REASONS)[number];

// ---------------------------------------------------------------------------
// Prompt specs — data, so `plan()` stays pure
// ---------------------------------------------------------------------------

/** Why a seat is being asked to take this turn — §3.2's section 2 and 3 inputs. */
export type TurnIntent =
  | 'draft'
  | 'critique'
  | 'revise'
  | 'retry'
  /**
   * §3.3: the drafter reported, but nothing exists at `scope.artifactPath`.
   *
   * Not `retry`, which is the "you produced no structured report" instruction.
   * The seat here *did* report; what is missing is the file, and telling it to
   * report harder would be a wrong diagnosis in the one sentence it reads.
   */
  | 'artifact_missing'
  | 'answered'
  /** §3.5: the overseer's first turn — turn the goal into child assignments. */
  | 'decompose'
  /** §3.5: the overseer's later turns — verify what the children produced. */
  | 'review'
  /** §3.5: the single turn of a child assignment the overseer minted as `solo`. */
  | 'work';

/**
 * One child assignment as the parent's `plan()` and prompt see it (§3.5).
 *
 * Flattened deliberately: `plan()` is a pure function of {@link AssignmentState}
 * and may not reach into a repository to ask a child anything, so everything the
 * review decision and the review prompt need is resolved by the engine and
 * handed over as data — including the child's **last structured report**, which
 * is the claim the lead is told to check against the artifact rather than to
 * believe.
 */
export interface ChildState {
  readonly id: string;
  readonly goal: string | null;
  readonly pattern: string;
  /** Foundation's two-state admission gate — `open` while the child may still run. */
  readonly status: AssignmentStatus;
  readonly phase: AssignmentPhase;
  readonly closeReason: string | null;
  readonly haltReason: string | null;
  /** Repo-relative, from the child's scope: the file the lead must actually read. */
  readonly artifactPath: string | null;
  readonly tokenBudget: number | null;
  readonly tokensUsed: number;
  readonly closedAt: string | null;
  readonly members: readonly { readonly agentId: string; readonly role: AssignmentRole }[];
  /** The child's last `report_status` payload, if any turn of it produced one. */
  readonly report: TurnReport | null;
}

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
  /**
   * §3.5: the finished children this review turn must verify.
   *
   * Only the ones this round is *for* — a child the previous review already
   * looked at is not re-presented, or the lead would be asked to accept the same
   * work twice and the second acceptance would mean nothing.
   */
  readonly children?: readonly ChildState[] | undefined;
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
    | 'turn_in_flight'
    | 'awaiting_answer'
    | 'no_driver'
    | 'no_members'
    | 'not_running'
    /**
     * §3.5: at least one child assignment is still `open`.
     *
     * The parent plans nothing while a child can still change its own outcome.
     * A child that is `halted` or `awaiting_user` is still `open`, so this is
     * also what an overseer waiting on a human's answer *to a child's card*
     * looks like — the card is already in the inbox and a second one here would
     * ask the same person the same thing twice.
     */
    | 'children_running';
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
  /**
   * §3.5: the assignments this one is the parent of, oldest first.
   *
   * Empty for every pattern but `overseer`, and empty there too until the lead
   * calls `create_assignment`. It is part of the state rather than a lookup
   * because the review cadence *is* a function of the children — "wait while one
   * is running, review the ones that finished" is a decision `plan()` has to be
   * able to make on its own, or it would not be testable without a database.
   */
  readonly children: readonly ChildState[];
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
  /**
   * Is *any* decision card for this assignment still open?
   *
   * {@link openQuestion} carries the newest card and its answer, which cannot
   * answer "is this seat still waiting on something": the newest card may be an
   * answered one from two rounds ago while nothing is open at all. Telling those
   * apart is what stops a blocked seat waiting forever for an answer that has
   * already landed or was never asked for (§3.3).
   *
   * Resolved by the engine against the inbox and handed over as a boolean, in
   * the same discipline as {@link ChildState}: `plan()` is pure over persisted
   * assignment state and may not query anything (§3.1).
   *
   * `undefined` means "this build could not tell", and the wait is kept — a
   * state that cannot see the inbox must not conclude that nothing is in it.
   */
  readonly hasOpenQuestion?: boolean | undefined;
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

/** The sole seat's key, named because §3.5's child driver plans turns against it. */
export const SOLO_SEAT = 'solo';

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
      key: SOLO_SEAT,
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
  if (patternId === 'pair') return PAIR_CARD_SEAT_ORDER;
  // §3.5: one seat, so the order is that seat — stated rather than left empty,
  // because "this pattern has no card order" and "this pattern has one seat" are
  // different facts and the UI branches on the list it is given.
  if (patternId === 'overseer') return OVERSEER_CARD_SEAT_ORDER;
  return [];
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

    // §3.3's three "the turn did not produce a verdict" rows — blocked, then
    // unstructured, then failed — are seat-agnostic, so they live in one
    // implementation both sequential patterns call (see {@link unfinishedTurn}).
    const unfinished = unfinishedTurn(state, last, seatOf(last.seat).agentId);
    if (unfinished !== undefined) return unfinished;

    // --- last.status === 'reported' ---

    if (last.seat === DRAFTER_SEAT) {
      // §8.1 `no_artifact`, and it comes first because it is the more basic
      // failure: `no_progress` compares two hashes and cannot fire when there is
      // no hash at all.
      //
      // The engine has already done the looking — `onSessionEnded` hashes
      // `scope.artifactPath` and writes `null` when the file is not there — so
      // this branch spends nothing to learn that the critic would be reviewing
      // an empty room. §3.3's own cost shape is why that matters: a critic turn
      // is a quarter of a 3-round pair's estimate, and in the observed run it
      // was spent entirely on "I can't find the artifact".
      if (requiresArtifact(state) && last.artifactHash === null && state.resumeRequested !== true) {
        // One re-plan first, for the same reason §3.3 retries an unstructured
        // turn once: a model that skipped the write and a scope whose path the
        // seat misread look identical from here, and one explicit instruction
        // naming the exact path distinguishes them cheaply.
        if (artifactMissingTurns(turns, DRAFTER_SEAT, last.round) >= 2) {
          return { halt: true, haltReason: 'no_artifact' };
        }
        return {
          seat: DRAFTER_SEAT,
          agentId: drafter.agentId,
          round: last.round,
          prompt: {
            intent: 'artifact_missing',
            seat: DRAFTER_SEAT,
            round: last.round,
            retryOfTurnId: last.id,
          },
          // The seat resumes its own session: it already holds the draft in
          // context, and a fresh session would ask it to write the file twice.
          ...continuation(turns, DRAFTER_SEAT),
          priority: 'normal',
        };
      }

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

// ---------------------------------------------------------------------------
// `overseer` — a lead that decomposes, and children that do the work (§3.5, M10)
// ---------------------------------------------------------------------------

export const LEAD_SEAT = 'lead';

/**
 * §3.5's **one** seat.
 *
 * The workers are not seats here: they hold seats in the *child* assignments the
 * lead mints, each of which is an independent assignment with its own driver,
 * budget and turn table. Modelling them as seats of the parent would give one
 * assignment two turn loops, and `assignment_turns_active` says an assignment
 * has at most one turn in flight.
 *
 * `write: false` because the lead writes nothing: it reads its children's
 * artifacts and decides. Reads are never scoped (§2.5), so a read-only lead can
 * still open every file its workers produced — which is exactly what the
 * completion-verification rule of §3.5 asks it to do.
 */
export const OVERSEER_SEATS: readonly SeatDef[] = [
  { key: LEAD_SEAT, roles: ['overseer'], required: true, preferredTier: 'max', write: false },
];

export const OVERSEER_CARD_SEAT_ORDER: readonly string[] = [LEAD_SEAT];

/**
 * The lead of an overseer assignment.
 *
 * The member holding the `overseer` role, and otherwise **the first seat**.
 * The fallback is the owner decision of 2026-08-18 made concrete: roles are
 * ranking hints, so a user may seat an implementer as the lead, and a pattern
 * that answered `undefined` there would leave the assignment with no turn to
 * plan — a capability check by another name.
 */
export function leadOf(members: readonly StateMember[]): StateMember | undefined {
  const ordered = [...members].sort((a, b) => a.seatOrder - b.seatOrder);
  return ordered.find((member) => member.role === 'overseer') ?? ordered[0];
}

/** A child that can still change its own outcome, so the parent may not review it. */
export function isChildRunning(child: ChildState): boolean {
  return child.status === 'open';
}

/**
 * The children a review round is *for* (§3.5).
 *
 * The cutoff is the start of the last turn that **reported**: a child that
 * finished before the lead's last successful turn began was in that turn's
 * prompt and has already been judged. Deriving it from the turn table rather
 * than storing a per-child `reviewed` flag is the same discipline §8.1 applies
 * to breaker counters — a restart recomputes it and cannot lose it — and it
 * means a review turn that *failed* re-presents the same children rather than
 * skipping them.
 */
export function childrenAwaitingReview(state: AssignmentState): readonly ChildState[] {
  const cutoff = state.turns.filter((turn) => turn.status === 'reported').at(-1)?.startedAt ?? null;
  return state.children.filter(
    (child) =>
      child.status === 'closed' &&
      child.closedAt !== null &&
      (cutoff === null || child.closedAt > cutoff),
  );
}

export const OVERSEER_PATTERN: PatternDef = {
  id: 'overseer',
  driver: 'sequential',
  seats: OVERSEER_SEATS,
  // No `artifactPath`: the artifacts belong to the children, and demanding one
  // here would make the lead write a file to prove it coordinated. The budget is
  // required because every child's budget is debited from this one's remainder
  // (§7.2, §9-8) — a null parent budget is an unbounded tree.
  requires: { roundCap: true, tokenBudget: true },

  validate(_config, members) {
    const diagnostics: Diagnostic[] = [];
    if (members.length === 0) {
      diagnostics.push({
        level: 'error',
        code: 'seat_unfilled',
        message: 'An overseer assignment needs a member in its lead seat.',
      });
    } else if (leadOf(members)?.role !== 'overseer') {
      // A warning, not an error: the owner decision of 2026-08-18 makes the
      // seating choice authoritative and the role a hint (§9-5/§9-6).
      diagnostics.push({
        level: 'warn',
        code: 'lead_not_overseer',
        message:
          'The lead seat is held by a member in another role. It leads anyway, without the ' +
          'overseer role addendum.',
      });
    }
    if (members.length > 1) {
      diagnostics.push({
        level: 'error',
        code: 'seat_not_in_pattern',
        message:
          'The overseer pattern has exactly one seat, the lead. Workers join through the child ' +
          'assignments the lead creates, not through seats on this one.',
      });
    }
    return diagnostics;
  },

  plan(state) {
    const lead = leadOf(state.members);
    if (lead === undefined) return { wait: true, reason: 'no_members' };

    const turns = state.turns;
    const last = turns.at(-1);

    // No turns → round 1, the lead, decomposing the goal into child assignments.
    if (last === undefined) {
      return {
        seat: LEAD_SEAT,
        agentId: lead.agentId,
        round: 1,
        prompt: { intent: 'decompose', seat: LEAD_SEAT, round: 1 },
        priority: 'normal',
      };
    }

    if (last.status === 'planned' || last.status === 'running') {
      return { wait: true, reason: 'turn_in_flight' };
    }

    const unfinished = unfinishedTurn(state, last, lead.agentId, {
      children: childrenAwaitingReview(state),
    });
    if (unfinished !== undefined) return unfinished;

    // --- last.status === 'reported' ---

    // §3.5's cadence: nothing is reviewed while anything can still change. A
    // child that halted is still `open` and its own card is already in the
    // user's inbox, so the parent waits rather than raising a second one.
    if (state.children.some(isChildRunning)) return { wait: true, reason: 'children_running' };

    const pending = childrenAwaitingReview(state);
    if (pending.length > 0) {
      const nextRound = last.round + 1;
      if (roundsWouldExceedCap(nextRound, state.roundCap)) {
        return {
          done: true,
          closeReason: 'round_cap',
          summary:
            `The overseer reached its ${String(state.roundCap)}-round cap with ` +
            `${String(pending.length)} finished child assignment(s) it has not accepted.`,
        };
      }
      return {
        seat: LEAD_SEAT,
        agentId: lead.agentId,
        round: nextRound,
        prompt: { intent: 'review', seat: LEAD_SEAT, round: nextRound, children: pending },
        ...continuation(turns, LEAD_SEAT),
        priority: 'normal',
      };
    }

    // Nothing running and nothing left to review: the lead's own verdict decides,
    // by exactly §3.3's structural rule — `accept` **and** an empty blocking
    // list. An overseer that reports "accept, but three of these are wrong" has
    // not accepted, and one that reports nothing structured has not decided.
    if (isConverged(last)) {
      return {
        done: true,
        closeReason: 'converged',
        summary:
          `The overseer accepted ${String(state.children.length)} child assignment(s) after ` +
          `${String(last.round)} round(s).`,
      };
    }

    // §8.1's "Continue anyway" on the halt card below: one more review round, so
    // the lead can delegate the follow-up it asked for. Bounded by the same cap
    // as everything else — neither the agent nor the card may extend it.
    if (state.resumeRequested === true && !roundsWouldExceedCap(last.round + 1, state.roundCap)) {
      return {
        seat: LEAD_SEAT,
        agentId: lead.agentId,
        round: last.round + 1,
        prompt: { intent: 'review', seat: LEAD_SEAT, round: last.round + 1, children: [] },
        ...continuation(turns, LEAD_SEAT),
        priority: 'normal',
      };
    }

    return { halt: true, haltReason: 'review_unresolved' };
  },
};

// ---------------------------------------------------------------------------
// The child of an overseer, when that child is a `solo` (§3.5)
// ---------------------------------------------------------------------------

/**
 * The one-turn driver a **machine-created** `solo` assignment needs.
 *
 * §2.3 is right that the user's solo has no driver: the user starts it through
 * `createSolo` and continues it by hand through runner's own actions. A solo the
 * *overseer* minted has neither of those — nothing starts it, nothing reports
 * against it (`report_status` needs a turn row), and nothing closes it, so the
 * parent would wait on it forever.
 *
 * So a solo **with a parent** is driven as exactly one turn: launch it, wait,
 * then close. It is a distinct function rather than a driver on `SOLO_PATTERN`
 * because the difference is a property of the *row* (`parent_assignment_id`),
 * not of the pattern, and giving every user solo a driver would silently take
 * over work the user is steering by hand.
 *
 * A child never halts. Two unreported or two failed turns close it `failed`,
 * because a child that cannot report is a child the overseer cannot verify — and
 * handing that outcome to the lead's review is the loop working, while a halt
 * card on a child nobody launched by hand is a question with no useful answer.
 */
export function planChildSolo(state: AssignmentState): PlanResult {
  const member = [...state.members].sort((a, b) => a.seatOrder - b.seatOrder)[0];
  if (member === undefined) return { wait: true, reason: 'no_members' };

  const turns = state.turns;
  const last = turns.at(-1);
  if (last === undefined) {
    return {
      seat: SOLO_SEAT,
      agentId: member.agentId,
      round: 1,
      prompt: { intent: 'work', seat: SOLO_SEAT, round: 1 },
      priority: 'normal',
    };
  }
  if (last.status === 'planned' || last.status === 'running') {
    return { wait: true, reason: 'turn_in_flight' };
  }

  if (last.status === 'blocked') {
    // Identical to §3.3's blocked row: the seat stopped on an unanswered
    // decision and the engine — never runner — re-drives it with the answer.
    return answeredOrWait(state, last, member.agentId);
  }

  if (last.status === 'unstructured') {
    if (unstructuredForSeat(turns, last.seat) < 2) return retryPlan(state, last, member.agentId);
    return {
      done: true,
      closeReason: 'failed',
      summary: 'The child produced no structured report in two turns, so nothing can be verified.',
    };
  }

  if (last.status === 'failed') {
    if (consecutiveFailures(turns) < 2) return retryPlan(state, last, member.agentId);
    return {
      done: true,
      closeReason: 'failed',
      summary: 'Two consecutive turns of the child failed.',
    };
  }

  return {
    done: true,
    closeReason: 'converged',
    summary: last.report?.headline ?? 'The child assignment finished.',
  };
}

/** The registry of patterns this build ships (M5-1, M10-1). */
export const PATTERNS: readonly PatternDef[] = [SOLO_PATTERN, PAIR_PATTERN, OVERSEER_PATTERN];

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
  /**
   * Whether this agent declares one of the seat's roles — **owner decision,
   * 2026-08-18**.
   *
   * Every non-archived agent is a candidate for every seat now; this is the
   * label the dialog puts on a suggestion, and the first key it ranks by. It is
   * a fact about the agent, not permission to seat it: the user's choice is
   * authoritative and a mismatch costs one persona addendum (§9-5).
   */
  readonly declaresRole: boolean;
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

/**
 * `pattern_config_json` as `plan()` may read it — never throwing.
 *
 * The column is orchestrator's own free JSON (§2.1) and nothing revalidates it
 * on read, so a row written by an older build, or hand-edited, must not be able
 * to crash the planner. Unparsable is the empty config, which is the same thing
 * as "no overrides".
 */
function patternConfigOf(json: string): Readonly<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== 'object' || parsed === null) return {};
    return parsed as Readonly<Record<string, unknown>>;
  } catch {
    return {};
  }
}

/**
 * Whether the artifact guard applies to this assignment (§3.3's
 * `requireArtifact`, config default `true`).
 *
 * Two ways out, and both are honest rather than lenient. An assignment with no
 * `artifactPath` has nothing to hash, so the hash would be `null` forever and
 * the guard would re-plan the drafter until it halted on a rule it cannot
 * satisfy. And `requireArtifact: false` is the config saying this pair is
 * critiquing something other than a file — the one shape §3.3 warns is a
 * conversation rather than a review, but a shape the flag exists to allow.
 * Anything else — a missing key, a key of the wrong type — is the default:
 * guard on.
 */
function requiresArtifact(state: AssignmentState): boolean {
  if (state.assignment.artifactPath === null) return false;
  return patternConfigOf(state.assignment.patternConfigJson)['requireArtifact'] !== false;
}

/**
 * §3.3's three seat-agnostic rows, in one implementation.
 *
 * `blocked`, `unstructured` and `failed` say nothing about *which* seat produced
 * them, so both sequential patterns branch on them identically and a second copy
 * would be a rule that could drift. `undefined` means "the turn finished with a
 * report" and the caller's own table decides what happens next.
 *
 * `extra` rides on the retry prompt: an overseer's failed review turn has to be
 * re-issued with the children it was supposed to look at, or the retry would ask
 * the lead to review nothing.
 */
function unfinishedTurn(
  state: AssignmentState,
  last: TurnRow,
  agentId: string,
  extra: { readonly children?: readonly ChildState[] | undefined } = {},
): PlanResult | undefined {
  // §3.3: a `blocked` seat waits for the answer, then re-runs the same seat and
  // round with the answer prepended. Orchestrator never resumes the session
  // itself (§4.4, R6) — the turn ended cleanly and the engine re-drives it.
  if (last.status === 'blocked') return answeredOrWait(state, last, agentId);

  // §8.1 `unstructured`: the same seat producing two turns with no
  // `report_status` halts `no_report`. The first one is re-planned once with a
  // stricter instruction, because a wiring bug and a disobedient model look
  // identical from here and one retry distinguishes them cheaply.
  if (last.status === 'unstructured') {
    // The counter is `breakers.ts`'s, so §8.1's "re-derived from
    // `assignment_turns`" has exactly one implementation (see that file's
    // ownership table for why the *action* is here rather than there).
    if (unstructuredForSeat(state.turns, last.seat) >= 2 && state.resumeRequested !== true) {
      return { halt: true, haltReason: 'no_report' };
    }
    return retryPlan(state, last, agentId, extra);
  }

  // §8.1 `turn_failures`: two consecutive failed/orphaned turn sessions.
  if (last.status === 'failed') {
    if (consecutiveFailures(state.turns) >= 2 && state.resumeRequested !== true) {
      return { halt: true, haltReason: 'turn_failures' };
    }
    return retryPlan(state, last, agentId, extra);
  }

  return undefined;
}

/**
 * §3.3's blocked row: the answer, the wait for it — or the way out when neither
 * will ever come.
 *
 * The wait is only correct while an answer is still *possible*. Two shapes make
 * it impossible: the newest decision was answered **before** this turn blocked
 * (so `question.answered` has already fired and will not fire again), and there
 * is no card at all for a seat that reported `blocked`. Both leave an `open`,
 * `running` assignment with nothing scheduled — the dead-end the engine's
 * recovery pass keeps re-entering and this branch is the only thing that can
 * get out of.
 *
 * So when nothing is open, the same seat and round are re-planned instead. The
 * retry either raises its question again (and the next wait is a real one) or
 * finishes; it never loops, because a *second* blocked turn in the same
 * seat-and-round is left to wait — after which `maxAgeHours` is the backstop,
 * and a halt the user can see beats a retry the user cannot.
 */
function answeredOrWait(state: AssignmentState, last: TurnRow, agentId: string): PlanResult {
  const decision = state.openQuestion;
  const answer = decision?.answerText;
  const stale =
    decision?.answeredAt !== undefined &&
    last.endedAt !== null &&
    decision.answeredAt < last.endedAt;
  if (answer === undefined || stale) {
    const answerable = state.hasOpenQuestion !== false || blockedAgain(state.turns, last);
    return answerable ? { wait: true, reason: 'awaiting_answer' } : retryPlan(state, last, agentId);
  }
  return {
    seat: last.seat,
    agentId,
    round: last.round,
    prompt: {
      intent: 'answered',
      seat: last.seat,
      round: last.round,
      answer: { question: decision?.prompt ?? '', text: answer },
    },
    ...continuation(state.turns, last.seat),
    priority: 'normal',
  };
}

/**
 * Has this seat already blocked twice in this round?
 *
 * The bound on the escape above. `blocked` is the one terminal status no §8.1
 * counter watches — it is not a failure and not an unstructured turn — so
 * without this a seat that blocks, is retried, and blocks again would be
 * retried forever. One recovery attempt per seat-and-round is the whole budget;
 * past that the assignment waits, and the staleness halt is what the user sees.
 */
function blockedAgain(turns: readonly TurnRow[], last: TurnRow): boolean {
  return (
    turns.filter(
      (turn) => turn.seat === last.seat && turn.round === last.round && turn.status === 'blocked',
    ).length > 1
  );
}

/** The same seat and round again, told why it is being asked twice. */
function retryPlan(
  state: AssignmentState,
  last: TurnRow,
  agentId: string,
  extra: { readonly children?: readonly ChildState[] | undefined } = {},
): TurnPlan {
  return {
    seat: last.seat,
    agentId,
    round: last.round,
    prompt: {
      intent: 'retry',
      seat: last.seat,
      round: last.round,
      retryOfTurnId: last.id,
      ...(extra.children === undefined || extra.children.length === 0
        ? {}
        : { children: extra.children }),
    },
    ...continuation(state.turns, last.seat),
    priority: 'normal',
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
