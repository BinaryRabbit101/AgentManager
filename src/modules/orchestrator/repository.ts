/**
 * `AssignmentRepository` — foundation's `assignments` / `assignment_members`
 * repositories plus the columns `migrations/orchestrator/0001_orchestrator.sql`
 * adds (IMPLEMENTATION M1-1). **No other element writes these tables.**
 *
 * ## Why this composes rather than replaces
 *
 * Foundation ships `store.assignments` and owns the two-state `status` fact every
 * element joins on (§2.2, §17 R7). This repository does not re-implement it: it
 * *delegates* the base columns to `store.assignments` and composes SQL only
 * against the columns this element's own migration added. That keeps exactly one
 * writer of `status`, `tokens_used` and `rounds_used` — runner's metering rolls
 * onto `tokens_used` through foundation's repository in the same transaction as
 * the usage write (§7.1), and a second writer here would race it.
 *
 * The database handle is a constructor argument for the reason projects and
 * runner take one (foundation §1.3): an element's own migration gives it its own
 * columns, and foundation provides no accessor for them.
 *
 * ## `updated_at`
 *
 * Written on every mutation this repository makes, because `assignments_open`
 * indexes `(project_id, status, updated_at)` and a NULL there would sort a live
 * assignment behind every stale one. Foundation's own `create`/`close` do not
 * know the column exists, so the wrappers below set it.
 */
import type {
  AssignmentPattern,
  AssignmentRole,
  AssignmentStatus,
  AssignmentsRepository,
  Clock,
  Database,
} from '../../storage/index.js';
import { isoTimestamp } from '../../storage/index.js';

import type {
  AssignmentChildView,
  AssignmentPhase,
  AssignmentScope,
  CreatedBy,
  PreGrant,
} from './types.js';

/** One row, base columns and orchestrator's own, flattened. */
export interface AssignmentRow {
  readonly id: string;
  readonly projectId: string;
  readonly pattern: AssignmentPattern;
  readonly status: AssignmentStatus;
  readonly goal: string | null;
  readonly scopeJson: string | null;
  readonly tokenBudget: number | null;
  readonly tokensUsed: number;
  readonly roundCap: number | null;
  readonly roundsUsed: number;
  readonly createdAt: string;
  readonly closedAt: string | null;
  readonly closeReason: string | null;
  // --- orchestrator's own columns ---
  readonly createdBy: string;
  readonly parentAssignmentId: string | null;
  readonly leadAgentId: string | null;
  readonly write: boolean;
  readonly artifactPath: string | null;
  readonly patternConfigJson: string;
  /** 0004's column, raw. Parsed by `parsePreGrants` at the one place it is read. */
  readonly preGrantsJson: string;
  /** 0006's column: the task template this was started from, or `null` (WO5). */
  readonly templateId: string | null;
  readonly phase: AssignmentPhase;
  readonly haltReason: string | null;
  readonly updatedAt: string | null;
}

export interface MemberRow {
  readonly assignmentId: string;
  readonly agentId: string;
  readonly role: AssignmentRole;
  readonly seatOrder: number;
  readonly joinedAt: string | null;
}

export interface CreateAssignmentRow {
  readonly projectId: string;
  readonly pattern: AssignmentPattern;
  readonly goal?: string | undefined;
  readonly scope?: AssignmentScope | undefined;
  readonly write: boolean;
  readonly phase: AssignmentPhase;
  readonly createdBy: CreatedBy;
  readonly parentAssignmentId?: string | undefined;
  readonly leadAgentId?: string | undefined;
  readonly artifactPath?: string | undefined;
  readonly patternConfig?: Readonly<Record<string, unknown>> | undefined;
  readonly preGrants?: readonly PreGrant[] | undefined;
  readonly templateId?: string | undefined;
  readonly tokenBudget: number | null;
  readonly roundCap: number | null;
  readonly members: readonly {
    readonly agentId: string;
    readonly role: AssignmentRole;
    readonly seatOrder: number;
  }[];
}

