/**
 * `RosterService` — the object the routes call and the object other elements
 * reach through `ctx.require('roster')` (roster DESIGN §9, IMPLEMENTATION M3).
 *
 * Everything the API can do goes through here, and three rules hold across all
 * of it:
 *
 * 1. **Reads are served from memory, writes go to the files.** §2.3. A read
 *    never touches the disk, so `GET /agents` is a map iteration; a write goes
 *    through the store's atomic path and *then* updates the map. The library is
 *    the truth, the registry is the current reading of it, and there is no third
 *    copy anywhere.
 * 2. **Every mutation ends in the same three steps.** Update the registry,
 *    reconcile `agent_ui_state`, push the projection into foundation's `agents`
 *    index and emit `roster.changed` — see {@link RosterService.reload} and the
 *    private `settle` below. A path that changed a definition without pushing
 *    the index would leave every other element's joins looking at a roster that
 *    no longer exists (§2.2), and there is exactly one place that can happen.
 * 3. **A secret value never leaves here.** Nothing in this file resolves a
 *    `secretRef`; definitions are returned as stored, which is refs only (§10).
 *    Resolution happens once, at launch, in M4/M6's compiler.
 *
 * ## `roster.changed` and what gets persisted
 *
 * §9.1 broadcasts on "any registry mutation, including external file edits", and
 * foundation's bus persists what it is told to (§6.5). The rule here: a change
 * to a **definition** is persisted, because it is part of the audit trail the UI
 * replays after a reconnect and because it is something a human did to the
 * roster. A change to **`agent_ui_state`** is not — dragging a card is not
 * history, and persisting it would put a row in `events` per drag, which is the
 * very cost §2.2 moved board order out of git to avoid.
 */
import { Secret, type SecretResolver } from '../../secrets/index.js';
import type { AgentsRepository, SessionsRepository } from '../../storage/index.js';
import { isoTimestamp, type Clock } from '../../storage/time.js';
import type { EventBus } from '../types.js';

import {
  initialsAvatarFor,
  placeholderAvatar,
  sniffImageType,
  type AvatarImage,
  type AvatarUpload,
} from './avatar.js';
import { compileSession } from './compileSession.js';
import {
  CONNECTOR_SCHEMA_VERSION,
  connectorLookup,
  createConnectorRegistry,
  createConnectorStore,
  parseConnector,
  type Connector,
  type ConnectorRegistryChange,
  type ConnectorStore,
} from './connectors.js';
import type { Diagnostic, EffectivePermissions } from './contracts.js';
import {
  draftFromDescription,
  draftRequestSchema,
  type DraftQueryFn,
  type DraftResponse,
} from './draft.js';
import { projectRosterForOverseer, type OverseerRosterEntry } from './overseer.js';
import type { PermissionPolicy, RawPermissionSet } from './permissions.js';
import { gateLiableTools, type GateLiableTool } from './preflight.js';
import {
  SessionCompileError,
  type CompileSessionInput,
  type CompiledSession,
  type ProjectContext,
  type SessionToolsetProvider,
} from './sessionOptions.js';
import { duplicateAgentId, duplicateDefinition } from './duplicate.js';
import { RosterValidationError, issuesFromZod } from './errors.js';
import { agentIdProblem } from './ids.js';
import {
  integrationCredentialStatus,
  integrationPreflight,
  mcpToolPrefix,
  type ConnectorLookup,
  type IntegrationCredentialStatus,
  type IntegrationPreflight,
} from './integrations.js';
import {
  PACK_EXTENSION,
  buildAgentPack,
  inlineConnectorRefs,
  packFilename,
  readAgentPack,
  type RequiredSecret,
} from './pack.js';
import { parseAgentDefinition, serialiseAgentDefinition } from './parse.js';
import {
  AGENT_SCHEMA_VERSION,
  ROLES,
  connectorIdProblem,
  immutableFieldViolations,
  isConnectorRef,
  permissionRuleSchema,
  type AgentDefinition,
  type IntegrationConfig,
  type Role,
} from './schema.js';
import { normaliseAllowRules } from './sdkRules.js';
import {
  AgentArchivedError,
  AgentIdTakenError,
  AgentNotFoundError,
  ConnectorIdTakenError,
  ConnectorInUseError,
  ConnectorNotFoundError,
  ImmutableFieldError,
  InvalidRosterRequestError,
  PackUnresolvedConnectorError,
  PurgeBlockedError,
  RosterServiceError,
  TemplateNotFoundError,
  UnknownBoardOrderIdError,
} from './serviceErrors.js';
import { SKILLS_DIRNAME, validateSkills } from './skills.js';
import {
  createTemplateRegistry,
  createTemplateStore,
  missingIntegrations,
  templateVariables,
  type TaskTemplate,
  type TemplateIntegrationGap,
  type TemplateRegistryChange,
  type TemplateStore,
  type TemplateVariable,
} from './templates.js';
import { mintAgentId } from './slug.js';
import {
  AGENT_JSON_FILENAME,
  AVATAR_FILENAME,
  type ResolvedAgent,
  type RoleAddendaPatch,
  type RosterStore,
} from './store.js';
import type { RoleAddenda } from './roleAddenda.js';
import { createRosterRegistry, type RegistryChange, type RosterRegistry } from './registry.js';
import type { AgentUiState, AgentUiStateRepository } from './uiState.js';

// ---------------------------------------------------------------------------
// What the API returns
// ---------------------------------------------------------------------------

/**
 * One agent, as every endpoint returns it.
 *
 * Note what is absent: the agent's folder. §3.2 — "the API never returns
 * filesystem paths to the browser, only `/api/roster/agents/:id/avatar`" — and
 * the same reasoning covers the persona file, the skills folder and the plugin
 * manifest. The server knows where they are; the browser has an id.
 */
export interface AgentView {
  readonly definition: AgentDefinition;
  /** `persona.md`, resolved (§9.1: "full definition + resolved persona text"). */
  readonly persona: string;
  /**
   * `roles/<role>.md` per role that has one (§4) — the second system-prompt
   * slot, resolved for the same reason the persona is: the editor round-trips
   * these bodies, and a role with no addendum simply has no key.
   */
  readonly roleAddenda: RoleAddenda;
  readonly uiState: AgentUiState;
  readonly diagnostics: readonly Diagnostic[];
  /** Non-null for an agent read out of `.archive/` (§9.3). */
  readonly archivedAt: string | null;
  /** Always usable: the endpoint generates a placeholder when there is no file. */
  readonly avatarUrl: string;
  /**
   * `{ secretRef, resolved }` per credential the agent's integrations reference
   * (§10) — **never a value**. Present only on the endpoints that resolve it
   * (`GET /agents`, `GET /agents/:id`), because probing the secret store is
   * asynchronous and the rest of the service is not.
   */
  readonly credentials?: readonly IntegrationCredentialStatus[] | undefined;
  /**
   * The UI-facing badge field of §10: "so the UI can show a 'needs credential'
   * badge on the card". Present exactly when {@link AgentView.credentials} is.
   */
  readonly needsCredentials?: boolean | undefined;
  /**
   * §10's preflight projection (WO6): one row per declared integration, with
   * `ready` / `needs-auth` / `missing-secret` and the same `{ secretRef,
   * resolved }` block scoped to that server.
   *
   * Carried on the two endpoints that already resolve credentials, so Start-work
   * gets every seated agent's connector state from the roster read it was making
   * anyway rather than from N extra requests. `not-attached` never appears here
   * — it is a fact about a *task*, not about an agent, and needs the required
   * list only {@link RosterService.integrations} is given.
   */
  readonly integrations?: readonly IntegrationPreflight[] | undefined;
}

