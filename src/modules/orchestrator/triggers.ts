/**
 * Background triggers — the `triggers` table, and the arithmetic of *when*
 * (orchestrator DESIGN §2.8, WO8).
 *
 * A trigger is **when** + **what**, and this file is entirely the *when*. The
 * *what* is a WO5 task template applied through §2.3's one creation function,
 * so nothing here knows what a goal, a seat or a permission is: the row names a
 * template, a project, some agent ids and some variables, and the scheduler
 * (`triggerScheduler.ts`) hands all four to `createAssignment` exactly as the
 * Start-work dialog does.
 *
 * ## Why the schedule maths is pure and exported
 *
 * `nextFireAfter` and `withinActiveHours` take a millisecond and return a
 * millisecond. Every interesting property of the feature is a property of these
 * two functions — a fire lands inside the window, a missed window collapses to
 * one catch-up rather than a backfill storm, a wrapping window is one window and
 * not two — and a rule that can only be observed by waiting an hour is a rule
 * nobody tests. The repository below is the only impure part, and it is the
 * usual composed-statements shape the rest of the element uses.
 *
 * ## Local hours, deliberately
 *
 * `activeHours` is **local** time. The owner says "not before eight" meaning
 * their eight, and a schedule expressed in UTC would be right for half the year
 * in half the world. Every *timestamp* the row stores is still ISO-8601 UTC, per
 * foundation §1.3 — the local reading applies to the window and to nothing else.
 */
import type { Clock, Database } from '../../storage/index.js';
import { isoTimestamp, newId } from '../../storage/index.js';

// ---------------------------------------------------------------------------
// The vocabulary
// ---------------------------------------------------------------------------

/**
 * The window a trigger may fire in, in **local** hours, `from` inclusive and
 * `to` exclusive. `null` on the row means "always".
 *
 * `to` less than `from` wraps midnight — `{ from: 22, to: 6 }` is one window
 * across two dates and not two windows, because "overnight" is the case a
 * background job is most often wanted for.
 */
export interface ActiveHours {
  readonly from: number;
  readonly to: number;
}

/**
 * What the last fire did. The closed set the row's `last_outcome` column and
 * §11.4's four events agree on — a value only one of them can produce would be
 * a state the UI renders as blank.
 */
export const TRIGGER_OUTCOMES = ['fired', 'skipped', 'blocked', 'disabled'] as const;
export type TriggerOutcome = (typeof TRIGGER_OUTCOMES)[number];

export function isTriggerOutcome(value: unknown): value is TriggerOutcome {
  return typeof value === 'string' && (TRIGGER_OUTCOMES as readonly string[]).includes(value);
}

/** One row of `triggers`, flattened. */
export interface TriggerRow {
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
  readonly lastOutcome: TriggerOutcome | null;
  readonly lastOutcomeReason: string | null;
  readonly lastOutcomeAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string | null;
}

export interface CreateTriggerInput {
  readonly projectId: string;
  readonly templateId: string;
  readonly agentIds: readonly string[];
  readonly everyMinutes: number;
  readonly activeHours?: ActiveHours | null | undefined;
  readonly enabled?: boolean | undefined;
  readonly variables?: Readonly<Record<string, string>> | undefined;
  readonly maxRunsPerDay?: number | null | undefined;
  /** Set by the service from {@link nextFireAfter}; never chosen by a caller. */
  readonly nextFireAt?: string | null | undefined;
}

/**
 * What `PATCH /api/triggers/:id` may change.
 *
 * Never `projectId`: a schedule moved to another project is a different
 * schedule, and its history — the assignments carrying its id — would then
 * describe work on a project it never ran against.
 */
export interface TriggerPatch {
  readonly templateId?: string;
  readonly agentIds?: readonly string[];
  readonly everyMinutes?: number;
  readonly activeHours?: ActiveHours | null;
  readonly enabled?: boolean;
  readonly variables?: Readonly<Record<string, string>>;
  readonly maxRunsPerDay?: number | null;
}

export interface ListTriggersQuery {
  readonly projectId?: string | undefined;
  readonly enabled?: boolean | undefined;
}

