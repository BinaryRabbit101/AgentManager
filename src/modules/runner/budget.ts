/**
 * The assignment budget halt (runner DESIGN §7.2) — milestone M8.
 *
 * > "When the increment crosses `assignments.token_budget` (non-null), runner
 * > immediately: 1. pauses the session — `paused`, `exit_reason: budget_halt` —
 * > releasing the slot and keeping the lease; 2. raises a `budget_halt` question
 * > through the bridge naming the assignment, the budget, the overshoot, and the
 * > sessions involved; 3. emits `assignment.budget.exceeded`."
 *
 * ## Why the detection is a pure function here and the reaction is in `launch.ts`
 *
 * The *arithmetic* is the part that has to be exactly right and exactly once:
 * §7.2 pins `tokens_used += input + output` with cache tokens excluded, and
 * `usage.ts` already does that increment inside the metering transaction and
 * hands back the post-increment total. So the crossing test is a comparison
 * against a number that is already committed — "not via an event: a budget check
 * that lags an event-bus hop is a budget check that overruns" — and it belongs
 * next to the numbers rather than next to the session control verbs.
 *
 * ## The budget is re-read, not captured
 *
 * The launch chain already has `AssignmentContext.tokenBudget` from step 3. It
 * is deliberately *not* used here: the whole resolution path of §7.2 is "an
 * answer that raises the budget resumes the parked session", so the budget can
 * change while the session runs, and a captured value would halt a session whose
 * budget was raised a minute ago. The row is the truth, and reading it costs one
 * indexed primary-key lookup per metered turn.
 *
 * ## `>=`, not `>`
 *
 * A budget is an allowance, so it is spent when it is reached. `tokens_used`
 * equal to `token_budget` means there is nothing left, and letting the next turn
 * start would be spending money the assignment does not have. The reported
 * `overshoot` is therefore `0` in the exact-hit case, which is honest: the halt
 * happened at the line rather than past it.
 */
import type { AssignmentRecord } from '../../storage/index.js';

/** What crossed, by how much — the numbers the card and the event both carry. */
export interface BudgetCrossing {
  readonly assignmentId: string;
  readonly tokenBudget: number;
  readonly tokensUsed: number;
  /** `tokensUsed - tokenBudget`; `0` when the budget was hit exactly. */
  readonly overshoot: number;
}

/** The assignment fields the halt reads. Narrowed so a test needs no row. */
export type BudgetSubject = Pick<AssignmentRecord, 'id' | 'status' | 'tokenBudget' | 'tokensUsed'>;

/**
 * §7.2's crossing test, or `undefined` when nothing has been crossed.
 *
 * `tokensUsed` is passed separately from the row because the authoritative
 * figure is the one `assignments.addTokensUsed` returned inside the metering
 * transaction — reading it back off a row would be a second read of a number
 * that is already in hand, and one that a concurrent session could have moved.
 */
export function budgetCrossing(
  assignment: BudgetSubject | undefined,
  tokensUsed: number,
): BudgetCrossing | undefined {
  if (assignment === undefined) return undefined;
  const budget = assignment.tokenBudget;
  // §7.2's "non-null" and M8's "a `null` `token_budget` never halts anything".
  if (budget === null || !Number.isFinite(budget) || budget <= 0) return undefined;
  if (tokensUsed < budget) return undefined;
  return {
    assignmentId: assignment.id,
    tokenBudget: budget,
    tokensUsed,
    overshoot: tokensUsed - budget,
  };
}

/**
 * True when a budget-halted session may run again (§7.2's resolution).
 *
 * "An answer that raises the budget resumes the parked session by the ordinary
 * §5.4 path" — so the test is on the *row after the answer*, never on what the
 * card said. A closed assignment is not a resumption either way; that path ends
 * the session instead (M8's third criterion).
 */
export function budgetAllowsResume(assignment: BudgetSubject | undefined): boolean {
  if (assignment === undefined || assignment.status !== 'open') return false;
  const budget = assignment.tokenBudget;
  if (budget === null || !Number.isFinite(budget) || budget <= 0) return true;
  return assignment.tokensUsed < budget;
}

/**
 * The card's prompt (§7.2 step 2: "naming the assignment, the budget, the
 * overshoot, and the sessions involved").
 *
 * Runner writes the *facts*; orchestrator owns what the card offers and what
 * happens next (§7.2, §15.1-6). The wording is here rather than in the event so
 * a build with no orchestrator — where the fallback bridge writes the row itself
 * (§5.2) — still shows a human something they can act on.
 */
export function budgetHaltPrompt(crossing: BudgetCrossing, sessions: readonly string[]): string {
  const involved =
    sessions.length === 0
      ? ''
      : ` ${sessions.length === 1 ? 'Session' : 'Sessions'} ${sessions.join(', ')} ${
          sessions.length === 1 ? 'is' : 'are'
        } paused waiting on this.`;
  return (
    `Assignment ${crossing.assignmentId} has reached its token budget: ` +
    `${String(crossing.tokensUsed)} of ${String(crossing.tokenBudget)} tokens used, ` +
    `an overshoot of ${String(crossing.overshoot)}.` +
    involved +
    ' Raise the budget to continue, or close the assignment to stop here.'
  );
}

/** The `budget_halt` card's options. Orchestrator may replace them; runner needs defaults. */
export const BUDGET_HALT_OPTIONS = [
  {
    id: 'raise',
    label: 'Raise the budget',
    description: 'The paused session resumes automatically once the budget allows it.',
  },
  {
    id: 'close',
    label: 'Close the assignment',
    description: 'The paused session is discarded and the workspace lease is released.',
  },
] as const;
