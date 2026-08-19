/**
 * The orchestrator's own vocabulary, and the one contract other elements code
 * against.
 *
 * Everything here is a closed set. `phase`, `close_reason` and `halt_reason` are
 * columns whose values a UI branches on, so a value nothing can produce is a lie
 * in the state machine and a value produced from a free string is a bug nobody
 * finds until a card renders blank.
 */
import type { AssignmentPattern, AssignmentRole, AssignmentStatus } from '../../storage/index.js';

import type { QuestionInbox } from './questions.js';
import type { ToolsetFactory } from './toolset.js';

export type { AssignmentPattern, AssignmentRole, AssignmentStatus };

/** The five roles, as data, so the validator can name them in a refusal. */
export const ASSIGNMENT_ROLES: readonly AssignmentRole[] = [
  'implementer',
  'architect',
  'skeptic',
  'reviewer',
  'overseer',
];

export function isAssignmentRole(value: unknown): value is AssignmentRole {
  return typeof value === 'string' && (ASSIGNMENT_ROLES as readonly string[]).includes(value);
}

/**
 * The patterns this build ships with a driver (§9-4). `review` is still v2.
 *
 * `overseer` joined them in M10 (§3.5). What did **not** change is what a
 * machine may create: `create_assignment`'s own schema still accepts only
 * `solo | pair`, so an overseer cannot mint another overseer however this list
 * grows (§9-3 refuses the nesting as well, which is the second lock).
 */
export const SUPPORTED_PATTERNS: readonly AssignmentPattern[] = ['solo', 'pair', 'overseer'];

export function isAssignmentPattern(value: unknown): value is AssignmentPattern {
  return value === 'solo' || value === 'pair' || value === 'review' || value === 'overseer';
}

/**
 * Orchestrator's own state machine (§2.2), separate from `status` on purpose.
 *
 * A `halted` or `awaiting_user` assignment is still `open` — its sessions may
 * finish; the *driver* simply plans no new turns.
 */
export const ASSIGNMENT_PHASES = [
  'planned',
  'running',
  'awaiting_user',
  'halted',
  'converged',
  'closed',
] as const;
export type AssignmentPhase = (typeof ASSIGNMENT_PHASES)[number];

/** §2.2's closed set. */
export const CLOSE_REASONS = [
  'converged',
  'round_cap',
  'budget_exhausted',
  'user_closed',
  'gate_denied',
  'gate_expired',
  'breaker',
  'failed',
  'project_archived',
] as const;
export type CloseReason = (typeof CLOSE_REASONS)[number];

export function isCloseReason(value: unknown): value is CloseReason {
  return typeof value === 'string' && (CLOSE_REASONS as readonly string[]).includes(value);
}

/** Who minted the row. `overseer:<agentId>` is the machine-caller form (§2.1). */
export type CreatedBy = 'user' | 'system' | `overseer:${string}`;

// ---------------------------------------------------------------------------
// Scope (§2.5)
// ---------------------------------------------------------------------------

/**
 * `assignments.scope_json`.
 *
 * Paths are **repo-relative**, contain no `..` and carry no globs: projects
 * rewrites them onto the leased workspace root (projects §1.3) before roster
 * composes them, and orchestrator never computes an absolute path.
 */
export interface AssignmentScope {
  readonly paths: readonly string[];
  readonly description?: string;
  /** Pattern-required for `pair`; the file a critique is a review of (§3.3). */
  readonly artifactPath?: string;
}

/**
 * Raw rule strings per bucket, exactly roster's permission vocabulary
 * (runner §15.1-3, resolved R2).
 *
 * Orchestrator supplies the strings; roster's `compilePermissions` composes them
 * as the assignment layer and stays the sole composer; runner passes them
 * through untouched. An assignment with no scope restriction sends `{}`.
 */
export interface ScopeRules {
  readonly allow?: readonly string[];
  readonly deny?: readonly string[];
  readonly ask?: readonly string[];
}

// ---------------------------------------------------------------------------
// The runner contract (§2.7 / runner §15.1-3)
// ---------------------------------------------------------------------------

