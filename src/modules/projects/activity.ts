/**
 * The per-project activity timeline (projects DESIGN §3.1; IMPLEMENTATION M5).
 *
 * > "Projects owns the *question* 'what has happened on this project', not the
 * > storage of session records. Runner owns `sessions`, orchestrator owns
 * > `assignments`, and both tables are foundation's; projects reads them through
 * > foundation's repositories, which are the sanctioned cross-element read path."
 *
 * So this file composes and never writes. Every column it touches is one §3.1
 * already pinned — `sessions.project_id`, `assignment_id`, `status`, `summary`,
 * `pinned`, `transcript_path`, and the token split in `session_usage` — and the
 * one thing it *defines* is the assignment-level `outcome`.
 *
 * ## The outcome projection
 *
 * `sessions.status` is foundation's vocabulary and is consumed verbatim. §3.1's
 * table maps a *set* of those onto one of four assignment outcomes:
 *
 * | outcome | when |
 * |---|---|
 * | `running` | any session is `queued`, `running`, or `paused` |
 * | `completed` | every session is `done` |
 * | `stopped` | no session `running`, at least one `interrupted`, none `failed` |
 * | `failed` | any session is `failed` or `orphaned` |
 *
 * The rows overlap — a set with one `running` and one `failed` matches two — so
 * {@link deriveOutcome} evaluates them **in the table's order**, which is also
 * the order the `stopped` row's own wording assumes ("no session `running`").
 * Anything still live is `running` whatever else happened; that is the honest
 * answer while a pair is mid-flight and one seat has already failed.
 *
 * ## `transcriptAvailable` is derived, never stored
 *
 * §3.2: "`sessions.transcript_path` is authoritative, and every read, prune, and
 * availability check goes through it". So the flag is `transcript_path IS NOT
 * NULL` and nothing else — which is what makes the pruner's single UPDATE
 * (§3.3) enough to flip the whole UI without touching a second column.
 */
import type {
  AssignmentRecord,
  AssignmentsRepository,
  SessionRecord,
  SessionStatus,
  SessionsRepository,
  UsageRepository,
} from '../../storage/index.js';

import type { WorkspaceLeaseRepository } from './leases.js';
import { summariseScope } from './scope.js';
import type { WorkItemRepository } from './workItems.js';
import type { WorkspaceKind } from './types.js';

/** §3.1's derived projection of an assignment's session statuses. */
export type AssignmentOutcome = 'running' | 'completed' | 'stopped' | 'failed';

/**
 * §3.1's table, in its own order.
 *
 * An assignment with **no** sessions reads as `running`: it exists, and nothing
 * about it has finished. "Every session is `done`" is vacuously true of an empty
 * set, and taking that reading would show a completed entry on the timeline for
 * work that never started — which is the one answer that is certainly wrong.
 */
export function deriveOutcome(statuses: readonly SessionStatus[]): AssignmentOutcome {
  if (statuses.length === 0) return 'running';
  if (statuses.some((status) => status === 'queued' || status === 'running' || status === 'paused'))
    return 'running';
  if (statuses.every((status) => status === 'done')) return 'completed';
  if (statuses.some((status) => status === 'failed' || status === 'orphaned')) return 'failed';
  if (statuses.some((status) => status === 'interrupted')) return 'stopped';
  // Unreachable while the vocabulary is foundation's seven: the four clauses
  // above partition it. A status added there without a row in §3.1's table
  // lands here, and `failed` is the reading that gets noticed.
  return 'failed';
}

/** One session, as the timeline renders it (§3.1). */
export interface ActivitySession {
  readonly id: string;
  readonly agentId: string;
  /** Foundation's vocabulary, verbatim. */
  readonly status: SessionStatus;
  /** `= transcript_path IS NOT NULL` (§3.2). */
  readonly transcriptAvailable: boolean;
  /** `sessions.summary` — written by the runner so no transcript is opened. */
  readonly summary: string | null;
  /** Exempt from both prune paths (§3.3). */
  readonly pinned: boolean;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
}

/** One assignment's line on the project page (§3.1). */
export interface ProjectActivityEntry {
  readonly assignmentId: string;
  readonly workItemIds: readonly string[];
  readonly agentIds: readonly string[];
  /** Orchestrator's pattern; `null` for a solo assignment (§3.1). */
  readonly pattern: string | null;
  readonly scopeSummary: string | null;
  /**
   * The workspace the assignment ran in.
   *
   * `null` when it never took a lease — an assignment refused before it started,
   * or one created but never launched. §3.1 types this non-null; a fabricated
   * `{ kind: 'primary', path: localPath }` for an assignment that never held the
   * tree would be a claim about history that is simply untrue.
   */
  readonly workspace: {
    readonly kind: WorkspaceKind;
    readonly path: string;
    readonly branch: string | null;
  } | null;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly outcome: AssignmentOutcome;
  /** Joined from `session_usage` (§3.1). */
  readonly tokens: { readonly input: number; readonly output: number };
  readonly sessions: readonly ActivitySession[];
}

