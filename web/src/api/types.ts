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

export type HealthStatus = 'ok' | 'degraded' | 'failed' | 'not-started';

/**
 * `id`, not `code` — foundation's `HealthCondition` (`src/modules/types.ts`)
 * calls it "a stable id so it can be tracked across restarts", and the whole
 * point of M10's persistent warnings is that the same warning is recognisable
 * across a reconnect. `web/e2e/boot.test.ts` asserts these names against a real
 * `/api/health`, because a field name the UI guessed is a screen that renders
 * `undefined` in production and nothing in a fixture-fed test.
 */
export interface HealthCondition {
  readonly id: string;
  readonly level: 'warn' | 'error';
  readonly message: string;
}

export interface ModuleHealth {
  readonly id: string;
  readonly status: HealthStatus;
  readonly critical?: boolean;
  readonly message?: string;
  readonly error?: string;
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

/** roster §6's four rungs, least to most permissive. The editor's mode picker. */
export const PERMISSION_MODES = ['plan', 'dontAsk', 'default', 'acceptEdits'] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/** orchestrator §2.3's pinned five. The role checkboxes, and the addenda. */
export const ROLES = ['implementer', 'architect', 'skeptic', 'reviewer', 'overseer'] as const;
export type Role = (typeof ROLES)[number];

/**
 * `roles/<role>.md` per role that has one (roster §4).
 *
 * Distinct from `capabilities.roles`, which says which seats an agent may fill:
 * this is what gets appended to the persona once it is sitting in one. A role
 * can have an addendum without being listed, and be listed without one.
 */
export type RoleAddenda = Readonly<Partial<Record<Role, string>>>;

export interface PermissionSet {
  readonly mode?: PermissionMode;
  /** Auto-approve, never a restriction (roster §6.1) — restriction is `deny`. */
  readonly allow?: readonly string[];
  readonly deny?: readonly string[];
  readonly ask?: readonly string[];
}

export interface ModelSelection {
  readonly primary: string;
  readonly fallback?: string;
  readonly effort?: string;
}

export interface AgentDefinition {
  readonly schemaVersion: number;
  readonly id: string;
  readonly name: string;
  readonly avatar?: Avatar;
  readonly specialty: Specialty;
  readonly tagline?: string;
  readonly tags?: readonly string[];
  /** `mode` is `append` onto Claude Code's preset, or `replace` (roster §5). */
  readonly persona?: { readonly mode: string; readonly file: string };
  readonly model?: ModelSelection;
  readonly permissions?: PermissionSet;
  readonly skills?: { readonly mode: string; readonly names?: readonly string[] };
  readonly integrations?: Readonly<Record<string, unknown>>;
  readonly capabilities?: {
    readonly overseer?: boolean;
    /** The pinned five of orchestrator §2.3; the role picker is limited to these. */
    readonly roles?: readonly string[];
  };
  readonly meta: {
    readonly createdAt: string;
    readonly origin?: string;
    /** roster §9.2 — the "cloned from" line and the shared-credentials note (§7.2). */
    readonly duplicatedFrom?: string | null;
  };
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
  readonly roleAddenda: RoleAddenda;
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

/** projects §1.3's stored override. Never composed here (§4) — roster composes. */
export interface PermissionOverride {
  readonly allow?: readonly string[];
  readonly deny?: readonly string[];
  readonly ask?: readonly string[];
  readonly mode?: string;
}

/**
 * projects §1.4. **The UI renders the name and never the value.**
 *
 * A literal `value` can be in the row, so the type says so honestly — but §8.2
 * pins that env entries are shown "as `secretRef` names with a set/unset
 * indicator, never values", and `envEntryView` below is the only way this record
 * reaches a component.
 */
export type EnvEntry =
  | { readonly name: string; readonly value: string }
  | { readonly name: string; readonly secretRef: string };

export interface ProjectDefaults {
  readonly agentIds?: readonly string[];
  readonly overseerAgentId?: string;
  readonly permissions?: PermissionOverride;
  readonly permissionElevation?: PermissionElevation;
  readonly env?: readonly EnvEntry[];
  readonly setupCommand?: string;
  readonly instructionsPath?: string;
}

/**
 * What §8.2 lets the settings panel see of one env entry.
 *
 * The `value` branch is collapsed to `set: true` **here**, in the type layer, so
 * no component is ever handed the string. That is the difference between a rule
 * and a habit: a future settings field cannot print a value it was never given.
 */
export interface EnvEntryView {
  readonly name: string;
  /** The `secretRef` name, or `null` for a literal stored in the project row. */
  readonly secretRef: string | null;
  /** Whether anything is there at all — the set/unset indicator of §8.2. */
  readonly set: boolean;
}

export function envEntryView(entry: EnvEntry): EnvEntryView {
  if ('secretRef' in entry) {
    return { name: entry.name, secretRef: entry.secretRef, set: entry.secretRef !== '' };
  }
  return { name: entry.name, secretRef: null, set: entry.value !== '' };
}

export interface RetentionSettings {
  readonly transcriptDays: number;
  readonly transcriptCapMb: number;
  readonly keepPinned: boolean;
}

export type WorkspacePolicy = 'auto' | 'shared' | 'worktree';

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
  readonly workspacePolicy: WorkspacePolicy;
  /** `null` = inherit the global retention settings (projects §3.3). */
  readonly retention: RetentionSettings | null;
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

/** `POST /api/projects/inspect { repoUrl }` — the clone form, filled (§8.1). */
export interface RepoInspection {
  readonly repoUrl: string;
  readonly host: string | null;
  readonly name: string;
  readonly slug: string;
  /** `<projectsRoot>\<name>`, canonicalised. */
  readonly targetPath: string;
  readonly targetExists: boolean;
  readonly targetEmpty: boolean;
  readonly warnings: readonly InspectionWarning[];
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

/** orchestrator's `AssignmentPattern`. `solo` is a real pattern, not a special case. */
export type AssignmentPattern = 'solo' | 'pair' | 'review' | 'overseer';

/** orchestrator §11.1's phase vocabulary, rendered **as the word** (§10.2). */
export const ASSIGNMENT_PHASES = [
  'planned',
  'running',
  'awaiting_user',
  'halted',
  'converged',
  'closed',
] as const;
export type AssignmentPhase = (typeof ASSIGNMENT_PHASES)[number];

export interface AssignmentScope {
  readonly paths: readonly string[];
  readonly description?: string;
  readonly artifactPath?: string;
}

/** One seat. `seatOrder` 0 is the lead; the UI never reorders them. */
export interface AssignmentMember {
  readonly agentId: string;
  readonly role: string;
  readonly seatOrder: number;
  readonly joinedAt: string | null;
}

/** `GET /api/assignments/:id` — §10.2's header, exactly as orchestrator returns it. */
export interface AssignmentView {
  readonly id: string;
  readonly projectId: string;
  readonly pattern: AssignmentPattern;
  readonly status: 'open' | 'closed';
  readonly phase: AssignmentPhase;
  readonly goal: string | null;
  readonly scope: AssignmentScope | null;
  readonly write: boolean;
  readonly createdBy: string;
  readonly parentAssignmentId: string | null;
  readonly leadAgentId: string | null;
  readonly artifactPath: string | null;
  /** §10.2: the budget is **tokens**, never money (orchestrator §16.8). */
  readonly tokenBudget: number | null;
  readonly tokensUsed: number;
  readonly roundCap: number | null;
  readonly roundsUsed: number;
  readonly haltReason: string | null;
  readonly closeReason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string | null;
  readonly closedAt: string | null;
  readonly members: readonly AssignmentMember[];
}

export interface AssignmentListView {
  readonly assignments: readonly AssignmentView[];
}

export interface ReportArtifact {
  readonly path: string;
  readonly kind?: string;
}

export interface BlockingIssue {
  readonly severity: string;
  readonly summary: string;
}

/** The critic's verdict — a chip, with the blocking issues as a severity list. */
export interface TurnVerdict {
  readonly decision: 'accept' | 'revise';
  readonly blocking: readonly BlockingIssue[];
  readonly nonBlocking: readonly string[];
}

export interface TurnReport {
  readonly state: 'working' | 'blocked' | 'needs_review' | 'done';
  readonly headline: string;
  readonly detail?: string;
  readonly artifacts: readonly ReportArtifact[];
  readonly verdict?: TurnVerdict;
  readonly at: string;
}

export type TurnStatus =
  'planned' | 'running' | 'reported' | 'unstructured' | 'blocked' | 'failed' | 'orphaned';

/**
 * orchestrator §16.5's delivery ladder.
 *
 * Four values, not three: `undeliverable` is what an `undelivered` message
 * becomes once the assignment is no longer open — the recipient will now never
 * see it. Both render as "never seen by the recipient" (§10.2), because that is
 * what they mean, and the distinction between "not yet" and "never" is carried
 * by the word beside it.
 */
export type MessageDelivery = 'inlined' | 'read' | 'undelivered' | 'undeliverable';

export interface ConversationTurnEntry {
  readonly type: 'turn';
  readonly turnId: string;
  /** `solo` | `drafter` | `critic` — the seat, which is how §10.2 attributes. */
  readonly seat: string;
  readonly agentId: string;
  readonly role: string | null;
  readonly sessionId: string | null;
  readonly status: TurnStatus;
  readonly report: TurnReport | null;
  readonly excerpt: string | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly retryOfTurnId: string | null;
}

export interface ConversationMessageEntry {
  readonly type: 'message';
  readonly messageId: string;
  readonly from: string | null;
  /** `null` is a broadcast. */
  readonly to: string | null;
  readonly kind: string;
  readonly body: string | null;
  readonly delivery: MessageDelivery;
  readonly createdAt: string;
}

export interface ConversationQuestionEntry {
  readonly type: 'question';
  readonly questionId: string;
  readonly kind: string;
  readonly prompt: string;
  readonly recommendations: readonly RecommendationView[];
  readonly disagreement: boolean;
  readonly contested: boolean;
  readonly answer: {
    readonly optionIds?: readonly string[];
    readonly labels?: readonly string[];
    readonly text?: string;
  } | null;
  readonly createdAt: string;
}

export type ConversationEntry =
  ConversationTurnEntry | ConversationMessageEntry | ConversationQuestionEntry;

export interface ConversationRound {
  readonly round: number;
  readonly entries: readonly ConversationEntry[];
}

/** `GET /api/assignments/:id/conversation` — "the ordering is the server's" (§10.1). */
export interface ConversationView {
  readonly assignmentId: string;
  readonly pattern: string;
  readonly phase: AssignmentPhase;
  readonly status: string;
  readonly artifactPath: string | null;
  readonly roundsUsed: number;
  readonly roundCap: number | null;
  readonly tokensUsed: number;
  readonly tokenBudget: number | null;
  readonly closeReason: string | null;
  readonly haltReason: string | null;
  readonly rounds: readonly ConversationRound[];
}

/** `GET /api/patterns` (orchestrator §16.9) — what drives §10.4's dialog. */
export interface SeatDefinition {
  readonly key: string;
  readonly roles: readonly string[];
  readonly required: boolean;
  readonly preferredTier?: ModelTier;
  readonly write: boolean;
}

export interface SeatCandidate {
  readonly agentId: string;
  readonly name: string;
  readonly roles: readonly string[];
  /** §10.4: "showing each one's model tier and current open-assignment count". */
  readonly openAssignments: number;
  readonly available: boolean;
}

export interface PatternSummary {
  readonly id: string;
  readonly driver: 'none' | 'sequential';
  readonly seats: readonly SeatDefinition[];
  readonly requires: {
    readonly artifactPath: boolean;
    readonly roundCap: boolean;
    readonly tokenBudget: boolean;
  };
  readonly defaults: { readonly roundCap: number | null; readonly tokenBudget: number | null };
  readonly maxRoundCap: number | null;
  readonly cardSeatOrder: readonly string[];
  readonly candidates?: Readonly<Record<string, readonly SeatCandidate[]>>;
}

export interface PatternListView {
  readonly patterns: readonly PatternSummary[];
}

export interface AssignmentWarning {
  readonly code: string;
  readonly message: string;
}

/** §10.4: a returned `gate` must never leave an "it's running" impression. */
export interface GateSpec {
  readonly reason: string;
  readonly questionId?: string;
}

/** `POST /api/assignments` → 201. Note `assignmentId`, not `id`. */
export interface CreateAssignmentResult {
  readonly assignmentId: string;
  readonly status: 'open' | 'closed';
  readonly phase: AssignmentPhase;
  readonly warnings: readonly AssignmentWarning[];
  readonly gate?: GateSpec;
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

/** `GET /api/orchestrator/status` (orchestrator §11.3) — the fleet view. */
export interface AgentStatus {
  readonly agentId: string;
  readonly state: FleetState;
  readonly assignmentId: string | null;
  readonly sessionId: string | null;
  readonly projectId: string | null;
  readonly role: string | null;
  readonly headline: string | null;
  readonly since: string | null;
}

export interface FleetStatus {
  readonly agents: readonly AgentStatus[];
  readonly assignments: {
    readonly open: number;
    readonly halted: number;
    readonly awaitingUser: number;
  };
  /** §2.2's badge count, and the number the Electron tray mirrors (§1.5 #6). */
  readonly questions: { readonly open: number; readonly oldestOpenedAt: string | null };
}

// ---------------------------------------------------------------------------
// Projects — the project page (§8.2)
// ---------------------------------------------------------------------------

/** projects §3.1's derived projection. **Read, never derived here** (§4). */
export type AssignmentOutcome = 'running' | 'completed' | 'stopped' | 'failed';

export interface ActivitySession {
  readonly id: string;
  readonly agentId: string;
  readonly status: SessionStatus;
  /** `transcript_path IS NOT NULL` — `false` renders "transcript pruned" (§8.2). */
  readonly transcriptAvailable: boolean;
  readonly summary: string | null;
  readonly pinned: boolean;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
}

export type WorkspaceKind = 'primary' | 'worktree';

export interface ProjectActivityEntry {
  readonly assignmentId: string;
  readonly workItemIds: readonly string[];
  readonly agentIds: readonly string[];
  /** `null` for a solo assignment (projects §3.1). */
  readonly pattern: string | null;
  readonly scopeSummary: string | null;
  readonly workspace: {
    readonly kind: WorkspaceKind;
    readonly path: string;
    readonly branch: string | null;
  } | null;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly outcome: AssignmentOutcome;
  readonly tokens: { readonly input: number; readonly output: number };
  readonly sessions: readonly ActivitySession[];
}

export interface ProjectActivityPage {
  readonly entries: readonly ProjectActivityEntry[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

export type WorkItemKind = 'bug' | 'feature' | 'chore' | 'question';
export const WORK_ITEM_KINDS = ['bug', 'feature', 'chore', 'question'] as const;
export type WorkItemStatus = 'open' | 'in_progress' | 'done' | 'dropped';

/** projects §1.5's deliberately thin backlog entry: no priority, no assignee. */
export interface WorkItem {
  readonly id: string;
  readonly projectId: string;
  readonly kind: WorkItemKind;
  readonly title: string;
  readonly body: string;
  readonly status: WorkItemStatus;
  readonly rank: number;
  readonly scopePaths: readonly string[];
  readonly source: 'user' | 'overseer';
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly closedAt: string | null;
}

export interface WorkItemListView {
  readonly workItems: readonly WorkItem[];
}

/** projects §4.4's "review needed" state. Derived on read, never stored. */
export interface WorkspaceReview {
  readonly commits: number;
  readonly dirty: boolean;
  readonly present: boolean;
}

export interface WorkspaceListEntry {
  readonly id: string;
  readonly projectId: string;
  readonly assignmentId: string;
  readonly kind: WorkspaceKind;
  readonly path: string;
  readonly branch: string | null;
  readonly baseCommit: string | null;
  readonly write: boolean;
  readonly state: 'active' | 'released' | 'orphaned';
  readonly acquiredAt: string;
  readonly releasedAt: string | null;
  readonly scopePaths: readonly string[];
  /** Present for a retained worktree — the loudest thing on the page (§8.2). */
  readonly review?: WorkspaceReview;
}

export interface WorkspaceListView {
  readonly workspaces: readonly WorkspaceListEntry[];
}

/** `GET /api/sessions?agentId=` — the agent detail page's history (§7.3). */
export interface SessionListView {
  readonly sessions: readonly SessionRecord[];
  readonly next: string | null;
}

// ---------------------------------------------------------------------------
// Runner — the usage view (§12)
// ---------------------------------------------------------------------------

/**
 * `GET /api/runner/usage` (runner §7.4).
 *
 * Every number here is **AgentManager's own** metering. There is no plan total
 * in the payload, and §12 forbids inventing one: no percentage, no ring, no
 * "remaining". The `disclaimer` is the API's own string and is shown in full.
 */
export interface UsageWindow {
  readonly since: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly sessions: number;
}

export interface RunnerUsage {
  readonly own: {
    readonly window5h: UsageWindow;
    readonly window7d: UsageWindow;
    /** runner §7.4's honesty label, rendered as the panel's provenance line. */
    readonly source: string;
  };
  readonly rateLimit: {
    readonly state: 'ok' | 'cooling';
    readonly lastHitAt: string | null;
    readonly resetsAt: string | null;
    readonly source: string;
  };
  readonly disclaimer: string;
}

/** `GET /api/runner/queue` — `blockedReason` on the wire (SQL calls it otherwise). */
export interface QueueEntry {
  readonly sessionId: string;
  readonly assignmentId: string;
  readonly agentId: string;
  readonly projectId: string;
  readonly status: 'running' | 'queued';
  readonly priority: 'interactive' | 'normal';
  readonly weight: number;
  readonly queuedAt: string | null;
  readonly blockedReason: string | null;
  /** 1-based, `null` for a running session. */
  readonly position: number | null;
}

export interface RunnerQueue {
  readonly running: number;
  readonly queued: number;
  readonly blocked: number;
  readonly capacity: number;
  readonly usedWeight: number;
  readonly cooling: boolean;
  readonly coolingUntil: string | null;
  readonly entries: readonly QueueEntry[];
}

/** runner §6.1: the cap is clamped to this range, server-side and here. */
export const CAPACITY_MIN = 1;
export const CAPACITY_MAX = 8;

// ---------------------------------------------------------------------------
// Remote — settings §13.2, and the parity rules of §13.4
// ---------------------------------------------------------------------------

/**
 * One row of `GET /api/remote/status`'s `deniedRemotely` (remote §12.7).
 *
 * §13.4: the denied set is "read from the deny list enumerated in
 * `GET /api/remote/status`, **not hardcoded**, so a future denial greys the
 * right control automatically". Every disabled control in settings matches
 * itself against this list by method and path.
 */
export interface DenyListEntry {
  readonly method: string;
  readonly path: string;
  readonly source: 'declared' | 'backstop';
  readonly reason: string;
  readonly conditional: boolean;
}

export interface RemoteStatus {
  readonly state: 'waiting' | 'binding' | 'listening' | 'down';
  readonly enabled: boolean;
  readonly boundAddress: { readonly address: string; readonly port: number } | null;
  readonly port: number;
  readonly magicDnsName: string | null;
  /** Tailscale's **own** state string — §13.2 renders it verbatim. */
  readonly tailscaleState: string | null;
  readonly lastError: string | null;
  readonly recentBindFailures: number;
  readonly detectionSource: 'cli' | 'interface' | null;
  readonly mode: string;
  /**
   * The origin a phone opens, assembled by the core (remote §4.2): this socket when the phone
   * reaches it directly, `remote.publicUrl` when a proxy fronts it. Rendered verbatim — the UI
   * never rebuilds it from `magicDnsName` and `port`, which are wrong behind a proxy.
   */
  readonly clientUrl: string | null;
  readonly activeTokenCount: number;
  readonly deniedRemotely: readonly DenyListEntry[];
  readonly backstopPatterns: readonly {
    readonly methods: readonly string[];
    readonly pattern: string;
  }[];
}

/** A device token as the list returns it — **never** the token itself (§13.2). */
export interface RemoteTokenView {
  readonly id: string;
  readonly label: string;
  readonly device: string | null;
  readonly prefix: string;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  readonly lastUsedPeer: string | null;
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
  readonly expired: boolean;
}

export interface RemoteTokenListView {
  readonly tokens: readonly RemoteTokenView[];
}

/** `POST /api/remote/tokens` → 201. The **only** time `token` ever exists. */
export interface MintedToken {
  readonly id: string;
  readonly label: string;
  readonly device: string | null;
  readonly token: string;
  readonly prefix: string;
  readonly createdAt: string;
  readonly expiresAt: string | null;
  /** `http://<magicdns>:<port>/#t=<token>` — what the QR encodes (§3.2). */
  readonly qrUrl: string | null;
}

/** `GET /api/remote/agents` — `expiresAt` is required, never optional (§13.2). */
export interface RemoteGrantView {
  readonly agentId: string;
  readonly agentName: string | null;
  readonly enabled: boolean;
  readonly grantedAt: string;
  readonly expiresAt: string;
  readonly grantedVia: 'local' | 'remote';
  readonly tokenId: string | null;
}

export interface RemoteAgentListView {
  readonly agents: readonly RemoteGrantView[];
}

/** remote §4.4: a credential that expires silently is worse than one that does not. */
export const TOKEN_EXPIRY_BANNER_DAYS = 14;

// ---------------------------------------------------------------------------
// Logs (§13.3)
// ---------------------------------------------------------------------------

export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface LogRecord {
  readonly ts: string;
  readonly level: LogLevel;
  readonly component?: string;
  readonly msg?: string;
  readonly sessionId?: string;
  readonly requestId?: string;
}

export interface LogsView {
  readonly records: readonly LogRecord[];
  readonly count: number;
  readonly source: 'ring' | 'files';
  readonly level: LogLevel;
  readonly ringSize: number;
  readonly ringCapacity: number;
}

// ---------------------------------------------------------------------------
// Roster — the wizard and the editor (§7)
// ---------------------------------------------------------------------------

export const MODEL_TIERS = ['fast', 'balanced', 'max'] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

export const PERSONA_MODES = ['append', 'replace'] as const;
export type PersonaMode = (typeof PERSONA_MODES)[number];

export interface SuggestedSkill {
  readonly name: string;
  readonly description: string;
}

export interface SuggestedIntegration {
  readonly name: string;
  readonly why: string;
  /** A placeholder ref, never a credential (roster §12.2, §10). */
  readonly secretRef?: string;
}

/** roster §12.3's `draft`: "an `agent.json`-shaped object, minus id/meta". */
export interface AgentDraft {
  readonly schemaVersion?: number;
  readonly name?: string;
  readonly avatar?: { readonly kind: 'emoji'; readonly value: string };
  readonly specialty?: string;
  readonly tagline?: string;
  readonly tags?: readonly string[];
  readonly persona?: { readonly mode: string; readonly file: string };
  readonly model?: {
    readonly primary: string;
    readonly fallback?: string;
    readonly effort?: string;
  };
  readonly permissions?: {
    readonly mode?: string;
    readonly allow?: readonly string[];
    readonly deny?: readonly string[];
    readonly ask?: readonly string[];
  };
  readonly capabilities?: { readonly overseer: boolean; readonly roles: readonly string[] };
}

/** `POST /api/roster/draft` → roster §12.3, verbatim in field names. */
export interface DraftResponse {
  readonly draft: AgentDraft;
  /** The markdown body — `persona.md`, which the wizard posts as `personaText`. */
  readonly persona: string;
  /** Per-field-group prose, shown beside each section (§7.1). */
  readonly rationale: Readonly<Record<string, string>>;
  readonly suggestedSkills: readonly SuggestedSkill[];
  readonly suggestedIntegrations: readonly SuggestedIntegration[];
  readonly warnings: readonly string[];
  /** "Claude couldn't finish this draft" — every partial field stays editable. */
  readonly degraded: boolean;
  readonly attempts?: number;
}

/** `DELETE /api/roster/agents/:id[?purge=true]` (roster §9.1). */
export interface RemoveAgentResult {
  readonly agentId: string;
  /** Where it went, or `null` when it was purged outright. */
  readonly archivedAt: string | null;
  readonly purged: boolean;
}
