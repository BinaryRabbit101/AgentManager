/**
 * The trigger scheduler — assignments that start themselves (DESIGN §2.8, WO8).
 *
 * An in-process timer, because the core is already always-on (foundation §4.3:
 * Task Scheduler autostart, survives reboot). No OS cron, no second process, no
 * inbound webhook (§2.8 defers those, and an inbound port would fight D5).
 *
 * ## The whole design in one sentence
 *
 * A trigger adds **no new creation semantics** — it applies a WO5 task template
 * and calls the same `createAssignment` the Start-work dialog calls, with
 * `origin: 'trigger'` and the trigger's id recorded on the row (§2.3).
 *
 * ## Skip, don't stall
 *
 * Every check below produces a *skip* with a named reason and a re-armed
 * `next_fire_at`, never a stall. The one exception is the failure backoff, which
 * disables the trigger outright — and says so, loudly, through §10's channel.
 * The ordering matters, and each step is here because the alternative is worse
 * than not running:
 *
 * 1. **The global kill switch** (`orchestrator.triggers.enabled`). Hoisted above
 *    the rest: a scheduler that has been switched off must do no preflight work
 *    and send no notifications, and a fire that ran the connector projection
 *    before noticing it was disabled would do both.
 * 2. **Singleflight.** A previous assignment from this trigger is still open →
 *    `still-running`. An hourly job whose runs take ninety minutes must not
 *    stack; the second copy would fight the first for the same workspace lease.
 * 3. **Preflight, unattended-strict.** WO4's permission dry-run and WO6's
 *    integration-state projection, read *as data at fire time* through roster.
 *    Anything short of green does not launch. "An unattended launch that would
 *    park on a permission card or a dead connector is worse than no launch" — it
 *    burns a workspace lease and a session slot to sit on a question nobody is
 *    at the desk to answer.
 * 4. **Caps.** `maxRunsPerDay`, counted from the assignments the trigger
 *    actually produced rather than from a counter column that a crash can put
 *    out of step with them.
 *
 * ## What this deliberately does not do
 *
 * It never asks the todo list or the mailbox whether there is anything to do.
 * WO6 established that connectors belong to *agents* (OAuth, no
 * machine-scavengeable credentials), and the core impersonating an agent's grant
 * to save a short turn is a new security surface for a marginal saving. The
 * quiet run is the agent's job: a template written for a trigger opens its
 * `goalTemplate` with *"If the source has no open items, report done
 * immediately and write nothing"*, and a quiet run is then one short turn.
 */
import type { Clock } from '../../storage/index.js';
import type { AppEvent, EventBus, Unsubscribe } from '../types.js';

import type { OrchestratorConfig } from './config.js';
import { InvalidRequestError, TriggerNotFoundError } from './errors.js';
import type { Notifier } from './notify.js';
import { patternFor } from './patterns.js';
import {
  hasUnattendedPreflight,
  type ProjectsPort,
  type RosterPort,
  type TaskTemplatePort,
} from './ports.js';
import type { AssignmentRepository } from './repository.js';
import {
  createTriggerRepository,
  nextFireAfter,
  recomputedNextFire,
  startOfLocalDay,
  type ActiveHours,
  type ListTriggersQuery,
  type TriggerOutcome,
  type TriggerPatch,
  type TriggerRepository,
  type TriggerRow,
} from './triggers.js';
import type {
  AssignmentMemberRequest,
  AssignmentService,
  AssignmentStatus,
  CreateAssignmentRequest,
} from './types.js';
import { isAssignmentRole } from './types.js';

export type { TriggerRepository };
export { createTriggerRepository };

// ---------------------------------------------------------------------------
// The read model
// ---------------------------------------------------------------------------

/** The assignment a trigger row's "last run" links to (§2.8, ui §8.2). */
export interface TriggerLastRun {
  readonly assignmentId: string;
  readonly status: AssignmentStatus;
  readonly phase: string;
  readonly closeReason: string | null;
  readonly createdAt: string;
}

