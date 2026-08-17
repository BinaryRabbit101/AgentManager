/**
 * The assignment engine as far as M1 takes it: the three creation paths of
 * §2.3 (two of them; the MCP one is M4), the runner contract of §2.7, the close
 * of §2.2, and the boot reconciliation of IMPLEMENTATION M1-6.
 *
 * ## One creation function, three callers
 *
 * §2.3: "Three, all through one internal function so the invariants hold once."
 * `createSolo` does not validate anything itself — it builds a one-member
 * `CreateAssignmentRequest` and calls `createAssignment`, which is what makes
 * "a drag-and-drop solo launch is the trivial assignment" (§2.1) a fact about
 * the code and not a claim about the design. The only thing `createSolo` adds is
 * the second half of its contract: it starts the first session and returns both
 * ids in one call, which is why the launch stays a one-minute flow.
 *
 * ## What is deliberately not here
 *
 * No pattern driver, no turn loop, no convergence check, no round accounting.
 * The solo pattern has no driver (§2.3), and everything after the first session
 * on a solo assignment is user-driven through runner's own Continue/Resume
 * actions. That is what makes solo genuinely trivial rather than a special case
 * threaded through an engine that does not exist yet.
 */
import type { EventBus } from '../types.js';
import type {
  Clock,
  QuestionsRepository,
  SessionsRepository,
  SessionStatus,
} from '../../storage/index.js';

import { raiseCard, GATE_CARD_PREFIX, GATE_OPTIONS } from './cards.js';
import type { OrchestratorConfig } from './config.js';
import {
  AssignmentClosedError,
  AssignmentNotFoundError,
  AssignmentRefusedError,
  DependencyUnavailableError,
  InvalidRequestError,
  RunnerUnavailableError,
  type Refusal,
} from './errors.js';
import {
  hasLauncher,
  hasWorkItemLinker,
  type ProjectsPort,
  type RosterPort,
  type RunnerPort,
} from './ports.js';
import type { QuestionInbox } from './questions.js';
import type { AssignmentRepository, AssignmentRow } from './repository.js';
import { emitScopeRules } from './scopeRules.js';
import type { SessionToolset, ToolsetFactory } from './toolset.js';
import {
  isMachineCreated,
  validateCreateAssignment,
  type AgentFacts,
  type ParentFacts,
  type ProjectFacts,
  type WorkItemFacts,
} from './validate.js';
import {
  isAssignmentRole,
  type AssignmentContext,
  type AssignmentPatch,
  type AssignmentPhase,
  type AssignmentRole,
  type AssignmentScope,
  type AssignmentService,
  type AssignmentView,
  type BootReconciliation,
  type CloseReason,
  type CreateAssignmentRequest,
  type CreateAssignmentResult,
  type CreateSoloRequest,
  type CreateSoloResult,
  type ListAssignmentsQuery,
} from './types.js';

/** Session statuses that are still alive and must be stopped on close (§2.2). */
const LIVE_STATUSES: readonly SessionStatus[] = ['queued', 'running', 'paused'];

export interface AssignmentServiceOptions {
  readonly repository: AssignmentRepository;
  readonly sessions: SessionsRepository;
  readonly questions: QuestionsRepository;
  readonly bus: EventBus;
  readonly config: OrchestratorConfig;
  /** `modules.orchestrator.enabled` — §9-1's first clause. */
  readonly moduleEnabled: boolean;
  /**
   * Injectable, so tests are not time-dependent (foundation §6.1).
   *
   * Every timestamp M1 writes goes through {@link AssignmentRepository}, which
   * has its own clock; this one is taken so the question and notification paths
   * of M2 and M8 do not have to change the constructor's shape to get one.
   */
  readonly clock: Clock;
  /** Resolved lazily: `ctx.require` is answered at call time, not at `init`. */
  readonly roster: () => RosterPort | undefined;
  readonly projects: () => ProjectsPort | undefined;
  readonly runner: () => RunnerPort | undefined;
  /**
   * `runner.question.expireHours`, **read** from runner's config (§12), for the
   * deadline on §8.2's gate cards. Defaults to runner's own 24 so a build that
   * does not state it still expires its gates — and an expired gate is a denial.
   */
  readonly expireHours?: number | undefined;
  /**
   * M2's question inbox, resolved lazily because it is built *after* this
   * service — §6.5's expiry consequences call back into `closeAssignment`, and
   * a constructor argument in the other direction would be a cycle. Absent in a
   * build that has no inbox, which is why `closeAssignment` still knows how to
   * cancel rows on its own.
   */
  readonly inbox?: (() => QuestionInbox | undefined) | undefined;
  /**
   * §4.1's toolset factory, resolved lazily for the same reason the inbox is: it
   * is built after this service, because its tools write turn rows the engine
   * planned. Absent in a build with no toolset, which is the case roster's
   * rule-dropping diagnostic already covers (§4.1).
   */
  readonly toolset?: (() => ToolsetFactory | undefined) | undefined;
  readonly log?: (message: string, detail?: Record<string, unknown>) => void;
}

