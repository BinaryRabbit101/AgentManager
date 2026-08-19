-- 0007_triggers.sql — standing instructions that fire a task template on a
-- schedule (orchestrator DESIGN §2.3 path 4, §2.8; WO8).
--
-- A trigger is *when* + *what*. The *what* is exactly a WO5 template
-- application, so this table stores no task shape of its own: it names the
-- template, the project, the seats and the variables that fill the template's
-- placeholders, and the scheduler hands all four to the one creation function
-- §2.3 already funnels the other three paths through.
--
-- **A table, not a library file.** Foundation §1.1's split read honestly: a
-- template is shareable content an owner edits in git, but a schedule is
-- operational state — it references a *local* project id, it is mutated
-- concurrently by the scheduler and by the UI, and `next_fire_at` changes
-- several times an hour. A file that a timer rewrites is a file that loses a
-- write.
--
-- Conventions are foundation's (§1.3): plural table name, ULID text ids,
-- ISO-8601 UTC timestamps, STRICT, INTEGER 0/1 for flags, CASCADE for child
-- rows. Applied inside the migration runner's transaction: no BEGIN/COMMIT and
-- no `IF NOT EXISTS`, per the conventions of 0001-0006.

-- ---------------------------------------------------------------------------
-- triggers
--
-- `template_id` carries no foreign key and is never validated against the
-- library, for the reason 0006 gives for `assignments.template_id`: templates
-- are files an owner may rename, delete or `git checkout` past (roster §2.1). A
-- trigger whose template has gone is **blocked at fire time with a named
-- reason**, which the owner can see and fix, rather than a row that fails to
-- load.
--
-- `project_id` *does* cascade: a schedule pointed at a project that no longer
-- exists is not a schedule, it is a timer that can only ever fail.
--
-- `agent_ids_json` and `variables_json` are JSON columns rather than child
-- tables under the same foundation §1.1 rule the pre-grants column follows
-- (0004): both sets are written whole, read whole by exactly one reader, and
-- never queried by predicate.
--
-- `active_from_hour` / `active_to_hour` are **local** hours, 0-23, and are
-- either both set or both NULL — NULL meaning "always". Two integers rather
-- than a JSON object because the scheduler compares them on every tick and an
-- hour window is the whole v1 vocabulary (cron expressions are deferred, WO8).
-- A window whose `to` is not after its `from` wraps midnight, which is how
-- "22 → 6" is expressed without a second column.
--
-- `max_runs_per_day` is a cap, not a counter: the count itself is derived from
-- `assignments.trigger_id` (0008), because a counter column and the assignment
-- rows it is supposed to describe are two sources of truth that a crash between
-- two writes puts permanently out of step.
--
-- `last_outcome*` is what the UI's row renders when a trigger is not simply
-- running: the last fire's verdict, its reason, and when. It is a projection of
-- the events of §11.4 kept on the row on purpose — an event log is not
-- queryable per trigger without a scan, and "why is this one not doing
-- anything" has to be answerable in the same request that lists them.
-- ---------------------------------------------------------------------------
CREATE TABLE triggers (
  id                   TEXT    PRIMARY KEY,
  project_id           TEXT    NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  template_id          TEXT    NOT NULL,
  agent_ids_json       TEXT    NOT NULL DEFAULT '[]',
  every_minutes        INTEGER NOT NULL,
  active_from_hour     INTEGER,
  active_to_hour       INTEGER,
  enabled              INTEGER NOT NULL DEFAULT 1,
  variables_json       TEXT    NOT NULL DEFAULT '{}',
  max_runs_per_day     INTEGER,
  last_fired_at        TEXT,
  next_fire_at         TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_outcome         TEXT
                       CHECK (last_outcome IS NULL OR
                              last_outcome IN ('fired', 'skipped', 'blocked', 'disabled')),
  last_outcome_reason  TEXT,
  last_outcome_at      TEXT,
  created_at           TEXT    NOT NULL,
  updated_at           TEXT
) STRICT;

-- "Which enabled triggers are due" — the one query the scheduler makes on every
-- tick, and the only reason this table is read at all between edits.
CREATE INDEX triggers_due ON triggers (enabled, next_fire_at);

-- The project page's Triggers section (ui §8.2).
CREATE INDEX triggers_by_project ON triggers (project_id);