/**
 * What `getAssignmentContext(assignmentId)` returns — runner's launch chain step
 * 3, and the reason this module ships before anything collaborative.
 *
 * `write` is an **assignment** property, not a session one: projects leases on
 * write-capability, and a plan/review assignment must not take the write hold.
 * Independently of what `scopeRules` declares, roster's compiler adds a
 * mutating-tool deny when `write === false`, so a read-only assignment is safe
 * by the one flag rather than by orchestrator remembering to enumerate every
 * mutating tool.
 */
export interface AssignmentContext {
  readonly id: string;
  readonly pattern: AssignmentPattern;
  /** The coarse admission gate. Runner refuses to start on anything but `open`. */
  readonly status: AssignmentStatus;
  /** The seat's role, when the assignment has exactly one — or when one is named. */
  readonly role?: AssignmentRole;
  readonly write: boolean;
  readonly scopeRules: ScopeRules;
  readonly tokenBudget: number | null;
  readonly tokensUsed: number;
  readonly roundCap: number | null;
  readonly roundsUsed: number;
  /**
   * The tool names this **seat** may not be asked about (§2.3, WO4 §2).
   *
   * Already filtered to the agent the context was resolved for, because the
   * scope of a pre-grant is `(assignment, agent, tool)` and a list runner had to
   * filter itself would be a list runner could filter wrongly. Empty when the
   * caller named no agent — the sole-seat shortcut `role` takes is deliberately
   * *not* taken here: guessing a seat costs a prompt addendum, guessing a
   * pre-grant costs a permission gate somebody wanted.
   */
  readonly preGrantedTools: readonly string[];
  /**
   * `scope.artifactPath` (§2.5), for the one thing runner does with it: name it
   * on a permission card whose input targets that file, so a deny is informed
   * rather than blind (WO4 addendum §6). Null when the assignment declares none.
   */
  readonly artifactPath: string | null;
}

// ---------------------------------------------------------------------------
// Service inputs and outputs (§2.3)
// ---------------------------------------------------------------------------

export interface AssignmentMemberRequest {
  readonly agentId: string;
  readonly role: AssignmentRole;
}

/**
 * One gate the user pre-answered in the Start-work dialog (§2.3, WO4 §2).
 *
 * Scope is `(assignment, agent, tool)` and nothing wider. It is **not** a
 * permission: roster's `compilePermissions` remains the sole composer (roster
 * §6.2), and a pre-grant can only pre-answer a card the compiled permissions
 * would have raised — a tool the deny set removed raises no card, so a
 * pre-grant on it grants nothing. That is the whole difference from roster's
 * Always-allow, which edits the agent's baseline and outlives every assignment.
 */
export interface PreGrant {
  readonly agentId: string;
  /** A bare tool name — `Bash`, `Edit`, `mcp__gmail__send`. Never a scoped rule:
   *  a pre-grant answers "do not stop and ask about this tool", and a pattern
   *  would be a rule, which is roster's to compose and not orchestrator's. */
  readonly tool: string;
}

/** `POST /api/assignments` (§2.3 path 2) and `create_assignment` (path 3). */
export interface CreateAssignmentRequest {
  readonly projectId: string;
  readonly pattern: AssignmentPattern;
  readonly goal?: string;
  readonly members: readonly AssignmentMemberRequest[];
  readonly scope?: AssignmentScope;
  readonly write?: boolean;
  readonly tokenBudget?: number | null;
  readonly roundCap?: number | null;
  readonly workItemIds?: readonly string[];
  readonly patternConfig?: Readonly<Record<string, unknown>>;
  /** Gates the user pre-answered in the dialog, scoped to this assignment (§2.3). */
  readonly preGrants?: readonly PreGrant[];
  /**
   * The roster task template this was started from, for provenance (§2.3, WO5).
   *
   * Recorded and never acted on: a template is a prefill, so everything it
   * contributed is already in `goal`, `scope.artifactPath`, `pattern` and
   * `preGrants` by the time this request is built. Nothing validates it against
   * the library either — templates are files an owner may rename or delete
   * (roster §2.1), and a create call that started refusing because somebody
   * pruned a folder would be a template *gating* a launch.
   */
  readonly templateId?: string;
  /** Defaults to `'user'`; the MCP tool passes `overseer:<agentId>` (M4). */
  readonly createdBy?: CreatedBy;
  /** Set by `create_assignment` only; a user-created assignment has no parent. */
  readonly parentAssignmentId?: string;
  /** Plans the first turn immediately; otherwise the row sits at `phase: planned`. */
  readonly autoStart?: boolean;
}

