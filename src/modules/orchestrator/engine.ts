/**
 * The pattern engine — DESIGN §3.1's loop, IMPLEMENTATION M5-2..M5-5 and
 * M6-4/M6-7.
 *
 * ```
 * assignment.created / advance / session.ended / question.answered / assignment.budget.exceeded
 *         │
 *         ├─ acquire the per-assignment in-process mutex
 *         ├─ reload AssignmentState from the DB          (never from memory)
 *         ├─ evaluate breakers (§8) → halt if tripped
 *         ├─ pattern.plan(state)
 *         │     ├─ TurnPlan     → insert assignment_turns row (the partial unique index is the guard)
 *         │     │                 → compose the prompt (§3.2) → runner.startSession | runner.continueFrom
 *         │     └─ Termination  → close or halt, raise the card, emit events
 *         └─ release the mutex
 * ```
 *
 * Everything durable is in the database and everything decided is in
 * `patterns.ts`. What lives here is exactly the two things a pure function cannot
 * be: the I/O, and the *one* piece of process state that is genuinely
 * process-shaped — the mutex, which serialises two triggers arriving for one
 * assignment in the same tick. It is not a substitute for the database's guard:
 * `assignment_turns_active` is what makes the loop safe across a restart, and the
 * mutex only saves a doomed insert.
 *
 * ## Reading a turn's output: which of §3.2's three channels this build has
 *
 * §3.2 prefers (1) the `report_status` payload, then (2) a live
 * `session.message` capture, then (3) the transcript tail. **This runner build
 * emits no `session.message` event** — its bus vocabulary is
 * `session.queued/started/usage/steered/paused/ended/diagnostic/question.*`. So
 * channel 2 is unavailable and the engine uses channel 3 (R3's in-process
 * `getTranscriptTail`, probed on the runner port) as its live capture, falling
 * back to `session.ended`'s `summary` when the transcript is pruned or the read
 * is absent. This is a deviation from the milestone text, recorded here and in
 * the report rather than quietly implemented as if channel 2 existed.
 *
 * ## Round-cap termination closes on the *answer*, not before it
 *
 * §3.3 says the round cap "terminates" **and** that the user then gets a
 * three-option card — *Accept as-is* / *Run N more rounds* / *Close unfinished*.
 * Those two cannot both be true of a closed assignment: "run one more round" is
 * impossible on a `status: closed` row and nothing in the design reopens one. So
 * the engine reads "terminate" as the pattern's half — plan no further turns —
 * and defers the *close* to the answer: `phase: awaiting_user`, which §2.2
 * explicitly says is still `open`. Accept-as-is closes `converged`, close-unfinished
 * closes `round_cap`, and one more round raises the cap (bounded by
 * `patterns.pair.maxRoundCap`) and re-enters the loop. The user is still the
 * tie-breaker exactly once, at the end.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, join, normalize, resolve as resolvePath, sep } from 'node:path';

import type { AppEvent, EventBus, Unsubscribe } from '../types.js';
import type { Clock, SessionsRepository, SessionStatus } from '../../storage/index.js';

import {
  evaluateBreakers,
  unstructuredBySeat,
  consecutiveFailures,
  type BreakerTrip,
} from './breakers.js';
import {
  raiseCard as raiseEngineCard,
  GATE_CARD_PREFIX,
  GATE_OPTIONS,
  type CardSpec,
} from './cards.js';
import type { OrchestratorConfig } from './config.js';
import { AssignmentNotFoundError } from './errors.js';
import type { MailboxRepository } from './messages.js';
import {
  hasContinuation,
  hasLauncher,
  hasOverseerRoster,
  hasTranscriptTail,
  type OverseerRosterEntryPort,
  type ProjectsPort,
  type RosterPort,
  type RunnerPort,
} from './ports.js';
import {
  cardSeatOrder,
  isDone,
  isHalt,
  isTurnPlan,
  isWait,
  patternFor,
  planChildSolo,
  LEAD_SEAT,
  PATTERNS,
  type AssignmentState,
  type ChildState,
  type HaltReason,
  type PatternDef,
  type PatternSummary,
  type PlanResult,
  type SeatCandidate,
  type StateMember,
  type TurnPlan,
} from './patterns.js';
import { composePrompt, type OpenDecision } from './prompt.js';
import type { QuestionInbox } from './questions.js';
import type { AssignmentRepository, AssignmentRow } from './repository.js';
import { TurnAlreadyActiveError, type TurnRepository, type TurnRow } from './turns.js';
import type { AssignmentScope, AssignmentService, CloseReason } from './types.js';

/**
 * The marker that tells an answered card apart from an agent's question.
 *
 * It rides in the envelope's `context.toolName`, which is orchestrator's own
 * shape (`questions.ts`), rather than in a new column: the engine needs to
 * recognise *its own* cards on the answer path, and a card's identity is not a
 * fact any other element reads.
 */
export const ROUND_CAP_CARD = 'orchestrator.round_cap';
export const HALT_CARD_PREFIX = 'orchestrator.halt.';

/** The three options of §3.3's round-cap card. */
export const ROUND_CAP_OPTIONS = [
  { id: 'accept', label: 'Accept as-is' },
  { id: 'more_rounds', label: 'Run one more round' },
  { id: 'close', label: 'Close unfinished' },
] as const;

export type AdvanceOutcome =
  | {
      readonly kind: 'planned';
      readonly turnId: string;
      readonly seat: string;
      readonly agentId: string;
      readonly round: number;
      readonly sessionId: string;
      readonly continued: boolean;
    }
  | { readonly kind: 'closed'; readonly closeReason: CloseReason }
  | { readonly kind: 'awaiting_user'; readonly questionId: string; readonly reason: string }
  | { readonly kind: 'halted'; readonly haltReason: HaltReason; readonly questionId: string }
  | { readonly kind: 'idle'; readonly reason: string };

/** What the boot reconciliation of M5-5 did, returned so a test can drive it. */
export interface TurnReconciliation {
  readonly failedTurns: readonly string[];
  readonly resumed: readonly string[];
}

export interface PatternEngine {
  /** `POST /api/assignments/:id/advance`, and every internal trigger. */
  advance(assignmentId: string, options?: { readonly manual?: boolean }): Promise<AdvanceOutcome>;
  /** `GET /api/patterns` (M5-1). */
  patterns(): readonly PatternSummary[];
  /** M5-5's boot task. */
  reconcileOnBoot(): Promise<TurnReconciliation>;
  /**
   * §8.1's `stale` breaker (M7-5), one pass.
   *
   * Returned as a callable rather than only scheduled, so a test drives one tick
   * instead of waiting a day for the timer that calls it.
   */
  sweepStale(): Promise<readonly string[]>;
  /**
   * §8.1's `tool_flood`, signalled by the toolset when a per-session cap is
   * exceeded (§4.2). Stops the session, then halts.
   */
  tripToolFlood(assignmentId: string, sessionId?: string): Promise<void>;
  /** Subscribes to the bus; the returned function detaches (module `stop`). */
  attach(): Unsubscribe;
  /** Read model for §11.2, built in `conversation.ts`. */
  turns(assignmentId: string): readonly TurnRow[];
}