export interface TriggerRepository {
  create(input: CreateTriggerInput): TriggerRow;
  get(id: string): TriggerRow | undefined;
  list(query?: ListTriggersQuery): readonly TriggerRow[];
  update(id: string, patch: TriggerPatch): TriggerRow;
  /** `false` when there was no such row — deleting a deleted trigger is not an error. */
  remove(id: string): boolean;
  /** Enabled, with a `next_fire_at` at or before `nowIso`. Oldest due first. */
  due(nowIso: string): readonly TriggerRow[];
  /** The scheduler's post-fire write: when it fired, and when it fires next. */
  recordFire(id: string, firedAt: string, nextFireAt: string | null): TriggerRow;
  /** The scheduler's verdict for the UI's row, and §11.4's event payload. */
  recordOutcome(id: string, outcome: TriggerOutcome, reason: string | null, at: string): TriggerRow;
  /** Re-arms a trigger that skipped, so the tick after next reconsiders it. */
  setNextFire(id: string, nextFireAt: string | null): TriggerRow;
  setEnabled(id: string, enabled: boolean): TriggerRow;
  setConsecutiveFailures(id: string, failures: number): TriggerRow;
}

// ---------------------------------------------------------------------------
// The arithmetic of *when* — pure, and the whole of the feature's behaviour
// ---------------------------------------------------------------------------

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/** `from` inclusive, `to` exclusive, wrapping when `to <= from`. */
export function withinActiveHours(at: Date, hours: ActiveHours | null): boolean {
  if (hours === null) return true;
  const hour = at.getHours();
  return hours.to > hours.from
    ? hour >= hours.from && hour < hours.to
    : hour >= hours.from || hour < hours.to;
}

/**
 * The first instant at or after `at` that falls inside the window.
 *
 * Returns `at` unchanged when it is already inside — which is what makes the
 * boot catch-up land immediately during working hours and at the top of the
 * window outside them, from one function rather than two branches at the call
 * site.
 */
export function intoActiveHours(at: Date, hours: ActiveHours | null): Date {
  if (withinActiveHours(at, hours)) return at;
  // The window opens at `from:00` local, today if that is still ahead and
  // tomorrow otherwise. Built by mutating a local-time copy rather than by
  // adding milliseconds, so a DST transition inside the wait moves the answer
  // with the clock instead of an hour past it.
  const start = new Date(at.getTime());
  start.setMinutes(0, 0, 0);
  start.setHours(hours === null ? start.getHours() : hours.from);
  if (start.getTime() <= at.getTime()) start.setTime(start.getTime() + 24 * HOUR_MS);
  return start;
}

/**
 * The next fire after `from`: one interval on, then pushed into the window.
 *
 * The push is what makes `activeHours` a *gate on firing* rather than a gate on
 * counting — a 60-minute trigger with an 8-22 window fires at 08:00 and not at
 * "whatever multiple of 60 minutes happens to land after 08:00", so the schedule
 * reads the same every morning.
 */
export function nextFireAfter(from: Date, everyMinutes: number, hours: ActiveHours | null): Date {
  return intoActiveHours(new Date(from.getTime() + everyMinutes * MINUTE_MS), hours);
}

/**
 * The boot recomputation (WO8: "missed fires collapse to **at most one**
 * catch-up run — never a backfill storm").
 *
 * The collapse is structural rather than arithmetic: the row stores exactly one
 * `next_fire_at`, so however long the core was down there is only ever one
 * moment to catch up on. All this does is bring a stale one forward to *now*
 * (pushed into the window), and invent one for a trigger that has none.
 *
 * A trigger whose next fire is still in the future is left alone — a restart
 * must not bring a schedule forward, which would make "every 60 minutes" mean
 * "every 60 minutes, or sooner if you reboot".
 */
export function recomputedNextFire(row: TriggerRow, now: Date): string | null {
  if (!row.enabled) return row.nextFireAt;
  const planned = row.nextFireAt === null ? undefined : Date.parse(row.nextFireAt);
  if (planned !== undefined && Number.isFinite(planned) && planned > now.getTime()) {
    return row.nextFireAt;
  }
  return isoTimestamp(intoActiveHours(now, row.activeHours));
}

/** UTC midnight of `at`'s **local** day — the boundary `maxRunsPerDay` counts from. */
export function startOfLocalDay(at: Date): Date {
  const start = new Date(at.getTime());
  start.setHours(0, 0, 0, 0);
  return start;
}

