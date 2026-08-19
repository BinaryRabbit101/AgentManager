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

import {
  applyBudgetCardPolicy,
  createBudgetPolicy,
  BUDGET_RAISE_GATE,
  type BudgetPolicy,
} from './budgets.js';
import { raiseCard, GATE_OPTIONS } from './cards.js';
import { createConversationReader } from './conversation.js';
import { createPatternEngine, type PatternEngine } from './engine.js';
import { createEngineRoutes } from './engineRoutes.js';
import { createMailboxRepository, type MailboxRepository } from './messages.js';
import { createNotifier, realNotifyTimers, type Notifier, type NotifyTimers } from './notify.js';
import { withAskingTurn } from './cards.js';
import { createQuestionInbox, type QuestionInbox } from './questions.js';
import { createQuestionRoutes } from './questionRoutes.js';
import { createAssignmentRepository, type AssignmentRepository } from './repository.js';
import { createAssignmentRoutes } from './routes.js';
import { createAssignmentService } from './service.js';
import { createFleetStatusReader } from './status.js';
import { createWidgetFeedReader } from './widget.js';
import { createWidgetRoutes } from './widgetRoutes.js';
import { createToolsetFactory, type ToolsetFactory } from './toolset.js';
import { createTriggerRepository } from './triggers.js';
import { createTriggerRoutes } from './triggerRoutes.js';
import { createTriggerService, type TriggerService } from './triggerScheduler.js';
import { createTurnRepository, type TurnRepository } from './turns.js';
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
  /** M5's `assignment_turns` repository. */
  readonly turns: TurnRepository;
  /** M5/M6's mailbox (the M4 slice §5 needs). */
  readonly mailbox: MailboxRepository;
  /** M5's pattern engine. */
  readonly engine: PatternEngine;
  /** §4.1's per-launch toolset factory. */
  readonly toolset: ToolsetFactory;
  /** M3's budget policy — §7.3's card and the mutate-then-resolve rule. */
  readonly budgets: BudgetPolicy;
  /** M8's ntfy channel. */
  readonly notifier: Notifier;
  /** §2.8's background triggers (WO8), driven by hand in the tests. */
  readonly triggers: TriggerService;
  /** M7-5's staleness sweep, driven once per tick and once per test. */
  sweepStale(): Promise<readonly string[]>;
}

export interface OrchestratorModuleOptions {
  /** Receives what the module built, so a test can exercise it through `init`. */
  readonly onReady?: (internals: OrchestratorInternals) => void;
  /**
   * Injectable timers for M7-5's sweep and M8's delay, so neither test waits.
   *
   * The same seam remote's listener takes, and for the same reason: a state
   * machine whose only trigger is a real clock is a state machine nobody tests.
   */
  readonly timers?: NotifyTimers | undefined;
  /** M8's outbound POST. Injected in tests; `globalThis.fetch` in production. */
  readonly fetch?: typeof globalThis.fetch | undefined;
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

      const turns = createTurnRepository({
        db: open.db,
        clock: ctx.clock,
        log: (message, detail) => {
          ctx.logger.warn(detail ?? {}, message);
        },
      });

      const mailbox = createMailboxRepository({
        db: open.db,
        messages: ctx.store.messages,
        clock: ctx.clock,
      });

      // M2's inbox and M5's toolset are both built *after* the service — the
      // inbox because §6.5's expiry consequences call `closeAssignment`, and the
      // toolset because its `request_user_decision` needs the inbox. The service
      // reaches both back through getters on this holder, which is what keeps
      // three mutually-dependent objects from being a constructor cycle.
      const built: {
        inbox?: QuestionInbox;
        toolset?: ToolsetFactory;
        engine?: PatternEngine;
        budgets?: BudgetPolicy;
      } = {};

