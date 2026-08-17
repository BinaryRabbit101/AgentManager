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

/** The patterns this build ships with a driver (§9-4). `review`/`overseer` are v2. */
export const SUPPORTED_PATTERNS: readonly AssignmentPattern[] = ['solo', 'pair'];

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
}

// ---------------------------------------------------------------------------
// Service inputs and outputs (§2.3)
// ---------------------------------------------------------------------------

export interface AssignmentMemberRequest {
  readonly agentId: string;
  readonly role: AssignmentRole;
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
  readonly createdBy?: CreatedBy;
}

/** A non-fatal note the create dialog shows before the user confirms (§2.3). */
export interface AssignmentWarning {
  readonly code: string;
  readonly message: string;
}

/** The gate a `write: true` machine-created assignment is parked behind (§9-10). */
export interface GateSpec {
  readonly reason: string;
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
