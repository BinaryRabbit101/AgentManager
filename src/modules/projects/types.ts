/**
 * The projects element's vocabulary (projects DESIGN §1).
 *
 * Two things this file deliberately does **not** do:
 *
 * - it defines no permission vocabulary. {@link PermissionOverride} is roster's
 *   shape, stored verbatim and handed over uncomposed (§1.3, §7.6): roster's
 *   `compilePermissions` is the sole composer, and a second definition here
 *   would be a second answer to one question;
 * - it stores no secret. {@link EnvEntry} carries either a literal value or a
 *   `secretRef` into foundation's secret store, resolved at session start by
 *   roster's option compiler (§1.4, §7.7).
 */

/** ULID, minted by foundation's `projects` repository. */
export type ProjectId = string;

/**
 * `provisioning` is the clone flow's transient state (§2.2) — a project in it
 * cannot be launched against. Registering an existing folder goes straight to
 * `active`.
 */
export type ProjectStatus = 'provisioning' | 'active' | 'archived';
export const PROJECT_STATUSES = ['provisioning', 'active', 'archived'] as const;

/** §4.2. `auto` is the hybrid rule of §4.1; non-git projects behave as `shared`. */
export type WorkspacePolicy = 'auto' | 'shared' | 'worktree';
export const WORKSPACE_POLICIES = ['auto', 'shared', 'worktree'] as const;

/** Non-git folders are fully supported; they simply get no worktrees (§2.1). */
export type Vcs = 'git' | 'none';
export const VCS_KINDS = ['git', 'none'] as const;

export function isProjectStatus(value: unknown): value is ProjectStatus {
  return PROJECT_STATUSES.includes(value as ProjectStatus);
}

export function isWorkspacePolicy(value: unknown): value is WorkspacePolicy {
  return WORKSPACE_POLICIES.includes(value as WorkspacePolicy);
}

export function isVcs(value: unknown): value is Vcs {
  return VCS_KINDS.includes(value as Vcs);
}

/**
 * Roster's permission vocabulary, stored and never composed here (§1.3).
 *
 * `mode` is left as a string rather than re-declaring roster's `PermissionMode`
 * ladder: projects does not rank the modes, roster does, and an out-of-date copy
 * of somebody else's enum is worse than no copy.
 */
export interface PermissionOverride {
  readonly allow?: readonly string[];
  readonly deny?: readonly string[];
  readonly ask?: readonly string[];
  readonly mode?: string;
}

/** The one widening path (§1.2), gated by `policy.allowPermissionElevation`. */
export interface PermissionElevation {
  readonly allow: readonly string[];
  /** Required, non-empty: an elevation nobody had to justify is the failure mode. */
  readonly reason: string;
}

/** §1.4. A literal value lives in the row; a `secretRef` never does. */
export type EnvEntry =
  | { readonly name: string; readonly value: string }
  | { readonly name: string; readonly secretRef: string };

/**
 * Per-project defaults (§1.2).
 *
 * `agentIds` is stored relationally in `project_default_agents`, not inside
 * `defaults_json`, so a roster deletion is resolvable without scanning JSON —
 * which is why {@link serializeProjectDefaults} omits it from the JSON column.
 */
export interface ProjectDefaults {
  readonly agentIds: readonly string[];
  readonly overseerAgentId?: string;
  readonly permissions?: PermissionOverride;
  readonly permissionElevation?: PermissionElevation;
  readonly env?: readonly EnvEntry[];
  readonly setupCommand?: string;
  readonly instructionsPath?: string;
}

/** §3.3. `null` on a project means "inherit the global settings". */
export interface RetentionSettings {
  readonly transcriptDays: number;
  readonly transcriptCapMb: number;
  readonly keepPinned: boolean;
}

/** The global fallbacks a partial `retention_json` is completed from (§3.3). */
export type RetentionDefaults = RetentionSettings;

/** Foundation config's `retention.*` values, which are also §3.3's stated defaults. */
export const BUILT_IN_RETENTION_DEFAULTS: RetentionDefaults = Object.freeze({
  transcriptDays: 90,
  transcriptCapMb: 500,
  keepPinned: true,
});

// ---------------------------------------------------------------------------
// Workspace leases (§1.6, §4)
// ---------------------------------------------------------------------------

/** `primary` is `project.localPath` itself; `worktree` is a git worktree (§4.4). */
export type WorkspaceKind = 'primary' | 'worktree';
export const WORKSPACE_KINDS = ['primary', 'worktree'] as const;

/** `orphaned` is what startup reconciliation makes of a lease from a dead process (§4.4). */
export type WorkspaceLeaseState = 'active' | 'released' | 'orphaned';
export const WORKSPACE_LEASE_STATES = ['active', 'released', 'orphaned'] as const;

export function isWorkspaceKind(value: unknown): value is WorkspaceKind {
  return WORKSPACE_KINDS.includes(value as WorkspaceKind);
}

export function isWorkspaceLeaseState(value: unknown): value is WorkspaceLeaseState {
  return WORKSPACE_LEASE_STATES.includes(value as WorkspaceLeaseState);
}

/** Which directory an assignment actually runs in (§1.6). */
export interface WorkspaceLease {
  readonly id: string;
  readonly projectId: ProjectId;
  readonly assignmentId: string;
  readonly kind: WorkspaceKind;
  /** Absolute; equals `project.localPath` when `kind` is `primary`. */
  readonly path: string;
  /** Worktree only. */
  readonly branch: string | null;
  /** Worktree only: the primary tree's HEAD the branch was cut from. */
  readonly baseCommit: string | null;
  /** `false` = a read/plan assignment, which does not hold the tree (§4.1). */
  readonly write: boolean;
  readonly state: WorkspaceLeaseState;
  readonly acquiredAt: string;
  readonly releasedAt: string | null;
}