/** `GET /api/projects/:id/activity`'s envelope — §5 says the timeline is paged. */
export interface ProjectActivityPage {
  readonly entries: readonly ProjectActivityEntry[];
  /** Assignments on the project, so the UI can size the pager. */
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

export interface ActivityDeps {
  readonly sessions: SessionsRepository;
  readonly assignments: AssignmentsRepository;
  readonly usage: UsageRepository;
  readonly leases: WorkspaceLeaseRepository;
  readonly workItems: WorkItemRepository;
}

export interface ActivityOptions {
  readonly limit?: number;
  readonly offset?: number;
}

/** §5's default page. Big enough for a project page, small enough for a phone. */
export const DEFAULT_ACTIVITY_LIMIT = 50;
export const MAX_ACTIVITY_LIMIT = 200;

/** `{"paths": ["src/api"]}` — orchestrator's stored scope, read defensively. */
function scopePathsFrom(scopeJson: string | null): readonly string[] {
  if (scopeJson === null || scopeJson.trim().length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(scopeJson);
    if (typeof parsed !== 'object' || parsed === null) return [];
    const paths = (parsed as { paths?: unknown }).paths;
    return Array.isArray(paths)
      ? paths.filter((entry): entry is string => typeof entry === 'string')
      : [];
  } catch {
    return [];
  }
}

/** The earliest of a set of nullable timestamps, or `undefined`. */
function earliest(values: readonly (string | null)[]): string | undefined {
  const present = values.filter((value): value is string => value !== null);
  return present.length === 0 ? undefined : present.reduce((a, b) => (a <= b ? a : b));
}

/** The latest, or `undefined` — used only when nothing is still running. */
function latest(values: readonly (string | null)[]): string | undefined {
  const present = values.filter((value): value is string => value !== null);
  return present.length === 0 ? undefined : present.reduce((a, b) => (a >= b ? a : b));
}

function buildEntry(
  assignment: AssignmentRecord,
  sessions: readonly SessionRecord[],
  deps: ActivityDeps,
): ProjectActivityEntry {
  const statuses = sessions.map((session) => session.status);
  const outcome = deriveOutcome(statuses);

  let input = 0;
  let output = 0;
  for (const session of sessions) {
    const totals = deps.usage.totals(session.id);
    if (totals === undefined) continue;
    input += totals.inputTokens;
    output += totals.outputTokens;
  }

  // Members first, in the order the assignment declares them, then anyone who
  // actually ran a session and is not on the roll — a seat filled after the fact
  // is still an agent that was active here.
  const agentIds: string[] = [];
  for (const member of deps.assignments.listMembers(assignment.id)) {
    if (!agentIds.includes(member.agentId)) agentIds.push(member.agentId);
  }
  for (const session of sessions) {
    if (!agentIds.includes(session.agentId)) agentIds.push(session.agentId);
  }

  // The lease for this assignment, newest first — `list` already orders that
  // way, so the first hit is the workspace it most recently ran in.
  const lease = deps.leases
    .list(assignment.projectId)
    .find((candidate) => candidate.assignmentId === assignment.id);

  const scopePaths = scopePathsFrom(assignment.scopeJson);

  return {
    assignmentId: assignment.id,
    workItemIds: deps.workItems.itemsFor(assignment.id),
    agentIds,
    // §3.1: "null for a solo assignment" — a solo launch has no pattern to name.
    pattern: assignment.pattern === 'solo' ? null : assignment.pattern,
    scopeSummary: summariseScope(scopePaths),
    workspace:
      lease === undefined ? null : { kind: lease.kind, path: lease.path, branch: lease.branch },
    startedAt: earliest(sessions.map((session) => session.startedAt)) ?? assignment.createdAt,
    // Still running means still open-ended, whatever timestamps the finished
    // seats carry.
    endedAt:
      outcome === 'running'
        ? null
        : (latest(sessions.map((s) => s.endedAt)) ?? assignment.closedAt),
    outcome,
    tokens: { input, output },
    sessions: sessions.map((session) => ({
      id: session.id,
      agentId: session.agentId,
      status: session.status,
      transcriptAvailable: session.transcriptPath !== null,
      summary: session.summary,
      pinned: session.pinned,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
    })),
  };
}

/**
 * The project's timeline, grouped by assignment, newest first (§3.1).
 *
 * Assignments are the spine rather than sessions, because an assignment that was
 * created and never launched is still something that happened on the project —
 * and because "which agents are/have been active here" is a question about
 * assignments, which carry the roll.
 */
export function readProjectActivity(
  projectId: string,
  deps: ActivityDeps,
  options: ActivityOptions = {},
): ProjectActivityPage {
  const limit = Math.min(
    MAX_ACTIVITY_LIMIT,
    Math.max(1, Math.trunc(options.limit ?? DEFAULT_ACTIVITY_LIMIT)),
  );
  const offset = Math.max(0, Math.trunc(options.offset ?? 0));

  const assignments = deps.assignments.listByProject(projectId);
  const page = assignments.slice(offset, offset + limit);

  // One read of the project's sessions, bucketed — rather than one query per
  // assignment, which is the same answer at N times the cost.
  const byAssignment = new Map<string, SessionRecord[]>();
  for (const session of deps.sessions.list({ projectId })) {
    const bucket = byAssignment.get(session.assignmentId);
    if (bucket === undefined) byAssignment.set(session.assignmentId, [session]);
    else bucket.push(session);
  }

  return {
    entries: page.map((assignment) =>
      buildEntry(
        assignment,
        // Oldest first inside an entry: a timeline reads down, and `list`
        // returns newest first.
        [...(byAssignment.get(assignment.id) ?? [])].reverse(),
        deps,
      ),
    ),
    total: assignments.length,
    limit,
    offset,
  };
}