export interface PatternEngineOptions {
  readonly repository: AssignmentRepository;
  readonly turns: TurnRepository;
  readonly mailbox: MailboxRepository;
  /** Read-only: the boot sweep asks whether a turn's session is still alive. */
  readonly sessions: SessionsRepository;
  readonly service: () => AssignmentService;
  readonly inbox: () => QuestionInbox | undefined;
  readonly runner: () => RunnerPort | undefined;
  readonly projects: () => ProjectsPort | undefined;
  /** Roster, for §16-9's candidate ranking on `GET /api/patterns` (M9-4). */
  readonly roster?: (() => RosterPort | undefined) | undefined;
  readonly bus: EventBus;
  readonly clock: Clock;
  readonly config: OrchestratorConfig;
  /** `runner.question.expireHours`, read from runner's config (§12). */
  readonly expireHours: number;
  /** Injectable so a test can hash without a workspace on disk. */
  readonly readArtifact?: (absolutePath: string) => string | undefined;
  readonly log?: (
    level: 'debug' | 'info' | 'warn',
    message: string,
    detail?: Record<string, unknown>,
  ) => void;
}

/** Session statuses that mean the turn's session failed rather than finished. */
const FAILED_SESSION_STATUSES: readonly SessionStatus[] = ['failed', 'orphaned', 'interrupted'];

