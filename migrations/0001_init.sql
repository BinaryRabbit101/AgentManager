-- 0001_init.sql — foundation's core schema (DESIGN §1.4).
--
-- Every table more than one element touches. Element-owned tables live in
-- element migration sets (`migrations/<moduleId>/NNNN_*.sql`, §1.3) and are
-- deliberately absent here.
--
-- Conventions, all from §1.3:
--   * Table names are plural, without exception.
--   * Ids are application-generated ULID strings; no autoincrement integers
--     appear in a cross-element contract.
--   * Timestamps are ISO-8601 UTC strings (`2026-08-16T10:35:00.000Z`), which
--     sort lexicographically and are readable in a DB browser.
--   * Every table is STRICT, so a value of the wrong type is rejected at write
--     time rather than discovered as a mis-typed row much later.
--
-- Applied inside a transaction opened by the runner: no BEGIN/COMMIT here.
--
-- Referential integrity follows §1.4's two rules:
--   * ON DELETE RESTRICT where the referenced row owns history — deleting a
--     project or an assignment that has sessions is refused; archive instead.
--   * ON DELETE CASCADE for child rows, which §1.4 names as
--     `assignment_members`, `question_recommendations` and `usage_events`.
-- Two consequences of those rules are spelled out where they apply below:
-- `sessions.agent_id` has no foreign key at all, and `events` has none either.

-- ---------------------------------------------------------------------------
-- schema_meta — key/value facts about this installation (§1.4).
--
-- Seeded by `openStorage` rather than by this file: the install id is a
-- runtime-minted ULID and `created_at` comes from the injectable clock.
-- ---------------------------------------------------------------------------
CREATE TABLE schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

-- ---------------------------------------------------------------------------
-- schema_migrations — the element-owned migration ledger (§1.3).
--
-- One row per applied module migration. `PRAGMA user_version` stays reserved
-- for foundation's own numbered set, so "the two mechanisms never contend":
-- nothing here ever describes foundation's schema, and `user_version` never
-- describes a module's.
--
-- Created by foundation's set because foundation's set always runs first, which
-- is what lets a module's very first migration be recorded in the same
-- transaction that applies it.
-- ---------------------------------------------------------------------------
CREATE TABLE schema_migrations (
  module     TEXT    NOT NULL,
  version    INTEGER NOT NULL,
  applied_at TEXT    NOT NULL,
  PRIMARY KEY (module, version)
) STRICT;

-- ---------------------------------------------------------------------------
-- agents — a rebuildable index of `library/agents/*` (§1.4).
--
-- Files are truth. Foundation never reads the library to build this; roster
-- pushes rows through the service registry and foundation writes what it is
-- given. Because the table is an index rather than a record of fact, **nothing
-- references it with a foreign key** — a full reindex must be free to delete
-- and reinsert every row, and deleting an agent must not destroy its history.
-- ---------------------------------------------------------------------------
CREATE TABLE agents (
  id           TEXT    PRIMARY KEY,          -- = the library folder name
  name         TEXT    NOT NULL,
  specialty    TEXT,
  model        TEXT,                         -- flattened: the resolved alias or id
  is_overseer  INTEGER NOT NULL DEFAULT 0,
  archived_at  TEXT,                         -- carried so an archived agent still renders in a join
  source_path  TEXT,
  content_hash TEXT,
  indexed_at   TEXT    NOT NULL
) STRICT;

-- ---------------------------------------------------------------------------
-- projects — the machine-bound project registry (§1.4).
--
-- Columns are specified by the projects element; foundation ships the table
-- because sessions, assignments and events all key on it.
-- ---------------------------------------------------------------------------
CREATE TABLE projects (
  id               TEXT PRIMARY KEY,
  slug             TEXT NOT NULL UNIQUE,
  name             TEXT NOT NULL,
  local_path       TEXT,
  local_path_key   TEXT UNIQUE,              -- canonical lowercased identity key
  repo_url         TEXT,
  default_branch   TEXT,
  vcs              TEXT,
  notes            TEXT,
  status           TEXT NOT NULL DEFAULT 'active',
  workspace_policy TEXT,
  defaults_json    TEXT,
  retention_json   TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  last_activity_at TEXT,
  archived_at      TEXT
) STRICT;

