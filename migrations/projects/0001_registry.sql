-- 0001_registry.sql — the projects element's own tables (projects DESIGN §1.2,
-- §1.5, §1.6), shipped under foundation §1.3's element-migration mechanism.
--
-- `projects` itself is deliberately absent: foundation ships it in
-- `0001_init.sql` because sessions, assignments and events all key on it
-- (foundation §1.4). Everything here is read by exactly one element — this one —
-- so it belongs to this set.
--
-- Applied inside a transaction opened by the runner: no BEGIN/COMMIT here, and
-- no `IF NOT EXISTS` — the runner tracks applied versions in `schema_migrations`
-- and never re-runs a version, so a defensive guard would only hide a genuine
-- collision.
--
-- Conventions are foundation's (§1.3): plural table names, ULID text ids,
-- ISO-8601 UTC timestamps, STRICT tables, CASCADE for child rows.

-- ---------------------------------------------------------------------------
-- project_default_agents — the ordered roster agents suggested for a project
-- (DESIGN §1.2).
--
-- Relational rather than a key inside `defaults_json` so that a roster deletion
-- can be resolved without scanning JSON. No foreign key to `agents`: that table
-- is a rebuildable index (foundation §1.4) and a full reindex must be free to
-- delete and reinsert every row. A dangling `agent_id` is dropped lazily on read
-- and reported in the project's health payload.
-- ---------------------------------------------------------------------------
CREATE TABLE project_default_agents (
  project_id TEXT    NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  agent_id   TEXT    NOT NULL,
  "rank"     INTEGER NOT NULL,
  PRIMARY KEY (project_id, agent_id)
) STRICT;

-- The list is always read in its declared order, which is `rank`, not `agent_id`.
CREATE INDEX project_default_agents_order ON project_default_agents (project_id, "rank");

-- ---------------------------------------------------------------------------
-- work_items — the deliberately thin per-project backlog (DESIGN §1.5, §7.2).
--
-- `rank` is REAL so an item can be dropped between two neighbours without
-- renumbering the list. There is no priority, no assignee, no label and no
-- dependency column: anything richer is a tracker, which this is not.
-- ---------------------------------------------------------------------------
CREATE TABLE work_items (
  id               TEXT NOT NULL PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  kind             TEXT NOT NULL,
  title            TEXT NOT NULL,
  body             TEXT NOT NULL DEFAULT '',
  status           TEXT NOT NULL DEFAULT 'open',
  "rank"           REAL NOT NULL,
  scope_paths_json TEXT NOT NULL DEFAULT '[]',
  source           TEXT NOT NULL DEFAULT 'user',
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  closed_at        TEXT
) STRICT;

-- The board query: one project's items, by status, in manual order (§1.5).
CREATE INDEX work_items_board ON work_items (project_id, status, "rank");

-- ---------------------------------------------------------------------------
-- work_item_assignments — which assignments carry which work items (§1.5).
--
-- Written only by orchestrator's assignment-creation and close paths, through
-- projects' `linkWorkItems` / `unlinkWorkItems`. No foreign key to
-- `assignments`: linking is optional end to end and an assignment row's
-- lifetime is orchestrator's, not this table's.
-- ---------------------------------------------------------------------------
CREATE TABLE work_item_assignments (
  work_item_id  TEXT NOT NULL REFERENCES work_items (id) ON DELETE CASCADE,
  assignment_id TEXT NOT NULL,
  PRIMARY KEY (work_item_id, assignment_id)
) STRICT;

-- "Which items does this assignment carry" — the direction the primary key
-- cannot answer.
CREATE INDEX work_item_assignments_assignment ON work_item_assignments (assignment_id);

-- ---------------------------------------------------------------------------
-- workspace_leases — which directory an assignment actually runs in (§1.6).
--
-- `write` is stored as INTEGER because STRICT tables have no boolean type;
-- 0 = a read/plan assignment, which shares the primary tree and takes no hold.
-- ---------------------------------------------------------------------------
CREATE TABLE workspace_leases (
  id            TEXT    NOT NULL PRIMARY KEY,
  project_id    TEXT    NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  assignment_id TEXT    NOT NULL,
  kind          TEXT    NOT NULL,
  path          TEXT    NOT NULL,
  branch        TEXT,
  base_commit   TEXT,
  "write"       INTEGER NOT NULL,
  state         TEXT    NOT NULL DEFAULT 'active',
  acquired_at   TEXT    NOT NULL,
  released_at   TEXT
) STRICT;

-- The half of §4.3's serialization the database owns: an in-process mutex
-- cannot survive a crash-restart, and this index can.
CREATE UNIQUE INDEX workspace_leases_active_assignment
  ON workspace_leases (project_id, assignment_id) WHERE state = 'active';

-- "What is currently leased on this project" — the project page's workspace list.
CREATE INDEX workspace_leases_project ON workspace_leases (project_id, state);