export function createPatternEngine(options: PatternEngineOptions): PatternEngine {
  const { repository, turns, mailbox, bus, config } = options;

  /**
   * One promise chain per assignment (§3.1's "per-assignment in-process mutex").
   *
   * Per assignment rather than global, because two assignments genuinely run
   * concurrently and a global lock would serialise them behind each other for no
   * reason. Entries are dropped as they drain, so the map does not grow with the
   * number of assignments the process has ever seen.
   */
  const locks = new Map<string, Promise<void>>();

  function log(
    level: 'debug' | 'info' | 'warn',
    message: string,
    detail?: Record<string, unknown>,
  ): void {
    options.log?.(level, message, detail);
  }

  function withLock<T>(assignmentId: string, work: () => Promise<T>): Promise<T> {
    const previous = locks.get(assignmentId) ?? Promise.resolve();
    // `then(work, work)` rather than `then(work)`: a *previous* holder that threw
    // must not stop the next one from running — the lock serialises, it does not
    // propagate failure sideways.
    const result = previous.then(work, work);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    locks.set(assignmentId, tail);
    void tail.then(() => {
      // Drop the entry only when nothing newer replaced it, so the map does not
      // grow with every assignment the process has ever driven.
      if (locks.get(assignmentId) === tail) locks.delete(assignmentId);
    });
    return result;
  }

  // -------------------------------------------------------------------------
  // State loading — never from memory (§3.1)
  // -------------------------------------------------------------------------

  function parseScope(row: AssignmentRow): AssignmentScope | null {
    if (row.scopeJson === null) return null;
    try {
      const parsed: unknown = JSON.parse(row.scopeJson);
      if (typeof parsed !== 'object' || parsed === null) return null;
      const record = parsed as Record<string, unknown>;
      return {
        paths: Array.isArray(record['paths'])
          ? record['paths'].filter((path): path is string => typeof path === 'string')
          : [],
        ...(typeof record['description'] === 'string'
          ? { description: record['description'] }
          : {}),
        ...(typeof record['artifactPath'] === 'string'
          ? { artifactPath: record['artifactPath'] }
          : {}),
      };
    } catch {
      return null;
    }
  }

  function members(assignmentId: string): readonly StateMember[] {
    return repository.listMembers(assignmentId).map((member) => ({
      agentId: member.agentId,
      role: member.role,
      seatOrder: member.seatOrder,
    }));
  }

  /**
   * The assignment's most recent decision card, and its answer once one lands.
   *
   * §3.3's blocked-seat rule needs the *answered* card and §6.4's solicitation
   * needs the *open* one, and they are the same row at two moments — so this
   * returns one value with `answerText` present only in the second case.
   * Engine-raised cards (round cap, halts) are excluded: a seat is never
   * re-planned by its own halt card.
   */
  function latestDecision(assignmentId: string): AssignmentState['openQuestion'] {
    const inbox = options.inbox();
    if (inbox === undefined) return undefined;
    const newest = inbox
      .list({ assignmentId })
      .find((card) => card.kind === 'question' && !isEngineCard(card.context)); // newest first
    if (newest === undefined) return undefined;
    const answerText =
      newest.status === 'answered'
        ? [...(newest.answer?.optionIds ?? []), newest.answer?.text ?? '']
            .filter((part) => part !== '')
            .join(' ')
        : '';
    return {
      id: newest.id,
      seat: '',
      prompt: newest.prompt,
      ...(answerText === '' ? {} : { answerText }),
      ...(newest.answeredAt === null ? {} : { answeredAt: newest.answeredAt }),
    };
  }

  /**
   * §3.5's children, resolved for the pattern that has any.
   *
   * The child's **last structured report** is read here rather than in
   * `plan()`, because `plan()` is pure over its state and a child's report lives
   * in the child's own turn table. Only for a pattern whose `plan()` can act on
   * them: every advance of every pair would otherwise pay for a query whose
   * answer is always empty.
   */
  function childrenOf(row: AssignmentRow): readonly ChildState[] {
    if (row.pattern !== 'overseer') return [];
    return [...repository.listChildren(row.id)].reverse().map((child) => {
      const reported = turns.list(child.id).filter((turn) => turn.report !== null).at(-1);
      return {
        id: child.id,
        goal: child.goal,
        pattern: child.pattern,
        status: child.status,
        phase: child.phase,
        closeReason: child.closeReason,
        haltReason: child.haltReason,
        artifactPath: child.artifactPath,
        tokenBudget: child.tokenBudget,
        tokensUsed: child.tokensUsed,
        closedAt: child.closedAt,
        members: repository
          .listMembers(child.id)
          .map((member) => ({ agentId: member.agentId, role: member.role })),
        report: reported?.report ?? null,
      };
    });
  }

  function loadState(row: AssignmentRow, resumeRequested = false): AssignmentState {
    const rows = turns.list(row.id);
    const decision = latestDecision(row.id);
    return {
      ...(resumeRequested ? { resumeRequested } : {}),
      assignment: row,
      scope: parseScope(row),
      members: members(row.id),
      turns: rows,
      children: childrenOf(row),
      roundsUsed: row.roundsUsed,
      tokensUsed: row.tokensUsed,
      budget: row.tokenBudget,
      roundCap: row.roundCap,
      ...(decision === undefined ? {} : { openQuestion: decision }),
      breakers: {
        // §8.1: "counters are re-derived from `assignment_turns` on every
        // evaluation rather than being maintained incrementally" — all of them
        // through `breakers.ts`, which is the one implementation of each.
        consecutiveFailures: consecutiveFailures(rows),
        unstructuredBySeat: unstructuredBySeat(rows),
        denialsPerSession: rows.reduce((most, turn) => Math.max(most, turn.permissionDenials), 0),
      },
    };
  }

  // -------------------------------------------------------------------------
  // The loop
  // -------------------------------------------------------------------------

  function advance(
    assignmentId: string,
    advanceOptions: { manual?: boolean } = {},
  ): Promise<AdvanceOutcome> {
    return withLock(assignmentId, () =>
      advanceLocked(assignmentId, advanceOptions.manual === true),
    );
  }

  async function advanceLocked(assignmentId: string, manual: boolean): Promise<AdvanceOutcome> {
    const row = repository.get(assignmentId);
    if (row === undefined) throw new AssignmentNotFoundError(assignmentId);

    const drive = driverFor(row);
    if (drive === undefined) {
      // M5-6: solo runs through the engine unchanged. Driver `none` plans
      // nothing, which is the abstraction working rather than a special case.
      return { kind: 'idle', reason: 'no_driver' };
    }
    if (row.status !== 'open') return { kind: 'idle', reason: 'assignment_closed' };

    // A manual advance out of `halted` is §8.1's "Continue anyway": the halting
    // evidence stays in `assignment_turns` (nothing is rewritten), but this one
    // advance is allowed to look past it.
    const resumeRequested = manual && (row.phase === 'halted' || row.haltReason !== null);

    // §3.1's loop: **evaluate breakers, then plan**. Ahead of the phase gate on
    // purpose — a manual advance that flipped the phase to `running` first would
    // rewrite the state its own breaker is about to undo. The counters come from
    // the table on every pass, so a restart between a crossing and its event
    // cannot lose one (§8.1).
    const trip = evaluateBreakers({
      // §7.5: a parent is judged on what its **tree** has spent. Runner meters
      // each child onto the child's own row (§7.1) and orchestrator never
      // re-derives that arithmetic — it only adds the rows up, so a lead whose
      // workers burned the budget stops planning instead of delegating again.
      assignment: { ...row, tokensUsed: row.tokensUsed + repository.childTokens(row.id).used },
      turns: turns.list(row.id),
      config,
      nowMs: options.clock().getTime(),
      resumeRequested,
    });
    if (trip !== undefined) return await actOnTrip(row, trip);

    const gate = phaseGate(row, manual);
    if (gate !== undefined) return gate;

    const state = loadState(repository.get(assignmentId) ?? row, resumeRequested);
    const result = drive(state);
    return await act(state, result);
  }

  /**
   * Which `plan()` drives this row — §3.1's registry, plus §3.5's one exception.
   *
   * The exception is a property of the **row**, not of the pattern: a `solo` the
   * user launched is steered by the user through runner's own actions (§2.3),
   * while a `solo` an overseer minted has nobody to steer it and a parent
   * waiting on it to finish. So the driverless pattern gains a driver exactly
   * when `parent_assignment_id` is set, and never otherwise.
   */
  function driverFor(row: AssignmentRow): ((state: AssignmentState) => PlanResult) | undefined {
    const pattern = patternFor(row.pattern);
    if (pattern === undefined) return undefined;
    if (pattern.driver !== 'none') return (state) => pattern.plan(state);
    return row.parentAssignmentId === null ? undefined : planChildSolo;
  }

  /** Which phases the driver may plan from, and which need a manual kick. */
  function phaseGate(row: AssignmentRow, manual: boolean): AdvanceOutcome | undefined {
    if (row.phase === 'running') return undefined;
    if (!manual) return { kind: 'idle', reason: `phase_${row.phase}` };
    // A manual advance is the resume-after-halt path (§11.1, M7-2): it clears the
    // halt reason, because leaving it set would make the next halt card
    // indistinguishable from the one the user just dismissed.
    repository.setPhase(row.id, 'running', null);
    return undefined;
  }

  /**
   * A breaker the engine itself owns (`breakers.ts`'s ownership table).
   *
   * `budget` is the one trip that is not a halt: §7.3 parks the assignment at
   * `awaiting_user` behind a card that offers a raise, and a `halted` phase would
   * make the raise look like a breaker override.
   */
  async function actOnTrip(row: AssignmentRow, trip: BreakerTrip): Promise<AdvanceOutcome> {
    if (trip.haltReason === undefined) return awaitBudgetDecision(row);
    log('info', 'a circuit breaker tripped', {
      assignmentId: row.id,
      breaker: trip.breaker,
      ...trip.detail,
    });
    return await halt(row, trip.haltReason);
  }

  /**
   * §8.1's halt: one phase change, one card, one event, and no further turns.
   *
   * "**Running sessions are not killed by a halt** except `tool_flood`" — so
   * nothing here stops a session; the one breaker that does calls
   * {@link tripToolFlood}, which stops it before halting.
   */
  async function halt(row: AssignmentRow, haltReason: HaltReason): Promise<AdvanceOutcome> {
    repository.setPhase(row.id, 'halted', haltReason);
    const questionId = await raiseHaltCard(row, haltReason);
    bus.emit({
      type: 'assignment.halted',
      ids: { assignmentId: row.id, projectId: row.projectId },
      persist: true,
      payload: { haltReason, questionId },
    });
    log('warn', 'an assignment halted', { assignmentId: row.id, haltReason });
    return { kind: 'halted', haltReason, questionId };
  }

  /**
   * §8.1's `tool_flood`, the only breaker that also kills the session.
   *
   * The toolset refuses the call as it happens and signals here; this stops the
   * session first and halts second, in that order, because a session left
   * running past its own flood halt would keep calling the tool that refused it.
   */
  async function tripToolFlood(assignmentId: string, sessionId: string | undefined): Promise<void> {
    const row = repository.get(assignmentId);
    if (row === undefined || row.status !== 'open') return;
    const active = turns.active(assignmentId);
    const target = sessionId ?? active?.sessionId ?? undefined;
    const runner = options.runner();
    if (target !== undefined && hasLauncher(runner)) {
      try {
        await runner.stop(target, 'tool_flood: a per-session tool-call cap was exceeded');
      } catch (error) {
        log('warn', 'a flooded session could not be stopped', {
          assignmentId,
          sessionId: target,
          error: String(error),
        });
      }
    }
    if (row.phase !== 'halted') await halt(row, 'tool_flood');
  }

  async function act(state: AssignmentState, result: PlanResult): Promise<AdvanceOutcome> {
    const row = state.assignment;

    if (isTurnPlan(result)) return await launch(state, result);

    if (isHalt(result)) return await halt(row, result.haltReason);

    if (isDone(result)) {
      if (result.closeReason === 'round_cap') {
        // See the file header: terminate the pattern, defer the close to the
        // answer, so "run one more round" is an option that can actually be taken.
        repository.setPhase(row.id, 'awaiting_user', null);
        const questionId = await raiseRoundCapCard(row, result.summary);
        return { kind: 'awaiting_user', questionId, reason: 'round_cap' };
      }
      await options.service().closeAssignment(row.id, result.closeReason);
      log('info', 'an assignment terminated', {
        assignmentId: row.id,
        closeReason: result.closeReason,
        summary: result.summary,
      });
      return { kind: 'closed', closeReason: result.closeReason };
    }

    return { kind: 'idle', reason: isWait(result) ? result.reason : 'unreachable' };
  }

  // -------------------------------------------------------------------------
  // Launching a turn
  // -------------------------------------------------------------------------

  async function launch(state: AssignmentState, plan: TurnPlan): Promise<AdvanceOutcome> {
    const row = state.assignment;
    const runner = options.runner();
    if (!hasLauncher(runner)) {
      log('warn', 'a turn could not be planned: this build cannot start sessions', {
        assignmentId: row.id,
      });
      return { kind: 'idle', reason: 'runner_unavailable' };
    }

    let turn: TurnRow;
    try {
      turn = turns.plan({
        assignmentId: row.id,
        round: plan.round,
        seat: plan.seat,
        agentId: plan.agentId,
        ...(plan.continueFromSessionId === undefined
          ? {}
          : { prevSessionId: plan.continueFromSessionId }),
      });
    } catch (error) {
      if (error instanceof TurnAlreadyActiveError) {
        // The database refused a second in-flight turn, which is exactly what it
        // is for. Nothing is wrong and nothing more is done.
        return { kind: 'idle', reason: 'turn_in_flight' };
      }
      throw error;
    }

    const role = state.members.find((member) => member.agentId === plan.agentId)?.role;
    const prompt = composePrompt({
      spec: plan.prompt,
      patternId: row.pattern,
      goal: row.goal,
      scope: state.scope,
      artifactPath: row.artifactPath,
      write: row.write,
      role: role ?? 'implementer',
      roundCap: row.roundCap,
      tokenBudget: row.tokenBudget,
      tokensUsed: row.tokensUsed,
      mail: mailbox.inlineFor(plan.agentId, row.id, {
        inlineMax: config.mailbox.inlineMax,
        inlineMaxBytes: config.mailbox.inlineMaxBytes,
      }),
      decisions: solicitations(state),
      budgets: { maxBytes: config.prompt.maxBytes, excerptBytes: config.prompt.excerptBytes },
    });

    const previousSession = plan.continueFromSessionId;
    const continued = previousSession !== undefined && hasContinuation(runner);
    let sessionId: string;
    try {
      const launched =
        continued && previousSession !== undefined
          ? await runner.continueFrom(previousSession, prompt.text)
          : await runner.startSession({
              assignmentId: row.id,
              agentId: plan.agentId,
              projectId: row.projectId,
              prompt: prompt.text,
              ...(role === undefined ? {} : { role }),
              priority: plan.priority,
            });
      sessionId = launched.sessionId;
    } catch (error) {
      // The turn row exists and its session does not. Marking it `failed` is what
      // keeps the assignment drivable: the pattern's own failure rules then apply,
      // and two consecutive launch failures halt rather than spin.
      turns.complete(turn.id, { status: 'failed' });
      emitTurnEnded(row, turns.get(turn.id) ?? turn, 'failed', 'launch_failed');
      log('warn', 'a planned turn could not be launched', {
        assignmentId: row.id,
        turnId: turn.id,
        error: String(error),
      });
      return { kind: 'idle', reason: 'launch_failed' };
    }

    if (plan.continueFromSessionId !== undefined && !continued) {
      // Recorded rather than silent: the seat's SDK conversation is *not* being
      // resumed in this build, and a reader of the turn table deserves to know
      // why `prev_session_id` is set while `resumed_from` is not (see ports.ts).
      log('info', 'a seat’s later turn started a fresh session: runner has no continueFrom yet', {
        assignmentId: row.id,
        turnId: turn.id,
        prevSessionId: plan.continueFromSessionId,
      });
    }

    const started = turns.start(turn.id, sessionId);
    const first = state.turns.length === 0;
    if (row.phase !== 'running') repository.setPhase(row.id, 'running', null);

    if (first) {
      bus.emit({
        type: 'assignment.started',
        ids: {
          assignmentId: row.id,
          projectId: row.projectId,
          agentId: plan.agentId,
          sessionId,
        },
        persist: true,
        payload: { firstTurnId: started.id, seat: plan.seat, agentId: plan.agentId },
      });
    }
    bus.emit({
      type: 'assignment.turn.started',
      ids: { assignmentId: row.id, projectId: row.projectId, agentId: plan.agentId, sessionId },
      persist: true,
      payload: {
        turnId: started.id,
        round: started.round,
        seat: started.seat,
        agentId: started.agentId,
        sessionId,
        continueFrom: plan.continueFromSessionId ?? null,
        promptBytes: prompt.bytes,
        promptTruncated: prompt.truncated,
      },
    });

    return {
      kind: 'planned',
      turnId: started.id,
      seat: started.seat,
      agentId: started.agentId,
      round: started.round,
      sessionId,
      continued,
    };
  }

  /** §6.4's stance solicitation, and the config switch that turns it off. */
  function solicitations(state: AssignmentState): readonly OpenDecision[] {
    if (state.assignment.pattern === 'pair' && !config.patterns.pair.stanceSolicitation) return [];
    const inbox = options.inbox();
    if (inbox === undefined) return [];
    return inbox
      .list({ assignmentId: state.assignment.id, status: 'open' })
      .filter((card) => card.kind === 'question' && !isEngineCard(card.context))
      .map((card) => ({
        questionId: card.id,
        prompt: card.prompt,
        options: card.options.map((option) => ({ id: option.id, label: option.label })),
      }));
  }

  // -------------------------------------------------------------------------
  // Turn completion (M5-3)
  // -------------------------------------------------------------------------

  async function onSessionEnded(event: AppEvent): Promise<void> {
    const sessionId = event.ids.sessionId;
    if (sessionId === undefined) return;
    const turn = turns.findBySession(sessionId);
    if (turn === undefined) return;
    if (turn.status !== 'planned' && turn.status !== 'running') return;

    const payload = (event.payload ?? {}) as {
      status?: unknown;
      exitReason?: unknown;
      summary?: unknown;
      permissionDenials?: unknown;
    };
    const sessionStatus = typeof payload.status === 'string' ? payload.status : 'done';
    const exitReason = typeof payload.exitReason === 'string' ? payload.exitReason : null;

    const assignmentId = turn.assignmentId;
    await withLock(assignmentId, async () => {
      const row = repository.get(assignmentId);
      if (row === undefined) return;

      const artifactHash = await hashArtifact(row);
      const output =
        turn.report !== null
          ? null
          : await captureOutput(
              sessionId,
              typeof payload.summary === 'string' ? payload.summary : null,
            );

      const status = classify(turn, sessionStatus);
      const completed = turns.complete(turn.id, {
        status,
        ...(output === null ? {} : { outputText: output }),
        ...(artifactHash === null ? {} : { artifactHash }),
        // §8.1's `tool_denials` input, written where it can be re-derived from.
        ...(typeof payload.permissionDenials === 'number'
          ? { permissionDenials: payload.permissionDenials }
          : {}),
      });
      emitTurnEnded(row, completed, sessionStatus, exitReason, payload.permissionDenials);

      // A round ends when the seat that closes it — the critic, for the pair —
      // finishes. `rounds_used` is incremented exactly here, once, so the cap and
      // the projection read the same number the UI does.
      if (isRoundClosingSeat(row, completed) && completed.status === 'reported') {
        repository.incrementRounds(row.id, 1);
        const verdict = completed.report?.verdict;
        bus.emit({
          type: 'assignment.round.completed',
          ids: { assignmentId: row.id, projectId: row.projectId },
          persist: true,
          payload: {
            round: completed.round,
            converged: verdict?.decision === 'accept' && (verdict.blocking ?? []).length === 0,
            blockingCount: (verdict?.blocking ?? []).length,
          },
        });
      }
    });

    // Outside the lock: `advance` takes it itself, and nesting it would deadlock.
    await advance(assignmentId).catch((error: unknown) => {
      log('warn', 'the engine could not advance after a turn ended', {
        assignmentId,
        error: String(error),
      });
      return { kind: 'idle', reason: 'error' };
    });
  }

  /**
   * A finished session → the turn status §3.3's table branches on.
   *
   * The order matters: a session that *failed* is a failed turn even if a report
   * landed earlier in it, because the work did not finish; and a `done` session
   * with no report is `unstructured` however good its prose was — "the engine
   * never parses prose for a verdict".
   */
  function classify(
    turn: TurnRow,
    sessionStatus: string,
  ): 'reported' | 'unstructured' | 'blocked' | 'failed' {
    if ((FAILED_SESSION_STATUSES as readonly string[]).includes(sessionStatus)) return 'failed';
    if (turn.report === null) return 'unstructured';
    return turn.report.state === 'blocked' ? 'blocked' : 'reported';
  }

  /**
   * The seat whose report ends a round.
   *
   * For the pair it is the critic — the drafter's turn is half a round. For the
   * overseer it is the lead, because it holds the only seat: one turn *is* one
   * round there (decompose, then one review per batch of finished children).
   */
  function isRoundClosingSeat(row: AssignmentRow, turn: TurnRow): boolean {
    if (row.pattern === 'pair') return turn.seat === 'critic';
    return row.pattern === 'overseer' && turn.seat === LEAD_SEAT;
  }

  function emitTurnEnded(
    row: AssignmentRow,
    turn: TurnRow,
    sessionStatus: string,
    exitReason: string | null,
    permissionDenials?: unknown,
  ): void {
    bus.emit({
      type: 'assignment.turn.ended',
      ids: {
        assignmentId: row.id,
        projectId: row.projectId,
        agentId: turn.agentId,
        ...(turn.sessionId === null ? {} : { sessionId: turn.sessionId }),
      },
      persist: true,
      payload: {
        turnId: turn.id,
        round: turn.round,
        seat: turn.seat,
        status: turn.status,
        sessionStatus,
        exitReason,
        permissionDenials: typeof permissionDenials === 'number' ? permissionDenials : 0,
      },
    });
  }

  /**
   * §3.2's output capture, from the channels this build actually has.
   *
   * Channel 3 first (R3's in-process transcript read — "no HTTP call to our own
   * process"), then `session.ended`'s `summary`. A pruned transcript is a value
   * rather than a throw, which is why this never rejects.
   */
  async function captureOutput(sessionId: string, summary: string | null): Promise<string | null> {
    const runner = options.runner();
    if (hasTranscriptTail(runner)) {
      try {
        const page = await runner.getTranscriptTail(sessionId, {
          maxBytes: config.prompt.outputCaptureBytes,
        });
        if (!page.pruned) {
          const text = lastAssistantText(page.lines);
          if (text !== null) return text;
        }
      } catch (error) {
        log('debug', 'the transcript tail could not be read for a turn', {
          sessionId,
          error: String(error),
        });
      }
    }
    return summary;
  }

  /**
   * The artifact's content hash (§3.3's `no_progress` input).
   *
   * Repo-relative in, absolute never computed by orchestrator alone: the path is
   * joined onto projects' `cwd` (§2.5) and refused if it escapes it. A build
   * without the launch-context read, or a missing file, yields `null` — and a
   * `null` hash can never equal the previous one, so the breaker simply does not
   * fire rather than firing wrongly.
   */
  async function hashArtifact(row: AssignmentRow): Promise<string | null> {
    if (row.artifactPath === null) return null;
    const projects = options.projects();
    const read = projects?.getEffectiveLaunchContext;
    if (read === undefined) return null;
    try {
      const context = await read(row.projectId, row.id);
      const absolute = safeJoin(context.cwd, row.artifactPath);
      if (absolute === undefined) return null;
      const content = (options.readArtifact ?? defaultReadArtifact)(absolute);
      if (content === undefined) return null;
      return createHash('sha256').update(content).digest('hex');
    } catch (error) {
      log('debug', 'the artifact could not be hashed', {
        assignmentId: row.id,
        error: String(error),
      });
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Cards
  // -------------------------------------------------------------------------

  function raiseCard(row: AssignmentRow, card: CardSpec): Promise<string> {
    return raiseEngineCard(
      {
        inbox: options.inbox(),
        clock: options.clock,
        expireHours: options.expireHours,
        log: (message, detail) => {
          log('warn', message, detail);
        },
      },
      row,
      card,
    );
  }

  /**
   * The ceiling the round-cap card may raise a cap to, per pattern (§3.3, §3.5).
   *
   * Read from the pattern's own config key rather than from the pair's, because
   * "how many rounds may this kind of collaboration run" is a property of the
   * collaboration — an overseer's rounds are review passes and a pair's are
   * draft-and-critique, and one number for both would bound the wrong thing.
   */
  function maxRoundCapFor(pattern: string): number {
    return pattern === 'overseer'
      ? config.patterns.overseer.maxRoundCap
      : config.patterns.pair.maxRoundCap;
  }

  function raiseRoundCapCard(row: AssignmentRow, summary: string): Promise<string> {
    const cap = row.roundCap ?? 0;
    const max = maxRoundCapFor(row.pattern);
    return raiseCard(row, {
      kind: 'question',
      prompt:
        `${summary} Accept the artifact as it stands, run one more round (up to ${String(max)} ` +
        `in total, currently ${String(cap)}), or close it unfinished?`,
      options: ROUND_CAP_OPTIONS,
      marker: ROUND_CAP_CARD,
    });
  }

  function raiseHaltCard(row: AssignmentRow, haltReason: HaltReason): Promise<string> {
    return raiseCard(row, {
      kind: 'approval_gate',
      prompt: haltPrompt(haltReason, row),
      options: [
        { id: 'continue', label: 'Continue anyway' },
        { id: 'close', label: 'Close the assignment' },
      ],
      marker: `${HALT_CARD_PREFIX}${haltReason}`,
    });
  }

  function awaitBudgetDecision(row: AssignmentRow): AdvanceOutcome {
    if (row.phase !== 'awaiting_user') repository.setPhase(row.id, 'awaiting_user', null);
    // Runner raises the `budget_halt` card in the same transaction as the usage
    // write (§7.1/§7.2). The engine only stops planning; raising a second card
    // here would put two rows in the inbox for one crossing.
    const inbox = options.inbox();
    const existing = inbox
      ?.list({ assignmentId: row.id, status: 'open' })
      .find((card) => card.kind === 'budget_halt');
    return {
      kind: 'awaiting_user',
      questionId: existing?.id ?? '',
      reason: 'budget_exhausted',
    };
  }

  // -------------------------------------------------------------------------
  // Answers (M6-4)
  // -------------------------------------------------------------------------

  async function onQuestionAnswered(event: AppEvent): Promise<void> {
    const payload = (event.payload ?? {}) as { questionId?: unknown; assignmentId?: unknown };
    const assignmentId =
      event.ids.assignmentId ??
      (typeof payload.assignmentId === 'string' ? payload.assignmentId : undefined);
    const questionId = typeof payload.questionId === 'string' ? payload.questionId : undefined;
    if (assignmentId === undefined || questionId === undefined) return;

    const inbox = options.inbox();
    const card = inbox?.list({ assignmentId }).find((one) => one.id === questionId);
    const marker = card?.context?.toolName;

    if (marker === ROUND_CAP_CARD) {
      await onRoundCapAnswer(assignmentId, card?.answer?.optionIds ?? []);
      return;
    }
    if (typeof marker === 'string' && marker.startsWith(GATE_CARD_PREFIX)) {
      const chose = card?.answer?.optionIds ?? [];
      // §8.2: "It never auto-approves." Anything that is not an explicit
      // approval — a denial, a free-text answer, an empty one — is a denial.
      if (!chose.includes('approve')) {
        await options.service().closeAssignment(assignmentId, 'gate_denied');
        return;
      }
      const row = repository.get(assignmentId);
      if (row !== undefined && row.phase === 'planned') {
        repository.setPhase(assignmentId, 'running', null);
      }
      await advance(assignmentId, { manual: true }).catch(() => undefined);
      return;
    }
    if (typeof marker === 'string' && marker.startsWith(HALT_CARD_PREFIX)) {
      const chose = card?.answer?.optionIds ?? [];
      if (chose.includes('close')) {
        await options.service().closeAssignment(assignmentId, 'breaker');
        return;
      }
      // "Continue anyway" is the manual kick: the halt is cleared and the loop
      // re-enters (§11.1's `/advance`).
      await advance(assignmentId, { manual: true }).catch(() => undefined);
      return;
    }

    // A plain decision: §3.3's blocked seat is re-planned with the answer.
    await advance(assignmentId).catch(() => undefined);
  }

  async function onRoundCapAnswer(assignmentId: string, chose: readonly string[]): Promise<void> {
    const service = options.service();
    if (chose.includes('close')) {
      await service.closeAssignment(assignmentId, 'round_cap');
      return;
    }
    if (chose.includes('more_rounds')) {
      const row = repository.get(assignmentId);
      if (row === undefined) return;
      const max = maxRoundCapFor(row.pattern);
      const wanted = (row.roundCap ?? 0) + 1;
      if (wanted > max) {
        // Neither agent can extend the cap and neither can the card past its
        // configured ceiling (§3.3). Closing is the honest outcome.
        await service.closeAssignment(assignmentId, 'round_cap');
        return;
      }
      repository.update(assignmentId, { roundCap: wanted });
      bus.emit({
        type: 'assignment.round.cap.raised',
        ids: { assignmentId, projectId: row.projectId },
        persist: true,
        payload: { from: row.roundCap, to: wanted, reason: 'user_answered_round_cap_card' },
      });
      await advance(assignmentId, { manual: true }).catch(() => undefined);
      return;
    }
    // Accept as-is: the user is the tie-breaker, and what they accepted is the
    // artifact — so the assignment gets §2.2's completion phase, not a generic
    // closed header.
    await service.closeAssignment(assignmentId, 'converged');
  }

  // -------------------------------------------------------------------------
  // Bus wiring (M5-3)
  // -------------------------------------------------------------------------

  function attach(): Unsubscribe {
    const unsubscribes: Unsubscribe[] = [
      bus.subscribe(['assignment.created'], (event) => {
        const assignmentId = event.ids.assignmentId;
        if (assignmentId === undefined) return;
        void advance(assignmentId).catch(() => undefined);
      }),
      bus.subscribe(['session.ended'], (event) => {
        void onSessionEnded(event).catch((error: unknown) => {
          log('warn', 'the engine could not record a turn ending', { error: String(error) });
        });
      }),
      bus.subscribe(['question.answered'], (event) => {
        void onQuestionAnswered(event).catch((error: unknown) => {
          log('warn', 'the engine could not react to an answer', { error: String(error) });
        });
      }),
      // §3.5's review cadence: a child finishing is the parent's trigger. It is
      // the *close* rather than the child's last `session.ended`, because a
      // child may take several sessions and only its close says the outcome is
      // final — which is the thing the lead is asked to verify.
      bus.subscribe(['assignment.closed'], (event) => {
        const assignmentId = event.ids.assignmentId;
        if (assignmentId === undefined) return;
        const parentId = repository.get(assignmentId)?.parentAssignmentId;
        if (parentId === undefined || parentId === null) return;
        void advance(parentId).catch(() => undefined);
      }),
      bus.subscribe(['assignment.budget.exceeded'], (event) => {
        const assignmentId = event.ids.assignmentId;
        if (assignmentId === undefined) return;
        const row = repository.get(assignmentId);
        if (row === undefined || row.status !== 'open') return;
        repository.setPhase(assignmentId, 'awaiting_user', null);
        log('info', 'an assignment is awaiting a budget decision', { assignmentId });
      }),
      // §2.6's second source: projects emits this when two assignments land in
      // one workspace. Same behaviour as the creation-time scan — record it,
      // warn, and gate only when both sides can write.
      bus.subscribe(['project.scope.overlap'], (event) => {
        void onScopeOverlap(event).catch((error: unknown) => {
          log('warn', 'the engine could not record a scope overlap', { error: String(error) });
        });
      }),
    ];
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  }

  /**
   * §16-9's candidate ranking, per seat.
   *
   * **Owner decision, 2026-08-18: this ranks, it does not filter.** Every agent
   * the roster projection returns is a candidate for every seat, because "any
   * agent may work in any pair or group" and the seating choice is the user's.
   * A dialog that hid the agents which did not declare the seat's role would be
   * the capability gate the decision removed, moved into the UI.
   *
   * The order is the suggestion, in four keys: agents that declare one of the
   * seat's roles first (`declaresRole`, which the dialog also labels), then the
   * available before the loaded, then fewest open assignments, then name. The
   * agent most likely to be wanted is at the top and nobody is missing.
   */
  function candidatesFor(
    pattern: PatternDef,
    entries: readonly OverseerRosterEntryPort[],
  ): Record<string, readonly SeatCandidate[]> {
    const limit = config.assignment.maxConcurrentPerAgent;
    const bySeat: Record<string, readonly SeatCandidate[]> = {};
    for (const seat of pattern.seats) {
      bySeat[seat.key] = entries
        .map((entry) => {
          const openAssignments = repository.countOpenForAgent(entry.id);
          return {
            agentId: entry.id,
            name: entry.name,
            roles: entry.capabilities.roles,
            openAssignments,
            available: openAssignments < limit,
            declaresRole: entry.capabilities.roles.some((role) =>
              (seat.roles as readonly string[]).includes(role),
            ),
          };
        })
        .sort((a, b) => {
          if (a.declaresRole !== b.declaresRole) return a.declaresRole ? -1 : 1;
          if (a.available !== b.available) return a.available ? -1 : 1;
          if (a.openAssignments !== b.openAssignments) return a.openAssignments - b.openAssignments;
          return a.agentId.localeCompare(b.agentId);
        });
    }
    return bySeat;
  }

  // -------------------------------------------------------------------------
  // M7-3/M7-4 — gates and conflicts
  // -------------------------------------------------------------------------

  /**
   * §2.6 source 2, and §8.2-4's gate.
   *
   * Projects reports the overlap; this element decides what it means, and the
   * decision is the same table §2.6 states for the creation-time scan. Two
   * readers cannot collide, so nothing is raised for them; one writer warns; two
   * writers get a card *before* the second assignment's first turn.
   */
  async function onScopeOverlap(event: AppEvent): Promise<void> {
    const payload = (event.payload ?? {}) as {
      assignmentId?: unknown;
      otherAssignmentId?: unknown;
      paths?: unknown;
    };
    const assignmentId =
      event.ids.assignmentId ??
      (typeof payload.assignmentId === 'string' ? payload.assignmentId : undefined);
    const otherId =
      typeof payload.otherAssignmentId === 'string' ? payload.otherAssignmentId : undefined;
    if (assignmentId === undefined || otherId === undefined) return;
    const row = repository.get(assignmentId);
    const other = repository.get(otherId);
    if (row === undefined || other === undefined || row.status !== 'open') return;
    const paths = Array.isArray(payload.paths)
      ? payload.paths.filter((path): path is string => typeof path === 'string')
      : [];
    await recordConflict(row, other.id, other.write, paths);
  }

  /** The one place §2.6's table is applied, whichever source found the overlap. */
  async function recordConflict(
    row: AssignmentRow,
    otherAssignmentId: string,
    otherWrite: boolean,
    paths: readonly string[],
  ): Promise<void> {
    const bothWrite = row.write && otherWrite;
    if (!row.write && !otherWrite) return; // "Recorded, no warning. Two readers cannot collide."

    bus.emit({
      type: 'assignment.conflict',
      ids: { assignmentId: row.id, projectId: row.projectId },
      persist: true,
      payload: { otherAssignmentId, paths, bothWrite },
    });
    if (!bothWrite) return;

    // §2.6/§8.2-4: the one case where two agents can actually corrupt each
    // other's diff, so a human sees it first and no turn is planned until then.
    if (row.phase === 'running' || row.phase === 'planned') {
      repository.setPhase(row.id, 'planned', null);
    }
    await raiseCard(row, {
      kind: 'approval_gate',
      prompt:
        `This assignment's write scope overlaps open write-capable assignment ${otherAssignmentId}` +
        `${paths.length === 0 ? '' : ` on ${paths.join(', ')}`}. Two writers in one tree can ` +
        'corrupt each other’s diff. Approve it anyway, or deny and close it?',
      options: [...GATE_OPTIONS],
      marker: `${GATE_CARD_PREFIX}scope_overlap`,
    });
  }

  // -------------------------------------------------------------------------
  // M7-5 — the staleness sweep
  // -------------------------------------------------------------------------

  /**
   * §8.1's `stale`: an `open` assignment with no turn transition for
   * `assignment.maxAgeHours`.
   *
   * A *sweep* rather than a pre-`plan()` check, because the wedge it catches is
   * precisely the assignment nothing is advancing — there is no next `plan()` to
   * hang the check off. Assignments already waiting on a human are skipped: a
   * card that has been open for a day is the user's to answer, not a second
   * halt to raise on top of it.
   */
  async function sweepStale(): Promise<readonly string[]> {
    const halted: string[] = [];
    const nowMs = options.clock().getTime();
    for (const row of repository.list({ status: 'open' })) {
      if (row.phase === 'halted' || row.phase === 'awaiting_user') continue;
      const rows = turns.list(row.id);
      const live = rows.some((turn) => turn.status === 'planned' || turn.status === 'running');
      if (live) continue;
      const trip = evaluateBreakers({
        assignment: row,
        turns: rows,
        config,
        nowMs,
        includeStale: true,
      });
      if (trip?.breaker !== 'stale') continue;
      await withLock(row.id, async () => {
        // Re-read under the lock: an advance that landed between the scan and
        // the halt has already moved the assignment on.
        const fresh = repository.get(row.id);
        if (fresh === undefined || fresh.status !== 'open' || fresh.phase === 'halted') return;
        await halt(fresh, 'stale');
        halted.push(fresh.id);
      });
    }
    return halted;
  }

  // -------------------------------------------------------------------------
  // M5-5 — the boot task
  // -------------------------------------------------------------------------

  async function reconcileOnBoot(): Promise<TurnReconciliation> {
    const failedTurns: string[] = [];
    const resumed: string[] = [];

    for (const row of repository.list({ status: 'open' })) {
      if (driverFor(row) === undefined) continue;

      const active = turns.active(row.id);
      if (active !== undefined) {
        const session = active.sessionId;
        // `paused` counts as live: M5-5 says leave it — the question drives it,
        // and runner owns the auto-resume of anything it parked (R6).
        const status = session === null ? undefined : options.sessions.get(session)?.status;
        if (status !== undefined && ['queued', 'running', 'paused'].includes(status)) continue;
        // The core died with this turn in flight. Its session is gone, so the
        // turn is `failed` — which the pattern's own failure rules then judge,
        // rather than the boot task deciding what the assignment should do.
        turns.complete(active.id, { status: 'failed' });
        failedTurns.push(active.id);
      }

      const outcome: AdvanceOutcome = await advance(row.id).catch(() => ({
        kind: 'idle',
        reason: 'error',
      }));
      if (outcome.kind === 'planned') resumed.push(row.id);
    }

    return { failedTurns, resumed };
  }

  // -------------------------------------------------------------------------

  return {
    advance,
    attach,
    reconcileOnBoot,
    sweepStale,
    tripToolFlood: (assignmentId, sessionId) => tripToolFlood(assignmentId, sessionId),
    turns: (assignmentId) => turns.list(assignmentId),
    patterns: () => {
      // Read once for the whole reply: `GET /api/patterns` is the create
      // dialog's first call and a per-seat roster read would repeat the same
      // projection for every seat of every pattern.
      const roster = options.roster?.();
      const entries = hasOverseerRoster(roster) ? roster.overseerRoster() : undefined;

      return PATTERNS.map((pattern): PatternSummary => {
        const pair = pattern.id === 'pair';
        const overseer = pattern.id === 'overseer';
        return {
          id: pattern.id,
          driver: pattern.driver,
          seats: pattern.seats,
          requires: {
            artifactPath: pattern.requires?.artifactPath ?? false,
            roundCap: pattern.requires?.roundCap ?? false,
            tokenBudget: pattern.requires?.tokenBudget ?? false,
          },
          defaults: {
            roundCap: pair
              ? config.patterns.pair.roundCap
              : overseer
                ? config.patterns.overseer.roundCap
                : null,
            // §7.2: the overseer's budget has **no** default, and the dialog is
            // told so with a `null` it must make the user fill in — a default
            // cap on work that creates more work is a number nobody agreed to.
            tokenBudget: pair ? config.budgets.defaultPairTokens : null,
          },
          maxRoundCap: pair
            ? config.patterns.pair.maxRoundCap
            : overseer
              ? config.patterns.overseer.maxRoundCap
              : null,
          cardSeatOrder: cardSeatOrder(pattern.id),
          ...(entries === undefined ? {} : { candidates: candidatesFor(pattern, entries) }),
        };
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function isEngineCard(context: { toolName?: string } | null | undefined): boolean {
  const name = context?.toolName;
  return name === ROUND_CAP_CARD || (typeof name === 'string' && name.startsWith(HALT_CARD_PREFIX));
}

/** The last `assistant` text in a transcript page, if there is one. */
export function lastAssistantText(
  lines: readonly Readonly<Record<string, unknown>>[],
): string | null {
  for (const line of [...lines].reverse()) {
    if (line['type'] !== 'assistant') continue;
    const text = line['text'];
    if (typeof text === 'string' && text.trim() !== '') return text;
    const data = line['data'];
    if (typeof data === 'object' && data !== null) {
      const inner = (data as { text?: unknown }).text;
      if (typeof inner === 'string' && inner.trim() !== '') return inner;
    }
  }
  return null;
}

/**
 * Joins a repo-relative path onto a workspace root, refusing anything that
 * escapes it.
 *
 * §9-11 already refuses `..` at creation; this is the same rule applied at the
 * moment a path becomes a filesystem read, because a scope that was valid when
 * stored and a symlinked workspace are different facts.
 */
export function safeJoin(root: string, relative: string): string | undefined {
  if (isAbsolute(relative)) return undefined;
  const base = resolvePath(root);
  const joined = normalize(join(base, relative));
  return joined === base || joined.startsWith(base + sep) ? joined : undefined;
}

function defaultReadArtifact(absolutePath: string): string | undefined {
  try {
    return readFileSync(absolutePath, 'utf8');
  } catch {
    return undefined;
  }
}

export function haltPrompt(
  haltReason: HaltReason,
  row: Pick<AssignmentRow, 'artifactPath'>,
): string {
  switch (haltReason) {
    case 'no_progress':
      return `The drafting seat submitted an unchanged ${row.artifactPath ?? 'artifact'} while reporting a revision, twice. Continue anyway, or close the assignment?`;
    case 'no_report':
      return 'The same seat finished two turns without calling report_status, so the engine has no verdict to read. Continue with a stricter instruction, or close the assignment?';
    case 'turn_failures':
      return 'Two consecutive turns of this assignment failed. Continue anyway, or close the assignment?';
    case 'permission_fight':
      return 'A seat is repeatedly hitting denied tools, which is usually a configuration problem rather than an agent problem. Continue anyway, or close the assignment?';
    case 'tool_flood':
      return 'A seat exceeded its per-session tool-call cap. Continue anyway, or close the assignment?';
    case 'stale':
      return 'This assignment has not made a turn transition in a long time. Continue anyway, or close the assignment?';
    case 'question_expired':
      return 'A question this assignment was waiting on expired unanswered. Continue anyway, or close the assignment?';
    case 'review_unresolved':
      return (
        'The overseer finished a review round without accepting the work: it either asked for ' +
        'revisions it did not delegate, or reported no verdict at all. Continue anyway to give ' +
        'it one more round to delegate the follow-up, or close the assignment?'
      );
  }
}
