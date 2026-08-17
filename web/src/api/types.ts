/**
 * Every backend shape the UI states, in one file (DESIGN §1.1).
 *
 * Hand-written from the sibling design docs and the routes that serve them —
 * roster `service.ts`, projects `types.ts` / `inspect.ts`, foundation's
 * `config.ts`, `health.ts` and `events.ts`. Nothing here is generated and
 * nothing here is invented: if a field is not returned by a route that exists
 * today, it is not in this file.
 */

// ---------------------------------------------------------------------------
// Foundation — boot facts (§3.5)
// ---------------------------------------------------------------------------

export type Edition = 'home' | 'work';

export interface EffectiveConfig {
  readonly edition: Edition;
  readonly version: string;
  readonly config: Record<string, unknown>;
  readonly sources: Record<string, { readonly layer: string; readonly origin: string }>;
  readonly origins: Record<string, unknown>;
  readonly layers: readonly string[];
  readonly redacted: true;
}

export type HealthStatus = 'ok' | 'degraded' | 'failed';

export interface HealthCondition {
  readonly level: 'warn' | 'error';
  readonly code: string;
  readonly message: string;
  readonly module?: string;
}

export interface ModuleHealth {
  readonly name: string;
  readonly status: HealthStatus;
  readonly conditions?: readonly HealthCondition[];
}

export interface Health {
  readonly status: HealthStatus;
  readonly phase: string;
  readonly version: string;
  readonly edition: Edition;
  readonly uptime: number;
  readonly modules: readonly ModuleHealth[];
  readonly conditions: readonly HealthCondition[];
}

// ---------------------------------------------------------------------------
// Foundation — the event feed (§3.3)
// ---------------------------------------------------------------------------

/** The wire frame of `GET /api/events`, `EventFrame` in `http/routes/events.ts`. */
export interface EventFrame {
  /** Absent on a non-persisted event, which is therefore never replayable. */
  readonly id?: string | undefined;
  readonly ts: string;
  readonly type: string;
  readonly ids: Readonly<Record<string, string>>;
  readonly payload: unknown;
  readonly persist: boolean;
}

// ---------------------------------------------------------------------------
// Roster (§5.2)
// ---------------------------------------------------------------------------

export const SPECIALTIES = [
  'bug-patching',
  'feature-implementation',
  'code-review',
  'testing',
  'documentation',
  'research',
  'email-response',
  'overseer',
  'general',
] as const;
export type Specialty = (typeof SPECIALTIES)[number];

export type Avatar =
  | { readonly kind: 'emoji'; readonly value: string }
  | { readonly kind: 'file'; readonly value: string }
  | { readonly kind: 'initials'; readonly value: string; readonly color: string };

export interface AgentDefinition {
  readonly schemaVersion: number;
  readonly id: string;
  readonly name: string;
  readonly avatar?: Avatar;
  readonly specialty: Specialty;
  readonly tagline?: string;
  readonly tags?: readonly string[];
  readonly capabilities?: { readonly overseer?: boolean };
  readonly meta: { readonly createdAt: string; readonly origin?: string };
}

export type DiagnosticLevel = 'error' | 'warn' | 'info';

export interface Diagnostic {
  readonly level: DiagnosticLevel;
  readonly code: string;
  readonly message: string;
  readonly agentId?: string;
  readonly path?: string;
}

export interface AgentUiState {
  readonly agentId: string;
  readonly boardOrder: number;
  readonly pinned: boolean;
  readonly lastUsedAt: string | null;
}

export interface IntegrationCredentialStatus {
  readonly integration: string;
  readonly secretRef: string;
  readonly resolved: boolean;
}

export interface AgentView {
  readonly definition: AgentDefinition;
  readonly persona: string;
  readonly uiState: AgentUiState;
  readonly diagnostics: readonly Diagnostic[];
  readonly archivedAt: string | null;
  readonly avatarUrl: string;
  readonly credentials?: readonly IntegrationCredentialStatus[];
  readonly needsCredentials?: boolean;
}

export interface RosterListView {
  readonly agents: readonly AgentView[];
  /** Library-wide, including agents too broken to appear in `agents`. */
  readonly diagnostics: readonly Diagnostic[];
}

// ---------------------------------------------------------------------------
// Projects (§8.1)
// ---------------------------------------------------------------------------

export type ProjectStatus = 'provisioning' | 'active' | 'archived';
export type Vcs = 'git' | 'none';

export interface ProjectHealthCondition {
  readonly code: string;
  readonly level: 'warn' | 'error';
  readonly message: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

export interface Project {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly localPath: string;
  readonly repoUrl: string | null;
  readonly defaultBranch: string | null;
  readonly vcs: Vcs;
  readonly notes: string;
  readonly status: ProjectStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastActivityAt: string | null;
  readonly archivedAt: string | null;
  /** Attached by the list and get routes; the conditions of §2.3. */
  readonly health: readonly ProjectHealthCondition[];
}

export interface ProjectListView {
  readonly projects: readonly Project[];
}

export interface InspectionWarning {
  readonly code: string;
  readonly message: string;
}

export interface ProjectInspection {
  readonly localPath: string;
  readonly localPathKey: string;
  readonly name: string;
  readonly slug: string;
  readonly vcs: Vcs;
  readonly repoUrl: string | null;
  readonly defaultBranch: string | null;
  readonly unc: boolean;
  readonly warnings: readonly InspectionWarning[];
}

/** `GET /api/fs/browse?path=` — directory names only, never file contents. */
export interface BrowseEntry {
  readonly name: string;
  readonly path: string;
}

export interface BrowseListing {
  /** The **resolved** path that was listed (projects §2.1: resolve, then compare). */
  readonly path: string;
  /** `null` at a browse root, so the navigator knows where to stop going up. */
  readonly parent: string | null;
  readonly roots: readonly string[];
  readonly entries: readonly BrowseEntry[];
}

// ---------------------------------------------------------------------------
// Runner — only what the board reads (§5.2)
// ---------------------------------------------------------------------------

export type SessionStatus =
  'queued' | 'running' | 'paused' | 'done' | 'failed' | 'interrupted' | 'orphaned';

/**
 * The six-word status vocabulary of orchestrator §16.6, rendered verbatim.
 *
 * `GET /api/orchestrator/status` is orchestrator M9 and lands after ui M2, so
 * until then the same six words are derived from `session.*` (see
 * `board/fleetStatus.ts`). The words never change — only where they come from.
 */
export const FLEET_STATES = [
  'idle',
  'queued',
  'working',
  'awaiting_user',
  'paused',
  'halted',
] as const;
export type FleetState = (typeof FLEET_STATES)[number];

export interface AgentFleetStatus {
  readonly agentId: string;
  readonly state: FleetState;
  readonly headline: string | null;
  readonly since: string | null;
  readonly projectId: string | null;
  readonly sessionId: string | null;
}
