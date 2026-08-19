/**
 * What orchestrator needs from the three services it consumes, expressed as the
 * **narrowest** structural types that express it.
 *
 * Foundation §6.1: "Feature modules never import each other […] they talk
 * through the event bus and through service interfaces on the registry." So this
 * file declares the shapes rather than importing `RosterService`,
 * `ProjectsService` or `RunnerService`, and `module.ts` adapts whatever
 * `ctx.require` returns onto them. Three consequences, all wanted:
 *
 * - the orchestrator compiles with runner, roster or projects absent from the
 *   build entirely — which is exactly what `ctx.require` returning `undefined`
 *   is supposed to mean;
 * - a test supplies a plain object literal instead of booting three elements;
 * - **each port names only the methods this milestone calls**, so the day one of
 *   them changes a signature orchestrator does not care about, nothing here
 *   moves.
 *
 * Two of these ports point at surfaces that are still being built, and that is
 * stated rather than hidden:
 *
 * - `SessionLauncher` is runner's `startSession` / `stop` (runner §11.2), which
 *   lands in runner M3. Until then `ctx.require('runner')` returns a service
 *   without them, `hasLauncher()` is false, and `createSolo` refuses with
 *   `runner_unavailable` having written nothing — rather than creating an
 *   assignment that can never run.
 * - `WorkItemLinker` is projects' `linkWorkItems` / `unlinkWorkItems`
 *   (projects §1.5, orchestrator §17 R4), which lands in projects M8. Until then
 *   a request that names no work items is unaffected, and one that names some is
 *   refused rather than silently dropping the link — R4 exists precisely because
 *   a dropped link means a work item that never leaves `open`.
 */
import type { AssignmentRole } from './types.js';

// ---------------------------------------------------------------------------
// roster
// ---------------------------------------------------------------------------

/** The slice of a roster definition §9-5/§9-6 read. */
export interface AgentDefinitionPort {
  readonly id: string;
  readonly name: string;
  readonly capabilities?:
    { readonly overseer?: boolean; readonly roles?: readonly string[] } | undefined;
}

export interface ResolvedAgentPort {
  readonly definition: AgentDefinitionPort;
  readonly archivedAt?: string | null | undefined;
}

/**
 * One agent as `list_roster` (§4.3) returns it — roster §11's projection,
 * structurally.
 *
 * Named here rather than rebuilt: roster exposes `overseerRoster()` **because**
 * the reader is this tool, and its own header says "two implementations of what
 * an overseer may see is one implementation too many". So orchestrator consumes
 * the projection and adds only the two facts roster cannot know — how many open
 * assignments the agent holds, and whether that leaves it available.
 */
export interface OverseerRosterEntryPort {
  readonly id: string;
  readonly name: string;
  readonly specialty: string;
  readonly tagline: string | null;
  readonly tags: readonly string[];
  readonly capabilities: {
    readonly overseer: boolean;
    readonly roles: readonly string[];
  };
}

/**
 * WO4's permission dry-run, as data (roster §9.1's `POST /agents/:id/validate`).
 *
 * Only the field §2.8's unattended preflight reads: which tools would stop and
 * ask a human. `remembered` is roster's Always-allow memory — a gate that is
 * already answered standing is not a gate.
 */
export interface GateLiableToolPort {
  readonly tool: string;
  readonly remembered: boolean;
}

export interface PermissionPreviewPort {
  readonly gateLiable: readonly GateLiableToolPort[];
}

/**
 * WO6's integration-state projection, as data (roster §10).
 *
 * The four states are roster's closed set; orchestrator consumes them and never
 * re-derives one — the whole point of §2.8's preflight is that the *same*
 * projection the Start-work dialog shows a human is what an unattended launch is
 * judged against.
 */
export interface IntegrationStatePort {
  readonly integration: string;
  readonly state: 'ready' | 'needs-auth' | 'missing-secret' | 'not-attached';
  readonly required: boolean;
  readonly detail: string;
}