/** `GET /agents` — "list; includes `uiState` and any `diagnostics`" (§9.1). */
export interface RosterListView {
  readonly agents: readonly AgentView[];
  /** Library-wide, including agents that failed to load and so are not listed. */
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * `POST /agents/:id/validate` (§9.1) — the launch flow's permission preview.
 *
 * The field names are the ui's: its one accessor reads `effective` and
 * `diagnostics` and nothing else (`web/src/launch/permissionPreview.ts`), so
 * those two are the contract and everything beside them is additive.
 *
 * §9.1's reason for the endpoint, restated because it is the whole design:
 * "before launching, show the user the *effective* permission set for this agent
 * on this project, including any elevation. Permission composition that the user
 * cannot see is permission composition they will not trust."
 */
export interface ValidateResult {
  readonly agentId: string;
  readonly projectId: string | null;
  /** Exactly what the runner would receive for this pair (§6.2, §13). */
  readonly effective: EffectivePermissions;
  readonly diagnostics: readonly Diagnostic[];
  /** The elevation the project *declared*, whether or not it was applied — the
   *  banner half of ui §6, which must never be silently dropped. */
  readonly declaredElevation: { readonly allow: readonly string[]; readonly reason: string } | null;
  /** Foundation's `policy.allowPermissionElevation`, so the preview can say why
   *  a declared elevation was not applied (work edition). */
  readonly allowPermissionElevation: boolean;
  /** True when the assignment layer was assumed rather than supplied — a
   *  preview is not a launch and there is no assignment yet. */
  readonly assumedWriteAccess: boolean;
  /**
   * The tools this pair would stop and ask about at runtime (§6.3, WO4 §1).
   *
   * Additive, and derived entirely from `effective` plus the compiled policy —
   * a caller that ignores it sees exactly the response it saw before. It exists
   * because `effective` answers "what rules apply" and a start dialog needs
   * "what will interrupt me", and re-deriving the second from the first on the
   * client would put a copy of §6.1's evaluation order in the browser.
   */
  readonly gateLiable: readonly GateLiableTool[];
}

/** `GET /agents/:id/export` — the bytes and the name to offer them under (§9.4). */
export interface ExportedPack {
  readonly agentId: string;
  readonly filename: string;
  readonly bytes: Buffer;
}

/**
 * `POST /import` without `?commit=true` (§9.4).
 *
 * Everything the owner needs in order to decide, and nothing written: "Import is
 * two-phase: `POST /import` returns a preview (proposed id, collisions, missing
 * secrets, unknown schema fields, skills being added) and `?commit=true` writes
 * it."
 */
export interface ImportPreview {
  /** False on a preview, true on the response to `?commit=true`. */
  readonly committed: boolean;
  /** The id in the pack. */
  readonly sourceId: string;
  /** Where it would land — the source id, or a suffixed one on a collision. */
  readonly proposedId: string;
  /** True when `sourceId` is already taken, live or archived (§9.3). */
  readonly collision: boolean;
  readonly name: string;
  readonly specialty: string;
  readonly packVersion: number;
  readonly schemaVersion: number;
  readonly exportedAt: string;
  /** §9.4's manifest, with each ref's presence in *this* machine's store. */
  readonly requiredSecrets: readonly (RequiredSecret & { readonly resolved: boolean })[];
  /** The subset of the above that this machine cannot resolve — what the owner
   *  must supply before the agent will launch (§10). */
  readonly missingSecrets: readonly string[];
  /** `skills/<name>/` folders the import would add (§7.1). */
  readonly skills: readonly string[];
  /** Every file the import would write, relative to the agent folder. */
  readonly files: readonly string[];
  readonly warnings: readonly string[];
}

/** `POST /import?commit=true` — the preview that was acted on, plus the agent. */
export interface ImportResult extends ImportPreview {
  readonly committed: true;
  readonly agent: AgentView;
}

/** What `DELETE /agents/:id` answers with. */
/** What {@link RosterService.allowRule} did, and to what. */
export interface AllowRuleResult {
  readonly agent: AgentView;
  /** The rule as stored — byte for byte the one the caller asked for. */
  readonly rule: string;
  /** `false` when the agent already allowed it: a no-op success, not a failure. */
  readonly added: boolean;
}

export interface DeleteResult {
  readonly agentId: string;
  /** Where it went, or `null` when it was purged outright. */
  readonly archivedAt: string | null;
  readonly purged: boolean;
}

/** Why `roster.changed` fired. Carried on the event so the UI can be selective. */
export type RosterChangeReason =
  | 'created'
  | 'updated'
  | 'duplicated'
  | 'archived'
  | 'purged'
  | 'imported'
  | 'avatar'
  | 'ui-state'
  | 'board-order'
  | 'external'
  | 'loaded'
  /** A file under `templates/` changed (§2.4, WO5) — no agent did. */
  | 'templates'
  /** A file under `connectors/` changed (§10.3, WO3) — no agent did, though
   *  every agent that references one now compiles differently. */
  | 'connectors';

// ---------------------------------------------------------------------------
// Task templates (§2.4, WO5)
// ---------------------------------------------------------------------------

/**
 * One template as `GET /api/roster/templates` returns it.
 *
 * Two derived fields ride beside the stored document, and neither is something
 * the browser should be computing:
 *
 * - **`variables`** is which of `{{slug}}` / `{{source}}` this template's own
 *   text mentions, which is what decides whether the dialog renders the one
 *   extra input. Scanning for placeholders in the client would be a second
 *   implementation of the substitution rule.
 * - **`integrationGaps`** is WO5's "agent X lacks connector Y", answered for
 *   *every live agent* at once. Per-agent rather than per-selection because the
 *   selection changes with every tick and a request per keystroke would be a
 *   poll; the whole roster is a handful of rows, and the dialog looks up the
 *   agents it has seated. Templates that require nothing produce an empty list.
 */
export interface TaskTemplateView {
  readonly template: TaskTemplate;
  readonly variables: readonly TemplateVariable[];
  readonly integrationGaps: readonly TemplateIntegrationGap[];
}

export interface TaskTemplateListView {
  readonly templates: readonly TaskTemplateView[];
  /** Malformed `template.json`s, through the same channel a malformed
   *  `agent.json` reaches the board by (§2.3). */
  readonly diagnostics: readonly Diagnostic[];
}

// ---------------------------------------------------------------------------
// The connector library (§10.3, WO3)
// ---------------------------------------------------------------------------

/**
 * One credential a connector needs, as the API returns it.
 *
 * `{ secretRef, resolved }` and **nothing else** — §10's rule, unchanged by the
 * connector living in the library rather than in an agent: the name of the key,
 * whether this machine holds it, and no field a value could ever travel in.
 */
export interface ConnectorCredentialStatus {
  readonly secretRef: string;
  readonly resolved: boolean;
}

/**
 * One connector as `GET /api/roster/connectors` returns it.
 *
 * The stored document is deliberately *not* spread in wholesale: what the page
 * needs is the identity, the shape of the server, and two derived facts it
 * cannot honestly compute itself —
 *
 * - **`credentials`**, which needs the secret store (§10, foundation §3.2);
 * - **`usedBy`**, the agent ids that reference this connector. It is the same
 *   answer `DELETE` refuses on, computed in one place: a page that showed "used
 *   by nobody" beside a delete that then 409s would be a page nobody trusts.
 */
export interface ConnectorView {
  readonly id: string;
  readonly label?: string | undefined;
  readonly description?: string | undefined;
  readonly transport: 'stdio' | 'sse' | 'http';
  /** `mcp__<id>__` — what a permission rule for an agent that attaches this
   *  connector under its default name starts with (§10). */
  readonly toolPrefix: string;
  /** How it authorises: `oauth`, `credentials` (env/headers), or `none`. */
  readonly auth: 'oauth' | 'credentials' | 'none';
  readonly credentials: readonly ConnectorCredentialStatus[];
  /** Live agent ids carrying `{ connector: "<id>" }`, sorted. */
  readonly usedBy: readonly string[];
  readonly config: IntegrationConfig;
  readonly meta: Connector['meta'];
}

export interface ConnectorListView {
  readonly connectors: readonly ConnectorView[];
  /** Malformed `connector.json`s, through the same channel a malformed
   *  `agent.json` reaches the board by (§2.3). */
  readonly diagnostics: readonly Diagnostic[];
}

/** What `DELETE /connectors/:id` answers with. */
export interface DeleteConnectorResult {
  readonly connectorId: string;
  readonly removed: boolean;
}

export interface RosterService {
  list(): RosterListView;
  /** Live or archived — §9.3 keeps an archived definition readable for display. */
  get(id: string): AgentView;
  /**
   * {@link RosterService.get} plus §10's `{ secretRef, resolved }` block.
   *
   * Separate, and asynchronous, because resolving a reference means asking
   * foundation's secret store and the rest of this service is synchronous by
   * design (§2.3: reads are a map iteration). Nothing here reveals a value — the
   * probe answers a boolean and drops the `Secret`.
   */
  getWithCredentials(id: string): Promise<AgentView>;
  /** {@link RosterService.list} with the same block on every agent — the board
   *  is where §10's "needs credential" badge is shown. */
  listWithCredentials(): Promise<RosterListView>;
  /** The block on its own. */
  credentials(id: string): Promise<readonly IntegrationCredentialStatus[]>;
  /**
   * §10's preflight projection (WO6) — what Start-work renders as chips.
   *
   * `required` is the task's `requiredIntegrations`; a name in it that the agent
   * does not declare comes back as `not-attached`, which is the one state this
   * call can answer and {@link AgentView.integrations} cannot.
   */
  integrations(
    id: string,
    options?: { readonly required?: readonly string[] | undefined },
  ): Promise<readonly IntegrationPreflight[]>;
  /**
   * Remember what a session's `system/init` said about this agent's MCP servers.
   *
   * The only positive evidence an OAuth connector is authorised. The CLI owns
   * that grant and caches it privately under `CLAUDE_CONFIG_DIR`; roster does
   * not read it — a parser for an undocumented file that holds plaintext access
   * tokens would be a third `.reveal()`-equivalent site in all but name
   * (foundation §3.2). So the memory is what a session *reported*, held in
   * process and forgotten on restart, which is why the preflight's OAuth default
   * is "unknown" rather than "broken".
   */
  noteMcpStatus(
    agentId: string,
    servers: readonly { readonly name: string; readonly status: string }[],
  ): void;
  create(body: unknown): AgentView;
  patch(id: string, body: unknown): AgentView;
  /**
   * `POST /agents/:id/permissions/allow` (§6) — append one rule to
   * `permissions.allow`.
   *
   * The narrow write behind the question card's **Always allow** (runner DESIGN
   * §5.1, owner decision 2026-08-18). Runner never widens a live session's
   * permissions — `updatedPermissions` is set nowhere — so "remember this" is
   * expressed as *an explicit roster edit*, which keeps §6.2's "the only
   * composer" true. The edit goes through {@link RosterService.patch}, so the
   * rule is validated, persisted, hashed and announced by exactly the code path
   * the agent editor uses, and the rule shows up in the editor afterwards.
   *
   * **Idempotent.** Appending a rule the agent already allows is a success that
   * writes nothing and emits nothing — a user who taps the card twice, or two
   * clients answering the same card, must not produce a duplicate rule or a
   * second `roster.changed`.
   */
  allowRule(id: string, body: unknown): AllowRuleResult;
  duplicate(id: string, body: unknown): AgentView;
  remove(id: string, options?: { readonly purge?: boolean }): DeleteResult;
  /**
   * `GET /agents/:id/export` (§9.4) — the agent folder as a `.agentpack`.
   *
   * Refuses rather than redacts when the folder holds a credential value: a pack
   * carries refs, and an export that quietly dropped a key would produce an
   * agent that imports cleanly and then fails at launch for no visible reason.
   */
  exportPack(id: string): ExportedPack;
  /**
   * `POST /import` (§9.4) — preview, or write.
   *
   * Asynchronous because the preview reports which of the pack's
   * `requiredSecrets` this machine can resolve, and that is a question for
   * foundation's secret store. Nothing is revealed: the probe answers a boolean,
   * exactly as {@link RosterService.credentials} does.
   */
  importPack(bytes: unknown, options?: { readonly commit?: boolean }): Promise<ImportPreview>;
  setBoardOrder(order: unknown): RosterListView;
  patchUiState(id: string, body: unknown): AgentView;
  putAvatar(id: string, upload: AvatarUpload): AgentView;
  deleteAvatar(id: string): AgentView;
  /** The stored image, or a generated placeholder (§3.2). Never fails for a
   *  known agent. */
  avatarImage(id: string): AvatarImage;
  /**
   * The boot load: reads the library and publishes it, whether or not anything
   * differs from an empty registry.
   *
   * Distinct from {@link RosterService.reload} in exactly two ways, both
   * deliberate. It always pushes the index — a restart is the moment to rebuild
   * a `agents` table that drifted (§2.2) — and its `roster.changed` is not
   * persisted, because "the service started" is not roster history and would
   * otherwise write one event row per agent per boot.
   */
  load(): RegistryChange;
  /** Rereads the whole library — the watcher's filename-less case. */
  reload(): RegistryChange;
  /** Rereads named folders — the watcher's normal case. */
  reloadFolders(folders: readonly string[]): RegistryChange;
  /**
   * `GET /api/roster/templates` (§2.4, WO5) — every task template, with its
   * variables and its per-agent connector gaps.
   */
  listTemplates(): TaskTemplateListView;
  /** `GET /api/roster/templates/:id`. Throws {@link TemplateNotFoundError}. */
  getTemplate(id: string): TaskTemplateView;
  /** Rereads `templates/` — the templates watcher's filename-less case. */
  reloadTemplates(): TemplateRegistryChange;
  /** Rereads named template folders — the templates watcher's normal case. */
  reloadTemplateFolders(folders: readonly string[]): TemplateRegistryChange;
  /**
   * `GET /api/roster/connectors` (§10.3, WO3) — the library, with each entry's
   * credential status and the agents that reference it.
   *
   * Asynchronous for {@link RosterService.credentials}'s reason and no other:
   * `{ secretRef, resolved }` is a question for foundation's secret store, and
   * the probe answers a boolean without revealing anything.
   */
  listConnectors(): Promise<ConnectorListView>;
  /** `GET /api/roster/connectors/:id`. Throws {@link ConnectorNotFoundError}. */
  getConnector(id: string): Promise<ConnectorView>;
  /** `POST /api/roster/connectors` — the id is derived from the label when
   *  absent, and collision-suffixed exactly as an agent's is (§9.1). */
  createConnector(body: unknown): Promise<ConnectorView>;
  /** `PATCH /api/roster/connectors/:id`; `id` is immutable — it is the folder
   *  name and the thing every referencing agent joins on. */
  patchConnector(id: string, body: unknown): Promise<ConnectorView>;
  /** `DELETE /api/roster/connectors/:id`. Refused while any agent references
   *  it ({@link ConnectorInUseError}). */
  removeConnector(id: string): DeleteConnectorResult;
  /** Agent ids carrying `{ connector: "<id>" }`, sorted. The one answer behind
   *  both the view's `usedBy` and the delete refusal. */
  connectorUsedBy(id: string): readonly string[];
  /**
   * Everything wrong under `connectors/`, without the credential probe.
   *
   * Separate from {@link RosterService.listConnectors} because the module's
   * health check is synchronous and has no business asking the secret store
   * whether an agent could launch — it wants to know whether a file in the
   * library will not parse.
   */
  connectorDiagnostics(): readonly Diagnostic[];
  /**
   * The library as the compiler consumes it (§10.3).
   *
   * Published so the module can bind `compileSession` to it, the same way it
   * binds the orchestration toolset — the compiler is a pure function and does
   * not reach into the service registry.
   */
  readonly connectors: ConnectorLookup;
  /** Rereads `connectors/` — the connectors watcher's filename-less case. */
  reloadConnectors(): ConnectorRegistryChange;
  /** Rereads named connector folders — the watcher's normal case. */
  reloadConnectorFolders(folders: readonly string[]): ConnectorRegistryChange;
  /**
   * `POST /draft` (§12, M8) — draft-from-description.
   *
   * Stateless: nothing is written, nothing is cached, and no id is minted. The
   * wizard edits what comes back and saves it through {@link RosterService.create}
   * like any other agent.
   */
  draft(body: unknown): Promise<DraftResponse>;
  /** `POST /agents/:id/validate` (§9.1) — the dry-run compile behind the launch
   *  flow's permission preview. */
  validate(id: string, body: unknown): Promise<ValidateResult>;
  /**
   * §11's read-only roster projection: "names, specialties, tags, capabilities —
   * never permissions or integrations".
   *
   * Exposed on the service because the reader is orchestrator's `list_roster`
   * tool, which reaches roster through `ctx.require('roster')` and must not have
   * to build the projection itself — two implementations of "what an overseer
   * may see" is one implementation too many.
   */
  overseerRoster(): readonly OverseerRosterEntry[];
  /** The in-memory registry, for M4's compiler and the module's health check. */
  readonly registry: RosterRegistry;
  /** Diagnostics raised by bootstrap, which precede the registry itself. */
  readonly bootDiagnostics: readonly Diagnostic[];
}

export interface RosterServiceOptions {
  readonly store: RosterStore;
  /** §2.4's `templates/` store. Defaults to one over the same library root —
   *  injectable only so a test can point the two halves at different trees. */
  readonly templates?: TemplateStore;
  /** §10.3's `connectors/` store, on the same terms. */
  readonly connectors?: ConnectorStore;
  readonly uiState: AgentUiStateRepository;
  /** Foundation's rebuildable index — roster pushes, never reads (§2.2). */
  readonly agents: AgentsRepository;
  /** The purge guard of §9.3: `countByAgent` decides whether history exists. */
  readonly sessions: Pick<SessionsRepository, 'countByAgent'>;
  readonly bus: EventBus;
  readonly clock?: Clock;
  /** Raised before the service existed (a git that would not run, §2.1). */
  readonly bootDiagnostics?: readonly Diagnostic[];
  /**
   * Foundation's read-only secret face (§3.2), used for one thing only: turning
   * a `secretRef` into the boolean §10's badge needs. Absent in a build without
   * secrets, in which case every ref reports `resolved: false` — which is the
   * honest answer, since nothing can resolve it.
   */
  readonly secrets?: SecretResolver;
  /**
   * Foundation's `policy` namespace (§6.2's two out-of-band inputs).
   *
   * Needed by `POST /agents/:id/validate`, which must compose exactly what the
   * runner would — and the runner is given the same namespace. Defaults to the
   * permissive pair so a test harness that does not care need not state it.
   */
  readonly policy?: PermissionPolicy;
  /**
   * The projects service, structurally, resolved lazily.
   *
   * Lazily because module init order puts projects after roster, and
   * structurally because feature modules never import each other (foundation
   * §6.1). Absent — or throwing, which is how projects reports an unknown id —
   * means the preview composes the roster baseline alone and says so.
   */
  readonly projects?: () => ProjectDefaultsProvider | undefined;
  /** §13's orchestration row, so the preview shows the §11 grant the launch
   *  will actually carry. */
  readonly toolset?: SessionToolsetProvider | undefined;
  /** §12's one `query()` call. Absent in a build with no SDK wired, in which
   *  case `POST /draft` refuses rather than pretending. */
  readonly draftQuery?: DraftQueryFn | undefined;
  readonly log?: (message: string, detail?: Record<string, unknown>) => void;
}

/**
 * As much of projects' service as the permission preview reads (§9.1).
 *
 * `get` throws `ProjectNotFoundError` for an unknown id — projects' own
 * behaviour, caught here and turned into roster's typed 404 rather than a 500.
 */
export interface ProjectDefaultsProvider {
  get(projectId: string): {
    readonly id: string;
    readonly localPath?: string | undefined;
    readonly defaults?:
      | {
          readonly permissions?: RawPermissionSet | undefined;
          readonly permissionElevation?:
            { readonly allow: readonly string[]; readonly reason: string } | undefined;
        }
      | undefined;
  };
}

/** The permissive pair, matching foundation's own config defaults. */
const OPEN_POLICY: PermissionPolicy = { allowPermissionElevation: true, globalDeny: [] };

/**
 * `compileSession` for the **preview**, with a launch refusal turned into a
 * refusal of the request.
 *
 * The one refusal a preview can still hit is §10.3's dangling connector
 * reference: `previewSecrets` already stops a missing credential from failing a
 * dry run, but a ref with nothing behind it leaves the compiler with no server
 * to emit and no honest way to guess one. That is a 409 naming the problem —
 * the same status a purge blocked by history gets — rather than the flat 500 an
 * escaped `SessionCompileError` would answer with, because the owner can fix it
 * and the message says how.
 */
async function compilePreview(input: CompileSessionInput): Promise<CompiledSession> {
  try {
    return await compileSession(input);
  } catch (error) {
    if (error instanceof SessionCompileError) {
      throw new RosterServiceError('session_compile_failed', error.message, 409, {
        agentId: input.agent.definition.id,
      });
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------

export function createRosterService(options: RosterServiceOptions): RosterService {
  const { store, uiState, agents, sessions, bus } = options;
  const clock: Clock = options.clock ?? ((): Date => new Date());
  const registry = createRosterRegistry(store);
  // §2.4's second index, built the same way over `templates/`. It is a sibling
  // of the agent registry rather than part of it: a template is not an agent,
  // nothing joins the two, and folding them together would make every listing
  // and every diagnostic have to say which kind it meant.
  const templateStore = options.templates ?? createTemplateStore({ root: store.paths.root });
  const templates = createTemplateRegistry(templateStore);
  // §10.3's third index, built the same way over `connectors/`. A connector is
  // not an agent and not a template — nothing joins the first two, and what
  // joins an agent to the third is a reference the compiler resolves, never a
  // merge of the two indexes.
  const connectorStore = options.connectors ?? createConnectorStore({ root: store.paths.root });
  const connectorRegistry = createConnectorRegistry(connectorStore);
  const lookupConnector = connectorLookup(connectorRegistry);

  /**
   * agentId → server name → the status the last session reported (WO6).
   *
   * In process and unpersisted on purpose. It is a *cache of observations*, and
   * a stale row survived across a restart would be worse than no row: an OAuth
   * grant can be revoked from the other end at any time, so "we saw it connect
   * last Tuesday" is not evidence about today. Losing it on restart costs one
   * cautious `needs-auth` chip, which is the direction §10 wants to be wrong in.
   */
  const lastSeenMcp = new Map<string, Map<string, string>>();

  // -------------------------------------------------------------------------
  // The three steps every mutation ends with
  // -------------------------------------------------------------------------

  /** Foundation's index row for one agent (§2.2, foundation §1.4). */
  function projection(agent: ResolvedAgent, indexedAt: string) {
    return {
      id: agent.definition.id,
      name: agent.definition.name,
      specialty: agent.definition.specialty,
      model: agent.definition.model?.primary ?? null,
      isOverseer: agent.definition.capabilities?.overseer ?? false,
      archivedAt: agent.archivedAt,
      sourcePath: agent.dir,
      contentHash: agent.contentHash,
      indexedAt,
    };
  }

  /**
   * Publishes the current registry: `agent_ui_state` rows, foundation's index,
   * and `roster.changed`.
   *
   * The index is replaced wholesale rather than patched per agent. Foundation's
   * `replaceAll` is one transaction precisely so the index is never half-rebuilt
   * (§1.4), and a full rebuild also repairs an index that drifted — which is the
   * documented remedy: "If the index and the files disagree, the index is wrong
   * and is rebuilt" (§2.2).
   */
  function settle(reason: RosterChangeReason, agentIds: readonly string[]): void {
    const live = registry.list();
    const indexedAt = isoTimestamp(clock());

    uiState.reconcile(
      live.map((agent) => agent.definition.id),
      (id) => registry.knows(id) && registry.getArchived(id) === undefined,
    );

    agents.replaceAll([
      ...live.map((agent) => projection(agent, indexedAt)),
      ...registry.listArchived().map((agent) => projection(agent, indexedAt)),
    ]);

    bus.emit({
      type: 'roster.changed',
      ...(agentIds.length === 1 && agentIds[0] !== undefined
        ? { ids: { agentId: agentIds[0] } }
        : {}),
      // A definition changed: audit-trail material the UI replays after a
      // reconnect. Board order, pinning and "we just booted" did not, and are
      // not.
      persist: reason !== 'ui-state' && reason !== 'board-order' && reason !== 'loaded',
      payload: { reason, agentIds: [...agentIds], count: live.length },
    });
  }

  /**
   * `roster.changed`, for a change under `templates/` (§2.4, WO5).
   *
   * Deliberately *not* {@link settle}: no agent moved, so reconciling
   * `agent_ui_state` and rewriting foundation's whole `agents` index would be
   * work with no cause, and a `roster.changed` claiming `agentIds` nobody
   * touched would be a lie the UI acts on. The event is the same *type* because
   * the ui's invalidation map already keys the `roster.*` prefix onto the
   * library's queries (ui §3.4) — one edit to a library file, one refetch.
   *
   * Not persisted: a template edit is a file on disk the board re-reads, and the
   * event log is the audit trail of what *happened to agents*, not a change feed
   * for the filesystem.
   */
  function announceTemplates(): void {
    bus.emit({
      type: 'roster.changed',
      persist: false,
      payload: {
        reason: 'templates' satisfies RosterChangeReason,
        agentIds: [],
        count: registry.list().length,
      },
    });
  }

  /**
   * `roster.changed`, for a change under `connectors/` (§10.3, WO3).
   *
   * The template announcement's twin, and deliberately the same *type* for the
   * same reason: the ui's invalidation map keys the `roster.*` prefix onto the
   * library's queries (ui §3.4), so one edit to a library file means one
   * refetch — and a connector edit really does change what every referencing
   * agent would launch with, which is exactly the sort of thing the board
   * should not be showing a stale copy of.
   *
   * Not {@link settle}: no agent moved, so reconciling `agent_ui_state` and
   * rewriting foundation's `agents` index would be work with no cause, and an
   * event claiming `agentIds` nobody touched would be a lie the UI acts on.
   */
  function announceConnectors(): void {
    bus.emit({
      type: 'roster.changed',
      persist: false,
      payload: {
        reason: 'connectors' satisfies RosterChangeReason,
        agentIds: [],
        count: registry.list().length,
      },
    });
  }

  // -------------------------------------------------------------------------
  // Views
  // -------------------------------------------------------------------------

  /**
   * One template, plus the two things the dialog cannot honestly derive itself.
   *
   * The gaps are computed against the **live** registry only: an archived agent
   * cannot be seated (§5.2), so a warning about its connectors would be advice
   * about a launch nobody can make.
   */
  function templateViewOf(template: TaskTemplate): TaskTemplateView {
    const required = template.requiredIntegrations;
    const gaps: TemplateIntegrationGap[] = [];
    if (required !== undefined && required.length > 0) {
      for (const agent of registry.list()) {
        const missing = missingIntegrations(
          required,
          Object.keys(agent.definition.integrations ?? {}),
        );
        if (missing.length > 0) {
          gaps.push({
            agentId: agent.definition.id,
            agentName: agent.definition.name,
            missing,
          });
        }
      }
    }
    return { template, variables: templateVariables(template), integrationGaps: gaps };
  }

  /**
   * Live agents carrying `{ connector: "<id>" }`, sorted (§10.3).
   *
   * Live only, for `templateViewOf`'s reason: an archived agent cannot be
   * launched, so counting it would refuse a delete on the strength of a
   * reference nothing can act on. An *inline* config that happens to describe
   * the same server is not a reference and does not count — nothing about it
   * breaks when the library entry goes.
   */
  function usedByAgents(connectorId: string): string[] {
    const out: string[] = [];
    for (const agent of registry.list()) {
      const attachments = Object.values(agent.definition.integrations ?? {});
      if (
        attachments.some(
          (attachment) => isConnectorRef(attachment) && attachment.connector === connectorId,
        )
      ) {
        out.push(agent.definition.id);
      }
    }
    return out.sort();
  }

  /**
   * One connector, plus the two facts the page cannot derive itself.
   *
   * The credential probe goes through `integrationCredentialStatus` — the same
   * function the agent endpoints use, handed a one-entry record — rather than a
   * second walker over `env`/`headers`. §10's "never a value" is a property of
   * that function, and a second implementation of it is a second thing to get
   * wrong.
   */
  async function connectorViewOf(connector: Connector): Promise<ConnectorView> {
    const credentials = await integrationCredentialStatus(
      { integrations: { [connector.id]: connector.config } },
      options.secrets ?? { get: () => Promise.resolve(undefined) },
    );
    const oauth = connector.config.transport !== 'stdio' && connector.config.auth === 'oauth';
    return {
      id: connector.id,
      ...(connector.label === undefined ? {} : { label: connector.label }),
      ...(connector.description === undefined ? {} : { description: connector.description }),
      transport: connector.config.transport,
      toolPrefix: mcpToolPrefix(connector.id),
      auth: oauth ? 'oauth' : credentials.length > 0 ? 'credentials' : 'none',
      // Names and booleans only: the richer `{ integration, kind, key, path }`
      // block the agent endpoints carry describes an *attachment*, and a library
      // entry has none until an agent makes one.
      credentials: credentials.map((credential) => ({
        secretRef: credential.secretRef,
        resolved: credential.resolved,
      })),
      usedBy: usedByAgents(connector.id),
      config: connector.config,
      meta: connector.meta,
    };
  }

  /** The live connector, or the reason there is not one. */
  function requireConnector(id: string): Connector {
    const found = connectorRegistry.get(id);
    if (found === undefined) throw new ConnectorNotFoundError(id);
    return found.connector;
  }

  function viewOf(agent: ResolvedAgent): AgentView {
    const id = agent.definition.id;
    return {
      definition: agent.definition,
      persona: agent.persona,
      roleAddenda: agent.roleAddenda,
      uiState: uiState.get(id) ?? {
        agentId: id,
        // An archived agent has no board row by design; the view still has to
        // answer, so it reports the neutral position rather than omitting it.
        boardOrder: 0,
        pinned: false,
        lastUsedAt: null,
      },
      diagnostics: agent.diagnostics,
      archivedAt: agent.archivedAt,
      avatarUrl: `/api/roster/agents/${encodeURIComponent(id)}/avatar`,
    };
  }

  /** The live agent, or the reason there is not one. */
  function requireLive(id: string): ResolvedAgent {
    const agent = registry.get(id);
    if (agent !== undefined) return agent;
    const archived = registry.getArchived(id);
    if (archived !== undefined) {
      throw new AgentArchivedError(id, archived.archivedAt ?? 'an earlier time');
    }
    throw new AgentNotFoundError(id);
  }

  function requireKnown(id: string): ResolvedAgent {
    const agent = registry.get(id) ?? registry.getArchived(id);
    if (agent === undefined) throw new AgentNotFoundError(id);
    return agent;
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  /**
   * §7.2's exact-name check, at write time.
   *
   * M5: "`skills.mode: "declared"` with a name that has no folder is rejected at
   * write time with a message naming the missing folder — **not at launch**."
   * The SDK throws before the process starts when it is handed a skill name it
   * cannot find, and a launch failure is the worst possible moment to discover a
   * typo in a definition the API was in a position to refuse.
   *
   * This is the API's gate only. A folder that arrives by hand-edit or `git
   * pull` cannot be refused — there is nobody to refuse — so the store turns the
   * same check into a diagnostic and the compiler drops the name at launch.
   */
  function requireSkillFolders(definition: AgentDefinition, source: string): void {
    const diagnostics = validateSkills(
      definition,
      store.skillNames(definition.id),
      store.agentDir(definition.id),
    );
    if (diagnostics.length === 0) return;
    throw new RosterValidationError(
      `agent "${definition.id}" declares ${String(diagnostics.length)} skill(s) with no folder`,
      diagnostics.map((diagnostic) => ({ path: 'skills.names', message: diagnostic.message })),
      source,
    );
  }

  /**
   * Writes `skills/<name>/SKILL.md` for each accepted suggestion (§12.4).
   *
   * Folder first, `agent.json` second — the same order `duplicate` and the pack
   * importer use, and required here because {@link requireSkillFolders} reads the
   * folder listing and would refuse a name whose folder does not exist yet.
   */
  function writeSkillStubs(id: string, skills: readonly AcceptedSkill[]): void {
    if (skills.length === 0) return;
    store.writeFolderFiles(
      id,
      skills.map((skill) => ({
        name: `${SKILLS_DIRNAME}/${skill.name}/SKILL.md`,
        data: Buffer.from(skillStub(skill), 'utf8'),
      })),
    );
  }

  function persist(
    definition: AgentDefinition,
    persona: string | undefined,
    roleAddenda?: RoleAddendaPatch,
  ): ResolvedAgent {
    let written = store.write(definition, persona);
    // After `write`, never as part of it: `agent.json` is what makes a folder an
    // agent, so the folder has to exist before there is a `roles/` inside it.
    // The second read is the price of the addenda being in the content hash, and
    // it is only paid when a request actually carries them.
    if (roleAddenda !== undefined && Object.keys(roleAddenda).length > 0) {
      written = store.writeRoleAddenda(definition.id, roleAddenda);
    }
    registry.apply(written);
    return written;
  }

  const service: RosterService = {
    registry,
    bootDiagnostics: options.bootDiagnostics ?? [],

    list() {
      const order = new Map(uiState.list().map((row, index) => [row.agentId, index]));
      const agents = registry
        .list()
        .map(viewOf)
        .sort((a, b) => {
          const left = order.get(a.definition.id) ?? Number.MAX_SAFE_INTEGER;
          const right = order.get(b.definition.id) ?? Number.MAX_SAFE_INTEGER;
          if (left !== right) return left - right;
          return a.definition.id < b.definition.id ? -1 : 1;
        });
      return { agents, diagnostics: [...service.bootDiagnostics, ...registry.diagnostics()] };
    },

    get: (id) => viewOf(requireKnown(id)),

    async credentials(id) {
      const agent = requireKnown(id);
      if (options.secrets === undefined) {
        // No store to ask: report every ref as unresolved rather than as
        // resolved-by-default. A badge that is wrong in the reassuring direction
        // is worse than one that is wrong in the alarming direction.
        return integrationCredentialStatus(
          agent.definition,
          { get: () => Promise.resolve(undefined) },
          lookupConnector,
        );
      }
      // §10.3: a referenced connector's credentials are this agent's, because
      // they are what its launch will resolve.
      return integrationCredentialStatus(agent.definition, options.secrets, lookupConnector);
    },

    async integrations(id, integrationOptions = {}) {
      const agent = requireKnown(id);
      return integrationPreflight({
        definition: agent.definition,
        // The same "no store means nothing resolves" stance `credentials` takes:
        // a badge that is wrong in the reassuring direction is the worse error.
        secrets: options.secrets ?? { get: () => Promise.resolve(undefined) },
        connectors: lookupConnector,
        ...(integrationOptions.required === undefined
          ? {}
          : { required: integrationOptions.required }),
        lastSeen: Object.fromEntries(lastSeenMcp.get(id) ?? new Map<string, string>()),
      });
    },

    noteMcpStatus(agentId, servers) {
      if (servers.length === 0) return;
      const seen = lastSeenMcp.get(agentId) ?? new Map<string, string>();
      for (const server of servers) seen.set(server.name, server.status);
      lastSeenMcp.set(agentId, seen);
    },

    async listWithCredentials() {
      const view = service.list();
      const agents = await Promise.all(
        view.agents.map(async (agent) => {
          const credentials = await service.credentials(agent.definition.id);
          return {
            ...agent,
            credentials,
            needsCredentials: credentials.some((credential) => !credential.resolved),
            integrations: await service.integrations(agent.definition.id),
          };
        }),
      );
      return { ...view, agents };
    },

    async getWithCredentials(id) {
      const view = viewOf(requireKnown(id));
      const credentials = await service.credentials(id);
      return {
        ...view,
        credentials,
        needsCredentials: credentials.some((credential) => !credential.resolved),
        integrations: await service.integrations(id),
      };
    },

    create(body) {
      const { record, personaText, roleAddenda, acceptedSkills } = splitBody(body);
      const now = isoTimestamp(clock());

      const requestedId = record['id'];
      let id: string;
      if (requestedId !== undefined) {
        if (typeof requestedId !== 'string') {
          throw new InvalidRosterRequestError('"id" must be a string.', 'id');
        }
        const problem = agentIdProblem(requestedId);
        if (problem !== undefined) throw new InvalidRosterRequestError(problem, 'id');
        if (registry.knows(requestedId)) throw new AgentIdTakenError(requestedId);
        id = requestedId;
      } else {
        const name = record['name'];
        if (typeof name !== 'string' || name.trim().length === 0) {
          throw new InvalidRosterRequestError(
            'A "name" is required; the agent id is derived from it.',
            'name',
          );
        }
        const minted = mintAgentId(name, (candidate) => registry.knows(candidate));
        if (minted === undefined) {
          throw new RosterServiceError(
            'agent_id_exhausted',
            `No free agent id could be derived from "${name}"; give the agent a different name.`,
            409,
            { name },
          );
        }
        id = minted;
      }

      const meta = asRecord(record['meta']) ?? {};
      const definition = parseAgentDefinition(
        {
          ...record,
          schemaVersion: AGENT_SCHEMA_VERSION,
          id,
          meta: { duplicatedFrom: null, origin: 'manual', ...meta, createdAt: now, updatedAt: now },
        },
        'POST /api/roster/agents',
      );

      // DESIGN §12.4: "`suggestedSkills` are inert until accepted. Accepting one
      // creates `skills/<name>/SKILL.md` with the description as a stub and adds
      // the name to `skills.names`; the user (or a later agent session) writes
      // the body." The wizard cannot write files (ui §4), and the folder must
      // exist before `requireSkillFolders` reads it — so the stubs are written
      // here, from a wire-only field, in the same request that declares them.
      writeSkillStubs(id, acceptedSkills);

      requireSkillFolders(definition, 'POST /api/roster/agents');

      // An empty `persona.md` rather than none: the definition names the file
      // (§3), and a definition pointing at a file that is not there loads with a
      // warning for something the API just created.
      const written = persist(definition, personaText ?? '', roleAddenda);
      uiState.ensure(id);
      settle('created', [id]);
      return viewOf(written);
    },

    patch(id, body) {
      const existing = requireLive(id);
      const { record, personaText, roleAddenda } = splitBody(body);

      if (record['id'] !== undefined && record['id'] !== id) {
        throw new ImmutableFieldError(['id']);
      }

      const merged: Record<string, unknown> = { ...existing.definition };
      for (const [key, value] of Object.entries(record)) {
        if (key === 'id' || key === 'meta') continue;
        // `null` clears an optional field; an absent key leaves it alone. Without
        // the distinction there is no way to remove a tagline once it is set.
        if (value === null) delete merged[key];
        else merged[key] = value;
      }

      const patchMeta = asRecord(record['meta']) ?? {};
      merged['meta'] = {
        ...existing.definition.meta,
        ...patchMeta,
        updatedAt: isoTimestamp(clock()),
      };

      const next = parseAgentDefinition(merged, `PATCH /api/roster/agents/${id}`);
      const violations = immutableFieldViolations(existing.definition, next);
      if (violations.length > 0) throw new ImmutableFieldError(violations);
      requireSkillFolders(next, `PATCH /api/roster/agents/${id}`);

      const written = persist(next, personaText, roleAddenda);
      settle('updated', [id]);
      return viewOf(written);
    },

    allowRule(id, body) {
      const existing = requireLive(id);
      const rule = readAllowRule(body);
      const permissions = existing.definition.permissions ?? {};
      const allow = permissions.allow ?? [];

      // Idempotent by identity, not by "would match the same calls": two rules
      // that overlap are still two decisions the owner made, and collapsing them
      // is a normalisation nobody asked this route to perform.
      if (allow.includes(rule)) {
        return { agent: viewOf(existing), rule, added: false };
      }

      // Straight through `patch`: the same validation, the same atomic write,
      // the same content hash, the same `roster.changed`. A second write path
      // for one field is how the editor and the card start disagreeing about
      // what a saved agent looks like.
      const agent = service.patch(id, {
        permissions: { ...permissions, allow: [...allow, rule] },
      });
      return { agent, rule, added: true };
    },

    duplicate(id, body) {
      const source = requireLive(id);
      const record = asRecord(body) ?? {};
      const name = record['name'];
      if (name !== undefined && typeof name !== 'string') {
        throw new InvalidRosterRequestError('"name" must be a string.', 'name');
      }

      const cloneId = duplicateAgentId({
        sourceId: id,
        ...(name === undefined ? {} : { name }),
        taken: (candidate) => registry.knows(candidate),
      });
      if (cloneId === undefined) {
        throw new RosterServiceError(
          'agent_id_exhausted',
          `No free agent id could be derived from "${id}"; give the duplicate a name.`,
          409,
          { agentId: id },
        );
      }

      // The folder first, header second: the copy carries persona, roles, skills
      // and avatar (§9.2), and the write that follows only rewrites `agent.json`
      // and regenerates the plugin manifest under the new id.
      store.copyFolder(id, cloneId);
      const definition = duplicateDefinition(source.definition, {
        id: cloneId,
        ...(name === undefined ? {} : { name }),
        now: clock(),
      });
      const written = persist(definition, undefined);
      uiState.ensure(cloneId);
      settle('duplicated', [cloneId]);
      return viewOf(written);
    },

    remove(id, removeOptions = {}) {
      const known = requireKnown(id);

      if (removeOptions.purge === true) {
        const references = sessions.countByAgent(id);
        if (references > 0) throw new PurgeBlockedError(id, references);
        store.purge(id);
        registry.forget(id);
        registry.refreshArchive();
        uiState.delete(id);
        settle('purged', [id]);
        return { agentId: id, archivedAt: null, purged: true };
      }

      if (known.archivedAt !== null) {
        // Already archived: `DELETE` twice is the same request twice, and the
        // second one has nothing left to do.
        return { agentId: id, archivedAt: known.archivedAt, purged: false };
      }

      const entry = store.archive(id);
      registry.forget(id);
      registry.refreshArchive();
      uiState.delete(id);
      settle('archived', [id]);
      return { agentId: id, archivedAt: entry.archivedAt, purged: false };
    },

    exportPack(id) {
      // Archived agents export too: §9.3 keeps them readable "for display", and
      // an owner who archived an agent by mistake reaching for its pack is a
      // better outcome than one who cannot get it back at all.
      const agent = requireKnown(id);
      // §10.3: the pack inlines its connectors, so what ships is the resolved
      // definition — and the `agent.json` *inside* the pack is rewritten from
      // it, or the folder's copy would still carry the reference the manifest
      // says was inlined.
      const inlined = inlineConnectorRefs(agent.definition, lookupConnector);
      if (inlined.dangling.length > 0) throw new PackUnresolvedConnectorError(id, inlined.dangling);
      const files = store
        .readFolderFiles(agent.dir)
        .map((file) =>
          file.name === AGENT_JSON_FILENAME
            ? { name: file.name, data: Buffer.from(serialiseAgentDefinition(inlined.definition)) }
            : file,
        );
      const bytes = buildAgentPack({
        definition: inlined.definition,
        files,
        exportedAt: isoTimestamp(clock()),
      });
      return { agentId: id, filename: packFilename(id), bytes };
    },

    async importPack(bytes, importOptions = {}) {
      if (!Buffer.isBuffer(bytes)) {
        throw new InvalidRosterRequestError(
          `Send the ${PACK_EXTENSION} as the request body, or as a multipart/form-data file part.`,
        );
      }
      const pack = readAgentPack(bytes);
      const source = pack.definition;

      // §9.4: "On id collision the importer picks a new id and rewrites nothing
      // else." `registry.knows` covers archived ids too, because §9.3 never
      // reuses one; the folder check catches an id whose definition is currently
      // unloadable and so is not in the registry at all.
      const taken = (candidate: string): boolean =>
        registry.knows(candidate) || store.hasFolder(candidate);
      const collision = taken(source.id);
      let proposedId = source.id;
      if (collision) {
        const minted = duplicateAgentId({ sourceId: source.id, taken });
        if (minted === undefined) {
          throw new RosterServiceError(
            'agent_id_exhausted',
            `No free agent id could be derived from "${source.id}"; rename or archive the agent ` +
              'that already holds it before importing.',
            409,
            { agentId: source.id },
          );
        }
        proposedId = minted;
      }

      const probe = options.secrets;
      const requiredSecrets = await Promise.all(
        pack.manifest.requiredSecrets.map(async (secret) => ({
          ...secret,
          resolved: probe === undefined ? false : (await probe.get(secret.ref)) !== undefined,
        })),
      );
      const missingSecrets = requiredSecrets
        .filter((secret) => !secret.resolved)
        .map((secret) => secret.ref);

      const warnings: string[] = [];
      if (collision) {
        warnings.push(
          `Agent id "${source.id}" is already in use; the import will land as "${proposedId}".`,
        );
      }
      if (missingSecrets.length > 0) {
        warnings.push(
          `This agent needs ${String(missingSecrets.length)} credential(s) that are not in this ` +
            `machine's secret store: ${missingSecrets.join(', ')}. It will import, and refuse to ` +
            'launch until they are supplied (DESIGN §10).',
        );
      }

      const preview: ImportPreview = {
        committed: false,
        sourceId: source.id,
        proposedId,
        collision,
        name: source.name,
        specialty: source.specialty,
        packVersion: pack.manifest.packVersion,
        schemaVersion: pack.manifest.schemaVersion,
        exportedAt: pack.manifest.exportedAt,
        requiredSecrets,
        missingSecrets,
        skills: pack.skills,
        files: pack.files.map((file) => file.name),
        warnings,
      };

      // Phase one ends here, having touched nothing: "Preview lists collisions,
      // missing secrets, and skills to be added, and **writes nothing**" (M9).
      if (importOptions.commit !== true) return preview;

      // The folder first, `agent.json` second — the same order duplicate uses
      // (§9.2), and for the same reason: `store.write` reads the folder back and
      // validates the skill names against it, so the skills have to be there.
      const now = isoTimestamp(clock());
      store.writeFolderFiles(
        proposedId,
        pack.files.filter((file) => file.name !== AGENT_JSON_FILENAME),
      );
      const definition: AgentDefinition = {
        ...source,
        id: proposedId,
        // §9.4: the id and the provenance are what an import rewrites, and
        // nothing else — "the importer picks a new id and rewrites nothing
        // else". `duplicatedFrom` is cleared because the clone link is a link
        // into *this* library, and the pack's source is not in it.
        meta: {
          ...source.meta,
          createdAt: now,
          updatedAt: now,
          origin: 'imported',
          duplicatedFrom: null,
        },
      };
      const written = persist(definition, undefined);
      uiState.ensure(proposedId);
      settle('imported', [proposedId]);

      return { ...preview, committed: true, agent: viewOf(written) } satisfies ImportResult;
    },

    setBoardOrder(order) {
      if (!Array.isArray(order) || order.some((id) => typeof id !== 'string')) {
        throw new InvalidRosterRequestError(
          'Send the whole board as {"order": ["agent-id", …]}; a partial reorder is not a thing (DESIGN §9.5).',
          'order',
        );
      }
      const ids = order as string[];
      const seen = new Set<string>();
      const duplicates = ids.filter((id) => {
        if (seen.has(id)) return true;
        seen.add(id);
        return false;
      });
      if (duplicates.length > 0) {
        throw new InvalidRosterRequestError(
          `Board order lists ${duplicates[0] ?? ''} more than once.`,
          'order',
        );
      }
      const unknown = ids.filter((id) => registry.get(id) === undefined);
      // Validated in full before the transaction opens, which is what "an
      // unknown agent id is a 400 and leaves the previous order intact" means.
      if (unknown.length > 0) throw new UnknownBoardOrderIdError(unknown);

      uiState.setBoardOrder(ids);
      settle('board-order', ids);
      return service.list();
    },

    patchUiState(id, body) {
      const agent = requireLive(id);
      const record = asRecord(body);
      if (record === undefined) {
        throw new InvalidRosterRequestError('Send {"pinned": true|false}.', 'pinned');
      }
      const pinned = record['pinned'];
      if (pinned !== undefined && typeof pinned !== 'boolean') {
        throw new InvalidRosterRequestError('"pinned" must be true or false.', 'pinned');
      }
      if (pinned === undefined) {
        throw new InvalidRosterRequestError('Nothing to change; send {"pinned": …}.', 'pinned');
      }

      uiState.patch(id, { pinned });
      settle('ui-state', [id]);
      return viewOf(agent);
    },

    putAvatar(id, upload) {
      const existing = requireLive(id);
      // Bytes first: if the definition update fails validation, the file that
      // was written is the one the definition is about to name anyway.
      store.writeAvatar(id, upload.bytes);
      const definition: AgentDefinition = {
        ...existing.definition,
        avatar: { kind: 'file', value: AVATAR_FILENAME },
        meta: { ...existing.definition.meta, updatedAt: isoTimestamp(clock()) },
      };
      const written = persist(definition, undefined);
      settle('avatar', [id]);
      return viewOf(written);
    },

    deleteAvatar(id) {
      const existing = requireLive(id);
      if (existing.definition.avatar?.kind !== 'file') return viewOf(existing);

      store.removeAvatar(id);
      const definition: AgentDefinition = {
        ...existing.definition,
        avatar: initialsAvatarFor(existing.definition),
        meta: { ...existing.definition.meta, updatedAt: isoTimestamp(clock()) },
      };
      const written = persist(definition, undefined);
      settle('avatar', [id]);
      return viewOf(written);
    },

    avatarImage(id) {
      const agent = requireKnown(id);
      if (agent.definition.avatar?.kind === 'file') {
        const bytes = store.readAvatar(agent.dir, agent.definition.avatar.value);
        if (bytes !== undefined) {
          // The bytes decide the content type, and the file name is only the
          // fallback: an upload is always stored as `avatar.png` (§9.5) whatever
          // format it arrived in, so trusting the extension would serve a JPEG
          // labelled as a PNG.
          return {
            bytes,
            contentType: sniffImageType(bytes) ?? contentTypeFor(agent.definition.avatar.value),
          };
        }
      }
      return placeholderAvatar(agent.definition);
    },

    async draft(body) {
      const parsed = draftRequestSchema.safeParse(body);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new InvalidRosterRequestError(
          `The draft request is not usable: ${issue?.message ?? 'send {"description": "…"}'}`,
          issue?.path.join('.') || 'description',
        );
      }
      if (options.draftQuery === undefined) {
        throw new RosterServiceError(
          'draft_unavailable',
          'Drafting is not available in this build: the roster service was created without an ' +
            'SDK query seam (DESIGN §12.2).',
          503,
        );
      }
      return draftFromDescription(parsed.data, {
        query: options.draftQuery,
        ...(options.log === undefined ? {} : { log: options.log }),
      });
    },

    async validate(id, body) {
      const agent = requireLive(id);
      const record = asRecord(body) ?? {};

      const projectId = record['projectId'];
      if (projectId !== undefined && typeof projectId !== 'string') {
        throw new InvalidRosterRequestError('"projectId" must be a string.', 'projectId');
      }
      const write = record['write'];
      if (write !== undefined && typeof write !== 'boolean') {
        throw new InvalidRosterRequestError('"write" must be true or false.', 'write');
      }
      const role = record['role'];
      if (
        role !== undefined &&
        (typeof role !== 'string' || !(ROLES as readonly string[]).includes(role))
      ) {
        throw new InvalidRosterRequestError(`"role" must be one of ${ROLES.join(', ')}.`, 'role');
      }

      // The project layer, as *stored* — a preview happens before any workspace
      // lease exists, so this deliberately does not go through
      // `getEffectiveLaunchContext`, which needs one. Permissions are the same
      // either way: projects stores them uncomposed and roster composes them.
      let project: ProjectContext | undefined;
      let declaredElevation: ValidateResult['declaredElevation'] = null;
      if (projectId !== undefined) {
        const provider = options.projects?.();
        if (provider === undefined) {
          throw new RosterServiceError(
            'projects_unavailable',
            'This build has no projects module, so an agent cannot be validated against a ' +
              'project id.',
            503,
            { projectId },
          );
        }
        let stored;
        try {
          stored = provider.get(projectId);
        } catch {
          throw new RosterServiceError(
            'project_not_found',
            `There is no project "${projectId}".`,
            404,
            { projectId },
          );
        }
        const elevation = stored.defaults?.permissionElevation;
        declaredElevation =
          elevation === undefined
            ? null
            : { allow: [...elevation.allow], reason: elevation.reason };
        project = {
          projectId: stored.id,
          cwd: stored.localPath ?? '',
          ...(stored.defaults?.permissions === undefined
            ? {}
            : { permissionOverride: stored.defaults.permissions }),
          ...(elevation === undefined ? {} : { elevation }),
        };
      }

      const policy = options.policy ?? OPEN_POLICY;
      const compiled = await compilePreview({
        agent,
        ...(project === undefined ? {} : { project }),
        assignment: {
          // A preview has no assignment yet (§9.1: it happens *before* a
          // launch), so the layer is the permissive one: `write: true` and no
          // scope rules. Stated on the result as `assumedWriteAccess` rather
          // than hidden, because a preview that silently assumed the *narrower*
          // layer would show an owner a set no session will ever run under.
          id: 'roster-validate',
          write: write ?? true,
          ...(role === undefined ? {} : { role: role as Role }),
        },
        policy,
        // Nothing is launched, so nothing inherits this process's environment.
        baseEnv: {},
        secrets: previewSecrets(options.secrets),
        // The real library, not a preview stand-in: a dangling connector ref is
        // a launch refusal this preview should show rather than paper over —
        // unlike a missing secret, it is not something the owner can be
        // expected to have set up before looking.
        connectors: lookupConnector,
        ...(options.toolset === undefined ? {} : { toolset: options.toolset }),
      });

      return {
        agentId: agent.definition.id,
        projectId: projectId ?? null,
        effective: compiled.effective,
        diagnostics: [...agent.diagnostics, ...compiled.diagnostics],
        declaredElevation,
        allowPermissionElevation: policy.allowPermissionElevation,
        assumedWriteAccess: write === undefined,
        // The compiled *policy* is what makes this answerable — `effective`
        // alone cannot say whether an uncovered tool escalates to a human or is
        // denied outright, because that turns on the mode (§6.1). It is read
        // here rather than returned raw: `humanMayApprove` is roster's
        // derivation and shipping it to a client would invite a second one.
        gateLiable: gateLiableTools({
          effective: compiled.effective,
          policy: compiled.policy,
          diagnostics: [],
        }),
      };
    },

    overseerRoster: () =>
      projectRosterForOverseer(registry.list().map((agent) => agent.definition)),

    load() {
      const result = registry.reloadAll();
      // `templates/` and `connectors/` are read in the same boot pass and
      // *before* `settle`, so the one `roster.changed` a boot emits already
      // covers every half of the library rather than the other two arriving in
      // events nobody subscribed differently to. Connectors before agents would
      // be tidier still, but nothing in the agent load consults the library —
      // resolution happens at compile and preflight, both of which are after
      // this returns.
      templates.reloadAll();
      connectorRegistry.reloadAll();
      settle('loaded', result.agentIds);
      return result;
    },

    reload() {
      const result = registry.reloadAll();
      if (result.changed) settle('external', result.agentIds);
      return result;
    },

    reloadFolders(folders) {
      const touched = new Set<string>();
      for (const folder of folders) {
        for (const id of registry.reload(folder).agentIds) touched.add(id);
      }
      const result: RegistryChange =
        touched.size === 0
          ? { changed: false, agentIds: [] }
          : { changed: true, agentIds: [...touched].sort() };
      if (result.changed) settle('external', result.agentIds);
      return result;
    },

    // --- §2.4's task templates (WO5) ---------------------------------------

    listTemplates: () => ({
      templates: templates.list().map((entry) => templateViewOf(entry.template)),
      diagnostics: templates.diagnostics(),
    }),

    getTemplate(id) {
      const found = templates.get(id);
      if (found === undefined) throw new TemplateNotFoundError(id);
      return templateViewOf(found.template);
    },

    reloadTemplates() {
      const result = templates.reloadAll();
      if (result.changed) announceTemplates();
      return result;
    },

    reloadTemplateFolders(folders) {
      const touched = new Set<string>();
      for (const folder of folders) {
        for (const id of templates.reload(folder).templateIds) touched.add(id);
      }
      const result: TemplateRegistryChange =
        touched.size === 0
          ? { changed: false, templateIds: [] }
          : { changed: true, templateIds: [...touched].sort() };
      if (result.changed) announceTemplates();
      return result;
    },

    // --- §10.3's connector library (WO3) -----------------------------------

    connectors: lookupConnector,

    connectorUsedBy: (id) => usedByAgents(id),

    connectorDiagnostics: () => connectorRegistry.diagnostics(),

    async listConnectors() {
      const views = await Promise.all(
        connectorRegistry.list().map((entry) => connectorViewOf(entry.connector)),
      );
      return { connectors: views, diagnostics: connectorRegistry.diagnostics() };
    },

    // `async` rather than an arrow returning the promise: `requireConnector`
    // throws, and a declared `Promise` that sometimes throws synchronously is a
    // caller-side footgun the routes would be the last to notice.
    async getConnector(id) {
      return connectorViewOf(requireConnector(id));
    },

    async createConnector(body) {
      const { id: requestedId, label, description, config } = readConnectorBody(body, 'create');
      const now = isoTimestamp(clock());

      let id: string;
      if (requestedId !== undefined) {
        const problem = connectorIdProblem(requestedId);
        if (problem !== undefined) throw new InvalidRosterRequestError(problem, 'id');
        if (connectorTaken(requestedId)) throw new ConnectorIdTakenError(requestedId);
        id = requestedId;
      } else {
        if (label === undefined || label === null) {
          throw new InvalidRosterRequestError(
            'A "label" is required; the connector id is derived from it.',
            'label',
          );
        }
        // The agent minter, unchanged: its slug charset is a subset of the
        // integration-name one, so an id it produces is a valid server name —
        // and "collision-suffixed like agents" is then true by construction
        // rather than by a second implementation that agrees today.
        const minted = mintAgentId(label, connectorTaken);
        if (minted === undefined) {
          throw new RosterServiceError(
            'connector_id_exhausted',
            `No free connector id could be derived from "${label}"; give the connector a ` +
              'different label.',
            409,
            { label },
          );
        }
        id = minted;
      }

      if (config === undefined) {
        throw new InvalidRosterRequestError(
          'A "config" is required — the MCP server this connector defines (DESIGN §10).',
          'config',
        );
      }

      const connector = parseConnector(
        {
          schemaVersion: CONNECTOR_SCHEMA_VERSION,
          id,
          ...(label === undefined || label === null ? {} : { label }),
          ...(description === undefined || description === null ? {} : { description }),
          config,
          meta: { createdAt: now, updatedAt: now },
        },
        'POST /api/roster/connectors',
      );

      const written = connectorStore.write(connector);
      connectorRegistry.reload(id);
      announceConnectors();
      return connectorViewOf(written.connector);
    },

    async patchConnector(id, body) {
      const existing = requireConnector(id);
      const patch = readConnectorBody(body, 'patch');
      if (patch.id !== undefined && patch.id !== id) throw new ImmutableFieldError(['id']);

      // `null` clears an optional field and an absent key leaves it alone —
      // `patch`'s three-way distinction (§9.1), for the same reason: without it
      // there is no way to remove a description once it is set.
      const label = patch.label === undefined ? existing.label : (patch.label ?? undefined);
      const description =
        patch.description === undefined ? existing.description : (patch.description ?? undefined);

      const connector = parseConnector(
        {
          schemaVersion: CONNECTOR_SCHEMA_VERSION,
          id,
          ...(label === undefined ? {} : { label }),
          ...(description === undefined ? {} : { description }),
          config: patch.config ?? existing.config,
          meta: { createdAt: existing.meta.createdAt, updatedAt: isoTimestamp(clock()) },
        },
        `PATCH /api/roster/connectors/${id}`,
      );

      const written = connectorStore.write(connector);
      connectorRegistry.reload(id);
      // Every referencing agent now compiles differently — which is the point of
      // the library, and exactly why this is announced rather than left for the
      // watcher: the write came from the API, and a UI that had to wait for a
      // filesystem event would show the old config for a debounce interval.
      announceConnectors();
      return connectorViewOf(written.connector);
    },

    removeConnector(id) {
      // A folder that will not parse is still a folder to delete: the 404 is for
      // an id the library does not have at all, not for one it holds badly.
      if (!connectorStore.hasFolder(id)) throw new ConnectorNotFoundError(id);
      const usedBy = usedByAgents(id);
      if (usedBy.length > 0) throw new ConnectorInUseError(id, usedBy);
      connectorStore.remove(id);
      connectorRegistry.reload(id);
      announceConnectors();
      return { connectorId: id, removed: true };
    },

    reloadConnectors() {
      const result = connectorRegistry.reloadAll();
      if (result.changed) announceConnectors();
      return result;
    },

    reloadConnectorFolders(folders) {
      const touched = new Set<string>();
      for (const folder of folders) {
        for (const id of connectorRegistry.reload(folder).connectorIds) touched.add(id);
      }
      const result: ConnectorRegistryChange =
        touched.size === 0
          ? { changed: false, connectorIds: [] }
          : { changed: true, connectorIds: [...touched].sort() };
      if (result.changed) announceConnectors();
      return result;
    },
  };

  /** Every id the library has issued — loaded, broken, or merely a folder. */
  function connectorTaken(candidate: string): boolean {
    return connectorRegistry.get(candidate) !== undefined || connectorStore.hasFolder(candidate);
  }

  return service;
}

// ---------------------------------------------------------------------------
// Request shaping
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Splits a create/patch body into the definition fields and the persona text.
 *
 * `personaText` is the one field of the wire format that is not a definition
 * field: the definition carries `persona: { mode, file }` and the *body* of the
 * persona is a separate file (§4). It is lifted out here rather than being
 * tolerated by the schema, because the schema rejects unknown top-level keys on
 * purpose (§3) and weakening that for one convenience field would weaken it for
 * every typo.
 *
 * `roleAddenda` is lifted for exactly the same reason: `capabilities.roles`
 * says which seats an agent can fill and is a definition field, while the
 * `roles/<role>.md` bodies are files beside `persona.md` and are not.
 */
function splitBody(body: unknown): {
  readonly record: Record<string, unknown>;
  readonly personaText: string | undefined;
  readonly roleAddenda: RoleAddendaPatch | undefined;
  readonly acceptedSkills: readonly AcceptedSkill[];
} {
  const record = asRecord(body);
  if (record === undefined) {
    throw new InvalidRosterRequestError('Send a JSON object describing the agent.');
  }
  const personaText = record['personaText'];
  if (personaText !== undefined && typeof personaText !== 'string') {
    throw new InvalidRosterRequestError(
      '"personaText" must be the markdown body of persona.md, as a string.',
      'personaText',
    );
  }
  const roleAddenda = readRoleAddendaPatch(record['roleAddenda']);
  const acceptedSkills = readAcceptedSkills(record['acceptedSkills']);
  const rest = { ...record };
  delete rest['personaText'];
  delete rest['roleAddenda'];
  delete rest['acceptedSkills'];
  return { record: rest, personaText, roleAddenda, acceptedSkills };
}

/**
 * `{ id?, label?, description?, config? }` off the wire (§10.3).
 *
 * Only shaping, never validation of the config itself: that is
 * `connectorSchema`'s, applied by `parseConnector` on the assembled document, so
 * a connector written by the API is judged by exactly the schema a hand-edited
 * `connector.json` is. What this function does is separate "absent" from "sent
 * as null" — the create/patch distinction §9.1 draws for every optional field —
 * and refuse a body that is not an object at all.
 */
function readConnectorBody(
  body: unknown,
  kind: 'create' | 'patch',
): {
  readonly id: string | undefined;
  /** `null` means "clear it" on a patch; absent means "leave it alone". */
  readonly label: string | null | undefined;
  readonly description: string | null | undefined;
  readonly config: unknown;
} {
  const record = asRecord(body);
  if (record === undefined) {
    throw new InvalidRosterRequestError(
      kind === 'create'
        ? 'Send a JSON object describing the connector: { label, config }.'
        : 'Send a JSON object with the fields to change.',
    );
  }

  const id = record['id'];
  if (id !== undefined && typeof id !== 'string') {
    throw new InvalidRosterRequestError('"id" must be a string.', 'id');
  }
  const label = record['label'];
  if (label !== undefined && label !== null && typeof label !== 'string') {
    throw new InvalidRosterRequestError('"label" must be a string, or null to clear it.', 'label');
  }
  const description = record['description'];
  if (description !== undefined && description !== null && typeof description !== 'string') {
    throw new InvalidRosterRequestError(
      '"description" must be a string, or null to clear it.',
      'description',
    );
  }

  const known = new Set(['id', 'label', 'description', 'config']);
  const unknown = Object.keys(record).filter((key) => !known.has(key));
  if (unknown.length > 0) {
    // The schema's stance on unknown keys (§3), applied to the wire form: a
    // typo'd field that was silently ignored would report success for an edit
    // that did not happen.
    throw new InvalidRosterRequestError(
      `"${unknown[0] ?? ''}" is not a connector field; expected id, label, description or config.`,
      unknown[0] ?? '',
    );
  }

  return { id, label, description, config: record['config'] };
}

/**
 * `{ skeptic: "…", architect: null }` — the wire form of a role-addendum edit.
 *
 * The role must be one of §3's five. An unknown key is rejected rather than
 * ignored, matching the definition schema's treatment of unknown top-level keys
 * (§3): a typo'd role would otherwise write nothing and report success.
 */
function readRoleAddendaPatch(value: unknown): RoleAddendaPatch | undefined {
  if (value === undefined) return undefined;
  const record = asRecord(value);
  if (record === undefined) {
    throw new InvalidRosterRequestError(
      '"roleAddenda" must be an object keyed by role, with a markdown body or null for each.',
      'roleAddenda',
    );
  }
  const patch: Partial<Record<Role, string | null>> = {};
  for (const [key, body] of Object.entries(record)) {
    if (!(ROLES as readonly string[]).includes(key)) {
      throw new InvalidRosterRequestError(
        `"${key}" is not a role; expected one of ${ROLES.join(', ')}.`,
        `roleAddenda.${key}`,
      );
    }
    if (body !== null && typeof body !== 'string') {
      throw new InvalidRosterRequestError(
        `"roleAddenda.${key}" must be the markdown body of roles/${key}.md, or null to remove it.`,
        `roleAddenda.${key}`,
      );
    }
    patch[key as Role] = body;
  }
  return patch;
}

/**
 * `suggestedSkills` the wizard's user ticked (§12.4).
 *
 * The second wire-only field, and lifted out for the same reason `personaText`
 * is: it names files rather than definition fields, and the definition schema
 * rejects unknown top-level keys on purpose.
 */
export interface AcceptedSkill {
  readonly name: string;
  readonly description: string;
}

function readAcceptedSkills(value: unknown): readonly AcceptedSkill[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new InvalidRosterRequestError(
      '"acceptedSkills" must be an array of { name, description }.',
      'acceptedSkills',
    );
  }
  return value.map((entry, index) => {
    const record = asRecord(entry);
    const name = record?.['name'];
    const description = record?.['description'];
    if (typeof name !== 'string' || name.length === 0) {
      throw new InvalidRosterRequestError(
        'Every accepted skill needs a "name" — the folder name under skills/.',
        `acceptedSkills.${String(index)}.name`,
      );
    }
    return {
      name,
      description: typeof description === 'string' ? description : '',
    };
  });
}

/** The stub body §12.4 asks for: the description, and nothing invented. */
export function skillStub(skill: AcceptedSkill): string {
  return (
    `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n\n` +
    `# ${skill.name}\n\n${skill.description}\n\n` +
    'Write the steps here. This stub was created when the skill was accepted in ' +
    'the agent wizard (DESIGN §12.4); nothing has been authored for it yet.\n'
  );
}

/**
 * The resolver the **preview** compiles with.
 *
 * A dry run must not fail because a credential is missing: §10 makes an
 * unresolved `secretRef` fail a *launch* loudly, which is right — a session
 * whose tools will silently 401 must not start — but the permission preview
 * exists precisely so an owner can look before launching, and refusing to show
 * it because a token is absent would hide the composition at the moment it is
 * most wanted. So a missing ref resolves to a placeholder here and the launch
 * path keeps its refusal untouched. The value never leaves this function: the
 * preview returns `effective` and `diagnostics`, and discards the options.
 *
 * `needsCredentials` on `GET /agents` is where an owner learns the ref is
 * missing (§10) — that badge is not weakened by this.
 */
function previewSecrets(secrets: SecretResolver | undefined): SecretResolver {
  return {
    async get(key: string) {
      const found = await secrets?.get(key);
      return found ?? new Secret(`unresolved:${key}`);
    },
  };
}

/**
 * `{ rule }` off the wire, judged by the same grammar an `agent.json` is.
 *
 * Three gates, narrowest first, and each one exists because a rule that gets
 * past it is a permission the owner believes is in force and is not:
 *
 * 1. **the schema's** `permissionRuleSchema` — length, whitespace, a balanced
 *    `Tool(pattern)`. Identical to what the editor's save would apply, so a rule
 *    this route accepts is a rule the editor would have accepted;
 * 2. **the engine's**, via {@link normaliseAllowRules}. That function is the
 *    element's record of which allow rules the SDK *actually* enforces (§6.1's
 *    fixes 1 and 2). If it would rewrite, drop, or lift the rule into `ask`,
 *    then the rule the caller showed a human is not the rule that would take
 *    effect — so this refuses with the normaliser's own diagnostic rather than
 *    quietly storing something else. Runner's derivation
 *    (`runner/permissionRules.ts`) is written to never produce one; this is the
 *    backstop that catches the day it drifts, or a hand-rolled client;
 * 3. **the definition parser's**, later, when {@link RosterService.patch} reparses
 *    the whole agent — which is what makes this a real edit rather than a
 *    special case.
 */
function readAllowRule(body: unknown): string {
  const record = asRecord(body);
  const raw = record?.['rule'];
  if (typeof raw !== 'string') {
    throw new InvalidRosterRequestError(
      '"rule" is required and must be a permission rule string, for example "Bash(npm run:*)".',
      'rule',
    );
  }

  const parsed = permissionRuleSchema.safeParse(raw);
  if (!parsed.success) {
    throw new RosterValidationError(
      'That permission rule is not one this roster can store.',
      issuesFromZod(parsed.error.issues).map((issue) => ({ ...issue, path: 'rule' })),
    );
  }

  const normalised = normaliseAllowRules([parsed.data], 'rule');
  const kept = normalised.rules[0];
  if (normalised.rules.length !== 1 || kept !== parsed.data) {
    const why = normalised.diagnostics[0]?.message ?? 'the SDK’s rule engine would not honour it';
    throw new RosterServiceError(
      'permission_rule_not_enforceable',
      `"${parsed.data}" was refused: ${why}`,
      400,
      { rule: parsed.data, ...(kept === undefined ? {} : { wouldBecome: kept }) },
    );
  }

  return parsed.data;
}

/** The declared type for a stored avatar, from its name. `avatar.png` is the
 *  only name an upload can produce (§9.5); a hand-placed file may be anything. */
function contentTypeFor(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  return 'image/png';
}
