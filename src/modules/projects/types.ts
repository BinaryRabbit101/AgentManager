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