      const service = createAssignmentService({
        repository,
        inbox: () => built.inbox,
        toolset: () => built.toolset,
        // Not lazy, unlike the two above: the turn repository is built at the
        // top of this block, so the read model's denial total has it from the
        // first call (WO4 addendum §5).
        turns,
        sessions: ctx.store.sessions,
        questions: ctx.store.questions,
        bus: ctx.bus,
        config: ctx.config.orchestrator,
        // §12: runner owns `question.expireHours`; the gate cards read it.
        expireHours: ctx.config.runner.question.expireHours,
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

      // §7.3's policy, built before the inbox because the inbox calls into it on
      // every answer — and after the service, because closing an assignment is
      // one of the three things an answer can mean.
      const budgets = createBudgetPolicy({
        repository,
        service: () => service,
        bus: ctx.bus,
        config: ctx.config.orchestrator,
        raiseGate: (row, requested) => {
          void raiseCard(
            {
              inbox: built.inbox,
              clock: ctx.clock,
              expireHours: ctx.config.runner.question.expireHours,
              log: (message, detail) => {
                ctx.logger.warn(detail ?? {}, message);
              },
            },
            row,
            {
              kind: 'approval_gate',
              prompt:
                `Raising this assignment's budget to ${String(requested)} tokens is more than ` +
                `${String(ctx.config.orchestrator.budgets.raiseMaxFactor)}× its original. ` +
                'Approve the raise, or deny it and leave the budget where it is?',
              options: GATE_OPTIONS,
              marker: BUDGET_RAISE_GATE,
              toolInput: { assignmentId: row.id, tokens: requested },
            },
          );
          // The id lands asynchronously; the caller's contract is "a gate was
          // raised", and the card itself is how the user reaches it.
          return '';
        },
        log: (message, detail) => {
          ctx.logger.info(detail ?? {}, message);
        },
      });
      built.budgets = budgets;

      const inbox = createQuestionInbox({
        questions: ctx.store.questions,
        assignments: repository,
        bus: ctx.bus,
        clock: ctx.clock,
        joinWindowMs: ctx.config.orchestrator.questions.joinWindowMs,
        // §7.1's split: runner raises the kind, orchestrator says what the card
        // offers.
        // Two shapings, one hook: orchestrator's budget options (§7.1) and the
        // round a tool gate belongs to (WO4 addendum §6). The turn is stamped
        // first so the budget policy's own rewrite carries it too.
        cardPolicy: (request) => applyBudgetCardPolicy(withAskingTurn(turns, request)),
        // §7.3's ordering rule, in the one place every answer passes through.
        onAnswered: (card) => {
          budgets.onAnswered(card);
        },
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

      const toolset = createToolsetFactory({
        assignments: repository,
        turns,
        mailbox,
        bus: ctx.bus,
        clock: ctx.clock,
        config: ctx.config.orchestrator,
        inbox: () => built.inbox,
        service: () => service,
        roster: () => ctx.require<RosterPort>('roster'),
        // §8.1's `tool_flood`: the tool refuses, the engine halts and stops.
        onCapExceeded: (launch, cap) => {
          ctx.logger.warn(
            { assignmentId: launch.assignmentId, agentId: launch.agentId, cap },
            'a session exceeded an orchestration tool cap',
          );
          void built.engine
            ?.tripToolFlood(launch.assignmentId, launch.sessionId)
            .catch((error: unknown) => {
              ctx.logger.warn({ err: error }, 'a tool_flood halt could not be applied');
            });
        },
        // §12: runner owns both question timings; orchestrator **reads** them.
        holdMs: ctx.config.runner.question.holdMs,
        expireHours: ctx.config.runner.question.expireHours,
        log: (message, detail) => {
          ctx.logger.debug(detail ?? {}, message);
        },
      });
      built.toolset = toolset;

      const engine = createPatternEngine({
        repository,
        turns,
        mailbox,
        sessions: ctx.store.sessions,
        service: () => service,
        inbox: () => built.inbox,
        runner: () => ctx.require<RunnerPort>('runner'),
        projects: () => ctx.require<ProjectsPort>('projects'),
        roster: () => ctx.require<RosterPort>('roster'),
        bus: ctx.bus,
        clock: ctx.clock,
        config: ctx.config.orchestrator,
        expireHours: ctx.config.runner.question.expireHours,
        // §3.1's 30-second re-advance after a failed launch. The same injectable
        // the notifier and the sweep use, so a test drives all three by hand.
        ...(options.timers === undefined ? {} : { timers: options.timers }),
        log: (level, message, detail) => {
          ctx.logger[level](detail ?? {}, message);
        },
      });
      built.engine = engine;
      // The loop is entirely event-driven (§3.1), so subscribing *is* starting
      // it. Done in `init` rather than `start()` because the boot task below runs
      // before any `start()` and already needs the loop live.
      const detach = engine.attach();

      const conversation = createConversationReader({
        repository,
        turns,
        mailbox,
        inbox: () => built.inbox,
        config: ctx.config.orchestrator,
      });

      const fleetStatus = createFleetStatusReader({
        repository,
        turns,
        sessions: ctx.store.sessions,
        inbox: () => built.inbox,
        roster: () => ctx.require<RosterPort>('roster'),
      });

      // §11.5's projection sits on top of the fleet reader rather than beside
      // it: one source for the six words, two shapes of it.
      const widgetFeed = createWidgetFeedReader({
        fleetStatus,
        inbox: () => built.inbox,
        sessions: ctx.store.sessions,
        members: (assignmentId) => repository.listMembers(assignmentId),
        roster: () => ctx.require<RosterPort>('roster'),
        clock: ctx.clock,
        config: ctx.config.orchestrator.widget,
      });

      const notifier = createNotifier({
        config: ctx.config.orchestrator,
        inbox: () => built.inbox,
        secrets: ctx.secrets,
        bus: ctx.bus,
        clock: ctx.clock,
        // §10: "the link in the notification is the tailnet URL of the question
        // card". Resolved at send time and `undefined` in the work edition,
        // where remote never binds — and where notification is off anyway.
        baseUrl: () =>
          ctx.require<{ boundAddress?: () => { url?: string } | null }>('remote')?.boundAddress?.()
            ?.url,
        ...(options.timers === undefined ? {} : { timers: options.timers }),
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        log: (level, message, detail) => {
          ctx.logger[level](detail ?? {}, message);
        },
      });
      const detachNotifier = notifier.attach();

      // §2.8's background triggers (WO8). Built after the notifier because a
      // blocked fire and a self-disable both push through §10's channel, and
      // after the service because a fire is a `createAssignment` call and
      // nothing else.
      const triggers = createTriggerService({
        triggers: createTriggerRepository({ db: open.db, clock: ctx.clock }),
        assignments: repository,
        service: () => service,
        bus: ctx.bus,
        clock: ctx.clock,
        config: ctx.config.orchestrator,
        roster: () => ctx.require<RosterPort>('roster'),
        projects: () => ctx.require<ProjectsPort>('projects'),
        notifier: () => notifier,
        log: (level, message, detail) => {
          ctx.logger[level](detail ?? {}, message);
        },
      });
      const detachTriggers = triggers.attach();

      // M7-5's periodic sweep. A self-rescheduling timer rather than an
      // interval, so a slow pass can never overlap itself, and `unref`ed (by
      // `realNotifyTimers`) so it is never the reason the process cannot exit.
      //
      // Its cadence is now set by the *recovery* pass rather than by the halt:
      // §3.1's re-advance is only as prompt as the sweep that calls it, and a
      // quarter of `maxAgeHours` (six hours) would make a two-minute knob mean
      // nothing. Half of `recoverAfterMinutes`, floored at 30 seconds, so the
      // worst case between a wedge and its recovery is one knob's worth.
      const timers = options.timers ?? realNotifyTimers;
      const sweepEveryMs = Math.max(
        30_000,
        Math.floor((ctx.config.orchestrator.assignment.recoverAfterMinutes * 60_000) / 2),
      );
      let cancelSweep: (() => void) | undefined;
      let stopped = false;
      const scheduleSweep = (): void => {
        if (stopped) return;
        cancelSweep = timers.after(sweepEveryMs, async () => {
          const halted = await engine.sweepStale().catch((error: unknown) => {
            ctx.logger.warn({ err: error }, 'the staleness sweep failed');
            return [] as readonly string[];
          });
          if (halted.length > 0) {
            ctx.logger.info({ halted: halted.length }, 'stale assignments were halted');
          }
          scheduleSweep();
        });
      };
      scheduleSweep();

      // §2.8's own timer, a sibling of the sweep above and for the same reasons:
      // self-rescheduling rather than an interval, so a slow tick can never
      // overlap itself, and `unref`ed so a pending fire is never the reason the
      // process cannot exit. Its cadence bounds how *late* a fire can be, not
      // how often one happens — the schedule lives on the row.
      let cancelTick: (() => void) | undefined;
      const scheduleTick = (): void => {
        if (stopped) return;
        cancelTick = timers.after(ctx.config.orchestrator.triggers.tickMs, async () => {
          const fired = await triggers.tick().catch((error: unknown) => {
            ctx.logger.warn({ err: error }, 'the trigger tick failed');
            return [];
          });
          if (fired.length > 0) {
            ctx.logger.debug({ fired: fired.length }, 'background triggers were evaluated');
          }
          scheduleTick();
        });
      };
      scheduleTick();

      ctx.provide(ORCHESTRATOR_SERVICE, service);
      ctx.registerRoutes(createAssignmentRoutes({ service, logger: ctx.logger }));
      ctx.registerRoutes(createQuestionRoutes({ inbox, logger: ctx.logger }));
      ctx.registerRoutes(
        createEngineRoutes({ engine, service, conversation, fleetStatus, logger: ctx.logger }),
      );
      ctx.registerRoutes(createWidgetRoutes({ widgetFeed, logger: ctx.logger }));
      ctx.registerRoutes(createTriggerRoutes({ triggers, logger: ctx.logger }));
      options.onReady?.({
        repository,
        service,
        inbox,
        turns,
        mailbox,
        engine,
        toolset,
        budgets,
        notifier,
        triggers,
        sweepStale: () => engine.sweepStale(),
      });

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

      // IMPLEMENTATION M5-5. Runs after M1's phase reconciliation, so an
      // assignment closed for an archived project is never re-entered: a turn is
      // only failed and re-planned for an assignment that is still `open`.
      ctx.registerBootTask(async () => {
        const result = await engine.reconcileOnBoot();
        if (result.failedTurns.length > 0 || result.resumed.length > 0) {
          ctx.logger.info(
            { failedTurns: result.failedTurns.length, resumed: result.resumed.length },
            'turns from a previous run were reconciled and the pattern loop re-entered',
          );
        }
      }, 'orchestrator:reconcile-turns');

      // §2.8's boot pass. A boot task rather than the first tick, so a trigger
      // whose window closed while the core was down is re-armed before any
      // listener can show a `next_fire_at` in the past — and so the catch-up
      // collapse happens exactly once per boot rather than once per tick.
      ctx.registerBootTask(() => {
        const result = triggers.reconcileOnBoot();
        if (result.rearmed.length > 0) {
          ctx.logger.info(
            { rearmed: result.rearmed.length },
            'background triggers were re-armed after a restart',
          );
        }
      }, 'orchestrator:rearm-triggers');

      ctx.logger.info(
        {
          maxConcurrentPerAgent: ctx.config.orchestrator.assignment.maxConcurrentPerAgent,
          notify: ctx.config.orchestrator.notify.enabled,
        },
        'assignment engine ready',
      );

      return {
        stop: () => {
          // The loop is its subscriptions; dropping them is how it stops. Without
          // this a second boot in one process (every test that reboots) would
          // drive the same assignment from two engines.
          detach();
          detachNotifier();
          detachTriggers();
          stopped = true;
          cancelSweep?.();
          cancelTick?.();
        },
        health: () => {
          const open_ = repository.list({ status: 'open' });
          const notify = notifier.health();
          return {
            // M8-3: a channel that is configured and failing is a **degraded
            // capability**, surfaced here and never retried into a loop. The
            // questions themselves are unaffected — they are raised, listed and
            // answerable whatever ntfy does.
            status: notify.degraded ? 'degraded' : 'ok',
            ...(notify.degraded
              ? {
                  conditions: [
                    {
                      id: `orchestrator.notify.${ctx.config.orchestrator.notify.channel}`,
                      level: 'warn' as const,
                      message:
                        `the ${ctx.config.orchestrator.notify.channel} notification channel is ` +
                        `not delivering (${notify.lastError ?? 'unknown error'}); question cards ` +
                        'are still raised and answerable over the tailnet',
                    },
                  ],
                }
              : {}),
            detail: {
              openAssignments: open_.length,
              halted: open_.filter((row) => row.phase === 'halted').length,
              awaitingUser: open_.filter((row) => row.phase === 'awaiting_user').length,
              // M5's own number: how many assignments have a turn in flight.
              turnsInFlight: open_.filter((row) => turns.active(row.id) !== undefined).length,
              notify: {
                enabled: ctx.config.orchestrator.notify.enabled,
                sent: notify.sent,
                suppressed: notify.suppressed,
              },
            },
          };
        },
      };
    },
  };
}
