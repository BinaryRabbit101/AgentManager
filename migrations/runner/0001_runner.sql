-- 0001_runner.sql — the runner element's own columns and tables (runner
-- DESIGN §3.5), shipped under foundation §1.3's element-migration mechanism.
--
-- `sessions`, `usage_events` and `session_usage` are foundation-shipped tables
-- that runner *owns* (§1), so the columns runner needs are added here rather
-- than in foundation's core set. Everything below is read by exactly one
-- element — this one.
--
-- Applied inside a transaction opened by the runner: no BEGIN/COMMIT here, and
-- no `IF NOT EXISTS` — the runner tracks applied versions in `schema_migrations`
-- and never re-runs a version, so a defensive guard would only hide a genuine
-- collision.
--
-- Conventions are foundation's (§1.3): plural table names, ULID text ids,
-- ISO-8601 UTC timestamps, STRICT tables, CASCADE for child rows.

-- ---------------------------------------------------------------------------
-- sessions — the eight columns §3.5 adds.
--
-- `role` is copied from `assignment_members.role` at admission rather than
-- joined at read time: the membership can change, and a session must keep
-- saying which seat it ran in (roster's system-prompt addendum was composed
-- from it).
--
-- `priority` and `weight` are copied at enqueue for the same reason the
-- scheduler exists at all — admission order must be decidable from one indexed
-- read over `sessions`, without reaching into roster for a weight or into
-- orchestrator for a band.
-- ---------------------------------------------------------------------------
ALTER TABLE sessions ADD COLUMN role           TEXT;
ALTER TABLE sessions ADD COLUMN lease_id       TEXT;
ALTER TABLE sessions ADD COLUMN resumed_from   TEXT;
ALTER TABLE sessions ADD COLUMN queued_at      TEXT;
ALTER TABLE sessions ADD COLUMN priority       TEXT NOT NULL DEFAULT 'normal'
                                               CHECK (priority IN ('interactive', 'normal'));
ALTER TABLE sessions ADD COLUMN weight         INTEGER NOT NULL DEFAULT 1;
ALTER TABLE sessions ADD COLUMN blocked_reason TEXT;
ALTER TABLE sessions ADD COLUMN turns          INTEGER NOT NULL DEFAULT 0;

-- The scheduler's one read: "the admissible queue, best band first, oldest
-- first within it" (§6.2). Covering, so admission never touches the table.
CREATE INDEX sessions_scheduler ON sessions (status, priority, queued_at);

-- ---------------------------------------------------------------------------
-- session_inputs — the durable launch request (§3.5).
--
-- Separate from `sessions` because it is written once and read once, and
-- because a prompt is unbounded text that no session listing should carry. It
-- is what makes a `queued` row survive a restart as something that can still be
-- launched (§9.2 item 2) rather than an empty intention.
-- ---------------------------------------------------------------------------
CREATE TABLE session_inputs (
  session_id       TEXT PRIMARY KEY REFERENCES sessions (id) ON DELETE CASCADE,
  prompt           TEXT NOT NULL,
  attachments_json TEXT NOT NULL DEFAULT '[]',
  created_at       TEXT NOT NULL
) STRICT;

-- ---------------------------------------------------------------------------
-- usage_events — the run discriminator and the dedupe key (§3.5, amended by
-- SDK-NOTES C1).
--
-- `source` separates the live per-assistant-message estimate from the
-- authoritative reconciliation against `result.modelUsage` (§7.1).
--
-- `run_id` is C1's required change and is **not** in §3.5 as written. The
-- pinned SDK documents `modelUsage` and `total_cost_usd` as cumulative per
-- `query()` call and states that "resumed sessions start fresh", so a
-- reconciliation baseline taken per *session row* goes negative across §9.4's
-- pause/resume path — which reuses the row with a new `query()` — and would
-- shrink `session_usage`, and with it `assignments.tokens_used`, back to the
-- resumed run's spend. One `run_id` per `query()` call makes the baseline
-- per-run, which is the only grain the SDK's numbers actually have.
--
-- The dedupe index therefore keys on all three: the same assistant message id
-- may legitimately reappear in a later run's replayed history, and a duplicate
-- *within* a run (parallel tool calls share one `message.id`) must still be a
-- no-op insert rather than a doubled count.
-- ---------------------------------------------------------------------------
ALTER TABLE usage_events ADD COLUMN source     TEXT NOT NULL DEFAULT 'turn'
                                               CHECK (source IN ('turn', 'reconcile'));
ALTER TABLE usage_events ADD COLUMN message_id TEXT;
ALTER TABLE usage_events ADD COLUMN run_id     TEXT;

CREATE UNIQUE INDEX usage_events_dedupe
  ON usage_events (session_id, run_id, message_id) WHERE message_id IS NOT NULL;