/** The slice of a WO5 task template §2.8 applies (roster §2.4). */
export interface TaskTemplatePort {
  readonly id: string;
  readonly name: string;
  readonly pattern: 'solo' | 'pair';
  readonly goalTemplate: string;
  readonly artifactPathTemplate?: string | undefined;
  readonly write?: boolean | undefined;
  readonly requiredIntegrations?: readonly string[] | undefined;
  readonly suggestedRoles?: readonly string[] | undefined;
  readonly preGrantTools?: readonly string[] | undefined;
}

/** Roster's in-memory registry, as far as `capabilities` goes. */
export interface RosterPort {
  readonly registry: {
    get(id: string): ResolvedAgentPort | undefined;
    getArchived(id: string): ResolvedAgentPort | undefined;
  };
  /**
   * Roster §11's credential-free projection, present from roster M7.
   *
   * Probed rather than required: without it `list_roster` refuses by name
   * instead of falling back to `registry`, which carries permissions and
   * integrations and must never reach a coordinating agent.
   */
  readonly overseerRoster?: () => readonly OverseerRosterEntryPort[];
  /**
   * §2.8's three reads, all probed rather than required.
   *
   * A build whose roster predates WO4/WO5/WO6 has none of them, and the
   * unattended preflight then **blocks** rather than launching blind — "anything
   * short of green does not launch" reads the absence of the projection as
   * short of green, which is the safe direction and the only one an unattended
   * feature may fail in.
   */
  readonly getTemplate?: (id: string) => { readonly template: TaskTemplatePort };
  readonly validate?: (agentId: string, body: unknown) => Promise<PermissionPreviewPort>;
  readonly integrations?: (
    agentId: string,
    options?: { readonly required?: readonly string[] | undefined },
  ) => Promise<readonly IntegrationStatePort[]>;
}

/** True when this build's roster ships WO4/WO5/WO6's preflight data (§2.8). */
export function hasUnattendedPreflight(
  roster: RosterPort | undefined,
): roster is RosterPort & Required<Pick<RosterPort, 'getTemplate' | 'validate' | 'integrations'>> {
  return (
    typeof roster?.getTemplate === 'function' &&
    typeof roster.validate === 'function' &&
    typeof roster.integrations === 'function'
  );
}

// ---------------------------------------------------------------------------
// projects
// ---------------------------------------------------------------------------

/** The slice of a project row §9-1/§9-2 read. */
export interface ProjectPort {
  readonly id: string;
  readonly status: string;
}

/**
 * Projects' §1.5 work-item linking (R4).
 *
 * Both calls are idempotent and validate that each item belongs to the
 * assignment's project. Orchestrator is the **sole writer** of
 * `work_item_assignments` and never writes a work-item status itself: projects
 * derives the status from these rows.
 */
export interface WorkItemLinker {
  linkWorkItems(assignmentId: string, workItemIds: readonly string[]): Promise<void> | void;
  unlinkWorkItems(assignmentId: string): Promise<void> | void;
  /** One item's project, for §2.3's "an id from another project is refused by name". */
  getWorkItem?(id: string): { readonly id: string; readonly projectId: string } | undefined;
}

