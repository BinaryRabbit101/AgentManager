/**
 * What runner requires from the service registry (runner DESIGN §11.3), stated
 * as **structural** interfaces owned by this element.
 *
 * Feature modules never import each other (foundation §6.1): they talk through
 * the bus and through service interfaces on the registry. So the shapes roster,
 * projects and orchestrator publish are re-declared here, narrowed to exactly
 * what the launch chain of §3.1 consumes, and reached with `ctx.require(...)`.
 * Three consequences are deliberate:
 *
 * - **The agent is opaque.** Runner passes roster's agent object straight back
 *   into roster's compiler and reads two fields off it (§3.1: "runner supplies
 *   ids and consumes results"). Re-declaring `AgentDefinition` here would be a
 *   second definition of roster's schema, and the first thing to drift.
 * - **The compiled options are the SDK's own type**, imported from the SDK
 *   package rather than restated. Runner is the element that calls `query()`
 *   (§1), so it is allowed to name the SDK's types; it still constructs no
 *   option shapes of its own beyond §3.3's whitelist.
 * - **`AssignmentContext` is orchestrator's pinned shape** (runner §15.1-3,
 *   orchestrator §2.3), field for field. Runner M3 builds against it with the
 *   stub in `assignmentContext.ts`; orchestrator M1 replaces the stub by
 *   publishing `getAssignmentContext` on the `orchestrator` service, and the
 *   swap is a registry lookup rather than a code change (§11.3).
 *
 * Nothing here is validated at compile time against the providing element —
 * that check belongs to the composition root, which is the only place that sees
 * both sides. What these interfaces buy is that a provider which *changes* its
 * shape breaks a named contract in one file instead of ten call sites.
 */
import type { Options as SdkOptions } from '@anthropic-ai/claude-agent-sdk';

import type { SecretResolver } from '../../secrets/index.js';

export type { SdkOptions };

// ---------------------------------------------------------------------------
// Orchestrator (§11.3, §15.1-3)
// ---------------------------------------------------------------------------

/** Rule strings per bucket, in roster's vocabulary. Runner never reads them. */
export interface AssignmentScopeRules {
  readonly allow?: readonly string[];
  readonly deny?: readonly string[];
  readonly ask?: readonly string[];
}

/**
 * Runner §15.1-3 / orchestrator §2.3, verbatim:
 *
 * ```ts
 * { id, pattern, status, role?, write, scopeRules: { allow?, deny?, ask? },
 *   tokenBudget: number | null, tokensUsed: number,
 *   roundCap: number | null, roundsUsed: number }
 * ```
 *
 * `status` is the coarse admission gate — `open` | `closed` and nothing else
 * (orchestrator §2.2); `phase` is orchestrator's own state machine and runner
 * neither reads nor receives it. `write` is an **assignment** property, because
 * projects leases on write-capability and a plan/review assignment must not take
 * the write hold.
 */
export interface AssignmentContext {
  readonly id: string;
  readonly pattern: string;
  readonly status: 'open' | 'closed';
  /** The seat's role, for roster's `roles/<role>.md` addendum. */
  readonly role?: string | undefined;
  readonly write: boolean;
  readonly scopeRules: AssignmentScopeRules;
  readonly tokenBudget: number | null;
  readonly tokensUsed: number;
  readonly roundCap: number | null;
  readonly roundsUsed: number;
}

/**
 * The one method the launch chain calls on orchestrator (§3.1 step 3).
 *
 * Declared on its own rather than as part of a wider `AssignmentService` so the
 * registry lookup can be satisfied by the real orchestrator *or* by
 * `createAssignmentContextStub`, with the same type on both sides.
 */
export interface AssignmentContextProvider {
  getAssignmentContext(assignmentId: string): Promise<AssignmentContext>;
}

// ---------------------------------------------------------------------------
// The question bridge (§5.2, §15.1-4)
// ---------------------------------------------------------------------------

/** §5.1's three kinds. `approval_gate` is orchestrator's to raise, never runner's. */
export type QuestionKindView = 'question' | 'approval_gate' | 'budget_halt';

export interface QuestionOptionView {
  readonly id: string;
  readonly label: string;
  readonly description?: string | undefined;
}

