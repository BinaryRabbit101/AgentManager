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
 */
import type { EventBus } from '../types.js';
import type {
  AgentsRepository,
  AssignmentsRepository,
  Clock,
  ProjectsRepository,
  SessionOrigin,
  SessionStatus,
} from '../../storage/index.js';
import type { SecretResolver } from '../../secrets/index.js';

import { resolveAgentEnv } from './agentEnv.js';
import { attachAuthEnv, type AuthMode } from './attachAuthEnv.js';
import { createDefaultDenyCanUseTool } from './canUseTool.js';
import type { RunnerConfig } from './config.js';
import {
  isWorkspaceRefusal,
  type AssignmentContextProvider,
  type CompiledSession,
  type ProjectsProvider,
  type RosterProvider,
  type SdkOptions,
} from './contracts.js';
import {
  AgentUnavailableError,
  AssignmentClosedError,
  AssignmentNotFoundError,
  LaunchCompileError,
  ProjectNotLaunchableError,
  ProviderUnavailableError,
  QueueFullError,
  SessionExecutionError,
  SessionStartTimeoutError,
  WorkspaceUnavailableError,
  isLaunchFailure,
} from './errors.js';
import { createInputQueue } from './inputQueue.js';
import type { LeaseBook } from './leases.js';
import { outcomeForResult } from './messages.js';
import { assertOptionsWhitelisted } from './optionGuard.js';
import type { RunnerSessionRecord, SessionPriority, SessionRepository } from './repository.js';
import { runReaderLoop } from './readerLoop.js';
import type { QueryFn } from './sdk.js';
import { TERMINAL_STATUSES, type ExitReason } from './status.js';
import { composeSummary } from './summary.js';
import type { SessionTranscript, TranscriptFactory } from './transcript.js';

/** M3's cap. M5 replaces this with the weighted, overridable one of §6.1. */
const M3_MAX_CONCURRENT = 1;

/** How much of the child's stderr is kept for a failure message (§3.2, §9.2). */
const STDERR_TAIL_BYTES = 4096;

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

export type LogSink = (
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string,
  detail?: Record<string, unknown>,
) => void;

export interface LaunchChainDeps {
  readonly sessions: SessionRepository;
  readonly transcripts: TranscriptFactory;
  /** Foundation's repositories — the only door to another element's tables (§1.3). */
  readonly store: {
    readonly assignments: Pick<AssignmentsRepository, 'get' | 'listMembers'>;
    readonly agents: Pick<AgentsRepository, 'get'>;
    readonly projects: Pick<ProjectsRepository, 'get'>;
  };
  /** `ctx.require('roster')` — fatal when absent (§11.3). */
  readonly roster: () => RosterProvider | undefined;
  /** `ctx.require('projects')` — fatal when absent (§11.3). */
  readonly projects: () => ProjectsProvider | undefined;
  /** orchestrator's, or the stub of `assignmentContext.ts` (§11.3). */
  readonly assignmentContext: AssignmentContextProvider;
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
  /** `assignment.closed` from orchestrator: release the lease (§15.1-5). */
  onAssignmentClosed(assignmentId: string): Promise<void>;
  /** `workspace.released` from projects: re-try blocked queue entries (§6.2). */
  onWorkspaceReleased(): void;
  /** Live sessions, for the health report and the queue panel. */
  activeCount(): number;
  /** Stops admitting. M9 owns the rest of shutdown. */
  stopAdmitting(): void;
}

