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
import {
  budgetCrossing,
  budgetHaltPrompt,
  BUDGET_HALT_OPTIONS,
  type BudgetCrossing,
} from './budget.js';
import { createDefaultDenyCanUseTool, createQuestionCanUseTool } from './canUseTool.js';
import type { RunnerConfig } from './config.js';
import { emitRunnerEvent, preview, type SessionEventSubject } from './events.js';
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
import { createInputQueue, type ImageAttachment, type SessionInputQueue } from './inputQueue.js';
import { createMcpAuthCoordinator, mcpLaunchContextNote } from './mcpAuth.js';
import type { SdkSession } from './sdk.js';
import type { LeaseBook } from './leases.js';
import {
  createLiveSessions,
  windDown,
  type InterruptReceipt,
  type LiveSession,
} from './liveSessions.js';
import {
  classifyRateLimit,
  deniedToolNames,
  outcomeForResult,
  readAssistant,
  readStreamDelta,
  readUser,
} from './messages.js';
import { assertOptionsWhitelisted } from './optionGuard.js';
import type { Recovery } from './recovery.js';
import type { RunnerSessionRecord, SessionPriority, SessionRepository } from './repository.js';
import { runReaderLoop } from './readerLoop.js';
import {
  bandRank,
  clampCapacity,
  createScheduler,
  type QueueEntry,
  type QueueState,
  type RateLimitStatus,
  type Scheduler,
} from './scheduler.js';
import type { QueryFn } from './sdk.js';
import { TERMINAL_STATUSES, type ExitReason } from './status.js';
import { composeSummary } from './summary.js';
import type { SessionTranscript, TranscriptFactory } from './transcript.js';
import { createRunMeter, type UsageRepository } from './usage.js';
import { createRateLimitEventCapture, type RateLimitEventCapture } from './usageWindows.js';

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
   * M9's §9.3 reader, for the Continue path.
   *
   * Optional so a build without it still launches: a `continueFrom` with no
   * recovery reader starts a **fresh** conversation rather than a resumed one,
   * which is the honest downgrade rather than a crash.
   */
  readonly recovery?:
    Pick<Recovery, 'resumability' | 'interruption' | 'continuationMessage'> | undefined;
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

/** What `continueFrom` may override on the new session (§9.4 path 2). */
export interface ContinueOptions {
  readonly priority?: SessionPriority | undefined;
  readonly origin?: SessionOrigin | undefined;
}

export interface LaunchChain {
  /** §3.1 steps 0–1, then the pump. */
  startSession(request: StartSessionRequest): Promise<StartSessionResult>;
  /**
   * §9.4 path 2 — Continue: a **new** session row with `resumed_from`, a new
   * transcript, and a first user message stating what happened to the one it
   * continues.
   *
   * The prior session must be terminal; a `paused` one is a `resume` and says
   * so. When §9.3 finds the prior conversation unresumable — no
   * `sdk_session_id`, a workspace that is gone, a deleted SDK session file —
   * this still starts the new session, but **fresh**: the row records the chain,
   * the agent is told the history is not available, and the UI's affordance is
   * Relaunch rather than Continue (§9.3). Refusing outright would turn a
   * pattern's second turn into a failed turn (orchestrator §3.2).
   */
  continueFrom(
    sessionId: string,
    prompt?: string,
    options?: ContinueOptions,
  ): Promise<StartSessionResult>;
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
  /** §7.4's `observed` rate-limit row, for `GET /api/runner/usage` (M11). */
  rateLimitStatus(): RateLimitStatus;
  /** `PUT /api/runner/capacity` (§6.1). Returns the clamped value stored. */
  setCapacity(maxConcurrent: number): number;
  /** Stops admitting. {@link shutdown} is the whole of §9.1. */
  stopAdmitting(): void;
  /** Re-runs admission — §9.2 item 2's "re-admitted through the scheduler". */
  admitQueued(): void;
  /**
   * §9.1's shutdown sequence: stop admitting, then interrupt every running
   * session, wait `gracefulInterruptMs`, close, and settle it `paused` /
   * `service_shutdown`. A session that does not wind down in time is aborted and
   * settles `interrupted` / `shutdown_forced` — honest labelling, because that
   * one may have died mid-tool-call.
   *
   * Resolves when every live session has a written status, which is what makes
   * "no orphaned subprocess" assertable rather than hopeful.
   */
  shutdown(): Promise<void>;
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
  // Events (§10) — M10.
  //
  // The persist flag is **not** an argument here: it is looked up from §10's
  // table in `events.ts` by type, so a high-volume event cannot be flagged
  // durable by a typo at one of eighteen call sites. `ids` comes off the session
  // row for the same reason (§10: "always populated").
  // -------------------------------------------------------------------------