/** §5.2's `ask()` request, field for field. */
export interface AskQuestionRequest {
  readonly sessionId: string;
  readonly assignmentId: string;
  readonly agentId: string;
  readonly kind: QuestionKindView;
  readonly prompt: string;
  readonly options?: readonly QuestionOptionView[] | undefined;
  readonly multiSelect?: boolean | undefined;
  readonly allowFreeText?: boolean | undefined;
  /**
   * §5.2's `context`, plus the fields runner adds to it.
   *
   * `toolName` and `toolInput` are §5.2's own. The rest are **additive** and
   * ride through orchestrator verbatim — the envelope stores whatever object it
   * was handed and `cardOf` returns it unchanged, so orchestrator needs no
   * change to carry them (that "server-of-origin verbatim" property is the same
   * one that already carries `matchedAskRule`, SDK-NOTES §5.1).
   *
   * - `durableRule` — the rule `ALLOW_ALWAYS_OPTION` would append to the agent's
   *   `permissions.allow` (§5.1's 2026-08-18 decision). Present only on a tool
   *   gate that offers the option, so its presence *is* the card's signal that
   *   the third button is real.
   * - `agentId` — who that rule would be added to. On the request already, but
   *   the card projection does not surface it and the client's roster edit is
   *   addressed to it.
   */
  readonly context?:
    | {
        toolName?: string;
        toolInput?: unknown;
        durableRule?: string;
        agentId?: string;
      }
    | undefined;
  /** ISO deadline for the inline hold — stage 1 of §5.4. */
  readonly holdUntil: string;
  /** ISO deadline for the question itself, from `runner.question.expireHours`. */
  readonly expiresAt: string;
  /**
   * Called with the question id the moment the row exists — **additive to
   * §5.2's shape, and optional on both sides**.
   *
   * §5.2 types `ask()` as returning the id only at settle time, but runner needs
   * it at *raise* time for two things it cannot get any other way: the
   * `session.question.raised` event of §10, and §5.4's park message, which names
   * the question so the agent (and the transcript) can be matched to the card.
   * An orchestrator build that ignores the callback still works — runner then
   * resolves the id from the `questions` row when it parks, which is the same
   * read §9.2's boot sweep makes.
   */
  readonly onRaised?: ((questionId: string) => void) | undefined;
}

export interface QuestionAnswerView {
  readonly optionIds?: readonly string[];
  readonly labels?: readonly string[];
  readonly text?: string;
}

/** §5.2's `QuestionOutcome`, field for field. */
export type QuestionOutcomeView =
  | {
      readonly status: 'answered';
      readonly questionId: string;
      readonly answer: QuestionAnswerView;
      readonly answeredVia: 'local' | 'remote';
      readonly answeredAt: string;
    }
  | { readonly status: 'expired'; readonly questionId: string }
  | { readonly status: 'cancelled'; readonly questionId: string; readonly reason: string };

/**
 * Orchestrator's `QuestionBridge` (§5.2).
 *
 * `ask()` may take hours to resolve; runner calls it at most once per pending
 * tool call and cancels it if the session dies first (§15.1-4).
 */
export interface QuestionBridgeView {
  ask(request: AskQuestionRequest): Promise<QuestionOutcomeView>;
  cancel(questionId: string, reason: string): Promise<void>;
}

/** What runner probes for on the `orchestrator` service (§11.3). */
export interface QuestionBridgeProvider {
  readonly questionBridge?: Partial<QuestionBridgeView> | undefined;
}

/** True when this build's orchestrator can actually carry a question. */
export function hasQuestionBridge(
  provider: QuestionBridgeProvider | undefined,
): provider is { questionBridge: QuestionBridgeView } {
  const bridge = provider?.questionBridge;
  return typeof bridge?.ask === 'function' && typeof bridge.cancel === 'function';
}

// ---------------------------------------------------------------------------
// Roster (§11.3, §3.1 step 6)
// ---------------------------------------------------------------------------

/**
 * Roster's agent, as far as runner is concerned: an opaque object with an id
 * and an archive marker, handed straight back to the compiler.
 */
export interface RosterAgent {
  readonly definition: {
    readonly id: string;
    readonly name?: string;
    /**
     * The one field of roster's `defaults` block runner reads (§6.1).
     *
     * "Weight comes from roster's `defaults.concurrencyWeight` (roster §3,
     * default 1) and is copied onto `sessions.weight` at enqueue". Everything
     * else in `defaults` — model, `maxTurns`, `maxBudgetUsd` — reaches the SDK
     * through roster's compiler and is none of runner's business (§3.3).
     */
    readonly defaults?: { readonly concurrencyWeight?: number } | undefined;
  };
  /** Non-null for an agent read out of `.archive/` — refused at admission. */
  readonly archivedAt?: string | null;
}

/** Roster's `EffectivePermissions` (roster §6.2), for display and the header. */
export interface EffectivePermissionsView {
  readonly mode: string;
  readonly allow: readonly string[];
  readonly deny: readonly string[];
  readonly ask: readonly string[];
  readonly elevation: { readonly allow: readonly string[]; readonly reason: string } | null;
}

/** Roster's default-deny `CanUseToolPolicy` (roster §6.1) — data, not a callback. */
export interface CanUseToolPolicyView {
  readonly default: 'deny';
  readonly humanMayApprove: boolean;
  readonly ask: readonly string[];
  readonly denyMessage: string;
}

/** Roster's `Diagnostic` (roster §2.3). `error` is fatal to a launch (§3.2). */
export interface CompileDiagnostic {
  readonly level: 'error' | 'warn' | 'info';
  readonly code: string;
  readonly message: string;
  readonly agentId?: string | undefined;
  readonly path?: string | undefined;
}