export interface ListRowsQuery {
  readonly projectId?: string | undefined;
  readonly status?: AssignmentStatus | undefined;
  readonly phase?: AssignmentPhase | undefined;
  readonly agentId?: string | undefined;
  readonly limit?: number | undefined;
}

export interface AssignmentRepository {
  /** Creates the assignment and its members in one transaction. */
  create(input: CreateAssignmentRow): AssignmentRow;
  get(id: string): AssignmentRow | undefined;
  list(query?: ListRowsQuery): readonly AssignmentRow[];
  listMembers(assignmentId: string): readonly MemberRow[];
  /** How many **open** assignments this agent holds a seat in (§9-7). */
  countOpenForAgent(agentId: string): number;
  /** Σ of the `token_budget`s of a parent's still-open children (§9-8). */
  openChildBudgetTotal(parentAssignmentId: string): number;
  /**
   * §7.5's budget tree, in one read.
   *
   * Two numbers because the tree is bounded in two different ways and confusing
   * them is how a budget lies:
   *
   * - `openReserved` is what the open children still *hold* — their whole
   *   budget, spent or not. It bounds **creation**: an overseer may not promise
   *   the same tokens twice (§9-8).
   * - `used` is what every child, open or closed, has actually spent. It bounds
   *   **running**: the parent halts when the tree has consumed its budget.
   *
   * Reserving against the halt as well would stop a lead the moment it finished
   * delegating — it would have no room left to *review* the work it just paid
   * for, which is the one thing it exists to do.
   */
  childTokens(parentAssignmentId: string): {
    readonly used: number;
    readonly openReserved: number;
    readonly closedUsed: number;
  };
  /** A parent's children, newest first — §4.2's `scopeOf` for an overseer. */
  listChildren(parentAssignmentId: string): readonly AssignmentRow[];
  /** Sets `phase`, and `halt_reason` when one is given. */
  setPhase(id: string, phase: AssignmentPhase, haltReason?: string | null): AssignmentRow;
  /**
   * Adds `by` to `rounds_used` (§3.3's round accounting, IMPLEMENTATION M5).
   *
   * Delegated to foundation's `addRoundsUsed` rather than written here, for the
   * reason the whole file exists: `rounds_used` is a base column and gains
   * nothing from a second writer. The engine calls this exactly once per
   * completed round.
   */
  incrementRounds(id: string, by?: number): AssignmentRow;
  /** The base-column patch of `PATCH /api/assignments/:id` (§11.1). */
  update(
    id: string,
    patch: {
      readonly tokenBudget?: number | null;
      readonly roundCap?: number | null;
      readonly goal?: string;
    },
  ): AssignmentRow;
  /**
   * Replaces `pattern_config_json` (§2.1) — orchestrator's own free JSON column.
   *
   * The one writer of it after creation, used by §7.3's budget note: the
   * original budget a raise is bounded against has to survive a restart, and a
   * column for one number the UI never reads would be a migration for nothing.
   */
  setPatternConfig(id: string, config: Readonly<Record<string, unknown>>): AssignmentRow;
  /**
   * `status: 'closed'` + `closed_at` + `close_reason`, and the phase §2.2
   * prescribes — `converged` keeps its own phase, everything else becomes
   * `closed`.
   */
  close(id: string, reason: string): AssignmentRow;
}

interface RawRow {
  readonly created_by: string;
  readonly parent_assignment_id: string | null;
  readonly lead_agent_id: string | null;
  readonly write: number;
  readonly artifact_path: string | null;
  readonly pattern_config_json: string;
  readonly pre_grants_json: string;
  readonly template_id: string | null;
  readonly phase: AssignmentPhase;
  readonly halt_reason: string | null;
  readonly updated_at: string | null;
}

interface RawMemberRow {
  readonly assignment_id: string;
  readonly agent_id: string;
  readonly role: AssignmentRole;
  readonly seat_order: number;
  readonly joined_at: string | null;
}