// ---------------------------------------------------------------------------
// The repository
// ---------------------------------------------------------------------------

interface RawTriggerRow {
  readonly id: string;
  readonly project_id: string;
  readonly template_id: string;
  readonly agent_ids_json: string;
  readonly every_minutes: number;
  readonly active_from_hour: number | null;
  readonly active_to_hour: number | null;
  readonly enabled: number;
  readonly variables_json: string;
  readonly max_runs_per_day: number | null;
  readonly last_fired_at: string | null;
  readonly next_fire_at: string | null;
  readonly consecutive_failures: number;
  readonly last_outcome: string | null;
  readonly last_outcome_reason: string | null;
  readonly last_outcome_at: string | null;
  readonly created_at: string;
  readonly updated_at: string | null;
}

export interface TriggerRepositoryOptions {
  readonly db: Database;
  readonly clock: Clock;
}

/**
 * `agent_ids_json`, read back defensively.
 *
 * Tolerant in the way `parsePreGrants` is: a column that will not parse yields
 * **no** agents rather than an exception, and a trigger with no agents is
 * blocked at fire time with a named reason instead of failing to list. A
 * schedule you cannot see is a schedule you cannot disable.
 */
function parseAgentIds(json: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === 'string' && entry !== '');
  } catch {
    return [];
  }
}

/** `variables_json`, likewise — non-string values are dropped one by one. */
function parseVariables(json: string): Readonly<Record<string, string>> {
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const values: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string') values[key] = value;
    }
    return values;
  } catch {
    return {};
  }
}