/** One environment entry as projects stores it: a literal or an unresolved ref. */
export type EnvEntryView =
  | { readonly name: string; readonly value: string }
  | { readonly name: string; readonly secretRef: string };

/** Roster's `ProjectContext` (roster §13) — raw inputs, never a computed result. */
export interface ProjectCompileContext {
  readonly projectId: string;
  readonly cwd: string;
  readonly permissionOverride?: unknown;
  readonly elevation?: { readonly allow: readonly string[]; readonly reason: string } | undefined;
  readonly env?: readonly EnvEntryView[] | undefined;
  readonly instructions?: string | undefined;
  readonly workspace?:
    { readonly kind: string; readonly path: string; readonly branch: string | null } | undefined;
}

/** Roster's `AssignmentContext` compile layer — the subset the compiler reads. */
export interface AssignmentCompileContext {
  readonly id: string;
  readonly role?: string | undefined;
  readonly write: boolean;
  readonly scopeRules?: AssignmentScopeRules | undefined;
  readonly env?: readonly EnvEntryView[] | undefined;
}

/** Roster's `CompileSessionInput` (roster §13), as runner assembles it. */
export interface CompileSessionRequest {
  readonly agent: RosterAgent;
  readonly project?: ProjectCompileContext | undefined;
  readonly assignment: AssignmentCompileContext;
  readonly policy: {
    readonly allowPermissionElevation: boolean;
    readonly globalDeny: readonly string[];
  };
  /** Foundation's `agentEnv`, with every `null` already resolved (`agentEnv.ts`). */
  readonly agentEnv?: Readonly<Record<string, string>> | undefined;
  readonly defaultModel?: string | undefined;
  /** The §3.2 read-only face; roster's compiler is one of the two reveal sites. */
  readonly secrets: SecretResolver;
}

/** Roster's `CompiledSession` (roster §13) — the object §3.3 treats as immutable. */
export interface CompiledSession {
  readonly options: SdkOptions;
  readonly effective: EffectivePermissionsView;
  readonly policy: CanUseToolPolicyView;
  readonly diagnostics: readonly CompileDiagnostic[];
}

/**
 * What the `roster` service must expose for a launch (§3.1 steps 6, §11.3
 * "fatal — runner does not start" if absent).
 *
 * `registry.get` answers the agent object; `compileSession` is roster §13's
 * compiler, "the only function in the system that constructs SDK option
 * shapes". Both are optional in the *type* so that a roster build which has not
 * published the compiler yet produces runner's named launch failure rather than
 * a `TypeError` from a missing method.
 */
export interface RosterProvider {
  readonly registry?: {
    get(agentId: string): RosterAgent | undefined;
    getArchived?(agentId: string): RosterAgent | undefined;
  };
  compileSession?(input: CompileSessionRequest): Promise<CompiledSession>;
}

// ---------------------------------------------------------------------------
// Projects (§11.3, §3.1 steps 4 and 5)
// ---------------------------------------------------------------------------

/** projects' `WorkspaceLease` (projects §4.1). */
export interface WorkspaceLeaseView {
  readonly id: string;
  readonly projectId: string;
  readonly assignmentId: string;
  readonly kind: string;
  readonly path: string;
  readonly branch: string | null;
  readonly write: boolean;
}

/** projects' `WorkspaceRefusal` (projects §4.4) — `retryable` is runner §15.4-21. */
export interface WorkspaceRefusalView {
  readonly refused: true;
  readonly code: string;
  readonly reason: string;
  readonly retryable: boolean;
}

export type AcquireWorkspaceResultView = WorkspaceLeaseView | WorkspaceRefusalView;

export function isWorkspaceRefusal(
  result: AcquireWorkspaceResultView,
): result is WorkspaceRefusalView {
  return (result as Partial<WorkspaceRefusalView>).refused === true;
}

/** projects' `LaunchContext` (projects §5) — raw inputs, uncomposed. */
export interface LaunchContextView {
  readonly cwd: string;
  readonly env: readonly EnvEntryView[];
  readonly permissionOverride?: unknown;
  readonly elevation?: { readonly allow: readonly string[]; readonly reason: string };
  readonly instructions?: string;
  readonly workspace: WorkspaceLeaseView;
}

export interface ProjectsProvider {
  acquireWorkspace(
    projectId: string,
    assignmentId: string,
    options: { readonly write: boolean; readonly scopePaths?: readonly string[] },
  ): Promise<AcquireWorkspaceResultView>;
  releaseWorkspace(
    leaseId: string,
    options?: { readonly cleanup?: 'keep' | 'remove' },
  ): Promise<unknown>;
  getEffectiveLaunchContext(projectId: string, assignmentId: string): Promise<LaunchContextView>;
}
