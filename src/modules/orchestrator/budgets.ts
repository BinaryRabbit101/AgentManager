/**
 * Budget **policy** — DESIGN §7, IMPLEMENTATION M3.
 *
 * §7.1 draws the line this file lives on: "Runner owns the arithmetic and the
 * trigger […]. Orchestrator never re-derives a token total and never polls one.
 * Orchestrator owns the *policy*: what the budget is, what the card offers, and
 * what happens next."
 *
 * So there is no arithmetic here. Runner detects the crossing in the same
 * transaction as the usage write, pauses the session with
 * `exit_reason: budget_halt`, raises a `budget_halt` question through this
 * element's bridge and emits `assignment.budget.exceeded`. What this file adds is
 * the two halves runner does not own:
 *
 * 1. **What the card offers** ({@link applyBudgetCardPolicy}). Runner's default
 *    card carries two options — raise, close. §7.3's card has three, because
 *    *Continue once* is a policy the element that owns the budget gets to offer.
 *    The card's kind, prompt and deadlines stay runner's; only the options are
 *    replaced, and only for `budget_halt`.
 * 2. **What happens on the answer** ({@link createBudgetPolicy}), under one rule
 *    stated once and obeyed everywhere:
 *
 * > **Mutate the state the answer implies, then resolve the question.**
 * > "Resolving first races runner's auto-resume."
 *
 * That ordering is not decorative. Runner's `deliverAnswer` re-reads the
 * `assignments` row the moment `question.answered` reaches it and refuses to
 * resume a session whose budget still has no headroom — and nothing re-triggers
 * it afterwards short of a restart. So the raise must be **committed to the row
 * before the event is emitted**, which is why {@link BudgetPolicy.onAnswered} is
 * synchronous and is called by the inbox between the answer write and the
 * events. A promise here would put the raise one microtask behind the resume it
 * exists to enable.
 *
 * ## Where the "original" budget comes from
 *
 * §7.3 bounds a raise at `raiseMaxFactor ×` **the original**, and there is no
 * `original_token_budget` column. Rather than adding one, the first mutation
 * records the value it is about to change into orchestrator's own
 * `pattern_config_json` (§2.1). The number it records *is* the original, because
 * it is read before any raise has happened; every later raise reads the recorded
 * one. A column would carry the same fact and one more migration.
 */
import type { EventBus } from '../types.js';

import type { OrchestratorConfig } from './config.js';
import type { AskRequest, QuestionCard, QuestionOption } from './questions.js';
import type { AssignmentRepository, AssignmentRow } from './repository.js';
import type { AssignmentService } from './types.js';

/** The marker an orchestrator-raised budget gate carries in its envelope. */
export const BUDGET_RAISE_GATE = 'orchestrator.budget.raise';

/** §7.3's three options, replacing runner's two. */
export const BUDGET_HALT_OPTIONS: readonly QuestionOption[] = [
  {
    id: 'raise',
    label: 'Raise the budget',
    description:
      'Adds 50% by default, or the number of tokens you type. The paused session resumes ' +
      'automatically once the budget allows it.',
  },
  {
    id: 'continue_once',
    label: 'Continue once',
    description:
      'A one-shot overdraft. The assignment carries on and asks again at the next crossing.',
  },
  {
    id: 'close',
    label: 'Close the assignment',
    description: 'Stops here. The paused session is discarded and the workspace lease released.',
  },
];

/**
 * §7.3's card, applied to whatever raised it.
 *
 * Runner raises the kind and writes the prompt (it knows the overshoot and which
 * sessions are parked); the options are this element's, because they *are* the
 * policy. Anything that is not a `budget_halt` passes through untouched.
 */
export function applyBudgetCardPolicy(request: AskRequest): AskRequest {
  if (request.kind !== 'budget_halt') return request;
  return { ...request, options: BUDGET_HALT_OPTIONS, allowFreeText: true };
}

/** What one answered budget card did, returned so a test can assert it. */
export interface BudgetDecision {
  readonly action: 'raised' | 'overdraft' | 'closed' | 'gated' | 'ignored';
  readonly from?: number | null;
  readonly to?: number | null;
  readonly questionId?: string;
}

export interface BudgetPolicy {
  /**
   * The inbox's pre-resolve hook: **synchronous**, and called after the answer
   * row is written and before any event is emitted (see the file header).
   */
  onAnswered(card: QuestionCard): BudgetDecision;
  /** §7.2's arithmetic-free reads, exposed for the status endpoint and tests. */
  originalBudget(row: AssignmentRow): number | null;
}

export interface BudgetPolicyOptions {
  readonly repository: AssignmentRepository;
  readonly service: () => AssignmentService;
  readonly bus: EventBus;
  readonly config: OrchestratorConfig;
  /** Raises §7.3's own approval gate when a raise passes `raiseMaxFactor`. */
  readonly raiseGate: (row: AssignmentRow, requested: number) => string;
  readonly log?: (message: string, detail?: Record<string, unknown>) => void;
}