export interface AssignmentRepositoryOptions {
  readonly db: Database;
  /** Foundation's repository — the sole writer of the base columns. */
  readonly assignments: AssignmentsRepository;
  readonly clock: Clock;
}

/**
 * 0004's `pre_grants_json`, read back defensively (§2.3, WO4 §2).
 *
 * Tolerant in exactly the way `parseScope` is: a column that will not parse
 * yields **no** pre-grants rather than an exception, because the failure mode of
 * a bad parse must be "every gate asks", which is the behaviour the feature
 * exists to improve on and never a permission somebody did not grant. Entries
 * that are not `{ agentId: string, tool: string }` are dropped one by one for
 * the same reason.
 */
export function parsePreGrants(json: string | null): readonly PreGrant[] {
  if (json === null || json === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const grants: PreGrant[] = [];
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const agentId = record['agentId'];
    const tool = record['tool'];
    if (typeof agentId !== 'string' || agentId === '') continue;
    if (typeof tool !== 'string' || tool === '') continue;
    grants.push({ agentId, tool });
  }
  return grants;
}

/**
 * §3.5's children, as both read models serve them.
 *
 * One projection rather than one per endpoint: `GET /api/assignments/:id` and
 * the conversation view both render the same team, and two mappings of the same
 * rows is how two endpoints come to disagree about what a child is. Oldest
 * first — {@link AssignmentRepository.listChildren} answers newest-first because
 * §4.2's `scopeOf` reads it that way, and a decomposition reads forwards.
 */
export function childViewsOf(
  repository: AssignmentRepository,
  parentAssignmentId: string,
): readonly AssignmentChildView[] {
  return [...repository.listChildren(parentAssignmentId)].reverse().map((child) => ({
    id: child.id,
    goal: child.goal,
    pattern: child.pattern,
    status: child.status,
    phase: child.phase,
    closeReason: child.closeReason,
    haltReason: child.haltReason,
    artifactPath: child.artifactPath,
    write: child.write,
    tokenBudget: child.tokenBudget,
    tokensUsed: child.tokensUsed,
    createdAt: child.createdAt,
    closedAt: child.closedAt,
    members: repository
      .listMembers(child.id)
      .map((member) => ({ agentId: member.agentId, role: member.role })),
  }));
}