/**
 * Why a retained worktree is still on disk (§4.4's "review needed").
 *
 * **Derived on read, never stored.** The same rule §2.3 states for health: a
 * commit count written into a row at release time is a number that starts
 * lying the moment somebody opens the branch in an editor.
 */
export interface WorkspaceReview {
  /** Commits on the worktree's branch beyond `baseCommit`. */
  readonly commits: number;
  /** `git status --porcelain` found something, untracked files included. */
  readonly dirty: boolean;
  /** True while the directory is still on disk. */
  readonly present: boolean;
}

/** A lease as `listWorkspaces` returns it: the row, plus §4.4's review state. */
export interface WorkspaceListEntry extends WorkspaceLease {
  /** Present for a retained worktree — the "review needed" entry of §4.4. */
  readonly review?: WorkspaceReview;
}

/**
 * Stable refusal codes (§4.4: "a typed refusal with a reason string, not a
 * generic error").
 */
export type WorkspaceRefusalCode =
  /** Another write-capable assignment holds the primary tree and policy is `shared`. */
  | 'shared_policy'
  /** Same, for a project that is not a git repository (forced `shared`, §4.2). */
  | 'not_a_repository'
  /** The project lives on a network share; worktrees are refused there (§4.4). */
  | 'unc_path'
  /** The repository is mid-rebase, mid-merge or mid-cherry-pick. */
  | 'repository_busy'
  /** The assignment asked for a clean base and the primary tree is dirty. */
  | 'dirty_primary'
  /** `git worktree add` failed. */
  | 'worktree_failed'
  /** `defaults.setupCommand` failed in the fresh worktree; it was removed again. */
  | 'setup_failed'
  /** The project is `provisioning` or `archived`. */
  | 'project_not_launchable';

/**
 * A refused acquisition (§4.3, §4.4).
 *
 * `retryable` is runner §15.4's flag: `true` means the condition clears on its
 * own — typically "somebody else holds the primary tree" — so the runner may
 * queue and retry; `false` means the configuration can never work as-is.
 */
export interface WorkspaceRefusal {
  readonly refused: true;
  readonly code: WorkspaceRefusalCode;
  readonly reason: string;
  readonly retryable: boolean;
}

export type AcquireWorkspaceResult = WorkspaceLease | WorkspaceRefusal;

export function isWorkspaceRefusal(result: AcquireWorkspaceResult): result is WorkspaceRefusal {
  return (result as Partial<WorkspaceRefusal>).refused === true;
}

// ---------------------------------------------------------------------------
// Launch context (§5)
// ---------------------------------------------------------------------------

/**
 * What `getEffectiveLaunchContext` answers with (§5).
 *
 * "The name is now the only misleading thing about it […]: this call returns
 * **raw inputs, not an effective anything**." There is deliberately no
 * `permissions` key — roster's `compilePermissions` is the sole composer — no
 * resolved `secretRef`, and no merged environment.
 */
export interface LaunchContext {
  /** The leased workspace root, which is not necessarily `project.localPath`. */
  readonly cwd: string;
  /** Ordered, unresolved: refs stay refs (§1.4). */
  readonly env: readonly EnvEntry[];
  /** Stored, uncomposed (§1.3). */
  readonly permissionOverride?: PermissionOverride;
  /** The escape hatch, carried so the launch flow can show it (§1.2). */
  readonly elevation?: PermissionElevation;
  /** Resolved `instructionsPath` text → roster §4's fourth system-prompt slot. */
  readonly instructions?: string;
  readonly workspace: WorkspaceLease;
}

// ---------------------------------------------------------------------------
// Health (§2.3 — derived on read, never stored)
// ---------------------------------------------------------------------------

export interface ProjectHealthCondition {
  /** `stale-agents`, `orphaned-worktrees`, `elevation-refused`. */
  readonly code: string;
  readonly level: 'warn' | 'error';
  readonly message: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

/** One project's derived health (§2.3). M9 adds `missing` and `dirty`. */
export interface ProjectHealth {
  readonly projectId: ProjectId;
  readonly conditions: readonly ProjectHealthCondition[];
}

/** A project as this element models it (§1.1). */
export interface Project {
  readonly id: ProjectId;
  /** Lowercase `[a-z0-9-]`, ≤ 24 chars, unique. Used in worktree paths (§4.4). */
  readonly slug: string;
  readonly name: string;
  /** Canonical absolute Windows path, no trailing separator. */
  readonly localPath: string;
  /** The lowercased canonical form — the identity of a project (§7.4). */
  readonly localPathKey: string;
  readonly repoUrl: string | null;
  readonly defaultBranch: string | null;
  readonly vcs: Vcs;
  readonly notes: string;
  readonly status: ProjectStatus;
  readonly workspacePolicy: WorkspacePolicy;
  readonly defaults: ProjectDefaults;
  /** `null` = inherit the global retention settings (§3.3). */
  readonly retention: RetentionSettings | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastActivityAt: string | null;
  readonly archivedAt: string | null;
}

/**
 * Why a project cannot be launched against right now, or `undefined`.
 *
 * Both halves are checked because they are written by different owners:
 * `status` is this element's column (§1.1) while `archived_at` is the one
 * foundation's `archive()` stamps — a project archived through foundation's
 * repository keeps `status: 'active'`, and reading only one of the two would
 * hand an assignment to a project the user has archived (§2.3).
 */
export function projectLaunchBlock(
  project: Pick<Project, 'status' | 'archivedAt'>,
): 'provisioning' | 'archived' | undefined {
  if (project.status === 'archived' || project.archivedAt !== null) return 'archived';
  if (project.status === 'provisioning') return 'provisioning';
  return undefined;
}