/** `POST /api/assignments/solo` (§2.3 path 1) — the drag-and-drop launch. */
export interface CreateSoloRequest {
  readonly projectId: string;
  readonly agentId: string;
  readonly prompt: string;
  readonly role?: AssignmentRole;
  readonly write?: boolean;
  readonly priority?: 'interactive' | 'normal';
  readonly scope?: AssignmentScope;
  readonly goal?: string;
  readonly workItemIds?: readonly string[];
  /** Gates the user pre-answered in the dialog (§2.3, WO4 §2). */
  readonly preGrants?: readonly PreGrant[];
  /** The task template this was started from (§2.3, WO5) — provenance only. */
  readonly templateId?: string;
  readonly createdBy?: CreatedBy;
}

/** A non-fatal note the create dialog shows before the user confirms (§2.3). */
export interface AssignmentWarning {
  readonly code: string;
  readonly message: string;
}

/**
 * The gate a `write: true` machine-created assignment is parked behind (§9-10),
 * or that two overlapping write scopes raise (§2.6, §8.2-4).
 *
 * `questionId` is §4.3's shape — the overseer is told which card is holding its
 * work, so it can say so in its report instead of waiting on it — and is absent
 * only in a build with no inbox to raise into.
 */
export interface GateSpec {
  readonly reason: string;
  readonly questionId?: string;
}

export interface CreateAssignmentResult {
  readonly assignmentId: string;
  readonly status: AssignmentStatus;
  readonly phase: AssignmentPhase;
  readonly warnings: readonly AssignmentWarning[];
  /** Present when §9-10 parked the assignment behind an approval gate. */
  readonly gate?: GateSpec;
}

export interface CreateSoloResult {
  readonly assignmentId: string;
  readonly sessionId: string;
  readonly warnings: readonly AssignmentWarning[];
}

/** The read model `GET /api/assignments/:id` serves. */
export interface AssignmentView {
  readonly id: string;
  readonly projectId: string;
  readonly pattern: AssignmentPattern;
  readonly status: AssignmentStatus;
  readonly phase: AssignmentPhase;
  readonly goal: string | null;
  readonly scope: AssignmentScope | null;
  readonly write: boolean;
  readonly createdBy: string;
  readonly parentAssignmentId: string | null;
  readonly leadAgentId: string | null;
  readonly artifactPath: string | null;
  /** The task template this assignment was started from, or `null` (WO5). */
  readonly templateId: string | null;
  readonly tokenBudget: number | null;
  readonly tokensUsed: number;
  readonly roundCap: number | null;
  readonly roundsUsed: number;
  readonly haltReason: string | null;
  readonly closeReason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string | null;
  readonly closedAt: string | null;
  readonly members: readonly {
    readonly agentId: string;
    readonly role: AssignmentRole;
    readonly seatOrder: number;
    readonly joinedAt: string | null;
  }[];
  /**
   * §3.5: the child assignments this one is the parent of, oldest first.
   *
   * Empty for everything a lead has not decomposed. It is on the *assignment*
   * view rather than behind a second endpoint because the team is what an
   * overseer assignment **is** — a page that had to fetch the children
   * separately would render a lead with no workers for one paint.
   */
  readonly children: readonly AssignmentChildView[];
  /**
   * Σ of the children's `tokens_used` — the tree half of §16.8's budget (§7.5).
   *
   * `tokensUsed` stays exactly what runner metered onto *this* row, because
   * runner is its only writer (§7.1) and a second writer would race it. The
   * rollup a parent's budget bar shows is `tokensUsed + childTokensUsed`, and
   * it is served as two numbers so the UI can also show where the spend went.
   */
  readonly childTokensUsed: number;
  /**
   * The gates pre-answered at creation (§2.3, WO4 §2).
   *
   * On the view because a standing permission the user cannot see is a standing
   * permission they will not trust — the same argument roster §9.1 makes for
   * the permission preview, applied to the narrower thing. Empty for every
   * assignment created without any.
   */
  readonly preGrants: readonly PreGrant[];
  /**
   * Σ of `permission_denials` across this assignment's turns (WO4 addendum §5).
   *
   * On the assignment rather than computed by the client because "it finished
   * but was denied X times" has to be readable at the moment the result is
   * judged, and the conversation view is not the only place a result is judged.
   * Zero when nothing was ever denied, which is the case the UI renders as
   * nothing at all.
   */
  readonly permissionDenials: number;
}

