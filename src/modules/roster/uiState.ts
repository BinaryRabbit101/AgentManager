/**
 * `agent_ui_state` — the roster's own SQLite table (DESIGN §2.2, §9.5).
 *
 * The one piece of agent state that is **not** in the library, and the reason
 * is stated once in §2.2 and worth repeating here: "board order changes every
 * time the user drags a card. Putting it in `agent.json` would produce a git
 * diff per drag. It is also worthless in an export."
 *
 * This repository is roster's alone. It is composed against `Storage.db`
 * because foundation hands each element its own tables through element-owned
 * migrations and provides no accessor for them (foundation §1.3, and the same
 * note the projects module carries) — `ctx.store` covers foundation's tables,
 * `migrations/roster/0001_ui_state.sql` covers this one.
 *
 * ## Why `setBoardOrder` takes the whole list
 *
 * §9.5 rejected a per-card `PATCH` outright: "dragging one card changes the
 * position of every card after it, so per-card writes would mean N requests
 * and, on a dropped connection, a torn order with duplicate or missing
 * positions." So the write is a whole-list rewrite in one transaction, and the
 * board either has the new order or the old one.
 */
import type { Database } from '../../storage/sqlite.js';

/** One row, as the API returns it under `uiState`. */
export interface AgentUiState {
  readonly agentId: string;
  readonly boardOrder: number;
  readonly pinned: boolean;
  /** Derived convenience for sorting; the authority is session history (§2.2). */
  readonly lastUsedAt: string | null;
}

/** What `PATCH /agents/:id/ui-state` may change. */
export interface AgentUiStatePatch {
  readonly pinned?: boolean;
  readonly lastUsedAt?: string | null;
}

export interface AgentUiStateRepository {
  get(agentId: string): AgentUiState | undefined;
  /** Every row, in board order. */
  list(): readonly AgentUiState[];
  /** The row for `agentId`, creating it at the end of the board if absent. */
  ensure(agentId: string): AgentUiState;
  /**
   * Creates a row for every id in `present`, and drops every row `keep`
   * rejects.
   *
   * The two arguments are not the same list on purpose. An agent whose
   * `agent.json` a hand-edit has just broken is not `present` — it is out of the
   * registry until it parses again (§2.3) — but deleting its row would throw
   * away the board position the owner dragged it to, and hand it back at the end
   * of the board once they fixed the typo. `keep` is what says "this id still
   * exists on disk"; only an archive or a purge makes it false.
   */
  reconcile(present: readonly string[], keep?: (agentId: string) => boolean): void;
  patch(agentId: string, patch: AgentUiStatePatch): AgentUiState;
  /**
   * Rewrites every row's `board_order` in one transaction (§9.5).
   *
   * `order` is the user's list; `rest` is every other known id, which keeps its
   * relative order *after* the listed ones — §9.5: "ids omitted from `order`
   * keep their relative order after the listed ones".
   */
  setBoardOrder(order: readonly string[]): readonly AgentUiState[];
  delete(agentId: string): boolean;
}

interface UiStateRow {
  readonly agent_id: string;
  readonly board_order: number;
  readonly pinned: number;
  readonly last_used_at: string | null;
}

const COLUMNS = 'agent_id, board_order, pinned, last_used_at';

function toRecord(row: UiStateRow): AgentUiState {
  return {
    agentId: row.agent_id,
    boardOrder: row.board_order,
    pinned: row.pinned !== 0,
    lastUsedAt: row.last_used_at,
  };
}

export function createAgentUiStateRepository(db: Database): AgentUiStateRepository {
  const getStatement = db.prepare<[string], UiStateRow>(
    `SELECT ${COLUMNS} FROM agent_ui_state WHERE agent_id = ?`,
  );
  const listStatement = db.prepare<[], UiStateRow>(
    `SELECT ${COLUMNS} FROM agent_ui_state ORDER BY board_order, agent_id`,
  );
  const insertStatement = db.prepare<[string, number]>(
    'INSERT INTO agent_ui_state (agent_id, board_order, pinned, last_used_at)' +
      ' VALUES (?, ?, 0, NULL) ON CONFLICT(agent_id) DO NOTHING',
  );
  const nextOrderStatement = db.prepare<[], { next: number }>(
    'SELECT COALESCE(MAX(board_order) + 1, 0) AS next FROM agent_ui_state',
  );
  const setPinnedStatement = db.prepare<[number, string]>(
    'UPDATE agent_ui_state SET pinned = ? WHERE agent_id = ?',
  );
  const setLastUsedStatement = db.prepare<[string | null, string]>(
    'UPDATE agent_ui_state SET last_used_at = ? WHERE agent_id = ?',
  );
  const setOrderStatement = db.prepare<[number, string]>(
    'UPDATE agent_ui_state SET board_order = ? WHERE agent_id = ?',
  );
  const deleteStatement = db.prepare<[string]>('DELETE FROM agent_ui_state WHERE agent_id = ?');

  function get(agentId: string): AgentUiState | undefined {
    const row = getStatement.get(agentId);
    return row === undefined ? undefined : toRecord(row);
  }

  function ensure(agentId: string): AgentUiState {
    const existing = get(agentId);
    if (existing !== undefined) return existing;
    insertStatement.run(agentId, nextOrderStatement.get()?.next ?? 0);
    // The row was just inserted; a miss would mean the insert did not happen.
    return get(agentId) as AgentUiState;
  }

  const reconcileTransaction = db.transaction(
    (present: readonly string[], keep: (agentId: string) => boolean): void => {
      for (const row of listStatement.all()) {
        if (!keep(row.agent_id)) deleteStatement.run(row.agent_id);
      }
      let next = nextOrderStatement.get()?.next ?? 0;
      for (const id of present) {
        if (getStatement.get(id) === undefined) {
          insertStatement.run(id, next);
          next += 1;
        }
      }
    },
  );

  /**
   * The listed ids take `0…n-1`; everything else follows in its previous
   * relative order. Written as one transaction so a replay of the same body is
   * a no-op and a torn order is unrepresentable (§9.5).
   */
  const setBoardOrderTransaction = db.transaction((order: readonly string[]): void => {
    const listed = new Set(order);
    let position = 0;
    for (const id of order) {
      ensure(id);
      setOrderStatement.run(position, id);
      position += 1;
    }
    for (const row of listStatement.all()) {
      if (listed.has(row.agent_id)) continue;
      setOrderStatement.run(position, row.agent_id);
      position += 1;
    }
  });

  return {
    get,
    list: () => listStatement.all().map(toRecord),
    ensure,
    reconcile: (present, keep) => {
      const wanted = new Set(present);
      reconcileTransaction(present, keep ?? ((agentId) => wanted.has(agentId)));
    },

    patch(agentId, patch) {
      ensure(agentId);
      if (patch.pinned !== undefined) setPinnedStatement.run(patch.pinned ? 1 : 0, agentId);
      if (patch.lastUsedAt !== undefined) setLastUsedStatement.run(patch.lastUsedAt, agentId);
      return get(agentId) as AgentUiState;
    },

    setBoardOrder(order) {
      setBoardOrderTransaction(order);
      return listStatement.all().map(toRecord);
    },

    delete: (agentId) => deleteStatement.run(agentId).changes > 0,
  };
}
