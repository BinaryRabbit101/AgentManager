/**
 * The eight circuit breakers — DESIGN §8.1, IMPLEMENTATION M7-1.
 *
 * > "All are **deterministic counters over persisted state**, evaluated by the
 * > engine before every `plan()`. No heuristics, no model in the loop."
 * > "Counters are re-derived from `assignment_turns` on every evaluation rather
 * > than being maintained incrementally, so a restart cannot lose or
 * > double-count one."
 *
 * Every counter in this file is a pure function of rows. Nothing here reads a
 * database, holds a total between calls, or consults a clock it was not handed.
 *
 * ## Who *acts* on each breaker, and why that is not all one place
 *
 * The counters live here once; the action does not, because §8.1 and §3.3
 * prescribe two different responses and only one of them is a halt:
 *
 * | Breaker | Counter | Acted on by | Why there |
 * |---|---|---|---|
 * | `budget` | runner's `tokens_used` vs `token_budget` | engine, pre-`plan()` | the arithmetic is runner's (§7.1); the engine only stops planning |
 * | `round_cap` | {@link roundsWouldExceedCap} | the pattern's `plan()` | §3.3's table terminates *with a card offering more rounds* — a halt cannot offer that |
 * | `turn_failures` | {@link consecutiveFailures} | the pattern's `plan()` | §3.3 retries the seat once first; the halt is the second failure |
 * | `unstructured` | {@link unstructuredForSeat} | the pattern's `plan()` | §3.3 re-plans once with a stricter instruction first |
 * | `no_progress` | {@link artifactUnchanged} | the pattern's `plan()` | it needs the seat vocabulary (`drafter`) only the pattern knows |
 * | `no_artifact` | {@link artifactMissingTurns} | the pattern's `plan()` | §3.3 re-plans the drafter once with the path named; the halt is the second miss |
 * | `tool_denials` | {@link denialBreaker} | engine, pre-`plan()` | nothing in a pattern's table mentions permissions |
 * | `tool_flood` | the toolset's per-session caps (§4.2) | engine, on the toolset's signal | the call must be refused *as it happens*, not at the next plan |
 * | `stale` | {@link staleSinceMs} | engine, the periodic sweep | there is no next `plan()` to hang it off — that is the point |
 *
 * The pattern-owned four call the counters below rather than counting inline, so
 * "re-derived from `assignment_turns`" is one implementation and a change to a
 * rule cannot land in one of two copies.
 */
import type { OrchestratorConfig } from './config.js';
import type { HaltReason } from './patterns.js';
import type { TurnRow } from './turns.js';

/** §8.1's names, as data, so a test can name the one it is tripping. */
export const BREAKER_NAMES = [
  'budget',
  'round_cap',
  'turn_failures',
  'unstructured',
  'no_progress',
  'no_artifact',
  'tool_denials',
  'tool_flood',
  'stale',
] as const;

export type BreakerName = (typeof BREAKER_NAMES)[number];

/**
 * What a tripped breaker tells the engine: which one, and what to halt as.
 *
 * `haltReason` is **absent for `budget`**, and that is the state machine being
 * honest rather than an omission: §7.3 puts a budget crossing at
 * `phase: awaiting_user` with a card offering a raise, not at `phase: halted`,
 * and `budget` is correspondingly not one of §8.1's halt reasons. A trip with no
 * halt reason means "stop planning and wait for the user".
 */