/** One child on {@link AssignmentView} — enough to render the team, no more. */
export interface AssignmentChildView {
  readonly id: string;
  readonly goal: string | null;
  readonly pattern: AssignmentPattern;
  readonly status: AssignmentStatus;
  readonly phase: AssignmentPhase;
  readonly closeReason: string | null;
  readonly haltReason: string | null;
  readonly artifactPath: string | null;
  readonly write: boolean;
  readonly tokenBudget: number | null;
  readonly tokensUsed: number;
  readonly createdAt: string;
  readonly closedAt: string | null;
  readonly members: readonly {
    readonly agentId: string;
    readonly role: AssignmentRole;
  }[];
}

/** What `PATCH /api/assignments/:id` may change — never members, never pattern. */
export interface AssignmentPatch {
  readonly tokenBudget?: number | null;
  readonly roundCap?: number | null;
  readonly goal?: string;
}

export interface ListAssignmentsQuery {
  readonly projectId?: string;
  readonly status?: AssignmentStatus;
  readonly phase?: AssignmentPhase;
  readonly agentId?: string;
  readonly limit?: number;
}

// ---------------------------------------------------------------------------
// The service surface published as `orchestrator` (§2.3)
// ---------------------------------------------------------------------------

/**
 * §2.3's interface as far as M1, M2 and M5/M6 take it.
 *
 * `getSessionToolset` is present from M5/M6, because the pair's convergence rule
 * has no other input than `report_status` — but it exposes only the **four worker
 * tools** M5 and M6 need (`toolset.ts`), not §4.3's six. That is stated on the
 * method rather than implied by its presence, for the reason the rest of this
 * interface is: "a method that resolves without doing anything is a contract
 * another element builds against and then discovers is a lie".
 */
export interface AssignmentService {
  /**
   * M2's `QuestionBridge` (runner §5.2, §15.1-4), published for runner.
   *
   * `undefined` in a build with no inbox wired — the case runner's degraded
   * fallback exists for.
   */
  readonly questionBridge?: QuestionInbox | undefined;
  /** The same object, under the name the inbox routes and M6 use. */
  readonly questions?: QuestionInbox | undefined;
  createAssignment(request: CreateAssignmentRequest): Promise<CreateAssignmentResult>;
  createSolo(request: CreateSoloRequest): Promise<CreateSoloResult>;
  closeAssignment(id: string, reason: CloseReason): Promise<void>;
  /** Runner's launch chain step 3 (runner §15.1-3). */
  getAssignmentContext(
    assignmentId: string,
    options?: { readonly agentId?: string },
  ): Promise<AssignmentContext>;
  get(id: string): AssignmentView;
  list(query?: ListAssignmentsQuery): readonly AssignmentView[];
  update(id: string, patch: AssignmentPatch): AssignmentView;
  /** The boot task of IMPLEMENTATION M1-6, exposed so a test can drive it. */
  reconcileOnBoot(): Promise<BootReconciliation>;
  /**
   * §4.1's per-launch MCP toolset, which roster mounts at
   * `options.mcpServers.agentmanager` (R1).
   *
   * A **new** instance every call — SDK-NOTES G2: an instance is single-use, and a
   * reused one yields "a session that believes it has the toolset and gets no
   * answers". `undefined` in a build with no toolset wired, which is the same
   * absence `require('orchestrator')` returning undefined already means to roster.
   */
  readonly getSessionToolset?: ToolsetFactory | undefined;
}

export interface BootReconciliation {
  /** Assignments closed because their project is archived. */
  readonly closedForArchivedProject: readonly string[];
  /** Assignments whose `phase` was corrected from `running` (§M1-6). */
  readonly phaseReconciled: readonly string[];
}
