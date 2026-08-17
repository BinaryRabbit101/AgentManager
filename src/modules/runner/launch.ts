/**
 * The launch chain (runner DESIGN §3.1) and the first real session.
 *
 * ```
 * RunnerService.startSession()
 *   ├─ 0. admission checks ────────── assignment open? agent known & not archived?
 *   │                                 project active? queue below runner.queueLimit?
 *   ├─ 1. persist ────────────────── sessions row (queued) + session_inputs, emit session.queued
 *   ├─ 2. scheduler waits ────────── until capacity is free               (M5; fixed at 1 here)
 *   ├─ 3. assignment context ─────── orchestrator.getAssignmentContext(assignmentId)
 *   ├─ 4. workspace lease ────────── projects.acquireWorkspace(…)         ← once per assignment
 *   ├─ 5. launch context ─────────── projects.getEffectiveLaunchContext(…)
 *   ├─ 6. compile ────────────────── roster.compileSession({ agent, project, assignment, secrets })
 *   ├─ 7. runner's own fields ────── §3.3 whitelist only
 *   ├─ 8. transcript open ────────── session.start header, sessions.transcript_path
 *   ├─ 9. query() ────────────────── streaming input; await system/init
 *   └─ 10. running ───────────────── sdk_session_id / model / permission_mode, session.started
 * ```
 *
 * **Steps 3–6 are pure delegation.** Runner supplies ids and consumes results:
 * it reads no other element's tables, re-derives no `cwd`, composes no
 * permissions, resolves no `secretRef` (its own OAuth token excepted, §3.4), and
 * merges no environment variables. Everything this file *decides* is in steps 0,
 * 7, 8 and 10, plus the settle at the end — which is precisely the boundary §1
 * draws: "runner decides *when* and *whether* a compiled session runs, never
 * *what it is allowed to do*".
 *
 * ## Concurrency here is 1, deliberately
 *
 * M3's brief: "Concurrency is temporarily fixed at 1; the scheduler is M5." So
 * the pump below admits one session at a time, `interactive` band first and FIFO
 * by `queued_at` within a band (§6.2's ordering, so M5 inherits behaviour rather
 * than replacing it). Weights, the `settings`-backed capacity override, the
 * `workspaceWaitMinutes` deadline and the rate-limit cool-down are all M5's.
 *
 * ## Failure is a status and a sentence, never a stack trace (§3.2)
 *
 * Every step's failure is a typed error carrying an `exit_reason` from §2.3's
 * closed set. The settle at the bottom writes that reason, a human-readable
 * message on the transcript's `error` line, and `session.ended` — and the API
 * sees the same typed error, with its `status` and `code`.
 *
 * ## Session control (M6, §4.3 / §9.1 / §11.1)
 *
 * `steer`, `pause`, `resume`, `stop` and `pin` are here rather than in
 * `service.ts` because four of the five need the live handle registered at step
 * 9 (`liveSessions.ts`) and the fifth needs the scheduler. Three properties are
 * load-bearing and are stated once, here, rather than at each verb:
 *
 * - **A deliberate wind-down outranks the stream.** When a control verb has set
 *   an intent, the settle writes that verb's status — not the one the last
 *   `result` subtype would have mapped to. An interrupted turn's `result` is not
 *   evidence that the work failed; it is evidence that the interrupt landed.
 * - **A control verb waits for the row.** Every one of them resolves only once
 *   the status it caused is written, so §11.1's idempotency rule ("a retry
 *   returns the current state with 200") is true for a retry that arrives one
 *   millisecond later, not merely one second later.
 * - **Pause keeps the lease, stop does not.** §3.1's refcount is released for
 *   every settle *except* a pause: "paused sessions keep the lease held, which
 *   is the whole point of pausing rather than stopping".
 *
 * The §9.4 resume path is a **resume run on the same row**: a `queued` session
 * whose `sdk_session_id` is already set is, by construction, one that has run
 * before, so the chain re-runs from step 3 (assignment context, lease, launch
 * context, compile — "resuming with stale compiled options would be a permission
 * bug with a very long fuse") and hands `resume: <sdk_session_id>` to `query()`.
 * The transcript is reopened rather than replaced, so `seq` continues.
 */
import type { EventBus } from '../types.js';
import type {
  AgentsRepository,
  AssignmentsRepository,
  Clock,
  ProjectsRepository,
  QuestionsRepository,
  SessionOrigin,
  SessionStatus,
  SettingsRepository,
} from '../../storage/index.js';
import { newId } from '../../storage/index.js';
import type { SecretResolver } from '../../secrets/index.js';

import { resolveAgentEnv } from './agentEnv.js';
import { attachAuthEnv, type AuthMode } from './attachAuthEnv.js';
import { createDefaultDenyCanUseTool, createQuestionCanUseTool } from './canUseTool.js';
import type { RunnerConfig } from './config.js';
import {
  isWorkspaceRefusal,
  type AssignmentContextProvider,
  type CompiledSession,
  type ProjectsProvider,
  type QuestionBridgeView,
  type RosterProvider,
  type SdkOptions,
} from './contracts.js';
import { openQuestionFor, questionBridgeStatus } from './questionBridge.js';
import {
  AgentUnavailableError,
  AssignmentClosedError,
  AssignmentNotFoundError,
  LaunchCompileError,
  ProjectNotLaunchableError,
  ProviderUnavailableError,
  QueueFullError,
  RunnerError,
  SessionControlRefusedError,
  SessionExecutionError,
  SessionNotResumableError,
  SessionStartTimeoutError,
  WorkspaceUnavailableError,
  isLaunchFailure,
} from './errors.js';
import { createInputQueue, type ImageAttachment } from './inputQueue.js';
import type { LeaseBook } from './leases.js';
import {
  createLiveSessions,
  windDown,
  type InterruptReceipt,
  type LiveSession,
} from './liveSessions.js';
import { classifyRateLimit, outcomeForResult, readRateLimitEvent } from './messages.js';
import { assertOptionsWhitelisted } from './optionGuard.js';
import type { RunnerSessionRecord, SessionPriority, SessionRepository } from './repository.js';
import { runReaderLoop } from './readerLoop.js';
import {
  bandRank,
  clampCapacity,
  createScheduler,
  type QueueEntry,
  type QueueState,
  type Scheduler,
} from './scheduler.js';
import type { QueryFn } from './sdk.js';
import { TERMINAL_STATUSES, type ExitReason } from './status.js';
import { composeSummary } from './summary.js';
import type { SessionTranscript, TranscriptFactory } from './transcript.js';
import { createRunMeter, type UsageRepository } from './usage.js';

/** How much of the child's stderr is kept for a failure message (§3.2, §9.2). */
const STDERR_TAIL_BYTES = 4096;

/**
 * What a resumed run says to restart the turn (§9.4 path 1).
 *
 * **Raised rather than assumed.** §9.4 specifies a first message only for path 2
 * (continuing an orphaned session); for a resumed *pause* it says only "same
 * row, same transcript, `resume: sdk_session_id`". But a streaming-input session
 * that is handed no user message never takes a turn — SDK-NOTES §2.2's pump
 * writes one message per iteration and the engine answers messages, not
 * resumptions — so a resume with an empty queue would replay the conversation
 * and then sit there. This is the smallest honest message that starts the turn:
 * it states what happened and adds no new instruction.
 */
export const RESUME_CONTINUATION =
  'This session was paused and has now been resumed. Continue from where you left off — ' +
  'nothing about the assignment has changed, and no work needs repeating.';

export interface StartSessionRequest {
  readonly assignmentId: string;
  readonly agentId: string;
  readonly projectId: string;
  readonly prompt: string;
  /** The seat's role; falls back to the assignment context's (§15.1-3). */
  readonly role?: string | undefined;
  /** §6.2's two bands. UI/remote launches are `interactive`. */
  readonly priority?: SessionPriority | undefined;
  /** From foundation's request context; runner adds no remote behaviour (§15.3). */
  readonly origin?: SessionOrigin | undefined;
  readonly attachments?: readonly unknown[] | undefined;
}