  function emit(
    type: string,
    session: SessionEventSubject,
    payload: Record<string, unknown>,
  ): void {
    emitRunnerEvent({ bus: deps.bus, type, subject: session, payload });
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

  /**
   * §7.4's `cli-reported` row (M11), or nothing at all.
   *
   * Built once, and **not built** when `rateLimit.observeCliEvent` is false —
   * so turning the key off removes the `rate_limit_event` handler rather than
   * making it a no-op that still runs. That distinction is what M11's fourth
   * acceptance bullet is actually asserting when it runs M5's cool-down suite
   * "with the handler disabled".
   */
  const rateLimitEvents: RateLimitEventCapture | undefined = config.rateLimit.observeCliEvent
    ? createRateLimitEventCapture({ settings: store.settings, clock: deps.clock, log })
    : undefined;

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
      // The seat is named, not inferred. Orchestrator resolves `role` by the
      // sole-member shortcut when it is not, and resolves `preGrantedTools` not
      // at all — a pre-grant belongs to one agent and guessing which would
      // pre-answer a card somebody else's user never saw (orchestrator §2.3).
      const context = await deps.assignmentContext.getAssignmentContext(session.assignmentId, {
        agentId: session.agentId,
      });
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
        emit('session.diagnostic', session, {
          severity: diagnostic.level,
          code: diagnostic.code,
          message: diagnostic.message,
        });
      }

      // --- step 7: runner's own fields, and only those ---------------------
      const abort = new AbortController();
      // §5.6 + SDK-NOTES C2, read off what roster compiled — never recomputed.
      const bridgeHealth = questionBridgeStatus(compiled);
      if (bridgeHealth.diagnostic !== undefined) {
        emit('session.diagnostic', session, {
          severity: 'warn',
          code: bridgeHealth.diagnostic.code,
          message: bridgeHealth.diagnostic.message,
          questionBridge: bridgeHealth.status,
        });
      }
      const authed = await attachAuthEnv(compiled.options, {
        mode: deps.auth,
        secrets: deps.secrets,
        sessionId,
        log: (level, message, detail) => {
          log(level, message, detail);
        },
      });
      /**
       * The live `Query`, once it exists.
       *
       * Needed by the OAuth coordinator below, which is built *before* the
       * session it will reconnect — the callback has to be an option, and the
       * options are what `query()` is called with. A `let` closed over is the
       * honest expression of that ordering; the coordinator only reaches it
       * after an elicitation, by which time the session is long since open.
       */
      let openedSdkSession: SdkSession | undefined = undefined;

      /** `Query.reconnectMcpServer` + a fresh status read, after a grant lands. */
      async function reconnectAfterGrant(
        subject: RunnerSessionRecord,
        server: string,
      ): Promise<void> {
        const open = openedSdkSession;
        if (open?.reconnectMcpServer === undefined) {
          // Said plainly rather than left silent: WO6 item 3's "otherwise the
          // card says the turn must be relaunched" case.
          emit('session.diagnostic', subject, {
            severity: 'warn',
            code: 'mcp_reconnect_unavailable',
            message:
              `The "${server}" connector was authorised, but this CLI build cannot reconnect an ` +
              'MCP server inside a running session. Relaunch the turn to pick it up.',
            server,
            relaunchRequired: true,
          });
          return;
        }
        try {
          await open.reconnectMcpServer(server);
          const live = await open.mcpServerStatus?.();
          if (live !== undefined && live.length > 0) {
            emit('runner.mcp.status', subject, {
              sessionId: subject.id,
              servers: live.map((one) => ({ name: one.name, status: one.status })),
            });
          }
        } catch (error) {
          emit('session.diagnostic', subject, {
            severity: 'warn',
            code: 'mcp_reconnect_failed',
            message:
              `The "${server}" connector was authorised but did not reconnect: ${describe(error)}. ` +
              'Relaunch the turn to pick it up.',
            server,
            relaunchRequired: true,
          });
        }
      }

