-- 0001_orchestrator.sql — the orchestrator element's own columns and tables
-- (orchestrator DESIGN §2.1), shipped under foundation §1.3's element-migration
-- mechanism.
--
-- `assignments`, `assignment_members` and `messages` are foundation-shipped
-- tables that orchestrator *owns* (§1), so the columns this element needs are
-- added here rather than in foundation's core set.
--
-- The split between `assignments.status` and `assignments.phase` is the whole
-- reason this file exists (§2.2, §17 R7). `status` is foundation's two-state
-- admission gate — `open` | `closed` — and is the only thing runner reads.
-- `phase` is orchestrator's own state machine, read by the UI and by the pattern
-- driver. One column cannot be both a coarse gate and a state machine without
-- lying to one of its two consumers.
--
-- Applied inside a transaction opened by the migration runner: no BEGIN/COMMIT
-- here, and no `IF NOT EXISTS` — applied versions are tracked in
-- `schema_migrations` under `orchestrator` and are never re-run, so a defensive
-- guard would only hide a genuine collision.
--
-- Conventions are foundation's (§1.3): plural table names, ULID text ids,
-- ISO-8601 UTC timestamps, STRICT tables, CASCADE for child rows.

-- ---------------------------------------------------------------------------
-- assignments — the nine columns §2.1 adds.
--
-- `phase` defaults to `planned` rather than `running` because the default is
-- what a row created by anything that does not know about phases would get, and
-- "not started" is the safe reading of that. `createSolo` sets `running`
-- explicitly (§2.3 path 1).
--
-- `write` is an INTEGER 0/1 because STRICT tables have no BOOLEAN type; it is
-- the flag roster's compiler turns into a mutating-tool deny floor (§2.5, R2).
--
-- `parent_assignment_id` carries no foreign key on purpose: the nesting rule of
-- §9-3 is enforced in the validator, and a self-referencing CASCADE would delete
-- a whole tree of children when a parent is removed, which is exactly the
-- silent data loss projects §4.4 refuses elsewhere.
-- ---------------------------------------------------------------------------
ALTER TABLE assignments ADD COLUMN created_by           TEXT NOT NULL DEFAULT 'user';
ALTER TABLE assignments ADD COLUMN parent_assignment_id TEXT;
ALTER TABLE assignments ADD COLUMN lead_agent_id        TEXT;
ALTER TABLE assignments ADD COLUMN write                INTEGER NOT NULL DEFAULT 1;
ALTER TABLE assignments ADD COLUMN artifact_path        TEXT;
ALTER TABLE assignments ADD COLUMN pattern_config_json  TEXT NOT NULL DEFAULT '{}';
ALTER TABLE assignments ADD COLUMN phase                TEXT NOT NULL DEFAULT 'planned';
ALTER TABLE assignments ADD COLUMN halt_reason          TEXT;
ALTER TABLE assignments ADD COLUMN updated_at           TEXT;

-- "The open assignments of this project, most recently touched first" — the
-- scan §2.6's overlap check and the boot reconciliation of M1 both make.
CREATE INDEX assignments_open ON assignments (project_id, status, updated_at);

-- ---------------------------------------------------------------------------
-- assignment_members — seat ordering and the join timestamp (§2.1, §2.4).
--
-- Seat order is fixed by the pattern definition, not by insertion order, so it
-- is stored rather than derived from the primary key.
-- ---------------------------------------------------------------------------
ALTER TABLE assignment_members ADD COLUMN seat_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE assignment_members ADD COLUMN joined_at  TEXT;

-- ---------------------------------------------------------------------------
-- assignment_turns — one row per seat-turn, the persisted state `plan()` is a
-- pure function of (§3.1). Written by the pattern engine (M5); created here so
-- the schema arrives in one migration rather than one per milestone.
--
-- `assignment_turns_active` is the crash-safe guard against double-launching a
-- turn: v1's patterns are sequential, so at most one planned-or-running turn may
-- exist per assignment, and the database says so rather than an in-process flag
-- that a restart forgets.
-- ---------------------------------------------------------------------------
CREATE TABLE assignment_turns (
  id              TEXT    PRIMARY KEY,
  assignment_id   TEXT    NOT NULL REFERENCES assignments (id) ON DELETE CASCADE,
  round           INTEGER NOT NULL,
  seat            TEXT    NOT NULL,
  agent_id        TEXT    NOT NULL,
  session_id      TEXT,
  prev_session_id TEXT,
  status          TEXT    NOT NULL
                  CHECK (status IN ('planned', 'running', 'reported', 'unstructured',
                                    'blocked', 'failed')),
  report_json     TEXT,
  output_text     TEXT,
  artifact_hash   TEXT,
  started_at      TEXT,
  ended_at        TEXT
) STRICT;

CREATE INDEX assignment_turns_read ON assignment_turns (assignment_id, round, seat);

CREATE UNIQUE INDEX assignment_turns_active
  ON assignment_turns (assignment_id) WHERE status IN ('planned', 'running');

-- ---------------------------------------------------------------------------
-- message_reads — per-recipient read state for broadcasts (§5).
--
-- `messages.read_at` stays as the direct-message convenience, set when the sole
-- recipient reads it; a broadcast has no sole recipient, so its read state
-- cannot live on the message row.
-- ---------------------------------------------------------------------------
CREATE TABLE message_reads (
  message_id TEXT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  agent_id   TEXT NOT NULL,
  read_at    TEXT NOT NULL,
  PRIMARY KEY (message_id, agent_id)
) STRICT;