/** `GET /api/triggers`'s projection — the row plus the two derived facts. */
export interface TriggerView {
  readonly id: string;
  readonly projectId: string;
  readonly templateId: string;
  readonly agentIds: readonly string[];
  readonly everyMinutes: number;
  readonly activeHours: ActiveHours | null;
  readonly enabled: boolean;
  readonly variables: Readonly<Record<string, string>>;
  readonly maxRunsPerDay: number | null;
  readonly lastFiredAt: string | null;
  readonly nextFireAt: string | null;
  readonly consecutiveFailures: number;
  /** The last fire's verdict — what the UI renders when a row is not simply running. */
  readonly lastOutcome: TriggerOutcome | null;
  readonly lastOutcomeReason: string | null;
  readonly lastOutcomeAt: string | null;
  /**
   * The newest assignment this trigger produced, or `null`.
   *
   * Derived, not stored: an id kept on the trigger row would be a second copy
   * of a fact `assignments.trigger_id` already holds, and the two would
   * disagree the first time an assignment was deleted.
   */
  readonly lastRun: TriggerLastRun | null;
  /** How many runs the cap has already counted today, for an honest "3 / 24". */
  readonly runsToday: number;
  readonly createdAt: string;
  readonly updatedAt: string | null;
}

/** What one fire did — the return of `POST /api/triggers/:id/run`, and of a tick. */
export interface TriggerFireResult {
  readonly triggerId: string;
  readonly outcome: TriggerOutcome;
  /** Why, for every outcome but a plain `fired`. */
  readonly reason: string | null;
  readonly assignmentId?: string;
}

export interface CreateTriggerRequest {
  readonly projectId: string;
  readonly templateId: string;
  readonly agentIds: readonly string[];
  readonly everyMinutes: number;
  readonly activeHours?: ActiveHours | null | undefined;
  readonly enabled?: boolean | undefined;
  readonly variables?: Readonly<Record<string, string>> | undefined;
  readonly maxRunsPerDay?: number | null | undefined;
}

export interface TriggerService {
  list(query?: ListTriggersQuery): readonly TriggerView[];
  get(id: string): TriggerView;
  create(request: CreateTriggerRequest): TriggerView;
  update(id: string, patch: TriggerPatch): TriggerView;
  remove(id: string): void;
  /**
   * One fire, whether the timer asked or a human pressed **Run now**.
   *
   * The *same* path either way, preflight included (§2.8). A manual fire that
   * skipped the checks would be a way to start an unattended run that the
   * unattended rules refused — and the button exists to test the schedule, so
   * it has to test what the schedule does.
   */
  fire(id: string): Promise<TriggerFireResult>;
  /** One tick: every trigger whose `next_fire_at` has come. */
  tick(): Promise<readonly TriggerFireResult[]>;
  /** The boot task of §2.8 — missed fires collapse to at most one catch-up. */
  reconcileOnBoot(): { readonly rearmed: readonly string[] };
  /** Subscribes to `assignment.closed` for the failure backoff; detaches on stop. */
  attach(): Unsubscribe;
}

export interface TriggerServiceOptions {
  readonly triggers: TriggerRepository;
  readonly assignments: AssignmentRepository;
  readonly service: () => AssignmentService;
  readonly bus: EventBus;
  readonly clock: Clock;
  readonly config: OrchestratorConfig;
  readonly roster: () => RosterPort | undefined;
  readonly projects: () => ProjectsPort | undefined;
  /** §10's channel, for the two cases §2.8 adds. Absent in a build with no notifier. */
  readonly notifier?: (() => Notifier | undefined) | undefined;
  readonly log?: (
    level: 'debug' | 'info' | 'warn',
    message: string,
    detail?: Record<string, unknown>,
  ) => void;
}

// ---------------------------------------------------------------------------
// Variable substitution
// ---------------------------------------------------------------------------

