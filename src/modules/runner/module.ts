/**
 * The `runner` module (runner IMPLEMENTATION M1).
 *
 * Registering it wires four things at once, all keyed on the module id:
 *
 * - **`migrations/runner/`** — foundation's `moduleMigrationsFor` maps the
 *   topologically ordered module list onto `migrations/<moduleId>/`, so §3.5's
 *   columns are applied after foundation's core set and tracked in
 *   `schema_migrations` under `runner` purely by virtue of this module being in
 *   the list (foundation §1.3);
 * - **routes**, recorded on foundation's one route table during `init`;
 * - **the service**, published as `runner` so orchestrator and the UI reach it
 *   through `ctx.require` without importing this element (§11.2, §15.1 item 1);
 * - **`dependsOn`**, which is also the start order: `storage`, `secrets`,
 *   `roster` and `projects` are all present before the first session can be
 *   admitted (M1's list, unchanged).
 *
 * ## Why the database handle is a constructor argument
 *
 * The same reason projects takes one: §3.5's columns and `session_inputs`
 * arrive in this element's own migration, and foundation gives a feature module
 * repositories rather than a handle. `sessions` itself is runner's table (§1),
 * so composing SQL against it is the sanctioned path — see `repository.ts`. The
 * getter is lazy because the module list is built *before* the database opens:
 * its topological order is what decides migration order.
 *
 * ## Not critical
 *
 * A runner that fails to initialise must leave the service reachable so the
 * owner can read the logs and fix it (foundation §6.2). Losing agent execution
 * is bad; losing the ability to see why is worse.
 */
import type { Storage } from '../../storage/index.js';
import type { Module, ModuleContext, ModuleHandle, Unsubscribe } from '../types.js';

import {
  createAssignmentContextStub,
  resolveAssignmentContextProvider,
} from './assignmentContext.js';
import type {
  AssignmentContextProvider,
  ProjectsProvider,
  QuestionBridgeProvider,
  RosterProvider,
} from './contracts.js';
import { ProviderUnavailableError } from './errors.js';
import { createLaunchChain, type LaunchChain } from './launch.js';
import { createLeaseBook } from './leases.js';
import {
  createQuestionBridgeClient,
  createQuestionSessions,
  installShadowWarningFilter,
  type QuestionBridgeClient,
  type QuestionSessions,
} from './questionBridge.js';
import { createRecovery, type Recovery } from './recovery.js';
import { createSessionRepository, type SessionRepository } from './repository.js';
import { createRunnerRoutes } from './routes.js';
import { realQuery, type QueryFn } from './sdk.js';
import { createRunnerService, type RunnerService } from './service.js';
import { createTranscriptFactory, type TranscriptFactory } from './transcript.js';
import { createTranscriptReader, type TranscriptReader } from './transcriptReader.js';
import { createUsageRepository, type UsageRepository } from './usage.js';

/** The module id: `dependsOn`, the service registry, and `migrations/runner/`. */
export const RUNNER_MODULE_ID = 'runner';

/** The name `ctx.require('runner')` answers to (§11.2). */
export const RUNNER_SERVICE = 'runner';

/** Everything the module builds, exposed for the tests that drive it directly. */
export interface RunnerInternals {
  readonly sessions: SessionRepository;
  readonly usage: UsageRepository;
  readonly transcripts: TranscriptFactory;
  readonly reader: TranscriptReader;
  readonly service: RunnerService;
  readonly launch: LaunchChain;
  /** M7's bridge client and the parked-session machinery. */
  readonly questionBridge: QuestionBridgeClient;
  readonly questionSessions: QuestionSessions;
  /** M9's §9.2 boot reconciliation and §9.3 resumability reader. */
  readonly recovery: Recovery;
}

export interface RunnerModuleOptions {
  /** Receives what the module built, so a test can exercise it through `init`. */
  readonly onReady?: (internals: RunnerInternals) => void;
  /**
   * The SDK seam of §4.1 (`sdk.ts`).
   *
   * Defaults to the real `query()`. A test passes a scripted async generator
   * instead, which is what lets every session mechanic — the reader loop, the
   * status mapping, the transcript vocabulary, the replay filter — be proven
   * without a token, a subprocess, or a bill.
   */
  readonly query?: QueryFn;
}

