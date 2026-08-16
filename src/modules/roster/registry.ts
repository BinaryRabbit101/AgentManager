/**
 * The in-memory registry (roster DESIGN §2.3, IMPLEMENTATION M2).
 *
 * > "The roster module loads every `agent.json` at startup into an in-memory
 * > `Map<AgentId, ResolvedAgent>`, validates each, and watches the directory
 * > […] Reads are served from memory; writes go through the store […] and then
 * > update the map. A file that fails validation is kept out of the registry
 * > and surfaced as a `RosterDiagnostic` the UI can display on the board —
 * > never a crash, never a silent drop."
 *
 * Three things this file decides, all of them consequences of that paragraph:
 *
 * - **Failures are remembered, not discarded.** A folder whose `agent.json` is
 *   corrupt is held in a second map. It is not an agent — nothing lists it, and
 *   nothing can launch it — but the registry still knows its id exists, which is
 *   what stops `POST /agents` from minting the same id and writing into somebody
 *   else's broken folder.
 * - **A reload that finds nothing new reports nothing.** Every comparison is
 *   against {@link ResolvedAgent.contentHash}, so the store's own writes, a
 *   regenerated plugin manifest, and an editor that touches a file without
 *   changing it all produce no `roster.changed`. Without that, the watcher and
 *   the writer feed each other.
 * - **Archived agents are loaded too.** §9.3 requires an archived definition to
 *   stay readable by id "for display", and foundation's `agents` index carries
 *   an `archived_at` column for exactly that join. They live in their own map so
 *   no listing can return one by accident.
 */
import type { Diagnostic } from './contracts.js';
import type { AgentId } from './schema.js';
import type { ResolvedAgent, RosterStore } from './store.js';

/** What a load or reload actually changed. */
export interface RegistryChange {
  readonly changed: boolean;
  /** Ids that appeared, vanished, or whose authored bytes differ. Sorted. */
  readonly agentIds: readonly AgentId[];
}

const NO_CHANGE: RegistryChange = { changed: false, agentIds: [] };

function change(ids: Iterable<string>): RegistryChange {
  const agentIds = [...new Set(ids)].sort();
  return agentIds.length === 0 ? NO_CHANGE : { changed: true, agentIds };
}

export interface RosterRegistry {
  /** Every live agent, by id. Board order is `agent_ui_state`'s job, not this one. */
  list(): readonly ResolvedAgent[];
  get(id: string): ResolvedAgent | undefined;
  /** The most recent archived copy of `id` (§9.3). */
  getArchived(id: string): ResolvedAgent | undefined;
  listArchived(): readonly ResolvedAgent[];
  /**
   * True when the library has ever issued this id — live, archived, or a folder
   * that will not load. The predicate `POST /agents` mints against, because
   * "ids are never reused" (§9.3) is about the folder, not about validity.
   */
  knows(id: string): boolean;
  /** Everything wrong across the whole library, for the board's banner (§2.3). */
  diagnostics(): readonly Diagnostic[];
  /** Rereads the entire library, including `.archive/`. */
  reloadAll(): RegistryChange;
  /** Rereads one folder — the watcher's per-folder path. */
  reload(id: string): RegistryChange;
  /** Records an agent the store has just written, skipping the reread. */
  apply(agent: ResolvedAgent): RegistryChange;
  /** Drops an id from the live map, after an archive or a purge. */
  forget(id: string): RegistryChange;
  /** Rereads `.archive/` only — after an archive or a purge. */
  refreshArchive(): void;
}

export function createRosterRegistry(store: RosterStore): RosterRegistry {
  const live = new Map<AgentId, ResolvedAgent>();
  /** Folders that exist but do not load: id → why. */
  const failed = new Map<string, readonly Diagnostic[]>();
  const archived = new Map<AgentId, ResolvedAgent>();

  function readArchive(): void {
    archived.clear();
    // `archiveEntries()` is oldest-first, so the last write of an id wins —
    // an agent archived, recreated and archived again shows its latest life.
    for (const entry of store.archiveEntries()) {
      const outcome = store.loadArchived(entry);
      if (outcome.ok) archived.set(outcome.agent.definition.id, outcome.agent);
    }
  }

  function absorb(id: string, touched: Set<string>): void {
    const outcome = store.load(id);
    const previous = live.get(id);

    if (outcome.ok) {
      failed.delete(id);
      live.set(id, outcome.agent);
      if (previous === undefined || previous.contentHash !== outcome.agent.contentHash) {
        touched.add(id);
      }
      return;
    }

    live.delete(id);
    const before = failed.get(id);
    failed.set(id, outcome.diagnostics);
    // A folder that was an agent and now is not is a change the board must see;
    // a folder that was already broken and is still broken in the same way is
    // not, or every editor keystroke on a malformed file would be an event.
    if (
      previous !== undefined ||
      before === undefined ||
      !sameDiagnostics(before, outcome.diagnostics)
    ) {
      touched.add(id);
    }
  }

  return {
    list: () => [...live.values()].sort(byId),
    get: (id) => live.get(id),
    getArchived: (id) => archived.get(id),
    listArchived: () => [...archived.values()].sort(byId),

    knows: (id) => live.has(id) || failed.has(id) || archived.has(id) || store.hasFolder(id),

    diagnostics() {
      const out: Diagnostic[] = [];
      for (const diagnostics of failed.values()) out.push(...diagnostics);
      for (const agent of live.values()) out.push(...agent.diagnostics);
      return out;
    },

    reloadAll() {
      const touched = new Set<string>();
      // The folder name is the id (§2.1), and `store.load` refuses a folder
      // whose definition disagrees, so a directory listing is the complete set
      // of ids the library claims to have.
      const seen = new Set(store.folderNames());

      for (const id of seen) absorb(id, touched);

      // Folders that disappeared while nobody was looking — a `git pull` that
      // removed an agent, or a hand-deleted directory.
      for (const id of [...live.keys()]) {
        if (!seen.has(id)) {
          live.delete(id);
          touched.add(id);
        }
      }
      for (const id of [...failed.keys()]) {
        if (!seen.has(id)) failed.delete(id);
      }

      readArchive();
      return change(touched);
    },

    reload(id) {
      const touched = new Set<string>();
      if (!store.hasFolder(id)) {
        const wasLive = live.delete(id);
        const wasFailed = failed.delete(id);
        if (wasLive || wasFailed) touched.add(id);
        readArchive();
        return change(touched);
      }
      absorb(id, touched);
      return change(touched);
    },

    apply(agent) {
      const previous = live.get(agent.definition.id);
      failed.delete(agent.definition.id);
      live.set(agent.definition.id, agent);
      return previous !== undefined && previous.contentHash === agent.contentHash
        ? NO_CHANGE
        : change([agent.definition.id]);
    },

    forget(id) {
      const wasLive = live.delete(id);
      const wasFailed = failed.delete(id);
      return wasLive || wasFailed ? change([id]) : NO_CHANGE;
    },

    refreshArchive: readArchive,
  };
}

function byId(a: ResolvedAgent, b: ResolvedAgent): number {
  return a.definition.id < b.definition.id ? -1 : a.definition.id > b.definition.id ? 1 : 0;
}

/** Two diagnostic lists that would render identically on the board. */
function sameDiagnostics(a: readonly Diagnostic[], b: readonly Diagnostic[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((left, index) => {
    const right = b[index];
    return right !== undefined && left.code === right.code && left.message === right.message;
  });
}
