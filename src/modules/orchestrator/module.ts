/**
 * The `orchestrator` module (orchestrator IMPLEMENTATION M0-1..3, M1).
 *
 * Registering it wires four things at once, all keyed on the module id:
 *
 * - **`migrations/orchestrator/`** — foundation's `moduleMigrationsFor` maps the
 *   topologically ordered module list onto `migrations/<moduleId>/`, so §2.1's
 *   columns and tables are applied after foundation's core set and tracked in
 *   `schema_migrations` under `orchestrator` purely by virtue of this module
 *   being in the list (foundation §1.3);
 * - **routes**, recorded on foundation's one route table during `init`;
 * - **the service**, published as `orchestrator` so runner reaches
 *   `getAssignmentContext` through `ctx.require` without importing this element
 *   (runner §11.3, §15.1-3). This is the unblock: runner has **no launch path**
 *   without it, because it never mints an assignment (runner §14 D9);
 * - **`dependsOn: ['storage', 'roster', 'projects']`** (M0-1), which is also the
 *   start order.
 *
 * ## Non-critical, deliberately
 *
 * M0-1: "a broken orchestrator must not stop the service booting" (foundation
 * §6.2). Losing the ability to create assignments is bad; losing the ability to
 * read the logs and see why is worse. Runner's §11.3 already states what a
 * missing `orchestrator` means for it — degraded questions, no launch path — so
 * absence is a case every consumer already handles.
 *
 * ## Why the database handle is a constructor argument
 *
 * The same reason projects and runner take one: `assignments.phase`, `write`,
 * `assignment_turns` and `message_reads` arrive in this element's own migration,
 * and foundation gives a feature module repositories rather than a handle
 * (foundation §1.3, and its §1.3 amendment). The getter is lazy because the
 * module list is built *before* the database opens — its topological order is
 * what decides migration order.
 *
 * ## `runner` is not in `dependsOn`
 *
 * It would be a cycle: runner already depends on this module's service for its
 * launch chain. Orchestrator reaches runner through `ctx.require('runner')` at
 * *call* time rather than at `init`, which is exactly the decoupling the service
 * registry exists for — and it is why `createSolo` can give a clean
 * `runner_unavailable` refusal instead of failing to boot.
 */
import type { Storage } from '../../storage/index.js';
import type { Module, ModuleContext, ModuleHandle } from '../types.js';

import { createQuestionInbox, type QuestionInbox } from './questions.js';
import { createQuestionRoutes } from './questionRoutes.js';
import { createAssignmentRepository, type AssignmentRepository } from './repository.js';
import { createAssignmentRoutes } from './routes.js';
import { createAssignmentService } from './service.js';
import type { ProjectsPort, RosterPort, RunnerPort } from './ports.js';
import type { AssignmentService } from './types.js';

/** The module id: `dependsOn`, the service registry, and `migrations/orchestrator/`. */
export const ORCHESTRATOR_MODULE_ID = 'orchestrator';

/** The name `ctx.require('orchestrator')` answers to (runner §11.3). */
export const ORCHESTRATOR_SERVICE = 'orchestrator';

/** Everything the module builds, exposed for the tests that drive it directly. */
export interface OrchestratorInternals {
  readonly repository: AssignmentRepository;
  readonly service: AssignmentService;
  /** M2's inbox and `QuestionBridge`. */
  readonly inbox: QuestionInbox;
}

export interface OrchestratorModuleOptions {
  /** Receives what the module built, so a test can exercise it through `init`. */
  readonly onReady?: (internals: OrchestratorInternals) => void;
}

