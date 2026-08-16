-- 0001_ui_state.sql — the roster element's own table (roster DESIGN §2.2, §9.5),
-- shipped under foundation §1.3's element-migration mechanism.
--
-- `agents` itself is deliberately absent: foundation ships it in `0001_init.sql`
-- because sessions, assignments and events all key on it, and it is a
-- *rebuildable index* that roster pushes into rather than reads from
-- (foundation §1.4, roster §2.2). This table is the opposite — nothing outside
-- roster reads it, and it is the one piece of agent state that is **not**
-- rebuildable from the library, because it records what the user dragged.
--
-- Applied inside a transaction opened by the runner: no BEGIN/COMMIT here, and
-- no `IF NOT EXISTS` — the runner tracks applied versions in `schema_migrations`
-- and never re-runs a version, so a defensive guard would only hide a genuine
-- collision.

-- ---------------------------------------------------------------------------
-- agent_ui_state — board order, pinning and a last-used convenience (§2.2).
--
-- Keyed by `agent_id`, which is the agent's folder name under
-- `<libraryRoot>/agents/` and therefore the join key every other element uses.
-- No foreign key to `agents`: that table is a rebuildable index whose rows are
-- deleted and reinserted wholesale on a reindex, and a cascade from it would
-- throw away board order every time roster refreshed the index.
--
-- Why the table exists at all: "board order changes every time the user drags a
-- card. Putting it in `agent.json` would produce a git diff per drag. It is also
-- worthless in an export" (§2.2). Nothing here is a definition field, and
-- nothing here is written by an `agent.json` edit.
--
-- `pinned` is INTEGER because STRICT tables have no boolean type; 0 = not
-- pinned. `last_used_at` is a derived convenience for sorting — the
-- authoritative history lives with sessions (§2.2) — so it is nullable and may
-- lag without anything being wrong.
-- ---------------------------------------------------------------------------
CREATE TABLE agent_ui_state (
  agent_id     TEXT    NOT NULL PRIMARY KEY,
  board_order  INTEGER NOT NULL DEFAULT 0,
  pinned       INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT
) STRICT;

-- The board's one query: every card, in the order the user left them. `agent_id`
-- is the tiebreak so a freshly-inserted row with a duplicate order still has a
-- stable position rather than an arbitrary one.
CREATE INDEX agent_ui_state_board ON agent_ui_state (board_order, agent_id);