      // WO6 item 3. Built before the options so the callback can close over it,
      // and held for the whole run so `elicitation_complete` can settle the
      // waiter the `url` elicitation opened. `mcpAuth.ts`'s header records what
      // the pinned SDK does and does not offer here.
      const mcpAuth = createMcpAuthCoordinator({
        signal: abort.signal,
        emit: (event) => {
          emit('session.diagnostic', session, {
            severity: event.severity,
            code: event.code,
            message: event.message,
            server: event.server,
            ...(event.url === undefined ? {} : { authorizeUrl: event.url }),
            action: event.code === 'mcp_authorize_url' ? 'authenticate' : null,
          });
        },
        onAuthorized: (server) => {
          // The SDK's own reconnection (`Query.reconnectMcpServer`), so a grant
          // completed mid-turn does not cost the user a relaunch.
          void reconnectAfterGrant(session, server);
        },
      });
      const options: SdkOptions = {
        ...authed,
        /**
         * WO6 item 3: the browser step of a remote MCP server's OAuth flow.
         *
         * Unhandled elicitations are declined silently by default
         * (`sdk.d.ts:1553`), which is precisely the failure the incident
         * produced — a connector that "just didn't work" and an agent left to
         * improvise. With this the link reaches the user as an actionable card.
         */
        onElicitation: (request) =>
          mcpAuth.onElicitation({
            serverName: request.serverName,
            message: request.message,
            ...(request.mode === undefined ? {} : { mode: request.mode }),
            ...(request.url === undefined ? {} : { url: request.url }),
            ...(request.elicitationId === undefined
              ? {}
              : { elicitationId: request.elicitationId }),
          }),
        // §9.4 / SDK-NOTES G3: `resume` and `sessionId` are mutually exclusive
        // unless `forkSession` is set, so the chain sets **at most one** and
        // runner never sets `sessionId`.
        ...(isResumeRun ? { resume: priorSdkSessionId } : {}),
        abortController: abort,
        // §10's `session.delta` exists "only when `includePartialMessages`", and
        // D11 is explicit about what the deltas are *for*: "deltas go to the
        // WebSocket for live typing" while the transcript keeps the complete
        // `assistant` line. Turning it on is what makes the session view type
        // rather than blink; it is one of §3.3's whitelisted keys precisely so
        // runner may make this call.
        includePartialMessages: true,
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
                // WO4 §2: gates this seat's user already answered in the dialog.
                // Orchestrator scoped the list to (assignment, agent) — runner
                // matches the bare name and nothing else.
                preGrantedTools: context.preGrantedTools ?? [],
                // WO4 addendum §6: who is asking, and what a deny would cost.
                seat: { ...(role === null ? {} : { role }), pattern: context.pattern },
                ...(context.artifactPath === undefined || context.artifactPath === null
                  ? {}
                  : { artifactPath: context.artifactPath }),
                onPreAllowed: (preAllowed) => {
                  // Recorded in both places a permission decision is read: the
                  // timeline (a persisted diagnostic) and the transcript. A
                  // gate answered before it was asked is still a gate answered.
                  emit('session.diagnostic', session, {
                    severity: 'info',
                    code: 'tool_pre_allowed',
                    message:
                      `"${preAllowed.toolName}" was pre-allowed for this assignment, so no ` +
                      'permission card was raised. Pre-grants are scoped to this assignment and ' +
                      "expire with it; they do not change the agent's standing permissions.",
                    toolName: preAllowed.toolName,
                  });
                  transcript?.append('system', {
                    event: 'permission.pre_allowed',
                    toolName: preAllowed.toolName,
                    assignmentId: session.assignmentId,
                    agentId: session.agentId,
                  });
                },
                onRaised: (raised) => {
                  emit('session.question.raised', session, {
                    questionId: raised.questionId,
                    kind: raised.kind,
                    prompt: raised.prompt,
                    options: raised.options,
                    toolName: raised.toolName,
                    holdUntil: raised.holdUntil,
                    expiresAt: raised.expiresAt,
                  });
                  transcript?.append('question', {
                    questionId: raised.questionId,
                    prompt: raised.prompt,
                    toolName: raised.toolName,
                    holdUntil: raised.holdUntil,
                  });
                },
                onSettled: (answered) => {
                  emit('session.question.answered', session, {
                    questionId: answered.questionId,
                    answeredVia: answered.answeredVia,
                    latencyMs: answered.latencyMs,
                    delivery: answered.delivery,
                    decision: answered.decision,
                  });
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
      openedSdkSession = sdkSession;
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
          emit('session.usage', session, {
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
          });
          // §7.2's tripwire, read from the figure the metering transaction just
          // committed — so the check never lags an event-bus hop, and the halt
          // lands on the turn that crossed rather than several turns later (M8).
          noteAssignmentTokens(session, metered.assignmentTokensUsed);
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
          // WO6 item 3: `system` / `elicitation_complete` is how the *server*
          // says the human finished authorising (`sdk.d.ts:4111`). It is the
          // only signal that closes a `mode: "url"` elicitation, so it is read
          // here, off the same stream everything else is read from.
          mcpAuth.noteMessage(message);
          // Live deltas, deduped by assistant `message.id` (§7.1). Metering is
          // never allowed to end a session: a token count that cannot be written
          // is a bug worth a loud log line, not a lost turn.
          if (message.type === 'assistant') {
            meterSafely(sessionId, () => meter.recordAssistantMessage(message));
          }
          // §10's four high-volume events (M10). None of them persists — their
          // durable record is the transcript line the reader loop wrote for the
          // same message — and none of them may end a session, which is why the
          // whole block is guarded.
          try {
            publishMessageEvents(session, openTranscript, message);
          } catch (error) {
            log('debug', 'a live session event could not be published', {
              sessionId,
              error: describe(error),
            });
          }
          // §7.4, M11. `capture` both stores whatever it recognised into
          // `settings['runner.rateLimit.lastEvent']` and hands back the parsed
          // facts; it never throws, so an unexpected shape costs a display and
          // not a session. `rateLimitEvents` is `undefined` when
          // `rateLimit.observeCliEvent` is off, which removes the handler
          // outright — the state M11's acceptance runs M5's cool-down suite in.
          const rateLimit = rateLimitEvents?.capture(message);
          if (rateLimit?.exhausted === true) {
            // §6.4 acts on the *presence* of an exhaustion, never on the
            // numbers: `resetsAt` only ever moves a deadline the backoff would
            // otherwise have guessed, and every other captured field is display.
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
          emit('session.started', session, {
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
          });
          if (isResumeRun) {
            // §10's `session.resumed`, with both ids: SDK-NOTES A1 says a plain
            // `resume` should preserve the id, but it is inferred rather than
            // observed (L1), so the design carries both and this reports both.
            emit('session.resumed', session, {
              mode: 'same-session',
              resumedFrom: session.resumedFrom,
              sdkSessionId: facts.sdkSessionId,
              priorSdkSessionId,
            });
          }
          // §10's `runner.mcp.status` and roster §10's actionable `needs-auth`
          // card, plus roster §7.1's plugin/skill assertion — all reads of what
          // `init` reported, none of which may fail the session (M10).
          publishInitDiagnostics(session, sdkSession, compiled.options, facts, input);
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
          message:
            live.exitReason === 'shutdown_forced'
              ? 'AgentManager shut down and this session did not wind down within ' +
                `runner.gracefulInterruptMs (${String(config.gracefulInterruptMs)} ms), so its ` +
                'subprocess was aborted. It may have died mid-tool-call (§9.1 step 3).'
              : live.forced
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
        // WO4 addendum §5: the names, not only the count. They have been in the
        // SDK's array since M8 and the transcript has kept them; what nobody
        // could read was *which* call the agent lost, which is the difference
        // between "2 tool calls denied" and "the write was denied".
        permissionDeniedTools: deniedToolNames(outcome.lastResult.permissionDenials),
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
      /** The denied calls' tool names, in the order the SDK reported them. */
      readonly permissionDeniedTools?: readonly string[];
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
    emit('session.ended', record, {
      status,
      exitReason,
      turns: detail.turns,
      ...(detail.durationMs === undefined ? {} : { durationMs: detail.durationMs }),
      ...(detail.costUsdEstimate === undefined ? {} : { costUsdEstimate: detail.costUsdEstimate }),
      permissionDenials: detail.permissionDenials ?? 0,
      // Absent rather than empty when the session recorded none: a consumer
      // must be able to tell "nothing was denied" from "this build did not
      // say", which is the same distinction 0005's nullable column keeps.
      ...(detail.permissionDeniedTools === undefined || detail.permissionDeniedTools.length === 0
        ? {}
        : { permissionDeniedTools: detail.permissionDeniedTools }),
      summary,
      transcriptBytes: record.transcriptBytes,
      ...(detail.message === undefined ? {} : { message: detail.message }),
    });
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
    //
    // The map is the fast path; the **row** is the fallback, because a budget
    // halt (§7.2) races its own card: the pause is deliberately started before
    // `ask()` resolves, so the id may not be in the map yet. Reading it back is
    // the same read §9.2's boot sweep makes, and it is the durable one.
    const questionId =
      parkedOn.get(sessionId) ??
      (exitReason === 'awaiting_answer' || exitReason === 'budget_halt'
        ? questionIdFor(sessionId)
        : undefined);
    parkedOn.delete(sessionId);
    emit('session.paused', record, {
      reason: exitReason,
      resumable,
      sdkSessionId: record.sdkSessionId,
      forced: detail.forced,
      transcriptBytes: record.transcriptBytes,
      ...(questionId === undefined ? {} : { questionId }),
    });
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
  // §10's live events — M10
  // -------------------------------------------------------------------------

  /** `toolUseId` → what it was and when it started, for `session.tool.end`. */
  const toolsInFlight = new Map<string, { readonly name: string; readonly startedAt: number }>();

  /**
   * The four high-volume events of §10, derived from one SDK message.
   *
   * The `seq` each carries is the transcript line the reader loop is about to
   * write for the same message — this runs *before* the append, which is what
   * makes "merge the live stream and the transcript on `seq`" (ui §9.4) a
   * merge rather than a guess. A `stream_event` writes no line at all (D11), so
   * its `seq` is a watermark: the line it will appear inside.
   */
  function publishMessageEvents(
    subject: RunnerSessionRecord,
    transcript: SessionTranscript,
    message: Parameters<NonNullable<Parameters<typeof runReaderLoop>[0]['onMessage']>>[0],
  ): void {
    const base = transcript.nextSeq();

    if (message.type === 'assistant') {
      const parts = readAssistant(message);
      emit('session.message', subject, {
        seq: base,
        role: 'assistant',
        messageId: parts.messageId,
        contentBlocks: parts.content,
        text: parts.text,
      });
      parts.toolUses.forEach((call, index) => {
        toolsInFlight.set(call.toolUseId, {
          name: call.name,
          startedAt: deps.clock().getTime(),
        });
        emit('session.tool.start', subject, {
          seq: base + 1 + index,
          toolUseId: call.toolUseId,
          name: call.name,
          inputPreview: preview(call.input),
        });
      });
      return;
    }

    if (message.type === 'user') {
      const parts = readUser(message);
      const text = typeof parts.content === 'string' ? parts.content : '';
      emit('session.message', subject, {
        seq: base,
        role: 'user',
        contentBlocks: typeof parts.content === 'string' ? [] : parts.content,
        text,
      });
      parts.toolResults.forEach((result, index) => {
        const started = toolsInFlight.get(result.toolUseId);
        toolsInFlight.delete(result.toolUseId);
        emit('session.tool.end', subject, {
          seq: base + 1 + index,
          toolUseId: result.toolUseId,
          name: started?.name ?? null,
          isError: result.isError,
          durationMs: started === undefined ? null : deps.clock().getTime() - started.startedAt,
          resultPreview: preview(result.content),
        });
      });
      return;
    }

    if (message.type === 'stream_event') {
      const text = readStreamDelta(message);
      if (text !== undefined) emit('session.delta', subject, { seq: base, text });
    }
  }

  /**
   * §10's `runner.mcp.status`, roster §10's `needs-auth` card, and roster §7.1's
   * plugin/skill assertion — everything `init` makes checkable.
   *
   * None of it can fail the session: an MCP server that wants an OAuth dance is
   * an actionable card, not a launch failure, and a plugin the CLI silently
   * skipped is a diagnostic the owner can act on rather than a reason to refuse
   * work the agent can still mostly do.
   */
  function publishInitDiagnostics(
    subject: RunnerSessionRecord,
    sdkSession: {
      mcpServerStatus?: () => Promise<readonly { name: string; status: string }[]>;
      reconnectMcpServer?: (serverName: string) => Promise<void>;
    },
    compiledOptions: SdkOptions,
    facts: {
      mcpServers: readonly { name: string; status: string }[];
      plugins: readonly { name: string; path: string }[];
      skills: readonly string[];
    },
    /** WO6 item 4: where the known-at-launch connector facts are injected. */
    input?: Pick<SessionInputQueue, 'push'>,
  ): void {
    void (async () => {
      // `Query.mcpServerStatus()` is the design's source; `init.mcp_servers`
      // carries the same vocabulary and is what a build without the method (or
      // a fake) answers with. Roster §10's five values pass through unchanged
      // either way — runner re-maps none of them.
      let servers: readonly { name: string; status: string }[] = facts.mcpServers;
      try {
        const live = await sdkSession.mcpServerStatus?.();
        if (Array.isArray(live)) {
          servers = (live as readonly { name: string; status: string }[]).map((server) => ({
            name: server.name,
            status: server.status,
          }));
        }
      } catch (error) {
        log('debug', 'the SDK could not report MCP server status', {
          sessionId: subject.id,
          error: describe(error),
        });
      }

      if (servers.length > 0) {
        emit('runner.mcp.status', subject, { sessionId: subject.id, servers });
      }
      // WO6 item 3: the card is actionable, and honest about what completing it
      // will and will not do. `reconnectMcpServer` exists on the pinned SDK
      // (`sdk.d.ts:2592`) but is optional in runner's seam, so `relaunchRequired`
      // is read off the session rather than assumed — a card that promised a
      // reconnect this build cannot perform would be worse than one that asks
      // for a relaunch.
      const canReconnect = typeof sdkSession.reconnectMcpServer === 'function';
      for (const server of servers) {
        if (server.status !== 'needs-auth') continue;
        emit('session.diagnostic', subject, {
          severity: 'warn',
          code: 'mcp_needs_auth',
          message: canReconnect
            ? `The MCP server "${server.name}" needs authorising before this session can use its ` +
              'tools. The session is running without them. Authorise it and this session ' +
              'reconnects the server without a relaunch.'
            : `The MCP server "${server.name}" needs authorising before this session can use its ` +
              'tools. The session is running without them; authorise the server and relaunch ' +
              'the turn.',
          server: server.name,
          status: server.status,
          action: 'authenticate',
          relaunchRequired: !canReconnect,
        });
      }
      // A `failed` declared server was previously only a roster diagnostic
      // nobody emitted. WO6 item 4 makes it a session fact, because "the agent
      // starts its work knowing the connector is down" needs the down connector
      // to have been said out loud somewhere the session view shows.
      for (const server of servers) {
        if (server.status !== 'failed') continue;
        emit('session.diagnostic', subject, {
          severity: 'warn',
          code: 'mcp_failed',
          message:
            `The MCP server "${server.name}" failed to start, so none of its ` +
            `mcp__${server.name}__* tools are mounted in this session.`,
          server: server.name,
          status: server.status,
        });
      }

      // WO6 item 4's second bullet. Pushed *silently* — see `PushOptions.silent`
      // — so the fact reaches the model's context without buying the session an
      // extra turn in which the agent acknowledges it.
      const note = mcpLaunchContextNote(servers);
      if (note !== undefined && input !== undefined) {
        input.push(note, { silent: true });
        log('debug', 'a launch-time connector note was injected into the session context', {
          sessionId: subject.id,
          servers: servers
            .filter((server) => server.status === 'failed' || server.status === 'needs-auth')
            .map((server) => server.name),
        });
      }
    })().catch((error: unknown) => {
      log('debug', 'MCP status reporting failed', {
        sessionId: subject.id,
        error: describe(error),
      });
    });

    // roster §7.1: "a nonexistent plugin path is **silently skipped**". So the
    // only way to know an agent's skills actually loaded is to compare what was
    // asked for against what `init` reports.
    const wanted = (compiledOptions.plugins ?? []).map((plugin) => plugin.path);
    const present = new Set(facts.plugins.map((plugin) => normalisePath(plugin.path)));
    const missingPlugins = wanted.filter((path) => !present.has(normalisePath(path)));
    if (missingPlugins.length > 0) {
      emit('session.diagnostic', subject, {
        severity: 'warn',
        code: 'plugins_not_loaded',
        message:
          `The CLI did not load ${String(missingPlugins.length)} requested plugin path(s): ` +
          `${missingPlugins.join(', ')}. A nonexistent plugin path is silently skipped (roster §7.1), ` +
          "so the agent's own skills are not available in this session.",
        plugins: missingPlugins,
      });
    }

    const requestedSkills = compiledOptions.skills;
    if (Array.isArray(requestedSkills)) {
      const loaded = new Set(facts.skills.map((skill) => skill.split(':').pop() ?? skill));
      const missingSkills = requestedSkills.filter(
        (skill) => !loaded.has(skill) && !loaded.has(skill.split(':').pop() ?? skill),
      );
      if (missingSkills.length > 0) {
        emit('session.diagnostic', subject, {
          severity: 'warn',
          code: 'skills_not_loaded',
          message:
            `The session requested skills the init message does not list: ${missingSkills.join(', ')} ` +
            '(roster §7.1). They will not fire in this session.',
          skills: missingSkills,
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // §7.2's budget halt — M8
  // -------------------------------------------------------------------------

  /** Sessions that have already halted, so the tripwire fires once per run. */
  const budgetHalted = new Set<string>();

  /**
   * §7.2, run against the figure `assignments.addTokensUsed` just committed.
   *
   * Order matters and is the design's: the session is put on the path to
   * `paused` **first**, then the card is raised, then the event goes out —
   * "because *detect-then-notify-then-act* burns tokens during the notify".
   * The budget itself is re-read from the row rather than taken from the launch
   * chain's `AssignmentContext`, so a budget raised while the session ran is
   * seen (see `budget.ts`).
   */
  function noteAssignmentTokens(
    subject: RunnerSessionRecord,
    assignmentTokensUsed: number | undefined,
  ): void {
    if (assignmentTokensUsed === undefined) return;
    if (budgetHalted.has(subject.id)) return;
    const crossing = budgetCrossing(
      store.assignments.get(subject.assignmentId),
      assignmentTokensUsed,
    );
    if (crossing === undefined) return;
    budgetHalted.add(subject.id);

    log('warn', 'an assignment crossed its token budget and its session was halted', {
      sessionId: subject.id,
      assignmentId: crossing.assignmentId,
      tokenBudget: crossing.tokenBudget,
      tokensUsed: crossing.tokensUsed,
    });

    // 1. Pause. `pause()` sets the wind-down intent before its first `await`,
    //    so the turn stops here rather than after the card round-trips.
    void pause(subject.id, 'budget_halt').catch((error: unknown) => {
      log('error', 'a budget-halted session could not be paused', {
        sessionId: subject.id,
        error: describe(error),
      });
    });

    // 2. The card. `ask()` may take hours to resolve (§15.1-4) and the resume is
    //    driven by the persisted row rather than this promise (§9.2), so the
    //    outcome is deliberately not awaited here.
    raiseBudgetHalt(subject, crossing);

    // 3. The event orchestrator turns into `phase: awaiting_user`.
    emit('assignment.budget.exceeded', subject, {
      assignmentId: crossing.assignmentId,
      tokenBudget: crossing.tokenBudget,
      tokensUsed: crossing.tokensUsed,
      overshoot: crossing.overshoot,
      sessionId: subject.id,
      sessions: sessionsHalted(crossing.assignmentId),
    });
  }

  function sessionsHalted(assignmentId: string): readonly string[] {
    return [...budgetHalted].filter(
      (sessionId) => sessions.get(sessionId)?.assignmentId === assignmentId,
    );
  }

  function raiseBudgetHalt(subject: RunnerSessionRecord, crossing: BudgetCrossing): void {
    const bridge = deps.questionBridge;
    if (bridge === undefined) {
      log('warn', 'a budget halt could not raise a card: this build has no question bridge', {
        sessionId: subject.id,
        assignmentId: crossing.assignmentId,
      });
      return;
    }
    const now = deps.clock().getTime();
    const prompt = budgetHaltPrompt(crossing, sessionsHalted(crossing.assignmentId));
    bridge
      .ask({
        sessionId: subject.id,
        assignmentId: subject.assignmentId,
        agentId: subject.agentId,
        // §15.1-8: `question` and `budget_halt` are the two kinds runner raises.
        kind: 'budget_halt',
        prompt,
        options: BUDGET_HALT_OPTIONS.map((option) => ({ ...option })),
        allowFreeText: true,
        holdUntil: new Date(now).toISOString(),
        expiresAt: new Date(now + config.question.expireHours * 3_600_000).toISOString(),
        onRaised: (questionId) => {
          parkedOn.set(subject.id, questionId);
          emit('session.question.raised', subject, {
            questionId,
            kind: 'budget_halt',
            prompt,
            options: BUDGET_HALT_OPTIONS.map((option) => ({ ...option })),
            toolName: null,
            holdUntil: new Date(now).toISOString(),
            expiresAt: new Date(now + config.question.expireHours * 3_600_000).toISOString(),
          });
        },
      })
      .catch((error: unknown) => {
        log('error', 'the budget-halt card could not be raised', {
          sessionId: subject.id,
          assignmentId: crossing.assignmentId,
          error: describe(error),
        });
      });
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
    emit('session.steered', record, {
      text,
      interrupted: interrupting,
      messageUuid,
      stillQueued: receipt.stillQueued,
      receiptSupported: receipt.supported,
    });

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

      // A resumed session must be able to halt again on its *next* budget
      // crossing (§7.2 — "the next crossing asks again"); without this clear,
      // the once-per-run tripwire above becomes once-per-process.
      budgetHalted.delete(sessionId);

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
    emit('session.ended', after, {
      status: 'interrupted',
      exitReason,
      turns: after.turns,
      permissionDenials: 0,
      summary,
      transcriptBytes: after.transcriptBytes,
      message,
    });
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
      emit('session.ended', after, {
        status: 'interrupted',
        exitReason: 'user_stopped',
        turns: after.turns,
        permissionDenials: 0,
        summary,
        transcriptBytes: after.transcriptBytes,
        message: reason ?? 'Discarded by the user while paused.',
      });
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
  // §3.1 steps 0–1, shared by `startSession` and §9.4's Continue
  // -------------------------------------------------------------------------

  function start(
    request: StartSessionRequest,
    continuation?: { readonly resumedFrom: string; readonly sdkSessionId: string | null },
  ): StartSessionResult {
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
      // §9.4 path 2: "**New** session row, new transcript, `resumed_from = <old
      // id>`". Written at enqueue because it is not patchable — the chain is a
      // record rather than something a later call may rewrite.
      ...(continuation === undefined ? {} : { resumedFrom: continuation.resumedFrom }),
      // §6.1: roster's `defaults.concurrencyWeight`, copied onto the row at
      // enqueue so admission order is decidable from one read over
      // `sessions` without reaching back into roster.
      weight: weightFor(request.agentId),
      // §8.3: written at admission so a live session already has a readable
      // row, and again at the terminal transition.
      summary: composeSummary({ prompt: request.prompt, status: 'queued' }),
    });

    // The one thing that makes the new row a *continuation* rather than a fresh
    // start: `runSession` decides "is this a resume?" from the row's
    // `sdk_session_id`, which is precisely the signal that survives a restart.
    // Left null when §9.3 says the conversation is not resumable — then this is
    // a Relaunch that still records the chain.
    if (continuation?.sdkSessionId != null) {
      sessions.patch(record.id, { sdkSessionId: continuation.sdkSessionId });
    }

    const queuePosition = sessions
      .list({ status: 'queued' })
      .filter(
        (other) =>
          other.id !== record.id &&
          bandRank(other.priority) <= bandRank(record.priority) &&
          (other.queuedAt ?? '') <= (record.queuedAt ?? ''),
      ).length;

    emit('session.queued', record, {
      priority: record.priority,
      weight: record.weight,
      queuePosition,
      promptPreview: request.prompt.slice(0, 200),
      resumedFrom: continuation?.resumedFrom ?? null,
    });

    if (continuation !== undefined) {
      emit('session.resumed', sessions.require(record.id), {
        // §10: `mode: 'same-session' | 'new-session'`. This is the new-session
        // half — the one §9.4 calls Continue.
        mode: 'new-session',
        resumedFrom: continuation.resumedFrom,
        sdkSessionId: continuation.sdkSessionId,
        priorSdkSessionId: continuation.sdkSessionId,
      });
    }

    scheduler.evaluate();
    return { sessionId: record.id, status: record.status, queuePosition };
  }

  return {
    startSession(request) {
      return Promise.resolve().then(() => start(request));
    },

    continueFrom(sessionId, prompt = '', continueOptions = {}) {
      return Promise.resolve().then(() => {
        const prior = sessions.require(sessionId);
        if (!TERMINAL_STATUSES.has(prior.status)) {
          throw new SessionControlRefusedError(
            'continue',
            sessionId,
            prior.status,
            prior.status === 'paused'
              ? 'a paused session is resumed on the same row rather than continued into a new one ' +
                  '(§9.4 path 1). Resume it instead.'
              : `it is "${prior.status}" and has not finished; Continue exists for a session that ` +
                  'genuinely ended (§9.4 path 2).',
          );
        }

        // §9.3, honestly: the resume is offered only when the conversation is
        // actually there. When it is not, this still starts the work — the row
        // records the chain and the agent is told the history is missing —
        // because a pattern's second turn must not fail over a pruned file.
        const state = deps.recovery?.resumability(prior) ?? {
          resumable: prior.sdkSessionId !== null,
        };
        const interruption = deps.recovery?.interruption(sessionId) ?? { lastSeq: 0 };
        const preamble =
          deps.recovery?.continuationMessage(prior, interruption) ??
          `The previous session (${sessionId}) ended. Continue from there.`;
        const opening = state.resumable
          ? preamble
          : `${preamble} Its conversation could not be replayed${
              state.reason === undefined ? '' : `: ${state.reason}`
            }`;

        const record = start(
          {
            assignmentId: prior.assignmentId,
            agentId: prior.agentId,
            projectId: prior.projectId,
            prompt: prompt.trim() === '' ? opening : `${opening}\n\n${prompt}`,
            ...(prior.role === null ? {} : { role: prior.role }),
            priority: continueOptions.priority ?? prior.priority,
            ...(continueOptions.origin === undefined ? {} : { origin: continueOptions.origin }),
          },
          {
            resumedFrom: sessionId,
            sdkSessionId: state.resumable ? prior.sdkSessionId : null,
          },
        );

        log('info', 'a finished session was continued into a new one', {
          sessionId: record.sessionId,
          resumedFrom: sessionId,
          resumable: state.resumable,
          ...(state.code === undefined ? {} : { notResumable: state.code }),
        });
        return record;
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
      // §15.1-5 names the lease. The sessions have to go with it, and M8's third
      // criterion pins the case that makes it visible: a session halted on a
      // budget whose assignment is then *closed* rather than raised "leaves it
      // `interrupted` and releases the lease". A paused session under a closed
      // assignment can never be resumed — admission re-checks the assignment
      // (§6.2) — so leaving it `paused` would strand a Resume button that only
      // ever fails, and would hold the lease for ever through §3.1's safety net.
      for (const session of sessions.list({ assignmentId })) {
        if (session.status === 'paused') {
          endParked(
            session.id,
            'user_stopped',
            'The assignment was closed while this session was paused, so it was discarded.',
          );
        } else if (session.status === 'queued') {
          failQueuedAs(
            session.id,
            'interrupted',
            'user_cancelled',
            'The assignment was closed before this session started.',
          );
        }
      }
      await leases.releaseAssignment(assignmentId);
    },

    onWorkspaceReleased: () => {
      scheduler.unblockAll();
    },

    activeCount: () => scheduler.activeCount(),
    queueState: () => scheduler.state(),
    queueEntries: () => scheduler.entries(),
    rateLimitStatus: () => scheduler.rateLimitStatus(),
    setCapacity: (maxConcurrent) => scheduler.setCapacity(maxConcurrent),
    stopAdmitting: () => {
      scheduler.stop();
    },
    admitQueued: () => {
      scheduler.evaluate();
    },

    async shutdown() {
      // §9.1 step 1: "Stop admitting. Queued sessions stay `queued` — a queue
      // entry is pure intent and loses nothing."
      scheduler.stop();

      const live = liveSessions.ids();
      if (live.length === 0) return;
      log('info', 'shutting down: winding every running session down', { sessions: live.length });

      // Step 2, in parallel, because the whole sequence has to fit inside
      // foundation's `service.shutdownGraceSeconds` and doing them one after
      // another would need N × gracefulInterruptMs.
      await Promise.all(
        live.map(async (sessionId) => {
          const handle = liveSessions.get(sessionId);
          if (handle === undefined) return;
          try {
            await windDown(handle, {
              intent: 'pause',
              gracefulInterruptMs: config.gracefulInterruptMs,
              exitReason: 'service_shutdown',
              // Step 3: "Any session that does not wind down in time: abort its
              // `AbortController`, set `interrupted` / `shutdown_forced`. Honest
              // labelling — that one may have died mid-tool-call."
              forced: { intent: 'stop', exitReason: 'shutdown_forced' },
            });
            await handle.settled;
          } catch (error) {
            log('error', 'a session could not be wound down during shutdown', {
              sessionId,
              error: describe(error),
            });
          }
        }),
      );

      // Step 4: "Workspace leases are **kept**. The assignments are not over."
    },
  };
}

/** A message a human can act on — never a stack trace (§3.2). */
function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Path comparison for roster §7.1's plugin assertion.
 *
 * Windows is the primary platform (architecture D1), so separators and case are
 * both noise here: the question is "did the CLI load the directory we asked
 * for", not "did it echo the string back byte for byte".
 */
function normalisePath(path: string): string {
  return path
    .replace(/[\\/]+/gu, '/')
    .replace(/\/$/u, '')
    .toLowerCase();
}