export function createOrchestratorModule(
  storage: () => Storage,
  options: OrchestratorModuleOptions = {},
): Module {
  return {
    id: ORCHESTRATOR_MODULE_ID,
    dependsOn: ['storage', 'roster', 'projects'],
    init(ctx: ModuleContext): ModuleHandle {
      const open = storage();

      const repository = createAssignmentRepository({
        db: open.db,
        assignments: ctx.store.assignments,
        clock: ctx.clock,
      });

      // M2's inbox is built *after* the service, because §6.5's expiry
      // consequences call `closeAssignment`; the service reaches it back through
      // a getter on this holder, which is what keeps the two from being a
      // constructor cycle.
      const built: { inbox?: QuestionInbox } = {};

      const service = createAssignmentService({
        repository,
        inbox: () => built.inbox,
        sessions: ctx.store.sessions,
        questions: ctx.store.questions,
        bus: ctx.bus,
        config: ctx.config.orchestrator,
        // §9-1's first clause. The module being *in the list* already implies
        // it, since main.ts gates the push on the same flag — but the validator
        // is pure and takes it as an input, so a test can exercise the rule
        // without rebuilding the composition root.
        moduleEnabled: ctx.config.modules.orchestrator.enabled,
        clock: ctx.clock,
        // Resolved at call time, not at init: `ctx.require` answers from the
        // registry as it stands when the call is made, which is what lets
        // orchestrator start before runner does.
        roster: () => ctx.require<RosterPort>('roster'),
        projects: () => ctx.require<ProjectsPort>('projects'),
        runner: () => ctx.require<RunnerPort>('runner'),
        log: (message, detail) => {
          ctx.logger.warn(detail ?? {}, message);
        },
      });

      const inbox = createQuestionInbox({
        questions: ctx.store.questions,
        assignments: repository,
        bus: ctx.bus,
        clock: ctx.clock,
        joinWindowMs: ctx.config.orchestrator.questions.joinWindowMs,
        // §12: runner owns `question.expireHours`; orchestrator **reads** it
        // rather than shipping a second key that could disagree with it.
        expireHours: ctx.config.runner.question.expireHours,
        onExpiredGate: (assignmentId, reason) => {
          void service.closeAssignment(assignmentId, reason);
        },
        onExpiredBudget: (assignmentId) => {
          void service.closeAssignment(assignmentId, 'budget_exhausted');
        },
        log: (message, detail) => {
          ctx.logger.debug(detail ?? {}, message);
        },
      });

      built.inbox = inbox;

      ctx.provide(ORCHESTRATOR_SERVICE, service);
      ctx.registerRoutes(createAssignmentRoutes({ service, logger: ctx.logger }));
      ctx.registerRoutes(createQuestionRoutes({ inbox, logger: ctx.logger }));
      options.onReady?.({ repository, service, inbox });

      // IMPLEMENTATION M1-6. A boot task, not `start()`: foundation runs it
      // after storage is up and *before* any listener binds (foundation §4.2),
      // so nothing can read an assignment in the window where last run's
      // `phase: running` still looks live.
      ctx.registerBootTask(async () => {
        const result = await service.reconcileOnBoot();
        if (result.closedForArchivedProject.length > 0 || result.phaseReconciled.length > 0) {
          ctx.logger.info(
            {
              closedForArchivedProject: result.closedForArchivedProject.length,
              phaseReconciled: result.phaseReconciled.length,
            },
            'assignments from a previous run were reconciled',
          );
        }
      }, 'orchestrator:reconcile-assignments');

      // IMPLEMENTATION M2-5's boot sweep: questions that aged out while the core
      // was down are expired here, before any listener binds, so the inbox never
      // serves a card whose deadline has already passed.
      ctx.registerBootTask(() => {
        const swept = inbox.sweepExpired();
        if (swept.expired.length > 0) {
          ctx.logger.info(
            {
              expired: swept.expired.length,
              closedAssignments: swept.closedAssignments.length,
              haltedAssignments: swept.haltedAssignments.length,
            },
            'questions that aged out while the core was down were expired',
          );
        }
      }, 'orchestrator:expire-questions');

      ctx.logger.info(
        {
          maxConcurrentPerAgent: ctx.config.orchestrator.assignment.maxConcurrentPerAgent,
          notify: ctx.config.orchestrator.notify.enabled,
        },
        'assignment engine ready',
      );

      return {
        health: () => {
          const open_ = repository.list({ status: 'open' });
          return {
            status: 'ok',
            detail: {
              openAssignments: open_.length,
              // The two numbers an assignment panel needs before the pattern
              // engine (M5) exists to report anything richer.
              halted: open_.filter((row) => row.phase === 'halted').length,
              awaitingUser: open_.filter((row) => row.phase === 'awaiting_user').length,
            },
          };
        },
      };
    },
  };
}