export interface StartSessionResult {
  readonly sessionId: string;
  readonly status: SessionStatus;
  /** How many sessions are ahead of this one in its band. */
  readonly queuePosition: number;
}

/**
 * What every control verb answers with (§11.1's idempotency rule).
 *
 * `changed: false` is the idempotent case — "pausing a paused session, stopping
 * a stopped one, or resuming a running one returns the current state with 200".
 * The caller sees the same shape either way and does not have to branch on it.
 */
export interface SessionControlResult {
  readonly sessionId: string;
  readonly status: SessionStatus;
  readonly exitReason: string | null;
  /** False when the session was already in the state the verb asks for. */
  readonly changed: boolean;
}

/** What a resume may change about the run it restarts (§9.4 path 1, §5.4 stage 3). */
export interface ResumeOptions {
  /** The first user message of the resumed turn. Defaults to {@link RESUME_CONTINUATION}. */
  readonly message?: string | undefined;
  /** §6.2's band. An answered question comes back at `interactive`. */
  readonly priority?: SessionPriority | undefined;
}

export interface SteerOptions {
  /** §4.3: "stop that, do this instead". Default `false` — next turn boundary. */
  readonly interrupt?: boolean | undefined;
  readonly attachments?: readonly unknown[] | undefined;
}

/**
 * The outcome of a steer, including SDK-NOTES **G4**'s receipt.
 *
 * Additive to §11.2's `steer(): Promise<void>`: `stillQueued` is the one fact a
 * caller cannot get any other way, and a UI that cannot say "your earlier steer
 * is still going to run" is a UI that lets the agent surprise its user.
 */
export interface SteerResult extends SessionControlResult {
  readonly interrupted: boolean;
  /** The uuid the steered message was stamped with. */
  readonly messageUuid: string;
  /** G4: queued messages that survive the interrupt and WILL still run. */
  readonly stillQueued: readonly string[];
  /** False when this CLI does not advertise `interrupt_receipt_v1` (G4). */
  readonly receiptSupported: boolean;
}

export type LogSink = (
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string,
  detail?: Record<string, unknown>,
) => void;

export interface LaunchChainDeps {
  readonly sessions: SessionRepository;
  /** M4's meter: `usage_events`, `session_usage`, `assignments.tokens_used` (§7). */
  readonly usage: UsageRepository;
  readonly transcripts: TranscriptFactory;
  /** Foundation's repositories — the only door to another element's tables (§1.3). */
  readonly store: {
    readonly assignments: Pick<AssignmentsRepository, 'get' | 'listMembers'>;
    readonly agents: Pick<AgentsRepository, 'get'>;
    readonly projects: Pick<ProjectsRepository, 'get'>;
    /** The runtime capacity override lives here, not in config (§6.1). */
    readonly settings: Pick<SettingsRepository, 'get' | 'set'>;
    /**
     * M7 reads the `questions` row a parked session is waiting on — the same
     * read §9.2's boot sweep makes, and the reason a park survives a restart.
     * Orchestrator is the table's only *writer* (orchestrator §6.5); this is a
     * read, through foundation's repository.
     */
    readonly questions?: Pick<QuestionsRepository, 'listByAssignment'> | undefined;
  };
  /** `ctx.require('roster')` — fatal when absent (§11.3). */
  readonly roster: () => RosterProvider | undefined;
  /** `ctx.require('projects')` — fatal when absent (§11.3). */
  readonly projects: () => ProjectsProvider | undefined;
  /** orchestrator's, or the stub of `assignmentContext.ts` (§11.3). */
  readonly assignmentContext: AssignmentContextProvider;
  /**
   * M7's question bridge (§5.2): orchestrator's when it is on the registry,
   * runner's degraded fallback otherwise. Absent altogether leaves M3's
   * default-deny installed, which is what a build before M7 had.
   */
  readonly questionBridge?: QuestionBridgeView | undefined;
  readonly leases: LeaseBook;
  readonly secrets: SecretResolver;
  readonly config: RunnerConfig;
  readonly auth: AuthMode;
  readonly policy: {
    readonly allowPermissionElevation: boolean;
    readonly globalDeny: readonly string[];
  };
  /** Foundation's `agentEnv`, nulls unresolved — resolved per launch (§2.3). */
  readonly agentEnv: Readonly<Record<string, string | null>>;
  /** `<dataRoot>\state`, for `agentEnv`'s computed `CLAUDE_CONFIG_DIR`. */
  readonly stateDir: string;
  /** The SDK seam (§4.1). Production passes `realQuery`; tests script it. */
  readonly query: QueryFn;
  readonly clock: Clock;
  readonly bus?: Pick<EventBus, 'emit'> | undefined;
  readonly log?: LogSink | undefined;
  /** Injected so a test's `agentEnv` resolution touches no disk. */
  readonly ensureDir?: ((path: string) => void) | undefined;
}

export interface LaunchChain {
  /** §3.1 steps 0–1, then the pump. */
  startSession(request: StartSessionRequest): Promise<StartSessionResult>;
  /**
   * Resolves when a session reaches a status it will not leave on its own —
   * terminal, `paused`, or blocked back into `queued` by a retryable workspace
   * refusal.
   *
   * Not part of §11.2's pinned interface: it is the seam the M3 checkpoint's
   * demo and every launch test drive, so that "run a session and look at what
   * happened" is one `await` rather than a poll loop. Nothing in the launch
   * path depends on anyone calling it.
   */
  awaitSettled(sessionId: string): Promise<RunnerSessionRecord>;
  /**
   * §4.3: push a message into a **running** session, optionally superseding the
   * turn in flight. Steering anything but a `running` session is a typed 409.
   */
  steer(sessionId: string, text: string, options?: SteerOptions): Promise<SteerResult>;
  /** §2.2 `running → paused`: `interrupt()` + `close()`, slot freed, lease kept. */
  pause(sessionId: string, exitReason?: ExitReason): Promise<SessionControlResult>;
  /**
   * §9.4 path 1: the same row, the same transcript, `resume: <sdk_session_id>`.
   *
   * `options.message` replaces the standard continuation with §5.4 stage 3's
   * first message — "You asked: … The user answered: … Continue from where you
   * stopped" — and `options.priority` is how an answered question re-queues at
   * `interactive`, ahead of background work.
   */
  resume(sessionId: string, options?: ResumeOptions): Promise<SessionControlResult>;
  /**
   * §5.4 stage 2: park a session on an open question (`paused` /
   * `awaiting_answer`), slot released, **lease kept**, question still open.
   *
   * Also the boot path (§9.2 item 3): a session found `running` from a previous
   * life with an open question is parked here rather than orphaned, because it
   * is waiting for a human rather than dead.
   */
  parkForQuestion(sessionId: string, questionId: string | null): Promise<SessionControlResult>;
  /** §5.4: a parked session whose question expired — `interrupted`, not `failed`. */
  endParked(sessionId: string, exitReason: ExitReason, message: string): SessionControlResult;
  /** §2.2's Stop, from any live status. Leaves no subprocess behind (§9.1). */
  stop(sessionId: string, reason?: string): Promise<SessionControlResult>;
  /** `POST /api/sessions/:id/pin` — projects' retention exemption (§11.1). */
  setPinned(sessionId: string, pinned: boolean): SessionControlResult;
  /** Sessions with a live `Query` handle. The "no subprocess left" assertion. */
  liveSessionIds(): readonly string[];
  /** `assignment.closed` from orchestrator: release the lease (§15.1-5). */
  onAssignmentClosed(assignmentId: string): Promise<void>;
  /** `workspace.released` from projects: re-try blocked queue entries (§6.2). */
  onWorkspaceReleased(): void;
  /** Live sessions, for the health report and the queue panel. */
  activeCount(): number;
  /** §11.2's `queueState()`. */
  queueState(): QueueState;
  /** The queue panel's rows, running first (§11.1's `GET /api/runner/queue`). */
  queueEntries(): readonly QueueEntry[];
  /** `PUT /api/runner/capacity` (§6.1). Returns the clamped value stored. */
  setCapacity(maxConcurrent: number): number;
  /** Stops admitting. M9 owns the rest of shutdown. */
  stopAdmitting(): void;
}