export function createAssignmentService(options: AssignmentServiceOptions): AssignmentService {
  const { repository, sessions, questions, bus, config } = options;

  // -------------------------------------------------------------------------
  // Fact resolution — the impure half, kept out of the validator
  // -------------------------------------------------------------------------

  function projectFacts(projectId: string): ProjectFacts | undefined {
    const projects = options.projects();
    if (projects === undefined) throw new DependencyUnavailableError('projects');
    try {
      const project = projects.get(projectId);
      return { id: project.id, status: project.status };
    } catch {
      // Projects throws a typed 404 for an unknown id; §9-1 turns that into its
      // own named refusal rather than letting another element's error shape
      // reach an orchestrator caller.
      return undefined;
    }
  }

  function agentFacts(agentIds: readonly string[]): ReadonlyMap<string, AgentFacts> {
    const roster = options.roster();
    // Orchestrator will not create work it could not validate: without roster's
    // registry there is no `capabilities.roles` to check §9-5 against, and an
    // unvalidated assignment is exactly what §9 exists to prevent.
    if (roster === undefined) throw new DependencyUnavailableError('roster');

    const facts = new Map<string, AgentFacts>();
    for (const agentId of new Set(agentIds)) {
      const live = roster.registry.get(agentId);
      const resolved = live ?? roster.registry.getArchived(agentId);
      if (resolved === undefined) continue;
      const capabilities = resolved.definition.capabilities;
      facts.set(agentId, {
        id: resolved.definition.id,
        name: resolved.definition.name,
        archived: live === undefined || (resolved.archivedAt ?? null) !== null,
        overseer: capabilities?.overseer ?? false,
        roles: capabilities?.roles ?? [],
        openAssignments: repository.countOpenForAgent(agentId),
      });
    }
    return facts;
  }

  function parentFacts(parentAssignmentId: string | undefined): ParentFacts | undefined {
    if (parentAssignmentId === undefined) return undefined;
    const parent = repository.get(parentAssignmentId);
    if (parent === undefined) throw new AssignmentNotFoundError(parentAssignmentId);
    return {
      id: parent.id,
      projectId: parent.projectId,
      status: parent.status,
      parentAssignmentId: parent.parentAssignmentId,
      tokenBudget: parent.tokenBudget,
      tokensUsed: parent.tokensUsed,
      openChildBudgets: repository.openChildBudgetTotal(parent.id),
    };
  }

  function workItemFacts(
    workItemIds: readonly string[] | undefined,
  ): ReadonlyMap<string, WorkItemFacts> | undefined {
    if (workItemIds === undefined || workItemIds.length === 0) return undefined;
    const projects = options.projects();
    const facts = new Map<string, WorkItemFacts>();
    const read = projects?.getWorkItem;
    if (read === undefined) return facts; // every id unresolvable → named refusals
    for (const id of new Set(workItemIds)) {
      const item = read(id);
      if (item !== undefined) facts.set(id, { id: item.id, projectId: item.projectId });
    }
    return facts;
  }

  /**
   * §2.6-1's creation-time overlap scan: deterministic path-prefix comparison on
   * normalised repo-relative paths against every other `open` assignment on the
   * project. No heuristics — a scoring threshold here would report an overlap
   * that is not one, and the warning would stop being read.
   */
  function overlapsFor(
    projectId: string,
    scope: AssignmentScope | undefined,
  ): readonly { assignmentId: string; write: boolean }[] {
    const paths = scope?.paths ?? [];
    if (paths.length === 0) return [];
    const mine = paths.map(normalisedPrefix);
    const found: { assignmentId: string; write: boolean }[] = [];
    for (const other of repository.list({ projectId, status: 'open' })) {
      const theirs = parseScope(other.scopeJson)?.paths ?? [];
      const overlapping = theirs
        .map(normalisedPrefix)
        .some((their) => mine.some((own) => their.startsWith(own) || own.startsWith(their)));
      if (overlapping) found.push({ assignmentId: other.id, write: other.write });
    }
    return found;
  }

  // -------------------------------------------------------------------------
  // §2.3 — the one creation function
  // -------------------------------------------------------------------------

  // `async` rather than a synchronous throw wrapped in a promise: a function
  // whose declared return type is a `Promise` but which can throw before
  // returning one forces every caller to write both a `try` and a `.catch`.
  async function createAssignment(
    request: CreateAssignmentRequest,
  ): Promise<CreateAssignmentResult> {
    await Promise.resolve();
    const write = request.write ?? true;
    const scope = request.scope;

    const workItems = workItemFacts(request.workItemIds);
    const overlaps = overlapsFor(request.projectId, scope);
    const validation = validateCreateAssignment({
      request,
      moduleEnabled: options.moduleEnabled,
      project: projectFacts(request.projectId),
      agents: agentFacts(request.members.map((member) => member.agentId)),
      parent: parentFacts(request.parentAssignmentId),
      ...(workItems === undefined ? {} : { workItems }),
      config,
      overlaps,
    });

    if (validation.refusals.length > 0) {
      throw new AssignmentRefusedError(validation.refusals);
    }

    // §2.6's third row: two write-capable assignments overlapping is the one
    // case where two agents can corrupt each other's diff, so it is a gate as
    // well as a warning — and the gate has to be decided *before* the row's
    // phase is chosen, because a gated assignment never reaches `running`.
    const contested = write && overlaps.some((overlap) => overlap.write);

    // A `write: true` machine-created assignment is created at `phase: planned`
    // behind an approval gate and never starts a session before a human approves
    // (§9-10). A user-created one that asked not to auto-start sits at `planned`
    // too, and `POST /:id/advance` (M7) is what moves it.
    const phase: AssignmentPhase =
      validation.gate !== undefined || contested || request.autoStart === false
        ? 'planned'
        : 'running';

    const row = repository.create({
      projectId: request.projectId,
      pattern: request.pattern,
      goal: request.goal,
      scope,
      write,
      phase,
      createdBy: request.createdBy ?? 'user',
      parentAssignmentId: request.parentAssignmentId,
      // The seat that owns the outcome (§2.4). For `pair` the lead is the
      // drafting seat, which is seat 0; for `solo` it is the sole member.
      leadAgentId: request.members[0]?.agentId,
      artifactPath: scope?.artifactPath,
      patternConfig: request.patternConfig,
      tokenBudget: request.tokenBudget ?? defaultBudget(request),
      roundCap: request.roundCap ?? defaultRoundCap(request),
      members: request.members.map((member, index) => ({
        agentId: member.agentId,
        role: member.role,
        seatOrder: index,
      })),
    });

    // §2.3: the engine is the sole writer of `work_item_assignments`, and it
    // links inside the same creation path as the assignment row.
    linkWorkItems(row.id, request.workItemIds);

    bus.emit({
      type: 'assignment.created',
      ids: { assignmentId: row.id, projectId: row.projectId },
      persist: true,
      payload: {
        pattern: row.pattern,
        members: request.members.map((member) => ({ agentId: member.agentId, role: member.role })),
        scope: scope ?? null,
        write: row.write,
        budget: row.tokenBudget,
        roundCap: row.roundCap,
        createdBy: row.createdBy,
        warnings: validation.warnings.map((warning) => warning.message),
      },
    });

    // §2.6: an overlap with any write-capable side is an `assignment.conflict`.
    // Emitted after `assignment.created`, so a subscriber that reads the new row
    // finds it.
    for (const overlap of overlaps) {
      if (!write && !overlap.write) continue; // two readers cannot collide
      bus.emit({
        type: 'assignment.conflict',
        ids: { assignmentId: row.id, projectId: row.projectId },
        persist: true,
        payload: {
          otherAssignmentId: overlap.assignmentId,
          paths: scope?.paths ?? [],
          bothWrite: write && overlap.write,
        },
      });
    }

    // §8.2's gates, both of which block the *first* turn. Raised after the row
    // exists, because a card names the assignment it is about.
    const gateReason =
      validation.gate?.reason ??
      (contested
        ? 'write-capable scope overlaps another open write-capable assignment'
        : undefined);
    let gate = validation.gate;
    if (gateReason !== undefined) {
      const questionId = await raiseGate(row, gateReason, contested);
      gate = { reason: gateReason, ...(questionId === '' ? {} : { questionId }) };
    }

    return {
      assignmentId: row.id,
      status: row.status,
      phase: row.phase,
      warnings: validation.warnings,
      ...(gate === undefined ? {} : { gate }),
    };
  }

  /**
   * §8.2-1 and §8.2-4's approval gate.
   *
   * "It never auto-approves; expiry is denial (§6.5)." Expiry is already the
   * inbox's `onExpiredGate` → `closeAssignment(gate_expired)`; approval and
   * denial are the engine's answer path, keyed on the marker written here.
   */
  function raiseGate(row: AssignmentRow, reason: string, overlap: boolean): Promise<string> {
    return raiseCard(
      {
        inbox: options.inbox?.(),
        clock: options.clock,
        expireHours: options.expireHours ?? 24,
        ...(options.log === undefined ? {} : { log: options.log }),
      },
      row,
      {
        kind: 'approval_gate',
        prompt:
          `Approve this ${row.write ? 'write-capable ' : ''}assignment before it starts? ` +
          `Reason: ${reason}. Denying it, or leaving it to expire, closes the assignment ` +
          'without running anything.',
        options: GATE_OPTIONS,
        marker: overlap ? `${GATE_CARD_PREFIX}scope_overlap` : `${GATE_CARD_PREFIX}create`,
      },
    );
  }

  // -------------------------------------------------------------------------
  // §2.3 path 1 — solo
  // -------------------------------------------------------------------------

  async function createSolo(request: CreateSoloRequest): Promise<CreateSoloResult> {
    if (typeof request.prompt !== 'string' || request.prompt.trim().length === 0) {
      throw new InvalidRequestError('A prompt is required to launch an agent.', 'prompt');
    }

    // Refuse *before* anything is written when there is no launch path at all:
    // an assignment created for a session that can never start is a row the user
    // has to clean up by hand (runner §11.3, "no launch path").
    const runner = options.runner();
    if (!hasLauncher(runner)) throw new RunnerUnavailableError();

    const role = resolveSoloRole(request);
    const result = await createAssignment({
      projectId: request.projectId,
      pattern: 'solo',
      ...(request.goal === undefined ? {} : { goal: request.goal }),
      members: [{ agentId: request.agentId, role }],
      // Defaults per §2.3 path 1: whole-project scope, `write: true`,
      // `token_budget: null`, `round_cap: null`, `phase: running`, driver none.
      ...(request.scope === undefined ? {} : { scope: request.scope }),
      write: request.write ?? true,
      tokenBudget: null,
      roundCap: null,
      ...(request.workItemIds === undefined ? {} : { workItemIds: request.workItemIds }),
      ...(request.createdBy === undefined ? {} : { createdBy: request.createdBy }),
    });

    let launched;
    try {
      launched = await runner.startSession({
        assignmentId: result.assignmentId,
        agentId: request.agentId,
        projectId: request.projectId,
        prompt: request.prompt,
        // The role is always passed to runner so roster appends a
        // `roles/<role>.md` addendum *if one exists*, and silently appends
        // nothing if it does not (§2.3).
        role,
        priority: request.priority ?? 'normal',
      });
    } catch (error) {
      // The assignment exists and its session does not. Close it rather than
      // leaving an `open`, `running` row with nothing behind it — that is
      // exactly the orphan state M1-6's boot task exists to repair, and leaving
      // one behind on a *synchronous* failure would be creating work for it.
      await closeAssignment(result.assignmentId, 'failed');
      throw error;
    }

    bus.emit({
      type: 'assignment.started',
      ids: {
        assignmentId: result.assignmentId,
        projectId: request.projectId,
        agentId: request.agentId,
        sessionId: launched.sessionId,
      },
      persist: true,
      payload: { firstTurnId: null, seat: 'solo', agentId: request.agentId },
    });

    return {
      assignmentId: result.assignmentId,
      sessionId: launched.sessionId,
      warnings: result.warnings,
    };
  }

  /**
   * §2.3: "`role` defaults to `implementer` when the agent declares it,
   * otherwise `capabilities.roles[0]`, otherwise `implementer`."
   *
   * The final fallback is what makes the role always passable to runner: an
   * agent that declares no roles at all still gets a seat, and roster appends no
   * addendum because no `roles/implementer.md` matched anything it needed to.
   */
  function resolveSoloRole(request: CreateSoloRequest): AssignmentRole {
    if (request.role !== undefined) return request.role;
    const declared = options.roster()?.registry.get(request.agentId)?.definition
      .capabilities?.roles;
    if (declared === undefined) return 'implementer';
    if (declared.includes('implementer')) return 'implementer';
    const first = declared[0];
    return isAssignmentRole(first) ? first : 'implementer';
  }

  // -------------------------------------------------------------------------
  // §2.7 — the runner contract
  // -------------------------------------------------------------------------

  async function getAssignmentContext(
    assignmentId: string,
    contextOptions?: { readonly agentId?: string },
  ): Promise<AssignmentContext> {
    await Promise.resolve();
    const row = repository.get(assignmentId);
    if (row === undefined) throw new AssignmentNotFoundError(assignmentId);

    const members = repository.listMembers(assignmentId);
    // "`role` is the role of the *member the session is for*". Runner's pinned
    // call carries only the assignment id, so the seat is resolved two ways: by
    // the agent when one is named, and — for the one-seat case that is every
    // solo assignment — by there being nothing else it could be. A multi-seat
    // assignment asked without an agent gets **no** `role` rather than a guess,
    // because a guessed seat compiles the wrong role addendum into a prompt.
    const seat =
      contextOptions?.agentId !== undefined
        ? members.find((member) => member.agentId === contextOptions.agentId)
        : members.length === 1
          ? members[0]
          : undefined;

    return {
      id: row.id,
      pattern: row.pattern,
      status: row.status,
      ...(seat === undefined ? {} : { role: seat.role }),
      write: row.write,
      scopeRules: emitScopeRules(parseScope(row.scopeJson), row.write),
      tokenBudget: row.tokenBudget,
      tokensUsed: row.tokensUsed,
      roundCap: row.roundCap,
      roundsUsed: row.roundsUsed,
    };
  }

  // -------------------------------------------------------------------------
  // §2.2 — closing
  // -------------------------------------------------------------------------

  async function closeAssignment(id: string, reason: CloseReason): Promise<void> {
    const row = repository.get(id);
    if (row === undefined) throw new AssignmentNotFoundError(id);
    // Idempotent: closing a closed assignment is not an error, because every
    // stop path in §2.2 reduces to "close it, or leave it open" and several of
    // them can fire for the same assignment.
    if (row.status === 'closed') return;

    const closed = repository.close(id, reason);

    // Cancel the open question cards **through the bridge** (M2): the row
    // transition is the durable half, and going through `cancel()` additionally
    // settles the in-process `ask()` promises so a session blocked on a card of
    // an assignment that just closed stops waiting instead of hanging until the
    // hold expires. Orchestrator is the only writer of `questions` (§6.5), so
    // the direct-repository path below is the same write, used only by a build
    // with no inbox wired.
    const inbox = options.inbox?.();
    if (inbox === undefined) {
      for (const question of questions.listOpen({ assignmentId: id })) {
        questions.cancel(question.id);
      }
    } else {
      inbox.cancelForAssignment(id, `assignment closed: ${reason}`);
    }

    // Stop the sessions still alive. R6 settled that orchestrator **may** do
    // this; what it may never do is *resume* a session runner parked, which is
    // why there is no counterpart to this call anywhere in the element.
    const runner = options.runner();
    if (hasLauncher(runner)) {
      for (const status of LIVE_STATUSES) {
        for (const session of sessions.list({ assignmentId: id, status })) {
          try {
            await runner.stop(session.id, `assignment closed: ${reason}`);
          } catch (error) {
            options.log?.('could not stop a session while closing its assignment', {
              assignmentId: id,
              sessionId: session.id,
              error: String(error),
            });
          }
        }
      }
    }

    unlinkWorkItems(id);

    // Runner **requires** this event to release the workspace lease
    // (runner §15.1-5), so it is emitted last, after every state change the
    // listeners might read is already committed.
    bus.emit({
      type: 'assignment.closed',
      ids: { assignmentId: id, projectId: closed.projectId },
      persist: true,
      payload: {
        closeReason: reason,
        rounds: closed.roundsUsed,
        tokens: closed.tokensUsed,
        artifactPath: closed.artifactPath,
      },
    });
  }

  // -------------------------------------------------------------------------
  // Work-item linking (§2.3, R4)
  // -------------------------------------------------------------------------

  function linkWorkItems(assignmentId: string, ids: readonly string[] | undefined): void {
    if (ids === undefined || ids.length === 0) return; // "Passing no ids writes no rows."
    const projects = options.projects();
    if (!hasWorkItemLinker(projects)) {
      throw new DependencyUnavailableError('projects.linkWorkItems');
    }
    void projects.linkWorkItems(assignmentId, [...new Set(ids)]);
  }

  function unlinkWorkItems(assignmentId: string): void {
    const projects = options.projects();
    if (!hasWorkItemLinker(projects)) return;
    void projects.unlinkWorkItems(assignmentId);
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  function view(row: AssignmentRow): AssignmentView {
    return {
      id: row.id,
      projectId: row.projectId,
      pattern: row.pattern,
      status: row.status,
      phase: row.phase,
      goal: row.goal,
      scope: parseScope(row.scopeJson),
      write: row.write,
      createdBy: row.createdBy,
      parentAssignmentId: row.parentAssignmentId,
      leadAgentId: row.leadAgentId,
      artifactPath: row.artifactPath,
      tokenBudget: row.tokenBudget,
      tokensUsed: row.tokensUsed,
      roundCap: row.roundCap,
      roundsUsed: row.roundsUsed,
      haltReason: row.haltReason,
      closeReason: row.closeReason,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      closedAt: row.closedAt,
      members: repository.listMembers(row.id).map((member) => ({
        agentId: member.agentId,
        role: member.role,
        seatOrder: member.seatOrder,
        joinedAt: member.joinedAt,
      })),
    };
  }

  // -------------------------------------------------------------------------
  // IMPLEMENTATION M1-6 — the boot task
  // -------------------------------------------------------------------------

  /**
   * "Close assignments whose project is archived; reconcile `phase` for
   * assignments whose sessions all reached a terminal status while the core was
   * down."
   *
   * A boot task rather than `start()`: foundation runs it after storage is up
   * and *before* any listener binds (foundation §4.2), so nothing can read an
   * assignment in the window where last run's `phase: running` still looks live.
   *
   * The phase half re-derives from `sessions` on every boot rather than trusting
   * a flag, which is the same discipline §8.1 applies to breaker counters and
   * for the same reason: a restart cannot lose or double-count what it
   * recomputes.
   */
  async function reconcileOnBoot(): Promise<BootReconciliation> {
    const closedForArchivedProject: string[] = [];
    const phaseReconciled: string[] = [];

    for (const row of repository.list({ status: 'open' })) {
      const project = safeProject(row.projectId);
      if (project !== undefined && project.status === 'archived') {
        await closeAssignment(row.id, 'project_archived');
        closedForArchivedProject.push(row.id);
        continue;
      }

      if (row.phase !== 'running') continue;
      const live = LIVE_STATUSES.some(
        (status) => sessions.list({ assignmentId: row.id, status }).length > 0,
      );
      if (live) continue;
      // No live session and nothing to drive it: `running` is a lie the UI would
      // render as a spinner forever. `planned` is the honest reading — the
      // assignment is open and awaiting a turn that nothing is currently taking.
      repository.setPhase(row.id, 'planned');
      phaseReconciled.push(row.id);
    }

    return { closedForArchivedProject, phaseReconciled };
  }

  function safeProject(projectId: string): ProjectFacts | undefined {
    try {
      return projectFacts(projectId);
    } catch {
      // Projects absent at boot is not a reason to refuse to boot: the sweep
      // simply cannot judge, and says nothing rather than closing work blindly.
      return undefined;
    }
  }

  /** §7.2's per-path budget defaults. `solo` is uncapped; `pair` is not. */
  function defaultBudget(request: CreateAssignmentRequest): number | null {
    if (isMachineCreated(request.createdBy)) return null; // §9-8 already refused a null
    return request.pattern === 'pair' ? config.budgets.defaultPairTokens : null;
  }

  function defaultRoundCap(request: CreateAssignmentRequest): number | null {
    return request.pattern === 'pair' ? config.patterns.pair.roundCap : null;
  }

  return {
    createAssignment,
    createSolo,
    closeAssignment,
    getAssignmentContext,
    reconcileOnBoot,

    // Runner reaches the bridge through `ctx.require('orchestrator')` (runner
    // §11.3, §15.1-4). Getters rather than fields because the inbox is built
    // after this object and would otherwise have to be captured as `undefined`.
    get questionBridge(): QuestionInbox | undefined {
      return options.inbox?.();
    },
    get questions(): QuestionInbox | undefined {
      return options.inbox?.();
    },

    // Roster reaches this through `ctx.require('orchestrator')` during
    // `compileSession` (R1). A getter, so a build with no toolset reports the
    // capability as *absent* rather than as a function that refuses.
    get getSessionToolset(): ToolsetFactory | undefined {
      const factory = options.toolset?.();
      if (factory === undefined) return undefined;
      return (launch): SessionToolset => factory(launch);
    },

    get(id) {
      const row = repository.get(id);
      if (row === undefined) throw new AssignmentNotFoundError(id);
      return view(row);
    },

    list: (query: ListAssignmentsQuery = {}) => repository.list(query).map(view),

    update(id, patch: AssignmentPatch) {
      const row = repository.get(id);
      if (row === undefined) throw new AssignmentNotFoundError(id);
      // §4.2's invariant reaches the HTTP surface too: a closed assignment does
      // not take edits, because every field on this patch changes what a future
      // turn is allowed to do and there will be no future turn.
      if (row.status === 'closed') throw new AssignmentClosedError(id);
      return view(repository.update(id, patch));
    },
  };

  function parseScope(json: string | null): AssignmentScope | null {
    if (json === null) return null;
    try {
      const parsed: unknown = JSON.parse(json);
      if (typeof parsed !== 'object' || parsed === null) return null;
      const record = parsed as Record<string, unknown>;
      const paths = Array.isArray(record['paths'])
        ? record['paths'].filter((p): p is string => typeof p === 'string')
        : [];
      return {
        paths,
        ...(typeof record['description'] === 'string'
          ? { description: record['description'] }
          : {}),
        ...(typeof record['artifactPath'] === 'string'
          ? { artifactPath: record['artifactPath'] }
          : {}),
      };
    } catch {
      // A scope that will not parse is a scope nothing can enforce. Returning
      // `null` makes it whole-project *advisory* and — because `emitScopeRules`
      // emits nothing for an empty path list — leaves roster's `write === false`
      // floor as the only boundary, which is the safe direction to fail.
      options.log?.('assignment scope_json did not parse; treated as no scope');
      return null;
    }
  }
}

/** Refusals are collected, never thrown one at a time — see `AssignmentRefusedError`. */
export type { Refusal };

/** Directory-ish comparison key: `docs/x` and `docs/x/` must compare equal. */
function normalisedPrefix(path: string): string {
  return path.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '') + '/';
}