export function createLaunchChain(deps: LaunchChainDeps): LaunchChain {
  const { sessions, transcripts, store, leases, config } = deps;
  const log: LogSink = deps.log ?? ((): void => {});

  const active = new Set<string>();
  const settled = new Map<string, Array<(record: RunnerSessionRecord) => void>>();
  let admitting = true;
  let pumping = false;

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
  // Step 2 — the pump (M5 replaces it with the real scheduler)
  // -------------------------------------------------------------------------

  function nextAdmissible(): RunnerSessionRecord | undefined {
    const queued = sessions
      .list({ status: 'queued' })
      .filter((session) => session.blockedReason === null && !active.has(session.id));
    // §6.2: two priority bands, FIFO by `queued_at` within each.
    const ordered = [...queued].sort((left, right) => {
      const band = bandRank(left.priority) - bandRank(right.priority);
      if (band !== 0) return band;
      return (left.queuedAt ?? '').localeCompare(right.queuedAt ?? '');
    });
    return ordered[0];
  }

  function pump(): void {
    if (pumping) return;
    pumping = true;
    try {
      while (admitting && active.size < M3_MAX_CONCURRENT) {
        const next = nextAdmissible();
        if (next === undefined) return;
        active.add(next.id);
        void runSession(next.id)
          // `runSession` is total — every failure it can name becomes a status.
          // This is the guard for the ones it cannot: a repository that refuses
          // a transition must not surface as an unhandled rejection.
          .catch((error: unknown) => {
            log('error', 'a session ended in an unhandled failure', {
              sessionId: next.id,
              error: describe(error),
            });
          })
          .finally(() => {
            active.delete(next.id);
            notifySettled(next.id);
            pump();
          });
      }
    } finally {
      pumping = false;
    }
  }

  // -------------------------------------------------------------------------
  // Steps 3–10, and the settle
  // -------------------------------------------------------------------------

  async function runSession(sessionId: string): Promise<void> {
    let session = sessions.require(sessionId);
    const prompt = sessions.input(sessionId)?.prompt ?? '';
    let transcript: SessionTranscript | undefined;
    let stderrTail = '';
    let lastAssistantText: string | null = null;
    let turns = 0;

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
          // §3.2 row 4, retryable half: stays `queued`, consumes no slot, and is
          // re-evaluated on `workspace.released`. The `workspaceWaitMinutes`
          // deadline is M5's.
          sessions.patch(sessionId, { blockedReason: acquired.reason });
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
        abortController: abort,
        canUseTool: createDefaultDenyCanUseTool({
          policy: compiled.policy,
          onDenied: (toolName) => {
            log('debug', 'a tool call reached canUseTool and was denied by roster default-deny', {
              sessionId,
              toolName,
            });
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
        // §5.6: a `dontAsk` session has no question bridge at all.
        questionBridge: compiled.policy.humanMayApprove ? 'enabled' : 'disabled',
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
      input.push(prompt);
      const sdkSession = deps.query({ prompt: input, options });

      // --- step 10: running, then the reader loop of §2.4 -------------------
      const outcome = await runReaderLoop({
        session: sdkSession,
        input,
        transcript,
        startTimeoutMs: config.startTimeoutMs,
        abort,
        onInit: (facts) => {
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
              questionBridge: compiled.policy.humanMayApprove ? 'enabled' : 'disabled',
              workspace: { kind: acquired.kind, path: acquired.path, branch: acquired.branch },
              effectivePermissions: compiled.effective,
              elevation: compiled.effective.elevation,
              diagnostics: compiled.diagnostics,
              transcriptPath: transcript?.relativePath ?? null,
              resumedFrom: session.resumedFrom,
            },
            true,
          );
        },
      });

      lastAssistantText = outcome.lastAssistantText;
      turns = outcome.turns;
      if (turns > 0) sessions.patch(sessionId, { turns });

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
      // The lease survives unless this was the assignment's last session and the
      // assignment is no longer open (§3.1's safety net).
      await leases.releaseSession(session.assignmentId, sessionId);
    }
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

        pump();
        return { sessionId: record.id, status: record.status, queuePosition };
      });
    },

    awaitSettled(sessionId) {
      const record = sessions.require(sessionId);
      const isSettled =
        !active.has(sessionId) &&
        (record.status !== 'queued' || record.blockedReason !== null) &&
        record.status !== 'running';
      if (isSettled) return Promise.resolve(record);
      return new Promise<RunnerSessionRecord>((resolve) => {
        const waiters = settled.get(sessionId) ?? [];
        waiters.push(resolve);
        settled.set(sessionId, waiters);
      });
    },

    async onAssignmentClosed(assignmentId) {
      await leases.releaseAssignment(assignmentId);
    },

    onWorkspaceReleased() {
      // Every blocked entry is eligible again; whether it is admitted is the
      // pump's call, and whether it stays blocked is projects' answer next time.
      for (const session of sessions.list({ status: 'queued' })) {
        if (session.blockedReason !== null) sessions.patch(session.id, { blockedReason: null });
      }
      pump();
    },

    activeCount: () => active.size,
    stopAdmitting: () => {
      admitting = false;
    },
  };
}

function bandRank(priority: SessionPriority): number {
  return priority === 'interactive' ? 0 : 1;
}

/** A message a human can act on — never a stack trace (§3.2). */
function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