/**
 * `{{key}}` → the variable's value, for every key the trigger supplies.
 *
 * A deliberate superset of roster's two-variable vocabulary (`slug`, `source`)
 * and the same rule for everything else: a placeholder with no value **survives
 * verbatim**, because a goal that silently lost half a sentence is worse than
 * one that visibly says `{{source}}` and can be fixed. Orchestrator does its own
 * substitution rather than importing roster's (foundation §6.1) — the web does
 * the same, and roster's own test pins the two implementations to each other.
 */
export function applyVariables(text: string, variables: Readonly<Record<string, string>>): string {
  return text.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (whole, key: string) =>
    key in variables ? (variables[key] ?? whole) : whole,
  );
}

/**
 * The `{{slug}}` a fire gets when the trigger names none.
 *
 * Per-fire rather than per-trigger, because `artifactPathTemplate` is usually
 * `docs/assignments/{{slug}}/…` and a constant slug would have every run of a
 * nightly job overwrite the last one's output — which is precisely the silent
 * data loss projects §4.4 refuses.
 */
export function defaultSlug(templateId: string, at: Date): string {
  const stamp = at.toISOString().slice(0, 16).replace(/[-:T]/g, '');
  return `${templateId}-${stamp}`;
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export function createTriggerService(options: TriggerServiceOptions): TriggerService {
  const { triggers, assignments, bus, clock, config } = options;

  function log(
    level: 'debug' | 'info' | 'warn',
    message: string,
    detail?: Record<string, unknown>,
  ): void {
    options.log?.(level, message, detail);
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  function view(row: TriggerRow): TriggerView {
    const latest = assignments.latestForTrigger(row.id);
    return {
      id: row.id,
      projectId: row.projectId,
      templateId: row.templateId,
      agentIds: row.agentIds,
      everyMinutes: row.everyMinutes,
      activeHours: row.activeHours,
      enabled: row.enabled,
      variables: row.variables,
      maxRunsPerDay: row.maxRunsPerDay,
      lastFiredAt: row.lastFiredAt,
      nextFireAt: row.nextFireAt,
      consecutiveFailures: row.consecutiveFailures,
      lastOutcome: row.lastOutcome,
      lastOutcomeReason: row.lastOutcomeReason,
      lastOutcomeAt: row.lastOutcomeAt,
      lastRun:
        latest === undefined
          ? null
          : {
              assignmentId: latest.id,
              status: latest.status,
              phase: latest.phase,
              closeReason: latest.closeReason,
              createdAt: latest.createdAt,
            },
      runsToday: runsToday(row.id),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  function runsToday(triggerId: string): number {
    return assignments.countForTriggerSince(triggerId, startOfLocalDay(clock()).toISOString());
  }

  function require_(id: string): TriggerRow {
    const row = triggers.get(id);
    if (row === undefined) throw new TriggerNotFoundError(id);
    return row;
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  function validateShape(input: {
    readonly everyMinutes?: number | undefined;
    readonly activeHours?: ActiveHours | null | undefined;
    readonly maxRunsPerDay?: number | null | undefined;
    readonly agentIds?: readonly string[] | undefined;
  }): void {
    if (input.everyMinutes !== undefined) {
      if (!Number.isInteger(input.everyMinutes) || input.everyMinutes < 1) {
        throw new InvalidRequestError(
          '"everyMinutes" must be a whole number of minutes, at least 1.',
          'everyMinutes',
        );
      }
    }
    const hours = input.activeHours;
    if (hours !== undefined && hours !== null) {
      const bounded = (value: number): boolean =>
        Number.isInteger(value) && value >= 0 && value < 24;
      if (!bounded(hours.from) || !bounded(hours.to)) {
        throw new InvalidRequestError('"activeHours" must be whole hours in 0-23.', 'activeHours');
      }
      // A window that opens and closes at the same hour is either "always" or
      // "never", and which one a reader assumes is a coin toss. `null` is how
      // "always" is said here, so this is refused rather than guessed.
      if (hours.from === hours.to) {
        throw new InvalidRequestError(
          '"activeHours.from" and "activeHours.to" must differ; use null for "always".',
          'activeHours',
        );
      }
    }
    if (input.maxRunsPerDay !== undefined && input.maxRunsPerDay !== null) {
      if (!Number.isInteger(input.maxRunsPerDay) || input.maxRunsPerDay < 1) {
        throw new InvalidRequestError(
          '"maxRunsPerDay" must be a whole number of runs, at least 1, or null.',
          'maxRunsPerDay',
        );
      }
    }
    if (input.agentIds !== undefined && input.agentIds.length === 0) {
      throw new InvalidRequestError('A trigger needs at least one agent.', 'agentIds');
    }
  }

  function create(request: CreateTriggerRequest): TriggerView {
    validateShape(request);
    if (request.projectId.trim() === '') {
      throw new InvalidRequestError('"projectId" is required.', 'projectId');
    }
    if (request.templateId.trim() === '') {
      throw new InvalidRequestError('"templateId" is required.', 'templateId');
    }
    if (request.agentIds.length === 0) {
      throw new InvalidRequestError('A trigger needs at least one agent.', 'agentIds');
    }
    const now = clock();
    const enabled = request.enabled ?? true;
    const hours = request.activeHours ?? null;
    const row = triggers.create({
      projectId: request.projectId,
      templateId: request.templateId,
      agentIds: request.agentIds,
      everyMinutes: request.everyMinutes,
      activeHours: hours,
      enabled,
      variables: request.variables ?? {},
      maxRunsPerDay: request.maxRunsPerDay ?? null,
      // The first fire is one interval away, not immediate: creating a schedule
      // is not the same as running it, and the Run-now button is right there for
      // anyone who meant the second thing.
      nextFireAt: enabled ? nextFireAfter(now, request.everyMinutes, hours).toISOString() : null,
    });
    return view(row);
  }

  function update(id: string, patch: TriggerPatch): TriggerView {
    const current = require_(id);
    validateShape(patch);
    const updated = triggers.update(id, patch);
    // Re-arm whenever the shape of *when* changed, or the trigger was switched
    // back on. A schedule edited from hourly to daily must not keep the fire
    // time the old interval computed — that is the one thing the user was
    // editing.
    const timingChanged =
      patch.everyMinutes !== undefined ||
      patch.activeHours !== undefined ||
      (patch.enabled === true && !current.enabled);
    if (!updated.enabled) return view(triggers.setNextFire(id, null));
    if (timingChanged || updated.nextFireAt === null) {
      return view(
        triggers.setNextFire(
          id,
          nextFireAfter(clock(), updated.everyMinutes, updated.activeHours).toISOString(),
        ),
      );
    }
    return view(updated);
  }

  // -------------------------------------------------------------------------
  // §2.8's preflight — WO4 and WO6's projections, read as data at fire time
  // -------------------------------------------------------------------------

  /**
   * The gate that refused, or `undefined` when everything is green.
   *
   * Named rather than boolean: the reason lands on the row, in the
   * `trigger.blocked` event and in the notification, and "preflight failed" is
   * not something a person can act on.
   */
  async function preflight(
    row: TriggerRow,
    template: TaskTemplatePort,
    roster: RosterPort,
  ): Promise<string | undefined> {
    const projects = options.projects();
    if (projects === undefined) return 'projects-unavailable';
    try {
      const project = projects.get(row.projectId);
      if (project.status !== 'active') return `project-${project.status}`;
    } catch {
      return 'project-missing';
    }

    if (!hasUnattendedPreflight(roster)) return 'roster-preflight-unavailable';

    // The tools the launch will pre-grant. A gate this list already answers is
    // not a gate: WO4's pre-grants are exactly the mechanism that stops a run
    // parking on a card, so preflight has to judge the launch as it will
    // actually be made rather than a hypothetical one without them.
    const preGranted = new Set(template.preGrantTools ?? []);
    const write = template.write ?? true;

    for (const agentId of row.agentIds) {
      const agent = roster.registry.get(agentId);
      if (agent === undefined || (agent.archivedAt ?? null) !== null) {
        return `agent-unavailable:${agentId}`;
      }

      const preview = await roster
        .validate(agentId, { projectId: row.projectId, write })
        .catch(() => undefined);
      if (preview === undefined) return `permission-preview-failed:${agentId}`;
      const gate = preview.gateLiable.find(
        (tool) => !tool.remembered && !preGranted.has(tool.tool),
      );
      if (gate !== undefined) return `permission-gate:${gate.tool}`;

      const states = await roster
        .integrations(agentId, {
          ...(template.requiredIntegrations === undefined
            ? {}
            : { required: template.requiredIntegrations }),
        })
        .catch(() => undefined);
      if (states === undefined) return `connector-preview-failed:${agentId}`;
      // Strict: *anything* short of `ready` refuses. A connector the agent
      // declares but this task does not need is still a connector that will be
      // mounted for the session, and a half-mounted MCP server is exactly the
      // condition that produces a run which reports nothing and costs a slot.
      const bad = states.find((state) => state.state !== 'ready');
      if (bad !== undefined) return `connector-${bad.state}:${bad.integration}`;
    }
    return undefined;
  }

  // -------------------------------------------------------------------------
  // The fire
  // -------------------------------------------------------------------------

  function outcomeOf(
    row: TriggerRow,
    outcome: TriggerOutcome,
    reason: string | null,
    extra: Readonly<Record<string, unknown>> = {},
  ): TriggerFireResult {
    const at = clock().toISOString();
    triggers.recordOutcome(row.id, outcome, reason, at);
    bus.emit({
      type: `trigger.${outcome}`,
      ids: { projectId: row.projectId },
      persist: true,
      payload: { triggerId: row.id, templateId: row.templateId, reason, ...extra },
    });
    return {
      triggerId: row.id,
      outcome,
      reason,
      ...(typeof extra['assignmentId'] === 'string' ? { assignmentId: extra['assignmentId'] } : {}),
    };
  }

  /** Re-arms the trigger for its next interval. Called for every non-fatal outcome. */
  function rearm(row: TriggerRow): void {
    if (!row.enabled) return;
    triggers.setNextFire(
      row.id,
      nextFireAfter(clock(), row.everyMinutes, row.activeHours).toISOString(),
    );
  }

  async function fire(id: string): Promise<TriggerFireResult> {
    const row = require_(id);

    // 1. The kill switch. Hoisted above everything so a switched-off scheduler
    //    does no preflight work and sends no notifications.
    if (!config.triggers.enabled) {
      rearm(row);
      return outcomeOf(row, 'skipped', 'triggers-disabled');
    }

    // 2. Singleflight.
    if (assignments.countOpenForTrigger(row.id) > 0) {
      rearm(row);
      return outcomeOf(row, 'skipped', 'still-running');
    }

    const roster = options.roster();
    if (roster === undefined) return blocked(row, 'roster-unavailable');
    // Roster throws a typed 404 for a template the owner renamed or deleted, and
    // a trigger pointed at a template that is no longer there is exactly the
    // case 0006's header describes: the id keeps its meaning ("this came from a
    // template that is not here any more"), and the fire is blocked by name.
    let template: TaskTemplatePort | undefined;
    try {
      template = roster.getTemplate?.(row.templateId)?.template;
    } catch {
      template = undefined;
    }
    if (template === undefined) return blocked(row, 'template-missing');

    // 3. Preflight, unattended-strict.
    const gate = await preflight(row, template, roster);
    if (gate !== undefined) return blocked(row, gate);

    // 4. Caps.
    if (row.maxRunsPerDay !== null && runsToday(row.id) >= row.maxRunsPerDay) {
      rearm(row);
      return outcomeOf(row, 'skipped', 'daily-cap');
    }

    // 5. Create, through §2.3's one function and nothing else.
    const now = clock();
    const variables = { slug: defaultSlug(row.templateId, now), ...row.variables };
    const members = membersFor(template, row.agentIds, roster);
    if (members.length === 0) return blocked(row, 'no-seat-for-agents');

    const goal = applyVariables(template.goalTemplate, variables);
    const artifactPath =
      template.artifactPathTemplate === undefined
        ? undefined
        : applyVariables(template.artifactPathTemplate, variables);

    const scope = { paths: [], ...(artifactPath === undefined ? {} : { artifactPath }) };
    const preGrants =
      template.preGrantTools === undefined || template.preGrantTools.length === 0
        ? undefined
        : members.flatMap((member) =>
            (template.preGrantTools ?? []).map((tool) => ({ agentId: member.agentId, tool })),
          );
    const seat = members[0];

    try {
      // The same two doors the Start-work dialog uses, chosen the same way it
      // chooses them (§2.3 paths 1 and 2): a solo goes through `createSolo`,
      // which creates *and starts* — the solo pattern has no driver, so an
      // assignment created without its session would be a row that never runs.
      // A pair goes through `createAssignment`, and the engine plans its first
      // turn exactly as it does for a human's.
      const created =
        template.pattern === 'solo' && seat !== undefined
          ? await options.service().createSolo({
              projectId: row.projectId,
              agentId: seat.agentId,
              prompt: goal,
              role: seat.role,
              write: template.write ?? true,
              goal,
              scope,
              origin: 'trigger',
              triggerId: row.id,
              templateId: row.templateId,
              ...(preGrants === undefined ? {} : { preGrants }),
            })
          : await options.service().createAssignment({
              projectId: row.projectId,
              pattern: template.pattern,
              goal,
              members,
              scope,
              write: template.write ?? true,
              origin: 'trigger',
              triggerId: row.id,
              templateId: row.templateId,
              ...(preGrants === undefined ? {} : { preGrants }),
            } satisfies CreateAssignmentRequest);
      triggers.recordFire(
        row.id,
        now.toISOString(),
        row.enabled ? nextFireAfter(now, row.everyMinutes, row.activeHours).toISOString() : null,
      );
      log('info', 'a trigger started an assignment', {
        triggerId: row.id,
        assignmentId: created.assignmentId,
      });
      return outcomeOf(row, 'fired', null, { assignmentId: created.assignmentId });
    } catch (error) {
      // A refusal from the creation path is the same class of news as a failed
      // preflight — the run did not happen and a human has to change something —
      // so it takes the same outcome rather than a fifth one nothing renders.
      return blocked(row, `create-refused:${String((error as { code?: string }).code ?? 'error')}`);
    }
  }

  /** A blocked fire: the row, the event, the notification, and a re-arm. */
  function blocked(row: TriggerRow, reason: string): TriggerFireResult {
    rearm(row);
    const result = outcomeOf(row, 'blocked', reason);
    void options
      .notifier?.()
      ?.send(
        'AgentManager: a background trigger did not run',
        `The scheduled job "${row.templateId}" did not start: ${reason}. It will try again at ` +
          'its next interval; the Automation settings show why.',
      )
      .catch(() => undefined);
    log('warn', 'a trigger was blocked at preflight', { triggerId: row.id, reason });
    return result;
  }

  /**
   * Seats, by exactly the rule §2.4 pins for a human's launch.
   *
   * The pattern's seat definitions decide the roles; the trigger's agent order
   * decides who takes which. Nothing here *invents* a seat: an agent list that
   * cannot fill the pattern's required seats produces no members, and the fire
   * is blocked by name rather than launching a half-crewed pair.
   */
  function membersFor(
    template: TaskTemplatePort,
    agentIds: readonly string[],
    roster: RosterPort,
  ): readonly AssignmentMemberRequest[] {
    const definition = patternFor(template.pattern);
    if (definition === undefined) return [];
    const remaining = [...agentIds];
    const members: AssignmentMemberRequest[] = [];
    for (const seat of definition.seats) {
      const agentId = remaining.shift();
      if (agentId === undefined) {
        return seat.required === false ? members : [];
      }
      const declared = roster.registry.get(agentId)?.definition.capabilities?.roles ?? [];
      const role =
        declared.find((one) => (seat.roles as readonly string[]).includes(one)) ??
        template.suggestedRoles?.find((one) => (seat.roles as readonly string[]).includes(one)) ??
        seat.roles[0];
      if (!isAssignmentRole(role)) return [];
      members.push({ agentId, role });
    }
    return members;
  }

  // -------------------------------------------------------------------------
  // The tick, the boot pass, and the failure backoff
  // -------------------------------------------------------------------------

  async function tick(): Promise<readonly TriggerFireResult[]> {
    // The kill switch is checked here as well as in `fire`, so a disabled
    // scheduler does not even walk the table — and so switching it off does not
    // write a `skipped` row for every trigger on every tick.
    if (!config.triggers.enabled) return [];
    const due = triggers.due(clock().toISOString());
    const results: TriggerFireResult[] = [];
    for (const row of due) {
      // Re-read through `fire`, which takes the row fresh: a long preflight on
      // the first trigger may have changed the second.
      results.push(
        await fire(row.id).catch((error: unknown) => {
          log('warn', 'a trigger fire threw', { triggerId: row.id, error: String(error) });
          return { triggerId: row.id, outcome: 'skipped' as const, reason: 'fire-failed' };
        }),
      );
    }
    return results;
  }

  function reconcileOnBoot(): { readonly rearmed: readonly string[] } {
    const now = clock();
    const rearmed: string[] = [];
    for (const row of triggers.list()) {
      const next = recomputedNextFire(row, now);
      if (next === row.nextFireAt) continue;
      triggers.setNextFire(row.id, next);
      rearmed.push(row.id);
    }
    return { rearmed };
  }

  /**
   * The failure backoff (§2.8).
   *
   * Driven off `assignment.closed` rather than off a poll, because that event
   * already carries the close reason and is already emitted last, after every
   * state change a listener might read (§2.2). A `failed` close increments;
   * anything else resets — including `converged` and `user_closed`, because a
   * schedule a human stopped by hand has not failed.
   */
  function attach(): Unsubscribe {
    return bus.subscribe(['assignment.closed'], (event: AppEvent) => {
      const assignmentId = event.ids.assignmentId;
      if (assignmentId === undefined) return;
      const row = assignments.get(assignmentId);
      if (row?.triggerId === null || row?.triggerId === undefined) return;
      const trigger = triggers.get(row.triggerId);
      if (trigger === undefined) return;
      const failed = (event.payload as { closeReason?: unknown } | undefined)?.closeReason;
      if (failed !== 'failed') {
        if (trigger.consecutiveFailures !== 0) triggers.setConsecutiveFailures(trigger.id, 0);
        return;
      }
      const failures = trigger.consecutiveFailures + 1;
      triggers.setConsecutiveFailures(trigger.id, failures);
      if (failures < config.triggers.maxConsecutiveFailures) return;
      // Three in a row is not a transient. Disabling is the honest response: an
      // hourly timer re-entering a bug all night is the exact failure mode an
      // unattended feature must not have, and re-enabling is one toggle.
      triggers.setEnabled(trigger.id, false);
      triggers.setNextFire(trigger.id, null);
      const reason = `disabled-after-${String(failures)}-failures`;
      outcomeOf({ ...trigger, enabled: false }, 'disabled', reason);
      void options
        .notifier?.()
        ?.send(
          'AgentManager: a background trigger switched itself off',
          `The scheduled job "${trigger.templateId}" failed ${String(failures)} times in a row and ` +
            'has been disabled. Nothing will run on this schedule until it is switched back on.',
        )
        .catch(() => undefined);
      log('warn', 'a trigger disabled itself after repeated failures', {
        triggerId: trigger.id,
        failures,
      });
    });
  }

  return {
    list: (query = {}) => triggers.list(query).map(view),
    get: (id) => view(require_(id)),
    create,
    update,
    remove(id) {
      require_(id);
      triggers.remove(id);
    },
    fire,
    tick,
    reconcileOnBoot,
    attach,
  };
}