export function createAssignmentRepository(
  options: AssignmentRepositoryOptions,
): AssignmentRepository {
  const { db, assignments, clock } = options;

  const ownColumns =
    'created_by, parent_assignment_id, lead_agent_id, write, artifact_path, ' +
    'pattern_config_json, pre_grants_json, template_id, phase, halt_reason, updated_at';

  const selectOwn = db.prepare<[string], RawRow>(
    `SELECT ${ownColumns} FROM assignments WHERE id = ?`,
  );
  const applyOwn = db.prepare<
    [
      string,
      string | null,
      string | null,
      number,
      string | null,
      string,
      string,
      string | null,
      string,
      string,
      string,
    ]
  >(
    'UPDATE assignments SET created_by = ?, parent_assignment_id = ?, lead_agent_id = ?, ' +
      'write = ?, artifact_path = ?, pattern_config_json = ?, pre_grants_json = ?, ' +
      'template_id = ?, phase = ?, updated_at = ? WHERE id = ?',
  );
  const setPhaseStatement = db.prepare<[string, string | null, string, string]>(
    'UPDATE assignments SET phase = ?, halt_reason = ?, updated_at = ? WHERE id = ?',
  );
  const touch = db.prepare<[string, string]>('UPDATE assignments SET updated_at = ? WHERE id = ?');
  const setConfig = db.prepare<[string, string, string]>(
    'UPDATE assignments SET pattern_config_json = ?, updated_at = ? WHERE id = ?',
  );
  const applySeat = db.prepare<[number, string, string, string]>(
    'UPDATE assignment_members SET seat_order = ?, joined_at = ? ' +
      'WHERE assignment_id = ? AND agent_id = ?',
  );
  const selectMembers = db.prepare<[string], RawMemberRow>(
    'SELECT assignment_id, agent_id, role, seat_order, joined_at FROM assignment_members ' +
      'WHERE assignment_id = ? ORDER BY seat_order, agent_id',
  );
  const countOpen = db.prepare<[string], { n: number }>(
    'SELECT COUNT(*) AS n FROM assignment_members m JOIN assignments a ON a.id = m.assignment_id ' +
      "WHERE m.agent_id = ? AND a.status = 'open'",
  );
  const childTotal = db.prepare<[string], { total: number | null }>(
    'SELECT SUM(token_budget) AS total FROM assignments ' +
      "WHERE parent_assignment_id = ? AND status = 'open'",
  );
  const childTokenTotals = db.prepare<
    [string],
    { used: number | null; open_reserved: number | null; closed_used: number | null }
  >(
    'SELECT SUM(tokens_used) AS used, ' +
      "SUM(CASE WHEN status = 'open' THEN COALESCE(token_budget, 0) ELSE 0 END) AS open_reserved, " +
      "SUM(CASE WHEN status = 'closed' THEN tokens_used ELSE 0 END) AS closed_used " +
      'FROM assignments WHERE parent_assignment_id = ?',
  );
  const childIds = db.prepare<[string], { id: string }>(
    'SELECT id FROM assignments WHERE parent_assignment_id = ? ORDER BY created_at DESC, id DESC',
  );
  // The unfiltered listing: no base-repository read covers "every project", and
  // `GET /api/assignments` with no filters is the fleet view's first call.
  const allIds = db.prepare<[], { id: string }>(
    'SELECT id FROM assignments ORDER BY created_at DESC, id DESC',
  );
  const allIdsByStatus = db.prepare<[string], { id: string }>(
    'SELECT id FROM assignments WHERE status = ? ORDER BY created_at DESC, id DESC',
  );

  function hydrate(id: string): AssignmentRow {
    const base = assignments.get(id);
    const own = selectOwn.get(id);
    if (base === undefined || own === undefined) {
      throw new Error(`Internal error: assignment ${id} vanished between two reads.`);
    }
    return {
      id: base.id,
      projectId: base.projectId,
      pattern: base.pattern,
      status: base.status,
      goal: base.goal,
      scopeJson: base.scopeJson,
      tokenBudget: base.tokenBudget,
      tokensUsed: base.tokensUsed,
      roundCap: base.roundCap,
      roundsUsed: base.roundsUsed,
      createdAt: base.createdAt,
      closedAt: base.closedAt,
      closeReason: base.closeReason,
      createdBy: own.created_by,
      parentAssignmentId: own.parent_assignment_id,
      leadAgentId: own.lead_agent_id,
      write: own.write !== 0,
      artifactPath: own.artifact_path,
      patternConfigJson: own.pattern_config_json,
      preGrantsJson: own.pre_grants_json,
      templateId: own.template_id,
      phase: own.phase,
      haltReason: own.halt_reason,
      updatedAt: own.updated_at,
    };
  }

  const createTransaction = db.transaction((input: CreateAssignmentRow): string => {
    const now = isoTimestamp(clock());
    const created = assignments.create({
      projectId: input.projectId,
      pattern: input.pattern,
      ...(input.goal === undefined ? {} : { goal: input.goal }),
      ...(input.scope === undefined ? {} : { scopeJson: JSON.stringify(input.scope) }),
      status: 'open',
      tokenBudget: input.tokenBudget,
      roundCap: input.roundCap,
      createdAt: now,
      members: input.members.map((member) => ({ agentId: member.agentId, role: member.role })),
    });

    applyOwn.run(
      input.createdBy,
      input.parentAssignmentId ?? null,
      input.leadAgentId ?? null,
      input.write ? 1 : 0,
      input.artifactPath ?? null,
      JSON.stringify(input.patternConfig ?? {}),
      // Written once, at creation, and never rewritten: a pre-grant is the
      // answer the user gave in the dialog, and an assignment that could grow
      // new ones after the fact would be the Always-allow memory with a
      // different name (§2.3, WO4 §2).
      JSON.stringify(input.preGrants ?? []),
      // Written once and never rewritten, for the same reason the pre-grants are:
      // it records where this assignment came from, and provenance that could be
      // edited afterwards is not provenance (WO5).
      input.templateId ?? null,
      input.phase,
      now,
      created.id,
    );

    // Seat order is the pattern definition's, not insertion order (§2.4).
    for (const member of input.members) {
      applySeat.run(member.seatOrder, now, created.id, member.agentId);
    }
    return created.id;
  });

  return {
    create: (input) => hydrate(createTransaction(input)),

    get(id) {
      const base = assignments.get(id);
      return base === undefined ? undefined : hydrate(id);
    },

    list(query = {}) {
      const rows =
        query.agentId !== undefined
          ? assignments.listByAgent(
              query.agentId,
              query.status === undefined ? {} : { status: query.status },
            )
          : query.projectId !== undefined
            ? assignments.listByProject(
                query.projectId,
                query.status === undefined ? {} : { status: query.status },
              )
            : query.status === undefined
              ? allIds.all()
              : allIdsByStatus.all(query.status);

      const hydrated = rows.map((row) => hydrate(row.id));
      const filtered =
        query.phase === undefined ? hydrated : hydrated.filter((row) => row.phase === query.phase);
      // Cross-cutting filters that the base repository's per-index reads cannot
      // express, applied after hydration rather than by a second query.
      const byProject =
        query.projectId === undefined || query.agentId === undefined
          ? filtered
          : filtered.filter((row) => row.projectId === query.projectId);
      return query.limit === undefined ? byProject : byProject.slice(0, query.limit);
    },

    listMembers: (assignmentId) =>
      selectMembers.all(assignmentId).map((row) => ({
        assignmentId: row.assignment_id,
        agentId: row.agent_id,
        role: row.role,
        seatOrder: row.seat_order,
        joinedAt: row.joined_at,
      })),

    countOpenForAgent: (agentId) => countOpen.get(agentId)?.n ?? 0,

    openChildBudgetTotal: (parentAssignmentId) => childTotal.get(parentAssignmentId)?.total ?? 0,

    childTokens(parentAssignmentId) {
      // SQLite's SUM over no rows is NULL, which is the honest answer to "what
      // have this assignment's children spent" only if it is read as zero.
      const row = childTokenTotals.get(parentAssignmentId);
      return {
        used: row?.used ?? 0,
        openReserved: row?.open_reserved ?? 0,
        closedUsed: row?.closed_used ?? 0,
      };
    },

    listChildren: (parentAssignmentId) =>
      childIds.all(parentAssignmentId).map((row) => hydrate(row.id)),

    setPhase(id, phase, haltReason) {
      setPhaseStatement.run(phase, haltReason ?? null, isoTimestamp(clock()), id);
      return hydrate(id);
    },

    incrementRounds(id, by = 1) {
      assignments.addRoundsUsed(id, by);
      touch.run(isoTimestamp(clock()), id);
      return hydrate(id);
    },

    update(id, patch) {
      assignments.update(id, patch);
      touch.run(isoTimestamp(clock()), id);
      return hydrate(id);
    },

    setPatternConfig(id, config) {
      setConfig.run(JSON.stringify(config), isoTimestamp(clock()), id);
      return hydrate(id);
    },

    close(id, reason) {
      const at = isoTimestamp(clock());
      assignments.close(id, { reason, at });
      // §2.2's one exception: a `converged` close sets `phase: converged`, not
      // `phase: closed`. Everything else about the close is identical, and
      // `status` is `closed` either way — which is all runner reads.
      setPhaseStatement.run(reason === 'converged' ? 'converged' : 'closed', null, at, id);
      return hydrate(id);
    },
  };
}