-- ---------------------------------------------------------------------------
-- assignments — the unit every session belongs to (§1.4).
--
-- `status` is exactly the two values orchestrator §2.2 fixes. The richer
-- lifecycle state machine arrives as an orchestrator-owned `phase` column in
-- orchestrator's own migration; this column stays the two-state fact every
-- element joins on, which is why the CHECK is safe to pin here.
-- ---------------------------------------------------------------------------
CREATE TABLE assignments (
  id           TEXT    PRIMARY KEY,
  project_id   TEXT    NOT NULL REFERENCES projects (id) ON DELETE RESTRICT,
  pattern      TEXT    NOT NULL CHECK (pattern IN ('solo', 'pair', 'review', 'overseer')),
  scope_json   TEXT,
  goal         TEXT,
  status       TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  token_budget INTEGER,
  tokens_used  INTEGER NOT NULL DEFAULT 0,
  round_cap    INTEGER,
  rounds_used  INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT    NOT NULL,
  closed_at    TEXT,
  close_reason TEXT
) STRICT;

-- Every "the assignments of this project, newest first" read, which is what the
-- projects activity view and the orchestrator's open-work scan both do.
CREATE INDEX assignments_project_idx ON assignments (project_id, created_at);

-- ---------------------------------------------------------------------------
-- assignment_members — who is in an assignment, and as what (§1.4).
--
-- The five roles are the v1 vocabulary everywhere: roster's
-- `capabilities.roles`, its `roles/<role>.md` addenda, and orchestrator's
-- patterns all key on exactly these strings.
--
-- `agent_id` carries no foreign key for the same reason `sessions.agent_id`
-- does not: `agents` is a rebuildable index, not the source of truth.
-- ---------------------------------------------------------------------------
CREATE TABLE assignment_members (
  assignment_id TEXT NOT NULL REFERENCES assignments (id) ON DELETE CASCADE,
  agent_id      TEXT NOT NULL,
  role          TEXT NOT NULL
                CHECK (role IN ('implementer', 'architect', 'skeptic', 'reviewer', 'overseer')),
  PRIMARY KEY (assignment_id, agent_id)
) STRICT;

-- "Which assignments is this agent on" — the roster/UI per-agent view, and the
-- reverse of the primary key, which only serves the forward direction.
CREATE INDEX assignment_members_agent_idx ON assignment_members (agent_id);

-- ---------------------------------------------------------------------------
-- sessions — one run of one agent (§1.4).
--
-- `assignment_id` is NOT NULL by design: a solo launch creates a trivial
-- assignment rather than a session without one, which is what makes budgets,
-- scope and question attribution uniform instead of special-cased.
--
-- `agent_id` deliberately has **no** foreign key: deleting an agent from the
-- library must not destroy its session history, and the UI renders an unknown
-- agent id as "deleted agent". Roster's purge guard therefore asks
-- `sessions.countByAgent(agentId)` instead of leaning on the database to refuse
-- the delete.
--
-- There is no `transcript_available` column: it is derived as
-- `transcript_path IS NOT NULL`, and the pruner that deletes a transcript file
-- NULLs the path in the same transaction. Token totals are not duplicated here
-- either — the input/output split lives in `session_usage`.
-- ---------------------------------------------------------------------------
CREATE TABLE sessions (
  id               TEXT    PRIMARY KEY,
  assignment_id    TEXT    NOT NULL REFERENCES assignments (id) ON DELETE RESTRICT,
  agent_id         TEXT    NOT NULL,          -- no FK, deliberately (above)
  project_id       TEXT    NOT NULL REFERENCES projects (id) ON DELETE RESTRICT,
  status           TEXT    NOT NULL DEFAULT 'queued'
                   CHECK (status IN ('queued', 'running', 'paused', 'done',
                                     'failed', 'interrupted', 'orphaned')),
  sdk_session_id   TEXT,
  model            TEXT,
  permission_mode  TEXT,
  origin           TEXT    NOT NULL DEFAULT 'local' CHECK (origin IN ('local', 'remote')),
  transcript_path  TEXT,                      -- relative to <dataRoot>/state/transcripts (§1.5)
  transcript_bytes INTEGER NOT NULL DEFAULT 0,
  summary          TEXT,                      -- one-line digest, so a timeline renders without a transcript
  pinned           INTEGER NOT NULL DEFAULT 0,-- exempt from transcript pruning
  started_at       TEXT,
  ended_at         TEXT,
  exit_reason      TEXT
) STRICT;

