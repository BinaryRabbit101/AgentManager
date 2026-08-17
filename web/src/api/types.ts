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
  readonly capabilities?: {
    readonly overseer?: boolean;
    /** The pinned five of orchestrator §2.3; the role picker is limited to these. */
    readonly roles?: readonly string[];
  };
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

/** projects §1.2's one widening path, gated by `policy.allowPermissionElevation`. */
export interface PermissionElevation {
  readonly allow: readonly string[];
  /** Required and non-empty server-side: an elevation nobody justified is the bug. */
  readonly reason: string;
}

export interface ProjectDefaults {
  readonly agentIds?: readonly string[];
  readonly permissionElevation?: PermissionElevation;
  readonly setupCommand?: string;
  readonly instructionsPath?: string;
}

/**
 * `GET /api/projects/:id` — the full record, which the list route also spreads.
 *
 * Declared separately from {@link Project} because only the read of one project
 * is *promised* to carry `defaults` ("One project: full record, defaults
 * (elevation included) and health"), and the launch flow's elevation banner is
 * the one place that must not depend on a list projection staying generous.
 */
export interface ProjectDetail extends Project {
  readonly defaults: ProjectDefaults;
}

/**
 * Why a project cannot be launched against — the drop-target rule of §5.3.
 *
 * The **words** are projects §2.2/§2.3's own (`provisioning`, `archived`, and
 * the `missing` health condition); the sentence beside each is the UI's, because
 * "it dims during the drag and its tooltip says why" is a UI affordance and no
 * server route returns a refusal for something that was never submitted.
 */
export function projectLaunchRefusal(project: Project): string | undefined {
  if (project.status === 'archived' || project.archivedAt !== null) {
    return 'archived — restore it before launching an agent on it';
  }
  if (project.status === 'provisioning') {
    return 'still being set up — it has no working folder yet';
  }
  if (project.health.some((condition) => condition.code === 'missing')) {
    return 'its folder is missing — relocate it before launching an agent on it';
  }
  return undefined;
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

// ---------------------------------------------------------------------------
// Runner — the session view (§9)
// ---------------------------------------------------------------------------

/** The session row, as `GET /api/sessions/:id` returns it (runner §11.1). */
export interface SessionRecord {
  readonly id: string;
  readonly assignmentId: string;
  readonly agentId: string;
  readonly projectId: string;
  readonly status: SessionStatus;
  readonly sdkSessionId: string | null;
  readonly model: string | null;
  readonly permissionMode: string | null;
  readonly origin: 'local' | 'remote';
  /** `null` once projects' retention has pruned the file (§9.4). */
  readonly transcriptPath: string | null;
  readonly transcriptBytes: number;
  readonly summary: string | null;
  readonly pinned: boolean;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly exitReason: string | null;
  readonly role: string | null;
  readonly resumedFrom: string | null;
  readonly blockedReason: string | null;
  readonly turns: number;
}

/**
 * The `session_usage` rollup.
 *
 * `costUsdEstimate` carries runner §7.3's rule in its name and the rail carries
 * it in its label: "estimated model cost", never spend, never a percentage of a
 * plan (§4, §9.2).
 */
export interface SessionUsageTotals {
  readonly sessionId: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  readonly totalTokens: number;
  readonly events: number;
  readonly turns: number;
  readonly costUsdEstimate: number | null;
  readonly updatedAt: string;
}

export interface SessionDetailView {
  readonly session: SessionRecord;
  readonly usage: SessionUsageTotals | null;
  readonly queuePosition: number | null;
}

/** One JSONL transcript line (runner §8.1). `seq` is the join key of §9.4. */
export interface TranscriptLine {
  readonly seq: number;
  readonly ts: string;
  readonly type: string;
  readonly [field: string]: unknown;
}

/** `GET /api/sessions/:id/transcript?tail=` | `?from=&limit=` (runner §11.1). */
export interface TranscriptPage {
  readonly sessionId: string;
  readonly lines: readonly TranscriptLine[];
  readonly from: number;
  readonly next: number;
  readonly size: number;
  readonly pruned: boolean;
}

/**
 * What every control verb answers with (runner §11.1).
 *
 * `changed` — not the status code — is what says whether *this* call did it,
 * which is the whole shape of "pressing Stop twice produces a state, not an
 * error" (§9.3, IMPLEMENTATION §4).
 */
export interface SessionControlResult {
  readonly sessionId: string;
  readonly status: SessionStatus;
  readonly exitReason: string | null;
  readonly changed: boolean;
}

// ---------------------------------------------------------------------------
// Orchestrator — assignments and the question inbox (§6, §11)
// ---------------------------------------------------------------------------

/** `POST /api/assignments/solo` → 201 (orchestrator §16.7). */
export interface CreateSoloResult {
  readonly assignmentId: string;
  readonly sessionId: string;
  readonly warnings: readonly { readonly code: string; readonly message: string }[];
}

export type QuestionKind = 'question' | 'approval_gate' | 'budget_halt';
export type QuestionStatus = 'open' | 'answered' | 'cancelled' | 'expired';

/**
 * orchestrator §6.2's four-value ordinal ladder, in rank order.
 *
 * Rendered **as the word**, never as a number, a bar or a percentage (§11.2).
 */
export const QUESTION_STRENGTHS = ['blocking', 'strong', 'lean', 'defer'] as const;
export type QuestionStrength = (typeof QUESTION_STRENGTHS)[number];

export interface QuestionOption {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
}

export interface RecommendationView {
  readonly agentId: string;
  /** The seat this agent held — attribution is always present (§16-2). */
  readonly role: string | null;
  readonly stance: string | null;
  readonly strength: QuestionStrength | null;
  readonly rationale: string | null;
}

/** orchestrator §11.1's pinned list projection — the inbox is one request cold. */
export interface QuestionCard {
  readonly id: string;
  readonly kind: QuestionKind;
  readonly status: QuestionStatus;
  readonly prompt: string;
  readonly options: readonly QuestionOption[];
  readonly multiSelect: boolean;
  readonly allowFreeText: boolean;
  readonly context: { readonly toolName?: string; readonly toolInput?: unknown } | null;
  readonly createdAt: string;
  readonly holdUntil: string | null;
  readonly expiresAt: string | null;
  readonly assignmentId: string;
  readonly projectId: string | null;
  readonly sessionId: string | null;
  readonly recommendations: readonly RecommendationView[];
  /** Server-computed (§6.3). Never derived here (§4, §18 decision 10). */
  readonly disagreement: boolean;
  readonly contested: boolean;
  readonly answeredVia: 'local' | 'remote' | null;
  readonly answeredAt: string | null;
  readonly answer: {
    readonly optionIds?: readonly string[];
    readonly labels?: readonly string[];
    readonly text?: string;
  } | null;
}

export interface QuestionListView {
  readonly questions: readonly QuestionCard[];
}
