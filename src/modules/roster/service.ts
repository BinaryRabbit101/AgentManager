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
import type { SecretResolver } from '../../secrets/index.js';
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
import type { Diagnostic } from './contracts.js';
import { duplicateAgentId, duplicateDefinition } from './duplicate.js';
import { RosterValidationError } from './errors.js';
import { agentIdProblem } from './ids.js';
import { integrationCredentialStatus, type IntegrationCredentialStatus } from './integrations.js';
import { parseAgentDefinition } from './parse.js';
import { AGENT_SCHEMA_VERSION, immutableFieldViolations, type AgentDefinition } from './schema.js';
import {
  AgentArchivedError,
  AgentIdTakenError,
  AgentNotFoundError,
  ImmutableFieldError,
  InvalidRosterRequestError,
  PurgeBlockedError,
  RosterServiceError,
  UnknownBoardOrderIdError,
} from './serviceErrors.js';
import { validateSkills } from './skills.js';
import { mintAgentId } from './slug.js';
import { AVATAR_FILENAME, type ResolvedAgent, type RosterStore } from './store.js';
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
}

/** `GET /agents` — "list; includes `uiState` and any `diagnostics`" (§9.1). */
export interface RosterListView {
  readonly agents: readonly AgentView[];
  /** Library-wide, including agents that failed to load and so are not listed. */
  readonly diagnostics: readonly Diagnostic[];
}

/** What `DELETE /agents/:id` answers with. */
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
  | 'avatar'
  | 'ui-state'
  | 'board-order'
  | 'external'
  | 'loaded';

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
  create(body: unknown): AgentView;
  patch(id: string, body: unknown): AgentView;
  duplicate(id: string, body: unknown): AgentView;
  remove(id: string, options?: { readonly purge?: boolean }): DeleteResult;
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
  /** The in-memory registry, for M4's compiler and the module's health check. */
  readonly registry: RosterRegistry;
  /** Diagnostics raised by bootstrap, which precede the registry itself. */
  readonly bootDiagnostics: readonly Diagnostic[];
}

export interface RosterServiceOptions {
  readonly store: RosterStore;
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
}

// ---------------------------------------------------------------------------

export function createRosterService(options: RosterServiceOptions): RosterService {
  const { store, uiState, agents, sessions, bus } = options;
  const clock: Clock = options.clock ?? ((): Date => new Date());
  const registry = createRosterRegistry(store);

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

  // -------------------------------------------------------------------------
  // Views
  // -------------------------------------------------------------------------

  function viewOf(agent: ResolvedAgent): AgentView {
    const id = agent.definition.id;
    return {
      definition: agent.definition,
      persona: agent.persona,
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

  function persist(definition: AgentDefinition, persona: string | undefined): ResolvedAgent {
    const written = store.write(definition, persona);
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
        return integrationCredentialStatus(agent.definition, {
          get: () => Promise.resolve(undefined),
        });
      }
      return integrationCredentialStatus(agent.definition, options.secrets);
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
      };
    },

    create(body) {
      const { record, personaText } = splitBody(body);
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

      requireSkillFolders(definition, 'POST /api/roster/agents');

      // An empty `persona.md` rather than none: the definition names the file
      // (§3), and a definition pointing at a file that is not there loads with a
      // warning for something the API just created.
      const written = persist(definition, personaText ?? '');
      uiState.ensure(id);
      settle('created', [id]);
      return viewOf(written);
    },

    patch(id, body) {
      const existing = requireLive(id);
      const { record, personaText } = splitBody(body);

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

      const written = persist(next, personaText);
      settle('updated', [id]);
      return viewOf(written);
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

    load() {
      const result = registry.reloadAll();
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
  };

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
 */
function splitBody(body: unknown): {
  readonly record: Record<string, unknown>;
  readonly personaText: string | undefined;
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
  const rest = { ...record };
  delete rest['personaText'];
  return { record: rest, personaText };
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