export function createBudgetPolicy(options: BudgetPolicyOptions): BudgetPolicy {
  const { repository, bus, config } = options;

  function originalBudget(row: AssignmentRow): number | null {
    const recorded = readBudgetNote(row).original;
    return recorded ?? row.tokenBudget;
  }

  /** Commits a new budget and emits §11.4's `assignment.budget.raised`. */
  function commit(row: AssignmentRow, to: number, reason: 'raise' | 'overdraft'): BudgetDecision {
    const note = readBudgetNote(row);
    const original = note.original ?? row.tokenBudget;
    writeBudgetNote(repository, row, {
      original,
      overdrafts: note.overdrafts + (reason === 'overdraft' ? 1 : 0),
    });
    repository.update(row.id, { tokenBudget: to });
    bus.emit({
      type: 'assignment.budget.raised',
      ids: { assignmentId: row.id, projectId: row.projectId },
      persist: true,
      payload: { from: row.tokenBudget, to, reason },
    });
    options.log?.('an assignment budget was raised', {
      assignmentId: row.id,
      from: row.tokenBudget,
      to,
      reason,
    });
    return { action: reason === 'overdraft' ? 'overdraft' : 'raised', from: row.tokenBudget, to };
  }

  function onAnswered(card: QuestionCard): BudgetDecision {
    if (card.kind === 'approval_gate' && card.context?.toolName === BUDGET_RAISE_GATE) {
      return onGateAnswered(card);
    }
    if (card.kind !== 'budget_halt') return { action: 'ignored' };

    const row = repository.get(card.assignmentId);
    if (row === undefined || row.status !== 'open') return { action: 'ignored' };

    const chose = new Set(card.answer?.optionIds ?? []);
    const typed = requestedTokens(card.answer?.text ?? null);

    // Close first: it is the only answer whose mutation must beat the resume in
    // *both* directions — runner refuses to resume a closed assignment, and it
    // learns that from the row this call closes (§7.3's ordering rule).
    if (chose.has('close')) {
      // `closeAssignment` is async, but its body commits `status: closed`
      // synchronously before its first `await` (it stops sessions after). So the
      // row runner is about to read is already closed when this returns.
      void options
        .service()
        .closeAssignment(card.assignmentId, 'budget_exhausted')
        .catch((error: unknown) => {
          options.log?.('a budget-exhausted close failed', {
            assignmentId: card.assignmentId,
            error: String(error),
          });
        });
      return { action: 'closed' };
    }

    if (chose.has('continue_once')) {
      const budget = row.tokenBudget ?? row.tokensUsed;
      return commit(row, budget + config.budgets.overdraftTokens, 'overdraft');
    }

    // Everything else — the explicit `raise`, or a bare typed number — is a
    // raise. A card answered with only free text is still an answer, and
    // refusing to read it would strand the session for a formatting reason.
    if (!chose.has('raise') && typed === undefined && chose.size > 0) {
      return { action: 'ignored' };
    }

    const current = row.tokenBudget;
    if (current === null) return { action: 'ignored' }; // an uncapped assignment never halted
    const wanted = typed ?? Math.ceil(current * 1.5);
    if (wanted <= current) return { action: 'ignored' };

    // §7.3 / §8.2-3: "A raise beyond the factor requires an `approval_gate` of
    // its own." The raise is *not* applied — a gate that fires after the money is
    // spent is theatre.
    const ceiling = (originalBudget(row) ?? current) * config.budgets.raiseMaxFactor;
    if (wanted > ceiling) {
      const questionId = options.raiseGate(row, wanted);
      return { action: 'gated', from: current, to: wanted, questionId };
    }

    return commit(row, wanted, 'raise');
  }

  /** The approval gate a beyond-`raiseMaxFactor` raise created (§8.2-3). */
  function onGateAnswered(card: QuestionCard): BudgetDecision {
    const row = repository.get(card.assignmentId);
    if (row === undefined || row.status !== 'open' || row.tokenBudget === null) {
      return { action: 'ignored' };
    }
    const chose = new Set(card.answer?.optionIds ?? []);
    const input = card.context?.toolInput;
    const requested =
      typeof input === 'object' &&
      input !== null &&
      typeof (input as { tokens?: unknown }).tokens === 'number'
        ? (input as { tokens: number }).tokens
        : undefined;
    if (!chose.has('approve') || requested === undefined) {
      // Never auto-approve, and a denial leaves the budget exactly as it was —
      // the assignment stays parked on its own halt card (§8.2).
      return { action: 'ignored' };
    }
    return commit(row, requested, 'raise');
  }

  return { onAnswered, originalBudget };
}

// ---------------------------------------------------------------------------
// The note in `pattern_config_json`
// ---------------------------------------------------------------------------

interface BudgetNote {
  readonly original: number | null;
  readonly overdrafts: number;
}

export function readBudgetNote(row: AssignmentRow): BudgetNote {
  try {
    const parsed: unknown = JSON.parse(row.patternConfigJson);
    if (typeof parsed !== 'object' || parsed === null) return { original: null, overdrafts: 0 };
    const budget = (parsed as { budget?: unknown }).budget;
    if (typeof budget !== 'object' || budget === null) return { original: null, overdrafts: 0 };
    const note = budget as { original?: unknown; overdrafts?: unknown };
    return {
      original: typeof note.original === 'number' ? note.original : null,
      overdrafts: typeof note.overdrafts === 'number' ? note.overdrafts : 0,
    };
  } catch {
    return { original: null, overdrafts: 0 };
  }
}

function writeBudgetNote(
  repository: AssignmentRepository,
  row: AssignmentRow,
  note: BudgetNote,
): void {
  let base: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row.patternConfigJson);
    if (typeof parsed === 'object' && parsed !== null) base = parsed as Record<string, unknown>;
  } catch {
    base = {};
  }
  repository.setPatternConfig(row.id, { ...base, budget: note });
}

/**
 * A token count typed into the card's free-text box.
 *
 * Digits and separators only: "500k" is ambiguous between 500 000 and 500 KiB,
 * and a budget misread by a factor of a thousand is exactly the failure a
 * budget exists to prevent.
 */
export function requestedTokens(text: string | null): number | undefined {
  if (text === null) return undefined;
  const cleaned = text.replace(/[\s,_]/g, '');
  if (!/^\d+$/.test(cleaned)) return undefined;
  const value = Number.parseInt(cleaned, 10);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