function hydrate(raw: RawTriggerRow): TriggerRow {
  return {
    id: raw.id,
    projectId: raw.project_id,
    templateId: raw.template_id,
    agentIds: parseAgentIds(raw.agent_ids_json),
    everyMinutes: raw.every_minutes,
    activeHours:
      raw.active_from_hour === null || raw.active_to_hour === null
        ? null
        : { from: raw.active_from_hour, to: raw.active_to_hour },
    enabled: raw.enabled !== 0,
    variables: parseVariables(raw.variables_json),
    maxRunsPerDay: raw.max_runs_per_day,
    lastFiredAt: raw.last_fired_at,
    nextFireAt: raw.next_fire_at,
    consecutiveFailures: raw.consecutive_failures,
    lastOutcome: isTriggerOutcome(raw.last_outcome) ? raw.last_outcome : null,
    lastOutcomeReason: raw.last_outcome_reason,
    lastOutcomeAt: raw.last_outcome_at,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

const COLUMNS =
  'id, project_id, template_id, agent_ids_json, every_minutes, active_from_hour, ' +
  'active_to_hour, enabled, variables_json, max_runs_per_day, last_fired_at, next_fire_at, ' +
  'consecutive_failures, last_outcome, last_outcome_reason, last_outcome_at, ' +
  'created_at, updated_at';

export function createTriggerRepository(options: TriggerRepositoryOptions): TriggerRepository {
  const { db, clock } = options;

  const insert = db.prepare<
    [
      string,
      string,
      string,
      string,
      number,
      number | null,
      number | null,
      number,
      string,
      number | null,
      string | null,
      string,
    ]
  >(
    'INSERT INTO triggers (id, project_id, template_id, agent_ids_json, every_minutes, ' +
      'active_from_hour, active_to_hour, enabled, variables_json, max_runs_per_day, ' +
      'next_fire_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const selectOne = db.prepare<[string], RawTriggerRow>(
    `SELECT ${COLUMNS} FROM triggers WHERE id = ?`,
  );
  const selectAll = db.prepare<[], RawTriggerRow>(
    `SELECT ${COLUMNS} FROM triggers ORDER BY created_at, id`,
  );
  const selectDue = db.prepare<[string], RawTriggerRow>(
    `SELECT ${COLUMNS} FROM triggers WHERE enabled = 1 AND next_fire_at IS NOT NULL ` +
      'AND next_fire_at <= ? ORDER BY next_fire_at, id',
  );
  const applyPatch = db.prepare<
    [
      string,
      string,
      number,
      number | null,
      number | null,
      number,
      string,
      number | null,
      string,
      string,
    ]
  >(
    'UPDATE triggers SET template_id = ?, agent_ids_json = ?, every_minutes = ?, ' +
      'active_from_hour = ?, active_to_hour = ?, enabled = ?, variables_json = ?, ' +
      'max_runs_per_day = ?, updated_at = ? WHERE id = ?',
  );
  const applyFire = db.prepare<[string, string | null, string, string]>(
    'UPDATE triggers SET last_fired_at = ?, next_fire_at = ?, updated_at = ? WHERE id = ?',
  );
  const applyOutcome = db.prepare<[string, string | null, string, string, string]>(
    'UPDATE triggers SET last_outcome = ?, last_outcome_reason = ?, last_outcome_at = ?, ' +
      'updated_at = ? WHERE id = ?',
  );
  const applyNextFire = db.prepare<[string | null, string, string]>(
    'UPDATE triggers SET next_fire_at = ?, updated_at = ? WHERE id = ?',
  );
  const applyEnabled = db.prepare<[number, string, string]>(
    'UPDATE triggers SET enabled = ?, updated_at = ? WHERE id = ?',
  );
  const applyFailures = db.prepare<[number, string, string]>(
    'UPDATE triggers SET consecutive_failures = ?, updated_at = ? WHERE id = ?',
  );
  const deleteOne = db.prepare<[string]>('DELETE FROM triggers WHERE id = ?');

  function require_(id: string): TriggerRow {
    const raw = selectOne.get(id);
    if (raw === undefined) {
      throw new Error(`Internal error: trigger ${id} vanished between two reads.`);
    }
    return hydrate(raw);
  }

  return {
    create(input) {
      const id = newId();
      insert.run(
        id,
        input.projectId,
        input.templateId,
        JSON.stringify([...input.agentIds]),
        input.everyMinutes,
        input.activeHours?.from ?? null,
        input.activeHours?.to ?? null,
        (input.enabled ?? true) ? 1 : 0,
        JSON.stringify(input.variables ?? {}),
        input.maxRunsPerDay ?? null,
        input.nextFireAt ?? null,
        isoTimestamp(clock()),
      );
      return require_(id);
    },

    get(id) {
      const raw = selectOne.get(id);
      return raw === undefined ? undefined : hydrate(raw);
    },

    list(query = {}) {
      return selectAll
        .all()
        .map(hydrate)
        .filter(
          (row) =>
            (query.projectId === undefined || row.projectId === query.projectId) &&
            (query.enabled === undefined || row.enabled === query.enabled),
        );
    },

    update(id, patch) {
      const current = require_(id);
      const activeHours = patch.activeHours === undefined ? current.activeHours : patch.activeHours;
      applyPatch.run(
        patch.templateId ?? current.templateId,
        JSON.stringify([...(patch.agentIds ?? current.agentIds)]),
        patch.everyMinutes ?? current.everyMinutes,
        activeHours?.from ?? null,
        activeHours?.to ?? null,
        (patch.enabled ?? current.enabled) ? 1 : 0,
        JSON.stringify(patch.variables ?? current.variables),
        patch.maxRunsPerDay === undefined ? current.maxRunsPerDay : patch.maxRunsPerDay,
        isoTimestamp(clock()),
        id,
      );
      return require_(id);
    },

    remove(id) {
      return deleteOne.run(id).changes > 0;
    },

    due: (nowIso) => selectDue.all(nowIso).map(hydrate),

    recordFire(id, firedAt, nextFireAt) {
      applyFire.run(firedAt, nextFireAt, isoTimestamp(clock()), id);
      return require_(id);
    },

    recordOutcome(id, outcome, reason, at) {
      applyOutcome.run(outcome, reason, at, isoTimestamp(clock()), id);
      return require_(id);
    },

    setNextFire(id, nextFireAt) {
      applyNextFire.run(nextFireAt, isoTimestamp(clock()), id);
      return require_(id);
    },

    setEnabled(id, enabled) {
      applyEnabled.run(enabled ? 1 : 0, isoTimestamp(clock()), id);
      return require_(id);
    },

    setConsecutiveFailures(id, failures) {
      applyFailures.run(failures, isoTimestamp(clock()), id);
      return require_(id);
    },
  };
}