-- §1.4 names all three explicitly.
-- agent_id:      roster's purge guard, `countByAgent`.
-- project_id:    the per-project timeline, and `SUM(transcript_bytes)` for the
--                projects size cap — which is a covering read of this index
--                only because the summed column is carried in it.
-- assignment_id: every "the sessions of this assignment" read.
CREATE INDEX sessions_agent_idx      ON sessions (agent_id);
CREATE INDEX sessions_project_idx    ON sessions (project_id, transcript_bytes);
CREATE INDEX sessions_assignment_idx ON sessions (assignment_id);

-- Boot reconciliation (§4.2) moves `running` sessions from a previous life to
-- `orphaned`; without this it is a full scan of every session ever run.
CREATE INDEX sessions_status_idx ON sessions (status);

-- ---------------------------------------------------------------------------
-- usage_events — append-only per-turn token deltas (§1.4).
--
-- A child row of a session, hence CASCADE.
-- ---------------------------------------------------------------------------
CREATE TABLE usage_events (
  id                    TEXT    PRIMARY KEY,
  session_id            TEXT    NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  ts                    TEXT    NOT NULL,
  input_tokens          INTEGER NOT NULL DEFAULT 0,
  output_tokens         INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  model                 TEXT
) STRICT;

-- The UI's per-session cost chart is exactly this: one session's deltas in time
-- order.
CREATE INDEX usage_events_session_idx ON usage_events (session_id, ts);

-- ---------------------------------------------------------------------------
-- session_usage — the rollup, written in the same transaction as the delta.
--
-- Exists so the orchestrator checks a budget with one indexed read instead of a
-- SUM over `usage_events`. Writing both in one transaction is what keeps them
-- from drifting (§8).
-- ---------------------------------------------------------------------------
CREATE TABLE session_usage (
  session_id            TEXT    PRIMARY KEY REFERENCES sessions (id) ON DELETE CASCADE,
  input_tokens          INTEGER NOT NULL DEFAULT 0,
  output_tokens         INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  -- The sum of the four counters above, maintained in the same statement.
  -- Budgets are checked against one number, and a budget that silently ignored
  -- cache tokens would under-count what the plan window actually spent.
  total_tokens          INTEGER NOT NULL DEFAULT 0,
  events                INTEGER NOT NULL DEFAULT 0,
  updated_at            TEXT    NOT NULL
) STRICT;