export function createLaunchChain(deps: LaunchChainDeps): LaunchChain {
  const { sessions, transcripts, store, leases, config } = deps;
  const log: LogSink = deps.log ?? ((): void => {});

  const settled = new Map<string, Array<(record: RunnerSessionRecord) => void>>();
  /** The `Query` handles, input queues and abort controllers of §4.3 / §9.1. */
  const liveSessions = createLiveSessions();
  /**
   * §5.4 stage 3's first message, held from `resume()` until the run reads it.
   *
   * A map rather than a column: the message is derived from the answer, which is
   * already durable in the `questions` row, so persisting a second copy would be
   * two records of one fact. A resume that loses the map (a restart between the
   * two) still resumes — with the standard continuation — and the boot sweep
   * re-derives the answer message from the row.
   */
  const resumeMessages = new Map<string, string>();
  /** The question a session was parked on, for `session.paused` (§10). */
  const parkedOn = new Map<string, string>();

  // -------------------------------------------------------------------------
  // Events (§10) — the three lifecycle events the launch chain owns. The full
  // table, with its persist flags, is M10's.
  // -------------------------------------------------------------------------

  function emit(
    type: string,
    session: RunnerSessionRecord,
    payload: Record<string, unknown>,
    persist: boolean,
  ): void {
    deps.bus?.emit({
      type,
      ids: {
        sessionId: session.id,
        assignmentId: session.assignmentId,
        projectId: session.projectId,
        agentId: session.agentId,
      },
      payload,
      persist,
    });
  }

  function notifySettled(sessionId: string): void {
    const waiters = settled.get(sessionId);
    if (waiters === undefined) return;
    settled.delete(sessionId);
    const record = sessions.get(sessionId);
    if (record === undefined) return;
    for (const waiter of waiters) waiter(record);
  }

  // -------------------------------------------------------------------------
  // Step 0 — admission
  // -------------------------------------------------------------------------

  function admit(request: StartSessionRequest): void {
    const assignment = store.assignments.get(request.assignmentId);
    if (assignment === undefined) throw new AssignmentNotFoundError(request.assignmentId);
    if (assignment.status !== 'open') throw new AssignmentClosedError(request.assignmentId);

    // Foundation's rebuildable `agents` index, which is the sanctioned way to
    // ask "is this agent known?" without reaching into roster (foundation §1.4).
    const agent = store.agents.get(request.agentId);
    if (agent === undefined) throw new AgentUnavailableError(request.agentId, 'unknown');
    if (agent.archivedAt !== null) throw new AgentUnavailableError(request.agentId, 'archived');

    const project = store.projects.get(request.projectId);
    if (project === undefined) {
      throw new ProjectNotLaunchableError(request.projectId, `No project "${request.projectId}".`);
    }
    if (project.status !== 'active') {
      throw new ProjectNotLaunchableError(
        request.projectId,
        `Project "${project.name}" is ${project.status}; a session cannot be launched against it ` +
          '(projects §2.2).',
      );
    }

    const queued = sessions.list({ status: 'queued' }).length;
    if (queued >= config.queueLimit) throw new QueueFullError(queued, config.queueLimit);
  }

  // -------------------------------------------------------------------------
  // Step 2 — the scheduler (§6, M5)
  // -------------------------------------------------------------------------

  const scheduler: Scheduler = createScheduler({
    sessions,
    config,
    settings: store.settings,
    clock: deps.clock,
    // `runSession` is total — every failure it can name becomes a status. The
    // scheduler's own catch is the guard for the ones it cannot.
    run: (sessionId) => runSession(sessionId),
    onSettled: notifySettled,
    onBlockedExpired: (sessionId, reason) => {
      // §3.2 row 4: "failed after runner.workspaceWaitMinutes". No transcript
      // exists — the file opens at step 8, after the lease — so the reason goes
      // on the row and into `session.ended`, which is where the UI reads it.
      failQueued(
        sessionId,
        'workspace_unavailable',
        `No workspace became available within ${String(config.workspaceWaitMinutes)} minutes: ${reason}`,
      );
    },
    onChanged: (state) => {
      // §10: `runner.queue.changed`, not persisted — it is a live panel, and its
      // durable record is the session rows it is computed from.
      deps.bus?.emit({ type: 'runner.queue.changed', ids: {}, payload: state, persist: false });
    },
    onRateLimited: (payload) => {
      deps.bus?.emit({ type: 'runner.ratelimited', ids: {}, payload, persist: true });
    },
    log,
  });

  /** A queued session that will never start, settled without a transcript. */
  function failQueued(sessionId: string, exitReason: ExitReason, message: string): void {
    failQueuedAs(sessionId, 'failed', exitReason, message);
  }

  // -------------------------------------------------------------------------
  // Steps 3–10, and the settle
  // -------------------------------------------------------------------------

  async function runSession(sessionId: string): Promise<void> {
    let session = sessions.require(sessionId);
    const prompt = sessions.input(sessionId)?.prompt ?? '';
    let transcript: SessionTranscript | undefined;
    let live: LiveSession | undefined;
    let stderrTail = '';
    let lastAssistantText: string | null = null;
    let turns = 0;

    // §9.4 path 1, decided from the row rather than from memory: a `queued`
    // session that already carries an `sdk_session_id` has run before, so this
    // is a resume. Reading it off the row is what makes a resume survive the
    // restart M9 will have to handle, and it is the only signal that does.
    const priorSdkSessionId = session.sdkSessionId;
    const isResumeRun = priorSdkSessionId !== null;

    try {
      // --- step 3: assignment context ------------------------------------
      const context = await deps.assignmentContext.getAssignmentContext(session.assignmentId);
      if (context.status !== 'open') {
        // §6.2: "Admission re-checks assignment status and project status,
        // because both can change while queued."
        throw new LaunchCompileError(
          `Assignment "${session.assignmentId}" closed while this session was queued, so it was ` +
            'never started.',
          { assignmentId: session.assignmentId },
        );
      }
      const role = session.role ?? context.role ?? null;

      // --- step 4: workspace lease, refcounted per assignment --------------
      // `scopePaths` is deliberately not passed: orchestrator's context carries
      // rule *strings* for roster to compose (§15.1-3), not repo-relative paths,
      // and runner does not interpret rules to invent them.
      const acquired = await leases.acquire({
        assignmentId: session.assignmentId,
        projectId: session.projectId,
        sessionId,
        write: context.write,
      });

      if (isWorkspaceRefusal(acquired)) {
        if (acquired.retryable) {
          // §3.2 row 4, retryable half: stays `queued`, consumes no slot, is
          // re-evaluated on `workspace.released`, and fails once it has waited
          // longer than `runner.workspaceWaitMinutes` — the deadline the
          // scheduler keeps from the moment of this first refusal.
          scheduler.block(sessionId, acquired.reason);
          log('info', 'session is waiting for a workspace', {
            sessionId,
            code: acquired.code,
            reason: acquired.reason,
          });
          return;
        }
        throw new WorkspaceUnavailableError(acquired.code, acquired.reason);
      }
      sessions.patch(sessionId, {
        leaseId: acquired.id,
        blockedReason: null,
        ...(role === session.role ? {} : { role }),
      });

      // --- step 5: launch context (raw inputs, uncomposed) -----------------
      const projects = requireProjects();
      const launchContext = await projects.getEffectiveLaunchContext(
        session.projectId,
        session.assignmentId,
      );

      // --- step 6: compile -------------------------------------------------
      const compiled = await compile({
        agentId: session.agentId,
        projectId: session.projectId,
        launchContext,
        assignment: {
          id: context.id,
          ...(role === null ? {} : { role }),
          write: context.write,
          scopeRules: context.scopeRules,
        },
        sessionId,
      });

      const fatal = compiled.diagnostics.filter((diagnostic) => diagnostic.level === 'error');
      if (fatal.length > 0) {
        throw new LaunchCompileError(
          `The session could not be compiled: ${fatal.map((one) => one.message).join('; ')}`,
          { diagnostics: fatal.map((one) => ({ code: one.code, message: one.message })) },
        );
      }
      for (const diagnostic of compiled.diagnostics) {
        emit(
          'session.diagnostic',
          session,
          { severity: diagnostic.level, code: diagnostic.code, message: diagnostic.message },
          true,
        );
      }

      // --- step 7: runner's own fields, and only those ---------------------
      const abort = new AbortController();
      // §5.6 + SDK-NOTES C2, read off what roster compiled — never recomputed.
      const bridgeHealth = questionBridgeStatus(compiled);
      if (bridgeHealth.diagnostic !== undefined) {
        emit(
          'session.diagnostic',
          session,
          {
            severity: 'warn',
            code: bridgeHealth.diagnostic.code,
            message: bridgeHealth.diagnostic.message,
            questionBridge: bridgeHealth.status,
          },
          true,
        );
      }
      const authed = await attachAuthEnv(compiled.options, {
        mode: deps.auth,
        secrets: deps.secrets,
        sessionId,
        log: (level, message, detail) => {
          log(level, message, detail);
        },
      });
      const options: SdkOptions = {
        ...authed,
        // §9.4 / SDK-NOTES G3: `resume` and `sessionId` are mutually exclusive
        // unless `forkSession` is set, so the chain sets **at most one** and
        // runner never sets `sessionId`.
        ...(isResumeRun ? { resume: priorSdkSessionId } : {}),
        abortController: abort,
        // M7: every undecided call becomes a question (§5.1). M3's total
        // default-deny stays as the terminal fallback for a build with no
        // bridge at all — "default-deny is the outcome whenever no human
        // answers", which is true of both.
        canUseTool:
          deps.questionBridge === undefined
            ? createDefaultDenyCanUseTool({
                policy: compiled.policy,
                onDenied: (toolName) => {
                  log(
                    'debug',
                    'a tool call reached canUseTool and was denied by roster default-deny',
                    { sessionId, toolName },
                  );
                },
              })
            : createQuestionCanUseTool({
                sessionId,
                assignmentId: session.assignmentId,
                agentId: session.agentId,
                policy: compiled.policy,
                bridge: deps.questionBridge,
                holdMs: config.question.holdMs,
                expireHours: config.question.expireHours,
                clock: deps.clock,
                onRaised: (raised) => {
                  emit(
                    'session.question.raised',
                    session,
                    {
                      questionId: raised.questionId,
                      kind: raised.kind,
                      prompt: raised.prompt,
                      options: raised.options,
                      toolName: raised.toolName,
                      holdUntil: raised.holdUntil,
                      expiresAt: raised.expiresAt,
                    },
                    true,
                  );
                  transcript?.append('question', {
                    questionId: raised.questionId,
                    prompt: raised.prompt,
                    toolName: raised.toolName,
                    holdUntil: raised.holdUntil,
                  });
                },
                onSettled: (answered) => {
                  emit(
                    'session.question.answered',
                    session,
                    {
                      questionId: answered.questionId,
                      answeredVia: answered.answeredVia,
                      latencyMs: answered.latencyMs,
                      delivery: answered.delivery,
                      decision: answered.decision,
                    },
                    true,
                  );
                },
                onPark: (questionId) => {
                  // The denial is returned first — the SDK is still blocked on
                  // it — and the wind-down follows on the next tick, which is
                  // what makes "the model's next token is the deny message" and
                  // "the session ends up paused" both true.
                  queueMicrotask(() => {
                    // A park that fails is a session left running with an open
                    // card — bad, and loud in the log; it is never a reason to
                    // reject out of a fire-and-forget continuation and take the
                    // process with it.
                    parkForQuestion(sessionId, questionId).catch((error: unknown) => {
                      log('error', 'a session could not be parked on its question', {
                        sessionId,
                        questionId,
                        error: error instanceof Error ? error.message : String(error),
                      });
                    });
                  });
                },
                resolveQuestionId: () => questionIdFor(sessionId),
                log: (level, message, detail) => {
                  log(level, message, detail);
                },
              }),
        stderr: (chunk: string) => {
          // Redacted on the way into `core.log` by foundation's logger; never
          // into the transcript (§3.3).
          stderrTail = `${stderrTail}${chunk}`.slice(-STDERR_TAIL_BYTES);
        },
      };
      // §3.3, enforced: only whitelisted key paths may differ.
      assertOptionsWhitelisted(compiled.options, options);

      // §5.4 stage 3: when a question was answered after the park, the first
      // message of the resumed turn is the **answer**, not the standard
      // continuation — "the agent regains the full conversation, knows the
      // answer, and re-issues the tool call itself". Read once, before the
      // header records it.
      const resumeMessage = resumeMessages.get(sessionId) ?? RESUME_CONTINUATION;
      resumeMessages.delete(sessionId);

      // --- step 8: transcript open + the session.start header ---------------
      transcript = transcripts.open(sessionId, {
        flushLines: config.transcript.flushLines,
        flushMs: config.transcript.flushMs,
        maxMb: config.transcript.maxMb,
        at: deps.clock(),
      });
      transcript.append('session.start', {
        agentId: session.agentId,
        projectId: session.projectId,
        assignmentId: session.assignmentId,
        role,
        model: compiled.options.model ?? null,
        permissionMode: compiled.effective.mode,
        effectivePermissions: {
          mode: compiled.effective.mode,
          allow: compiled.effective.allow,
          deny: compiled.effective.deny,
          ask: compiled.effective.ask,
        },
        elevation: compiled.effective.elevation,
        workspace: {
          kind: acquired.kind,
          path: acquired.path,
          branch: acquired.branch,
        },
        diagnostics: compiled.diagnostics,
        resumedFrom: session.resumedFrom,
        // The resume half of §9.4, on the same file as the run it continues:
        // the header records that a new `query()` began, which conversation it
        // replayed and what it said to restart the turn, and `seq` carries on
        // from the last line (§8.1, M2).
        ...(isResumeRun ? { resumedSdkSessionId: priorSdkSessionId, resumeMessage } : {}),
        // §5.6 (+ C2): `disabled` for a session that cannot prompt at all,
        // `degraded` when the agent's own `AskUserQuestion` is shadowed.
        questionBridge: bridgeHealth.status,
      });

      // --- step 9: query(), streaming input --------------------------------
      const input = createInputQueue({
        onError: (error) => {
          log('error', 'the session input queue failed and was closed', {
            sessionId,
            error: String(error),
          });
        },
      });
      // A resumed run replays the conversation rather than restating it, so the
      // original prompt is pushed on the first run only — pushing it again would
      // ask the agent to redo the work it was paused in the middle of. It still
      // needs *something*: a streaming session that is handed no user message
      // takes no turn, so the resume says what happened, exactly as §9.4's other
      // path does for a session that was orphaned.
      input.push(isResumeRun ? resumeMessage : prompt);
      const sdkSession = deps.query({ prompt: input, options });
      live = liveSessions.open({ sessionId, input, sdk: sdkSession, transcript, abort });

      // --- metering (§7, M4) ------------------------------------------------
      // One meter per `query()` call, because that is the only grain
      // `modelUsage` and `total_cost_usd` actually have (SDK-NOTES C1). A
      // pause/resume on this row gets a *new* run id and a fresh baseline.
      const openTranscript = transcript;
      const meter = createRunMeter({
        usage: deps.usage,
        sessionId,
        assignmentId: session.assignmentId,
        runId: newId(),
        log,
        onUsage: (metered) => {
          emit(
            'session.usage',
            session,
            {
              seq: openTranscript.nextSeq(),
              source: metered.source,
              delta: {
                input: metered.delta.input,
                output: metered.delta.output,
                cacheRead: metered.delta.cacheRead,
                cacheCreation: metered.delta.cacheCreation,
              },
              model: metered.model,
              sessionTotals: metered.totals ?? null,
              assignmentTokensUsed: metered.assignmentTokensUsed ?? null,
            },
            false,
          );
        },
      });

      // --- step 10: running, then the reader loop of §2.4 -------------------
      const openLive = live;
      const outcome = await runReaderLoop({
        session: sdkSession,
        input,
        transcript,
        startTimeoutMs: config.startTimeoutMs,
        // §12's two guards. The SDK has neither (SDK-NOTES §9.1), so both are
        // measured here and settled by §2.3's own `exit_reason` below.
        idleTimeoutMs: config.idleTimeoutMs,
        wallClockMs: config.wallClockMaxMinutes * 60_000,
        abort,
        onTurnEnd: () => {
          openLive.noteTurnEnd();
        },
        onGuard: (guard) => {
          log('warn', 'a session guard tripped and ended the session', { sessionId, guard });
        },
        onMessage: (message) => {
          // Live deltas, deduped by assistant `message.id` (§7.1). Metering is
          // never allowed to end a session: a token count that cannot be written
          // is a bug worth a loud log line, not a lost turn.
          if (message.type === 'assistant') {
            meterSafely(sessionId, () => meter.recordAssistantMessage(message));
          }
          const rateLimit = readRateLimitEvent(message);
          if (rateLimit?.exhausted === true) {
            scheduler.noteRateLimit({
              source: 'rate_limit_event',
              resetsAt: rateLimit.resetsAt,
              hint: `The CLI reported ${rateLimit.rateLimitType ?? 'a plan window'} as exhausted.`,
            });
          }
        },
        onResult: (facts) => {
          // §2.4 step 1, "record turn-level usage": the per-turn figure is
          // `result.usage` (main loop, genuinely per-turn), and the authoritative
          // correction is the per-run difference of `result.modelUsage` (C1).
          meterSafely(sessionId, () => meter.recordResult(facts));
          const source = classifyRateLimit(facts);
          if (source !== undefined) scheduler.noteRateLimit({ source });
        },
        onInit: (facts) => {
          // §6.4: "reset by any successful session start".
          scheduler.noteStarted();
          // SDK-NOTES G4: whether `interrupt()` can answer with a receipt at all
          // is a per-CLI-build fact, and `init` is where it is advertised.
          openLive.capabilities = facts.capabilities;
          session = sessions.transition(sessionId, 'running', {
            sdkSessionId: facts.sdkSessionId,
            model: facts.model,
            permissionMode: facts.permissionMode,
          });
          sessions.setSummary(sessionId, composeSummary({ prompt, status: 'running' }));
          emit(
            'session.started',
            session,
            {
              sdkSessionId: facts.sdkSessionId,
              model: facts.model,
              permissionMode: facts.permissionMode,
              questionBridge: bridgeHealth.status,
              workspace: { kind: acquired.kind, path: acquired.path, branch: acquired.branch },
              effectivePermissions: compiled.effective,
              elevation: compiled.effective.elevation,
              diagnostics: compiled.diagnostics,
              transcriptPath: transcript?.relativePath ?? null,
              resumedFrom: session.resumedFrom,
            },
            true,
          );
          if (isResumeRun) {
            // §10's `session.resumed`, with both ids: SDK-NOTES A1 says a plain
            // `resume` should preserve the id, but it is inferred rather than
            // observed (L1), so the design carries both and this reports both.
            emit(
              'session.resumed',
              session,
              {
                mode: 'same-session',
                resumedFrom: session.resumedFrom,
                sdkSessionId: facts.sdkSessionId,
                priorSdkSessionId,
              },
              true,
            );
          }
        },
      });
      live.markFinished();

      lastAssistantText = outcome.lastAssistantText;
      turns = outcome.turns;
      if (turns > 0) sessions.patch(sessionId, { turns });

      // A deliberate wind-down outranks whatever the stream did on its way out
      // (see the header). The interrupted turn's `result` is evidence that the
      // interrupt landed, not that the work failed.
      if (live.intent === 'pause') {
        settlePaused(sessionId, transcript, live.exitReason ?? 'user_stopped', {
          prompt,
          lastAssistantText,
          turns,
          forced: live.forced,
        });
        return;
      }
      if (live.intent === 'stop') {
        finish(sessionId, transcript, 'interrupted', live.exitReason ?? 'user_stopped', {
          prompt,
          lastAssistantText,
          turns,
          message: live.forced
            ? 'Stopped by the user; the session did not wind down in time and was aborted.'
            : 'Stopped by the user.',
        });
        return;
      }
      if (outcome.guard !== undefined) {
        // §12's deadlines, each with its own `exit_reason` from §2.3.
        finish(sessionId, transcript, 'failed', outcome.guard, {
          prompt,
          lastAssistantText,
          turns,
          message:
            outcome.guard === 'idle_timeout'
              ? `The agent produced no output for ${String(config.idleTimeoutMs)} ms ` +
                '(runner.idleTimeoutMs) and the session was stopped.'
              : `The session ran for longer than runner.wallClockMaxMinutes ` +
                `(${String(config.wallClockMaxMinutes)} minutes) and was stopped.`,
        });
        return;
      }

      if (!outcome.sawInit) {
        throw new SessionStartTimeoutError(
          outcome.startTimedOut
            ? `The agent process produced no system/init within ${String(config.startTimeoutMs)} ms, ` +
                'so the session never started.'
            : 'The agent process ended before it reported system/init, so the session never started.',
          { stderrTail: stderrTail.trim(), startTimedOut: outcome.startTimedOut },
        );
      }

      if (outcome.lastResult === undefined) {
        throw new SessionExecutionError(
          outcome.error === undefined
            ? 'The agent session ended without producing a result.'
            : `The agent session failed: ${describe(outcome.error)}`,
          { stderrTail: stderrTail.trim() },
        );
      }

      if (outcome.error !== undefined) {
        // A result was seen *and* the generator threw — SDK-NOTES §9.3's
        // "the thrown error is replaced" path. The result is authoritative for
        // the status; the throw is recorded so the reason is not lost.
        transcript.append('error', {
          stage: 'stream',
          code: 'stream_error_after_result',
          message: describe(outcome.error),
          stderrTail: stderrTail.trim(),
        });
      }

      const settledOutcome = outcomeForResult(outcome.lastResult.subtype);
      finish(sessionId, transcript, settledOutcome.status, settledOutcome.exitReason, {
        prompt,
        lastAssistantText,
        turns,
        costUsdEstimate: outcome.lastResult.costUsd,
        permissionDenials: outcome.lastResult.permissionDenials.length,
        durationMs: outcome.lastResult.durationMs,
      });
    } catch (error) {
      live?.markFinished();
      const exitReason: ExitReason = isLaunchFailure(error)
        ? (error.exitReason as ExitReason)
        : 'launch_failed';
      const message = describe(error);
      log('warn', 'the launch chain failed', { sessionId, exitReason, message });

      // A session that already settled cannot settle again (§2.2's terminal
      // rule); reaching here twice would mean a bug in the try block, and the
      // log line is how it gets found.
      if (!TERMINAL_STATUSES.has(sessions.require(sessionId).status)) {
        transcript?.append('error', {
          stage: 'launch',
          code: exitReason,
          message,
          ...(stderrTail.trim() === '' ? {} : { stderrTail: stderrTail.trim() }),
        });
        finish(sessionId, transcript, 'failed', exitReason, {
          prompt,
          lastAssistantText,
          turns,
          message,
        });
      }
    } finally {
      // Releasing the handle resolves `settled`, so a control verb blocked on it
      // sees the status it caused — and it must therefore happen *after* the
      // settle above, never before.
      const held = liveSessions.release(sessionId);
      if (held?.intent === 'pause') {
        // §3.1: "paused sessions keep the lease held, which is the whole point
        // of pausing rather than stopping". Dropping the refcount here would let
        // the safety net release the tree the resume is going to land in.
        log('debug', 'session paused; its workspace lease is deliberately kept', {
          sessionId,
          assignmentId: session.assignmentId,
        });
      } else {
        // The lease survives unless this was the assignment's last session and
        // the assignment is no longer open (§3.1's safety net).
        await leases.releaseSession(session.assignmentId, sessionId);
      }
    }
  }

  /**
   * §6.1's weight, read once at enqueue.
   *
   * Runner reads roster's declared default and copies it; it does not derive a
   * weight from a model, a permission set, or anything else it can see. An agent
   * roster cannot answer for — an unreachable provider, a definition without the
   * field — weighs 1, because the alternative is refusing to queue a session
   * over a scheduling hint.
   */
  function weightFor(agentId: string): number {
    const declared = deps.roster()?.registry?.get(agentId)?.definition.defaults?.concurrencyWeight;
    if (typeof declared !== 'number' || !Number.isFinite(declared)) return 1;
    return clampCapacity(declared);
  }

  /** §3.1 step 6, and nothing else: runner supplies inputs, roster composes. */
  async function compile(input: {
    readonly agentId: string;
    readonly projectId: string;
    readonly launchContext: Awaited<ReturnType<ProjectsProvider['getEffectiveLaunchContext']>>;
    readonly assignment: {
      readonly id: string;
      readonly role?: string;
      readonly write: boolean;
      readonly scopeRules: {
        allow?: readonly string[];
        deny?: readonly string[];
        ask?: readonly string[];
      };
    };
    readonly sessionId: string;
  }): Promise<CompiledSession> {
    const roster = deps.roster();
    if (roster === undefined || typeof roster.compileSession !== 'function') {
      throw new ProviderUnavailableError('roster', 'compileSession (roster §13)');
    }
    const agent = roster.registry?.get(input.agentId);
    if (agent === undefined) {
      throw new ProviderUnavailableError('roster', `the agent "${input.agentId}"`);
    }

    const agentEnv = resolveAgentEnv(deps.agentEnv, {
      stateDir: deps.stateDir,
      ...(deps.ensureDir === undefined ? {} : { ensureDir: deps.ensureDir }),
      onWarn: (message, detail) => {
        log('warn', message, { ...detail, sessionId: input.sessionId });
      },
    });

    return roster.compileSession({
      agent,
      project: {
        projectId: input.projectId,
        cwd: input.launchContext.cwd,
        ...(input.launchContext.permissionOverride === undefined
          ? {}
          : { permissionOverride: input.launchContext.permissionOverride }),
        ...(input.launchContext.elevation === undefined
          ? {}
          : { elevation: input.launchContext.elevation }),
        env: input.launchContext.env,
        ...(input.launchContext.instructions === undefined
          ? {}
          : { instructions: input.launchContext.instructions }),
        workspace: {
          kind: input.launchContext.workspace.kind,
          path: input.launchContext.workspace.path,
          branch: input.launchContext.workspace.branch,
        },
      },
      assignment: input.assignment,
      policy: {
        allowPermissionElevation: deps.policy.allowPermissionElevation,
        globalDeny: deps.policy.globalDeny,
      },
      agentEnv,
      defaultModel: config.defaultModel,
      secrets: deps.secrets,
    });
  }

  /** The settle of §2.4 step 5: status, `session.end`, summary, `session.ended`. */
  function finish(
    sessionId: string,
    transcript: SessionTranscript | undefined,
    status: SessionStatus,
    exitReason: ExitReason,
    detail: {
      readonly prompt: string;
      readonly lastAssistantText: string | null;
      readonly turns: number;
      readonly costUsdEstimate?: number;
      readonly permissionDenials?: number;
      readonly durationMs?: number;
      readonly message?: string;
    },
  ): void {
    const summary = composeSummary({
      prompt: detail.prompt,
      status,
      lastAssistantText: detail.lastAssistantText,
    });

    transcript?.append('session.end', {
      status,
      exitReason,
      turns: detail.turns,
      ...(detail.durationMs === undefined ? {} : { durationMs: detail.durationMs }),
      ...(detail.costUsdEstimate === undefined ? {} : { costUsdEstimate: detail.costUsdEstimate }),
      summary,
      ...(detail.message === undefined ? {} : { message: detail.message }),
    });
    transcript?.close();

    const record = sessions.transition(sessionId, status, { exitReason, summary });
    emit(
      'session.ended',
      record,
      {
        status,
        exitReason,
        turns: detail.turns,
        ...(detail.durationMs === undefined ? {} : { durationMs: detail.durationMs }),
        ...(detail.costUsdEstimate === undefined
          ? {}
          : { costUsdEstimate: detail.costUsdEstimate }),
        permissionDenials: detail.permissionDenials ?? 0,
        summary,
        transcriptBytes: record.transcriptBytes,
        ...(detail.message === undefined ? {} : { message: detail.message }),
      },
      true,
    );
  }

  /**
   * §2.2's `running → paused`: stop **with** intent to continue.
   *
   * Deliberately not {@link finish}: a pause is not terminal, its transcript is
   * reopened by the resume rather than replaced, and the event is
   * `session.paused` — which is what tells the UI a Resume button belongs there
   * and tells projects' timeline the assignment is still running (§2.2).
   */
  function settlePaused(
    sessionId: string,
    transcript: SessionTranscript | undefined,
    exitReason: ExitReason,
    detail: {
      readonly prompt: string;
      readonly lastAssistantText: string | null;
      readonly turns: number;
      readonly forced: boolean;
    },
  ): void {
    const before = sessions.require(sessionId);
    const summary = composeSummary({
      prompt: detail.prompt,
      status: 'paused',
      lastAssistantText: detail.lastAssistantText,
    });
    // §9.3's honesty: what makes this resumable is the recorded SDK session id,
    // and nothing else runner holds.
    const resumable = before.sdkSessionId !== null;

    transcript?.append('session.end', {
      status: 'paused',
      exitReason,
      turns: detail.turns,
      resumable,
      sdkSessionId: before.sdkSessionId,
      forced: detail.forced,
      summary,
    });
    transcript?.close();

    const record = sessions.transition(sessionId, 'paused', { exitReason, summary });
    // §10's `session.paused` carries `questionId?` — for a park it is the whole
    // point of the event, because it is what tells the UI which card resumes it.
    const questionId = parkedOn.get(sessionId);
    parkedOn.delete(sessionId);
    emit(
      'session.paused',
      record,
      {
        reason: exitReason,
        resumable,
        sdkSessionId: record.sdkSessionId,
        forced: detail.forced,
        transcriptBytes: record.transcriptBytes,
        ...(questionId === undefined ? {} : { questionId }),
      },
      true,
    );
  }

  /** The open question a session is waiting on, read from the row (§5.4, §9.2). */
  function questionIdFor(sessionId: string): string | undefined {
    const questions = store.questions;
    if (questions === undefined) return undefined;
    const session = sessions.get(sessionId);
    if (session === undefined) return undefined;
    return openQuestionFor(questions, session)?.id;
  }

  /**
   * Runs a metering write, and never lets it end a session.
   *
   * The write is transactional and its failures are real — SDK-NOTES C1's
   * negative-delta assertion in particular — but a session that produced work
   * and then died because its token counter could not be updated is strictly
   * worse than one whose counter is stale and says so in `core.log`. The
   * assertion is still loud; it is just not fatal to the agent's work.
   */
  function meterSafely(sessionId: string, write: () => unknown): void {
    try {
      write();
    } catch (error) {
      log('error', 'usage metering failed for a session', {
        sessionId,
        error: describe(error),
        code: error instanceof RunnerError ? error.code : undefined,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Session control (§4.3, §9.1, §11.1) — M6
  // -------------------------------------------------------------------------

  /** The shape every verb answers with, read fresh off the row. */
  function stateOf(sessionId: string, changed: boolean): SessionControlResult {
    const record = sessions.require(sessionId);
    return {
      sessionId,
      status: record.status,
      exitReason: record.exitReason,
      changed,
    };
  }

  async function steer(
    sessionId: string,
    text: string,
    steerOptions: SteerOptions = {},
  ): Promise<SteerResult> {
    const record = sessions.require(sessionId);
    // §4.3: "Steering a session that is not `running` is a typed 409, not a
    // silent no-op." Deliberately *not* idempotent — unlike pause/stop/resume,
    // a steer that quietly went nowhere is a message the user believes landed.
    if (record.status !== 'running') {
      throw new SessionControlRefusedError(
        'steer',
        sessionId,
        record.status,
        `it is "${record.status}", and only a running session has a turn to steer (§4.3). ` +
          (record.status === 'paused'
            ? 'Resume it first.'
            : 'Start a new session to continue this work.'),
      );
    }
    const live = liveSessions.get(sessionId);
    if (live === undefined) {
      throw new SessionControlRefusedError(
        'steer',
        sessionId,
        record.status,
        'it has no live agent process. The row will settle on its own shortly.',
      );
    }

    const interrupting = steerOptions.interrupt === true;
    // The hold is what keeps §2.4 step 3 from closing the input queue between
    // the interrupted turn's `result` and this push — see `inputQueue.ts`.
    const release = live.input.hold();
    let receipt: InterruptReceipt = { supported: false, stillQueued: [] };
    let messageUuid: string;
    try {
      if (interrupting) {
        receipt = await live.interrupt();
        // §4.3: "wait for the turn to wind down (bounded by
        // runner.gracefulInterruptMs), then push".
        await live.awaitTurnBoundary(config.gracefulInterruptMs);
      }
      messageUuid = live.input.push(
        text,
        steerOptions.attachments === undefined
          ? {}
          : { attachments: steerOptions.attachments as readonly ImageAttachment[] },
      );
    } finally {
      release();
    }

    if (interrupting && receipt.stillQueued.length > 0) {
      // SDK-NOTES G4, surfaced rather than swallowed: these WILL run after the
      // message that was meant to supersede them.
      log('warn', 'an interrupt left queued user messages that will still run', {
        sessionId,
        stillQueued: receipt.stillQueued,
      });
    }

    live.transcript.append('steer', {
      text,
      interrupted: interrupting,
      messageUuid,
      // Recorded even when empty, because "empty" and "this CLI cannot say" are
      // different facts and only one of them is reassuring (G4).
      stillQueued: receipt.stillQueued,
      receiptSupported: receipt.supported,
      ...(receipt.error === undefined ? {} : { interruptError: receipt.error }),
    });
    emit(
      'session.steered',
      record,
      {
        text,
        interrupted: interrupting,
        messageUuid,
        stillQueued: receipt.stillQueued,
        receiptSupported: receipt.supported,
      },
      true,
    );

    return {
      ...stateOf(sessionId, true),
      interrupted: interrupting,
      messageUuid,
      stillQueued: receipt.stillQueued,
      receiptSupported: receipt.supported,
    };
  }

  async function pause(
    sessionId: string,
    exitReason: ExitReason = 'user_stopped',
  ): Promise<SessionControlResult> {
    const record = sessions.require(sessionId);
    // §11.1's idempotency rule: already there, or already over, is a 200.
    if (record.status === 'paused' || TERMINAL_STATUSES.has(record.status)) {
      return stateOf(sessionId, false);
    }
    if (record.status !== 'running') {
      throw new SessionControlRefusedError(
        'pause',
        sessionId,
        record.status,
        '§2.2 has no "queued" → "paused" arrow: a queued session has nothing to suspend. ' +
          'Stop it instead, and start it again when you want it.',
      );
    }

    const live = liveSessions.get(sessionId);
    if (live === undefined) {
      // Nothing to interrupt, so there is nothing this verb can honestly do —
      // the row is about to settle on its own.
      throw new SessionControlRefusedError(
        'pause',
        sessionId,
        record.status,
        'it has no live agent process, so there is nothing to suspend and resume.',
      );
    }

    await windDown(live, {
      intent: 'pause',
      gracefulInterruptMs: config.gracefulInterruptMs,
      exitReason,
    });
    await live.settled;
    return stateOf(sessionId, true);
  }

  function resume(
    sessionId: string,
    resumeOptions: ResumeOptions = {},
  ): Promise<SessionControlResult> {
    return Promise.resolve().then(() => {
      const record = sessions.require(sessionId);
      if (record.status === 'queued' || record.status === 'running') {
        // §5.4's "the work is not run twice": a session already back in the
        // queue does not get a second resume because a duplicate event arrived.
        return stateOf(sessionId, false);
      }
      if (TERMINAL_STATUSES.has(record.status)) {
        throw new SessionControlRefusedError(
          'resume',
          sessionId,
          record.status,
          `"${record.status}" is terminal (§2.2). Continuing this work is a new session with ` +
            'resumed_from, which is what the Continue action does (§9.4).',
        );
      }
      if (record.sdkSessionId === null) {
        throw new SessionNotResumableError(
          sessionId,
          'no SDK session id was ever recorded for it, so there is no conversation to replay (§9.3).',
        );
      }

      if (resumeOptions.message !== undefined) resumeMessages.set(sessionId, resumeOptions.message);

      // §9.4 path 1: the **same** row, back into the queue. `queued_at` is not
      // re-dated (it is not patchable, deliberately), so a resumed session takes
      // its old place at the head of its band rather than the back of the queue.
      const requeued = sessions.transition(sessionId, 'queued', {
        blockedReason: null,
        // §5.4 stage 3: "re-queues the parked session at `interactive`
        // priority". A human is waiting on the other end of this one.
        ...(resumeOptions.priority === undefined ? {} : { priority: resumeOptions.priority }),
      });
      log('info', 'a paused session was re-queued for resume', {
        sessionId,
        sdkSessionId: requeued.sdkSessionId,
        priority: requeued.priority,
      });
      scheduler.evaluate();
      return stateOf(sessionId, true);
    });
  }

  /**
   * §5.4 stage 2 — and §9.2 item 3's boot half, which is the same state reached
   * two different ways.
   */
  async function parkForQuestion(
    sessionId: string,
    questionId: string | null,
  ): Promise<SessionControlResult> {
    const record = sessions.require(sessionId);
    if (record.status === 'paused' || TERMINAL_STATUSES.has(record.status)) {
      return stateOf(sessionId, false);
    }
    if (questionId !== null) parkedOn.set(sessionId, questionId);

    const live = liveSessions.get(sessionId);
    if (live === undefined) {
      // The boot case: `running` in the row, no process anywhere. There is
      // nothing to wind down, and the honest state is the one the answer will
      // resume — not `orphaned`, which is terminal and would strand the card.
      if (record.status !== 'running') {
        parkedOn.delete(sessionId);
        return stateOf(sessionId, false);
      }
      settlePaused(sessionId, undefined, 'awaiting_answer', {
        prompt: sessions.input(sessionId)?.prompt ?? '',
        lastAssistantText: null,
        turns: record.turns,
        forced: false,
      });
      notifySettled(sessionId);
      return stateOf(sessionId, true);
    }

    // The live case: §9.1's wind-down with a pause intent, so the slot is freed
    // and the **lease is kept** — §5.4: "the concurrency slot is released, the
    // workspace lease is kept, and the question stays open".
    await windDown(live, {
      intent: 'pause',
      gracefulInterruptMs: config.gracefulInterruptMs,
      exitReason: 'awaiting_answer',
    });
    await live.settled;
    return stateOf(sessionId, true);
  }

  /** §5.4's expiry half: the parked session ends, the expired card stays as the record. */
  function endParked(
    sessionId: string,
    exitReason: ExitReason,
    message: string,
  ): SessionControlResult {
    const record = sessions.get(sessionId);
    if (record === undefined)
      return { sessionId, status: 'interrupted', exitReason, changed: false };
    if (record.status !== 'paused') return stateOf(sessionId, false);

    const summary = composeSummary({
      prompt: sessions.input(sessionId)?.prompt ?? '',
      status: 'interrupted',
    });
    // `interrupted` rather than `failed`, "because nothing errored — the system
    // deliberately stopped waiting" (§5.4).
    sessions.transition(sessionId, 'interrupted', { exitReason, summary });
    const after = sessions.require(sessionId);
    emit(
      'session.ended',
      after,
      {
        status: 'interrupted',
        exitReason,
        turns: after.turns,
        permissionDenials: 0,
        summary,
        transcriptBytes: after.transcriptBytes,
        message,
      },
      true,
    );
    notifySettled(sessionId);
    return stateOf(sessionId, true);
  }

  async function stop(sessionId: string, reason?: string): Promise<SessionControlResult> {
    const record = sessions.require(sessionId);
    if (TERMINAL_STATUSES.has(record.status)) return stateOf(sessionId, false);

    if (record.status === 'queued') {
      // §2.2: "User cancels a queued session" → `interrupted` / `user_cancelled`.
      // No transcript exists — the file opens at step 8, after the lease.
      failQueuedAs(
        sessionId,
        'interrupted',
        'user_cancelled',
        reason ?? 'Cancelled before it started.',
      );
      return stateOf(sessionId, true);
    }

    if (record.status === 'paused') {
      // §2.2's `paused → interrupted`: "user discards a paused session".
      const summary = composeSummary({
        prompt: sessions.input(sessionId)?.prompt ?? '',
        status: 'interrupted',
      });
      sessions.transition(sessionId, 'interrupted', { exitReason: 'user_stopped', summary });
      const after = sessions.require(sessionId);
      emit(
        'session.ended',
        after,
        {
          status: 'interrupted',
          exitReason: 'user_stopped',
          turns: after.turns,
          permissionDenials: 0,
          summary,
          transcriptBytes: after.transcriptBytes,
          message: reason ?? 'Discarded by the user while paused.',
        },
        true,
      );
      return stateOf(sessionId, true);
    }

    const live = liveSessions.get(sessionId);
    if (live === undefined) {
      // `running` with no handle: the process is already gone, so the honest
      // outcome is the one Stop asks for rather than a refusal the caller can do
      // nothing about.
      finish(sessionId, undefined, 'interrupted', 'user_stopped', {
        prompt: sessions.input(sessionId)?.prompt ?? '',
        lastAssistantText: null,
        turns: record.turns,
        message: reason ?? 'Stopped by the user.',
      });
      notifySettled(sessionId);
      return stateOf(sessionId, true);
    }

    await windDown(live, {
      intent: 'stop',
      gracefulInterruptMs: config.gracefulInterruptMs,
      exitReason: 'user_stopped',
    });
    await live.settled;
    return stateOf(sessionId, true);
  }

  /** A queued session settled without a transcript, to a caller-chosen status. */
  function failQueuedAs(
    sessionId: string,
    status: SessionStatus,
    exitReason: ExitReason,
    message: string,
  ): void {
    const record = sessions.get(sessionId);
    if (record === undefined || TERMINAL_STATUSES.has(record.status)) return;
    finish(sessionId, undefined, status, exitReason, {
      prompt: sessions.input(sessionId)?.prompt ?? '',
      lastAssistantText: null,
      turns: 0,
      message,
    });
    notifySettled(sessionId);
    scheduler.evaluate();
  }

  function requireProjects(): ProjectsProvider {
    const projects = deps.projects();
    if (projects === undefined) {
      throw new ProviderUnavailableError('projects', 'the workspace and launch-context API');
    }
    return projects;
  }

  // -------------------------------------------------------------------------

  return {
    startSession(request) {
      return Promise.resolve().then(() => {
        admit(request);

        const record = sessions.enqueue({
          assignmentId: request.assignmentId,
          agentId: request.agentId,
          projectId: request.projectId,
          prompt: request.prompt,
          ...(request.attachments === undefined ? {} : { attachments: request.attachments }),
          ...(request.role === undefined ? {} : { role: request.role }),
          ...(request.priority === undefined ? {} : { priority: request.priority }),
          ...(request.origin === undefined ? {} : { origin: request.origin }),
          // §6.1: roster's `defaults.concurrencyWeight`, copied onto the row at
          // enqueue so admission order is decidable from one read over
          // `sessions` without reaching back into roster.
          weight: weightFor(request.agentId),
          // §8.3: written at admission so a live session already has a readable
          // row, and again at the terminal transition.
          summary: composeSummary({ prompt: request.prompt, status: 'queued' }),
        });

        const queuePosition = sessions
          .list({ status: 'queued' })
          .filter(
            (other) =>
              other.id !== record.id &&
              bandRank(other.priority) <= bandRank(record.priority) &&
              (other.queuedAt ?? '') <= (record.queuedAt ?? ''),
          ).length;

        emit(
          'session.queued',
          record,
          {
            priority: record.priority,
            weight: record.weight,
            queuePosition,
            promptPreview: request.prompt.slice(0, 200),
          },
          true,
        );

        scheduler.evaluate();
        return { sessionId: record.id, status: record.status, queuePosition };
      });
    },

    awaitSettled(sessionId) {
      const record = sessions.require(sessionId);
      const isSettled =
        !scheduler.isActive(sessionId) &&
        (record.status !== 'queued' || record.blockedReason !== null) &&
        record.status !== 'running';
      if (isSettled) return Promise.resolve(record);
      return new Promise<RunnerSessionRecord>((resolve) => {
        const waiters = settled.get(sessionId) ?? [];
        waiters.push(resolve);
        settled.set(sessionId, waiters);
      });
    },

    steer,
    pause,
    resume,
    parkForQuestion,
    endParked,
    stop,

    setPinned(sessionId, pinned) {
      // §11.1's pin: projects' retention exemption, and nothing more. It is not
      // a status change, so it needs no arrow and works in any status — pinning
      // a *finished* session is in fact the common case.
      sessions.patch(sessionId, { pinned });
      return stateOf(sessionId, true);
    },

    liveSessionIds: () => liveSessions.ids(),

    async onAssignmentClosed(assignmentId) {
      await leases.releaseAssignment(assignmentId);
    },

    onWorkspaceReleased: () => {
      scheduler.unblockAll();
    },

    activeCount: () => scheduler.activeCount(),
    queueState: () => scheduler.state(),
    queueEntries: () => scheduler.entries(),
    setCapacity: (maxConcurrent) => scheduler.setCapacity(maxConcurrent),
    stopAdmitting: () => {
      scheduler.stop();
    },
  };
}

/** A message a human can act on — never a stack trace (§3.2). */
function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