export interface ProjectsPort {
  get(id: string): ProjectPort;
  /** Present from projects M8 (R4). Probed, never assumed. */
  readonly linkWorkItems?: WorkItemLinker['linkWorkItems'];
  readonly unlinkWorkItems?: WorkItemLinker['unlinkWorkItems'];
  readonly getWorkItem?: WorkItemLinker['getWorkItem'];
  /**
   * Projects §5's launch context, read for **one** field: the workspace `cwd`
   * that `scope.artifactPath` is relative to (§8.1's `no_progress` breaker
   * compares artifact hashes, and a hash needs the file).
   *
   * Probed rather than required, and a failure is not fatal: an engine that
   * cannot resolve the workspace records no hash, `no_progress` cannot fire, and
   * the round cap remains the outer bound. Orchestrator still never computes an
   * absolute path of its own — it joins projects' `cwd` with the repo-relative
   * path it was given (§2.5).
   */
  readonly getEffectiveLaunchContext?: (
    projectId: string,
    assignmentId: string,
  ) => Promise<{ readonly cwd: string }>;
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

/** `RunnerService.startSession`'s request (runner §11.1/§11.2). */
export interface StartSessionRequest {
  readonly assignmentId: string;
  readonly agentId: string;
  readonly projectId: string;
  readonly prompt: string;
  readonly role?: AssignmentRole | undefined;
  /**
   * Runner §6.2's bands. `background` joined them for WO8: unattended work is
   * admitted only when nothing a human is waiting on is queued.
   */
  readonly priority?: 'interactive' | 'normal' | 'background' | undefined;
}

export interface StartSessionResult {
  readonly sessionId: string;
  readonly status?: string;
  readonly queuePosition?: number;
}

/**
 * The two runner calls M1 makes.
 *
 * `stop` is here because R6 settled the boundary explicitly: orchestrator **may**
 * call `RunnerService.stop()` on sessions of an assignment it is closing, while
 * auto-resume is runner's alone and applies only to sessions runner itself
 * parked with `exit_reason: awaiting_answer`. Orchestrator never resumes.
 */
export interface SessionLauncher {
  startSession(request: StartSessionRequest): Promise<StartSessionResult>;
  stop(sessionId: string, reason: string): Promise<void>;
}

/**
 * §3.2's second row: a seat's **subsequent** turn is `continueFrom`, which mints
 * a new session row with `resumed_from` and resumes that seat's SDK conversation
 * (runner §9.4).
 *
 * It is on `RunnerService` in runner §11.2 but **not yet implemented** — runner's
 * own service file states it is "absent rather than stubbed" until runner M9. So
 * the engine probes for it: with it, round ≥ 2 keeps the skeptic's memory of its
 * own prior critique and the SDK's prompt cache warm; without it, the engine
 * starts a fresh session, records `prev_session_id` on the turn row regardless,
 * and logs the downgrade. What it never does is silently drop the continuation
 * *fact*, because that is what the conversation view and a later `continueFrom`
 * both read.
 */
export interface SessionContinuation {
  continueFrom(previousSessionId: string, prompt: string): Promise<StartSessionResult>;
}

/** The optional transcript read of R3, used to recover a lost live capture (§3.2). */
export interface TranscriptTailReader {
  getTranscriptTail(
    sessionId: string,
    options?: { maxBytes?: number },
  ): Promise<{
    readonly lines: readonly Readonly<Record<string, unknown>>[];
    readonly pruned: boolean;
  }>;
}

export type RunnerPort = Partial<SessionLauncher & SessionContinuation & TranscriptTailReader>;

/** True when this build's runner can actually launch — runner M3 onwards. */
export function hasLauncher(runner: RunnerPort | undefined): runner is SessionLauncher {
  return typeof runner?.startSession === 'function' && typeof runner.stop === 'function';
}

/** True when this build's runner ships §3.2's continuation verb — runner M9 onwards. */
export function hasContinuation(
  runner: RunnerPort | undefined,
): runner is RunnerPort & SessionContinuation {
  return typeof runner?.continueFrom === 'function';
}

/** True when R3's in-process transcript read is available (runner §11.2). */
export function hasTranscriptTail(
  runner: RunnerPort | undefined,
): runner is RunnerPort & TranscriptTailReader {
  return typeof runner?.getTranscriptTail === 'function';
}

/** True when roster ships §11's projection — roster M7 onwards. */
export function hasOverseerRoster(
  roster: RosterPort | undefined,
): roster is RosterPort & { overseerRoster: () => readonly OverseerRosterEntryPort[] } {
  return typeof roster?.overseerRoster === 'function';
}

/** True when this build's projects can link work items — projects M8 onwards. */
export function hasWorkItemLinker(
  projects: ProjectsPort | undefined,
): projects is ProjectsPort & WorkItemLinker {
  return (
    typeof projects?.linkWorkItems === 'function' && typeof projects.unlinkWorkItems === 'function'
  );
}