export interface BreakerTrip {
  readonly breaker: BreakerName;
  readonly haltReason?: HaltReason | undefined;
  readonly detail: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// The counters (pure, one per breaker input)
// ---------------------------------------------------------------------------

/** Trailing `failed` turns — §8.1's "2 consecutive turn sessions ending failed or orphaned". */
export function consecutiveFailures(turns: readonly TurnRow[]): number {
  let count = 0;
  for (const turn of [...turns].reverse()) {
    if (turn.status !== 'failed') break;
    count += 1;
  }
  return count;
}

/** How many turns of one seat produced no `report_status` (§8.1 `unstructured`). */
export function unstructuredForSeat(turns: readonly TurnRow[], seat: string): number {
  return turns.filter((turn) => turn.seat === seat && turn.status === 'unstructured').length;
}

/** Every seat's count at once — the `AssignmentState.breakers` shape. */
export function unstructuredBySeat(turns: readonly TurnRow[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const turn of turns) {
    if (turn.status !== 'unstructured') continue;
    counts[turn.seat] = (counts[turn.seat] ?? 0) + 1;
  }
  return counts;
}

/**
 * §8.1 `no_progress`: this turn's artifact hash equals the seat's previous one.
 *
 * A `null` hash never equals anything — a build that could not read the file
 * records no hash, and the breaker simply does not fire rather than firing
 * wrongly on two unknowns.
 */
export function artifactUnchanged(current: TurnRow, previous: TurnRow | undefined): boolean {
  if (previous === undefined) return false;
  if (current.artifactHash === null || previous.artifactHash === null) return false;
  return current.artifactHash === previous.artifactHash;
}

/**
 * §8.1 `no_artifact`: turns of one seat, in one round, that reported without
 * leaving a file behind.
 *
 * `artifact_hash` is the engine's own evidence — `onSessionEnded` hashes
 * `scope.artifactPath` and stores `null` when nothing is there to read — so this
 * counts the turns where the seat *claimed* it was finished and the disk
 * disagreed. Scoped to a round because the guard is about one drafting attempt:
 * a round the drafter fixed is not evidence against the next one, and a counter
 * that spanned rounds would halt an assignment whose first round merely started
 * badly.
 *
 * Only `reported` turns count. An `unstructured`, `failed` or `blocked` turn has
 * its own row in §3.3's table and its own breaker; charging it here would halt
 * on evidence another rule is already acting on.
 */
export function artifactMissingTurns(
  turns: readonly TurnRow[],
  seat: string,
  round: number,
): number {
  return turns.filter(
    (turn) =>
      turn.seat === seat &&
      turn.round === round &&
      turn.status === 'reported' &&
      turn.artifactHash === null,
  ).length;
}

/** The highest `permission_denials` any one session of this assignment recorded. */
export function maxDenialsPerSession(turns: readonly TurnRow[]): number {
  return turns.reduce((most, turn) => Math.max(most, turn.permissionDenials), 0);
}

/** Trailing turns that each recorded at least one denial (§8.1's second clause). */
export function consecutiveDenialTurns(turns: readonly TurnRow[]): number {
  let count = 0;
  for (const turn of [...turns].reverse()) {
    if (turn.status === 'planned' || turn.status === 'running') continue;
    if (turn.permissionDenials <= 0) break;
    count += 1;
  }
  return count;
}

/** §8.1 `round_cap`: the next round would pass the cap. */
export function roundsWouldExceedCap(nextRound: number, roundCap: number | null): boolean {
  return roundCap !== null && nextRound > roundCap;
}

/**
 * How long this assignment has gone without a turn transition (§8.1 `stale`).
 *
 * The reference point is the last turn timestamp there is — ended, then started
 * — and the assignment's own `updated_at` when it has taken no turn at all, so a
 * `planned` assignment nothing ever drove is caught too. That is the wedge
 * "nothing else notices".
 */
export function staleSinceMs(
  assignment: { readonly updatedAt: string | null; readonly createdAt: string },
  turns: readonly TurnRow[],
  nowMs: number,
): number {
  const stamps = [
    ...turns.map((turn) => turn.endedAt),
    ...turns.map((turn) => turn.startedAt),
    turns.length === 0 ? (assignment.updatedAt ?? assignment.createdAt) : null,
  ].filter((stamp): stamp is string => stamp !== null);
  if (stamps.length === 0) return 0;
  const latest = stamps.reduce((most, stamp) => (stamp > most ? stamp : most));
  const at = new Date(latest).getTime();
  return Number.isNaN(at) ? 0 : Math.max(0, nowMs - at);
}

// ---------------------------------------------------------------------------
// The engine's pre-`plan()` hook
// ---------------------------------------------------------------------------

export interface BreakerInput {
  readonly assignment: {
    readonly tokenBudget: number | null;
    readonly tokensUsed: number;
    readonly updatedAt: string | null;
    readonly createdAt: string;
  };
  readonly turns: readonly TurnRow[];
  readonly config: OrchestratorConfig;
  readonly nowMs: number;
  /**
   * The user pressed *Continue anyway* on the halt card (§8.1, §11.1's
   * `/advance`).
   *
   * The counters are re-derived rather than reset, which is right everywhere
   * except immediately after a human looked at the evidence and said "go on" —
   * so this suppresses the trip for exactly one advance.
   */
  readonly resumeRequested?: boolean | undefined;
  /** Whether the staleness breaker is being asked for (the sweep, not a plan). */
  readonly includeStale?: boolean | undefined;
}

/**
 * The breakers the engine itself acts on, in a fixed order.
 *
 * `budget` first, because a crossing is the one that must not be planned past
 * under any circumstances — §7.1 puts the arithmetic in runner's transaction and
 * this is the policy half re-checked before every plan, so a restart between the
 * crossing and the event cannot lose it.
 */
export function evaluateBreakers(input: BreakerInput): BreakerTrip | undefined {
  const { assignment, config } = input;

  if (assignment.tokenBudget !== null && assignment.tokensUsed >= assignment.tokenBudget) {
    return {
      breaker: 'budget',
      detail: { tokensUsed: assignment.tokensUsed, tokenBudget: assignment.tokenBudget },
    };
  }

  if (input.resumeRequested === true) return undefined;

  const denials = denialBreaker(input.turns, config);
  if (denials !== undefined) return denials;

  if (input.includeStale === true) {
    const idleMs = staleSinceMs(assignment, input.turns, input.nowMs);
    const limitMs = config.assignment.maxAgeHours * 3_600_000;
    if (idleMs >= limitMs) {
      return {
        breaker: 'stale',
        haltReason: 'stale',
        detail: {
          idleHours: Math.floor(idleMs / 3_600_000),
          maxAgeHours: config.assignment.maxAgeHours,
        },
      };
    }
  }

  return undefined;
}

/**
 * §8.1 `tool_denials`, both clauses.
 *
 * "An agent repeatedly hitting a wall is a configuration bug, not an agent bug",
 * so the halt names the count rather than blaming a seat.
 */
export function denialBreaker(
  turns: readonly TurnRow[],
  config: OrchestratorConfig,
): BreakerTrip | undefined {
  const worst = maxDenialsPerSession(turns);
  if (worst >= config.breakers.denialsPerSession) {
    return {
      breaker: 'tool_denials',
      haltReason: 'permission_fight',
      detail: { denialsInOneSession: worst, limit: config.breakers.denialsPerSession },
    };
  }
  const streak = consecutiveDenialTurns(turns);
  if (streak >= 3) {
    return {
      breaker: 'tool_denials',
      haltReason: 'permission_fight',
      detail: { consecutiveTurnsWithDenials: streak },
    };
  }
  return undefined;
}