export function createRunnerModule(
  storage: () => Storage,
  options: RunnerModuleOptions = {},
): Module {
  return {
    id: RUNNER_MODULE_ID,
    dependsOn: ['storage', 'secrets', 'roster', 'projects'],
    init(ctx: ModuleContext): ModuleHandle {
      const open = storage();
      const runner = ctx.config.runner;

      const sessions = createSessionRepository({
        db: open.db,
        store: ctx.store,
        clock: ctx.clock,
      });

      // M4's meter. `usage_events` and `session_usage` are runner's tables (§1);
      // `assignments.tokens_used` is reached only through foundation's
      // repository, inside the same transaction (§7.2).
      const usage = createUsageRepository({
        db: open.db,
        assignments: ctx.store.assignments,
        clock: ctx.clock,
      });

      const transcripts = createTranscriptFactory({
        transcripts: ctx.store.transcripts,
        sessions: ctx.store.sessions,
        clock: ctx.clock,
        log: (level, message, detail) => {
          if (level === 'warn') ctx.logger.warn(detail ?? {}, message);
          else ctx.logger.debug(detail ?? {}, message);
        },
      });

      const reader = createTranscriptReader({
        transcripts: ctx.store.transcripts,
        sessions: ctx.store.sessions,
        maxTailBytes: runner.transcript.maxTailBytes,
        onMalformedLine: (sessionId) => {
          ctx.logger.warn({ sessionId }, 'transcript line did not parse as JSON');
        },
      });

      // The launch chain's three providers are resolved **lazily, per launch**,
      // not captured here (§11.3). Init order is `dependsOn`'s, but a provider
      // can be replaced or arrive late — orchestrator's `getAssignmentContext`
      // is exactly that case — and a getter is what makes the swap a registry
      // lookup rather than a code change.
      const leases = createLeaseBook({
        projects: () => requireProjects(ctx),
        isAssignmentOpen: (assignmentId) =>
          ctx.store.assignments.get(assignmentId)?.status === 'open',
        log: (level, message, detail) => {
          if (level === 'warn') ctx.logger.warn(detail, message);
          else ctx.logger.debug(detail, message);
        },
      });

      // M7's bridge (§5.2): orchestrator's when it is on the registry, runner's
      // degraded fallback when it is not — resolved per ask, so an orchestrator
      // that arrives late is picked up without a restart.
      const questionBridge = createQuestionBridgeClient({
        orchestrator: () => ctx.require<QuestionBridgeProvider>('orchestrator'),
        questions: ctx.store.questions,
        bus: ctx.bus,
        clock: ctx.clock,
        log: (level, message, detail) => {
          ctx.logger[level](detail ?? {}, message);
        },
      });

      // M9's §9.2 / §9.3. Built before the launch chain because the chain's
      // Continue path reads §9.3's answer, and after the reader because that is
      // where the transcript header — and therefore the workspace path a resume
      // needs to exist — comes from.
      const recovery = createRecovery({
        sessions,
        transcripts,
        reader,
        assignments: ctx.store.assignments,
        // Foundation §2.3 pins `CLAUDE_CONFIG_DIR` inside our own data root,
        // which is what makes an SDK session survive our restart at all (§9.3).
        claudeConfigDir: `${open.paths.state}\\claude-config`,
        config: runner,
        releaseLease: async (leaseId) => {
          const projects = ctx.require<ProjectsProvider>('projects');
          if (projects === undefined) return;
          await projects.releaseWorkspace(leaseId);
        },
        admitQueued: () => {
          launch.admitQueued();
        },
        bus: ctx.bus,
        clock: ctx.clock,
        log: (level, message, detail) => {
          ctx.logger[level](detail ?? {}, message);
        },
      });

      const launch = createLaunchChain({
        sessions,
        usage,
        transcripts,
        recovery,
        store: {
          assignments: ctx.store.assignments,
          agents: ctx.store.agents,
          projects: ctx.store.projects,
          settings: ctx.store.settings,
          questions: ctx.store.questions,
        },
        questionBridge,
        roster: () => ctx.require<RosterProvider>('roster'),
        projects: () => ctx.require<ProjectsProvider>('projects'),
        // orchestrator's when it is on the registry, runner's stub when it is
        // not — resolved per launch for the same reason (§11.3, M3's brief).
        assignmentContext: {
          getAssignmentContext: (assignmentId) =>
            assignmentContextProvider(ctx).getAssignmentContext(assignmentId),
        },
        leases,
        secrets: ctx.secrets,
        config: runner,
        auth: ctx.config.auth.mode,
        policy: ctx.config.policy,
        agentEnv: ctx.config.agentEnv,
        stateDir: open.paths.state,
        query: options.query ?? realQuery,
        clock: ctx.clock,
        bus: ctx.bus,
        log: (level, message, detail) => {
          ctx.logger[level](detail ?? {}, message);
        },
      });

      const service = createRunnerService({
        sessions,
        usage,
        transcripts: reader,
        launch,
        recovery,
      });

      // §5.4 stages 2 and 3 seen from outside the callback, plus §9.2's question
      // half. Runner **never** resumes a session it did not park itself
      // (§15.1-7), which is why this consults the row before it acts.
      const questionSessions = createQuestionSessions({
        sessions,
        questions: ctx.store.questions,
        control: launch,
        // M8: a `budget_halt` answer only resumes if the row now has the tokens.
        assignments: ctx.store.assignments,
        bus: ctx.bus,
        clock: ctx.clock,
        log: (level, message, detail) => {
          ctx.logger[level](detail ?? {}, message);
        },
      });

      // §15.1-5: orchestrator emits `assignment.closed`; runner releases the
      // workspace lease on it. §6.2: a session blocked on a retryable workspace
      // refusal is re-evaluated when projects releases one.
      const subscriptions: Unsubscribe[] = [
        ctx.bus.subscribe(['assignment.closed'], (event) => {
          const assignmentId = event.ids.assignmentId;
          if (assignmentId === undefined) return;
          void launch.onAssignmentClosed(assignmentId);
        }),
        ctx.bus.subscribe(['workspace.released'], () => {
          launch.onWorkspaceReleased();
        }),
        questionSessions.subscribe(),
        // SDK-NOTES G6: the shadow warning fires at every `query()` because
        // roster emits an allow set and runner sets `canUseTool`. One debug line
        // beats a multi-line stderr banner per launch.
        installShadowWarningFilter((level, message, detail) => {
          ctx.logger[level](detail ?? {}, message);
        }),
      ];

      // §9.2 item 3, as a boot task: parked sessions are reconciled from their
      // `questions` rows before any listener binds, so an answer that landed
      // while the core was down resumes without waiting for an event that will
      // never be emitted again.
      ctx.registerBootTask(async () => {
        const reconciled = await questionSessions.reconcileOnBoot();
        if (reconciled.parked.length + reconciled.resumed.length + reconciled.ended.length > 0) {
          ctx.logger.info(
            {
              parked: reconciled.parked.length,
              resumed: reconciled.resumed.length,
              ended: reconciled.ended.length,
            },
            'sessions waiting on a question were reconciled after a restart',
          );
        }
      }, 'runner:reconcile-questions');

      // §9.2 items 1, 2 and 4, registered **after** the question sweep and
      // therefore run after it: a session that was mid-question when the core
      // died is one waiting for a human, not a dead one, and parking it first is
      // what keeps the `running → orphaned` sweep from stranding its card (§5.4).
      ctx.registerBootTask(async () => {
        const reconciled = await recovery.reconcileOnBoot();
        if (reconciled.orphaned.length > 0) {
          ctx.logger.warn(
            { sessions: reconciled.orphaned },
            'sessions were left running by a previous process and have been marked orphaned',
          );
        }
      }, 'runner:reconcile-sessions');

      ctx.provide(RUNNER_SERVICE, service);
      ctx.registerRoutes(createRunnerRoutes({ service, logger: ctx.logger, bus: ctx.bus }));
      options.onReady?.({
        sessions,
        usage,
        transcripts,
        reader,
        service,
        launch,
        questionBridge,
        questionSessions,
        recovery,
      });

      ctx.logger.info(
        {
          maxConcurrent: runner.maxConcurrent,
          queueLimit: runner.queueLimit,
          transcripts: open.paths.transcripts,
        },
        'runner ready',
      );

      return {
        /**
         * §9.1, in foundation's `shutdownGraceSeconds` budget.
         *
         * The subscriptions go **first** so nothing new is started or resumed
         * while the wind-down runs, then every running session is interrupted,
         * closed and settled. Awaited, because "leaves no orphaned subprocess"
         * is only true if the process waits for the answer.
         */
        async stop() {
          for (const unsubscribe of subscriptions) unsubscribe();
          await launch.shutdown();
        },

        health: () => {
          const counts = sessions.countByStatus();
          return {
            status: 'ok',
            detail: {
              sessions: counts,
              // The scheduler's own view (§6): the effective cap includes the
              // `settings` override, which `ctx.config` cannot see.
              queue: launch.queueState(),
              queueLimit: runner.queueLimit,
            },
          };
        },
      };
    },
  };
}

/**
 * §11.3: `projects` is fatal for a launch. The lease book asks for it at the
 * moment it needs it, so an absent module is a typed refusal on that session
 * rather than a module that would not initialise.
 */
function requireProjects(ctx: ModuleContext): ProjectsProvider {
  const projects = ctx.require<ProjectsProvider>('projects');
  if (projects === undefined) {
    throw new ProviderUnavailableError('projects', 'the workspace and launch-context API');
  }
  return projects;
}

/** orchestrator's `getAssignmentContext`, or runner's stub (`assignmentContext.ts`). */
function assignmentContextProvider(ctx: ModuleContext): AssignmentContextProvider {
  return resolveAssignmentContextProvider(
    ctx.require<Partial<AssignmentContextProvider>>('orchestrator'),
    createAssignmentContextStub({ assignments: ctx.store.assignments }),
  );
}