-- ---------------------------------------------------------------------------
-- messages — the mailbox (§1.4).
--
-- "A mailbox is a query: `to_agent_id = ? AND read_at IS NULL ORDER BY
-- created_at`." `to_agent_id` NULL means broadcast.
--
-- CASCADE from the assignment: an assignment that can be deleted at all has no
-- sessions (they RESTRICT it), so it is an aborted shell, and its undelivered
-- mail has nowhere to be delivered to.
-- ---------------------------------------------------------------------------
CREATE TABLE messages (
  id            TEXT NOT NULL PRIMARY KEY,
  assignment_id TEXT NOT NULL REFERENCES assignments (id) ON DELETE CASCADE,
  from_agent_id TEXT,
  to_agent_id   TEXT,                          -- NULL = broadcast
  kind          TEXT NOT NULL,
  body          TEXT,
  payload_json  TEXT,
  created_at    TEXT NOT NULL,
  delivered_at  TEXT,
  read_at       TEXT
) STRICT;

-- The mailbox query, exactly: equality on `to_agent_id`, equality on
-- `read_at IS NULL`, and `created_at` trailing so the ORDER BY is satisfied by
-- the index rather than by a sort.
CREATE INDEX messages_mailbox_idx ON messages (to_agent_id, read_at, created_at);

-- The conversation view for one assignment is an ordered merge of turns and
-- messages; this is the messages half of it.
CREATE INDEX messages_assignment_idx ON messages (assignment_id, created_at);

-- ---------------------------------------------------------------------------
-- questions — the persisted question inbox (§1.4).
--
-- Persisted so an open question survives a core restart and is answerable from
-- the tailnet browser: "never stranded on the desktop".
-- ---------------------------------------------------------------------------
CREATE TABLE questions (
  id            TEXT NOT NULL PRIMARY KEY,
  assignment_id TEXT NOT NULL REFERENCES assignments (id) ON DELETE CASCADE,
  session_id    TEXT REFERENCES sessions (id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('question', 'approval_gate', 'budget_halt')),
  status        TEXT NOT NULL DEFAULT 'open'
                CHECK (status IN ('open', 'answered', 'cancelled', 'expired')),
  prompt        TEXT NOT NULL,
  options_json  TEXT,
  created_at    TEXT NOT NULL,
  answered_at   TEXT,
  answer_json   TEXT,
  answered_via  TEXT CHECK (answered_via IS NULL OR answered_via IN ('local', 'remote'))
) STRICT;

-- The inbox itself: every open question, oldest first. Partial on the status
-- that is queried, because answered questions accumulate forever and open ones
-- are a handful.
CREATE INDEX questions_open_idx ON questions (created_at) WHERE status = 'open';

-- One assignment's questions, for the assignment detail view.
CREATE INDEX questions_assignment_idx ON questions (assignment_id, created_at);

-- ---------------------------------------------------------------------------
-- question_recommendations — the per-agent recommendation the UI renders.
--
-- A child row of a question, hence CASCADE. The shape of `strength` is
-- orchestrator's call, so it is stored as given.
-- ---------------------------------------------------------------------------
CREATE TABLE question_recommendations (
  question_id TEXT NOT NULL REFERENCES questions (id) ON DELETE CASCADE,
  agent_id    TEXT NOT NULL,
  stance      TEXT NOT NULL,
  rationale   TEXT,
  strength    TEXT,
  PRIMARY KEY (question_id, agent_id)
) STRICT;

-- ---------------------------------------------------------------------------
-- events — the append-only structured event spine (§1.4, §6.5).
--
-- Every bus event with `persist: true` lands here. Powers UI replay after a
-- dropped connection (`since=<id>`, and the ids are ULIDs so a watermark is a
-- string comparison) and post-hoc debugging.
--
-- **No foreign keys, deliberately.** An event about a project is a fact that
-- outlives the project: a RESTRICT reference would make the event log block the
-- deletes it merely observed, and a CASCADE one would erase the audit trail of
-- exactly the deletion someone is investigating. Retention (30 days / 200k
-- rows, pruned on boot) is what bounds this table, not referential integrity.
-- ---------------------------------------------------------------------------
CREATE TABLE events (
  id            TEXT NOT NULL PRIMARY KEY,
  ts            TEXT NOT NULL,
  type          TEXT NOT NULL,
  session_id    TEXT,
  assignment_id TEXT,
  project_id    TEXT,
  agent_id      TEXT,
  payload_json  TEXT
) STRICT;

-- Age-based retention deletes by `ts`; the row-cap prune and the `since=<id>`
-- replay both walk the primary key, which is already an index.
CREATE INDEX events_ts_idx ON events (ts, id);

-- `/api/events?types=` filters the replay by exact type or `prefix.*`, and
-- trailing `id` keeps the watermark walk inside the index.
CREATE INDEX events_type_idx ON events (type, id);

-- ---------------------------------------------------------------------------
-- remote_tokens — bearer credentials, hashes only (§1.4, §3.4).
--
-- The table exists in both editions (harmless); only the remote module reads
-- it. A token is shown to the user exactly once and stored as `sha256(token)`
-- with a 6-character display prefix, so it can be revoked and reissued but
-- never recovered — and a compromise of the secrets envelope yields no remote
-- access.
-- ---------------------------------------------------------------------------
CREATE TABLE remote_tokens (
  id           TEXT PRIMARY KEY,
  label        TEXT NOT NULL,
  device       TEXT,
  token_hash   TEXT NOT NULL UNIQUE,          -- sha256 hex; UNIQUE is also the verification lookup
  token_prefix TEXT NOT NULL,                 -- 6 chars, for human recognition only
  created_at   TEXT NOT NULL,
  last_used_at TEXT,
  expires_at   TEXT,
  revoked_at   TEXT
) STRICT;

-- ---------------------------------------------------------------------------
-- settings — runtime-mutable state that is *not* configuration (§1.4, §2.4).
--
-- Config is immutable for the process lifetime; anything the UI toggles lives
-- here, so a config-file rewrite cannot clobber it. Remote stores one row per
-- agent under `remote.agentAccess.<id>`, which is why `listByPrefix` is a
-- shipped repository method: absence *is* the disabled state, so revocation
-- deletes a row rather than rewriting a blob.
-- ---------------------------------------------------------------------------
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
