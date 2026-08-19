-- 0008_assignment_origin.sql — where an assignment came *from* (orchestrator
-- DESIGN §2.1, §2.3; WO8).
--
-- `created_by` already answers "who minted the row" — a user, the system, or
-- `overseer:<agentId>` — and it is not the question a background trigger makes
-- newly interesting. A trigger-launched assignment is minted by the core on the
-- owner's standing instruction: `created_by` stays `user`, because a schedule
-- the owner wrote is the owner's intent expressed once instead of hourly, and
-- rewriting it to `system` would move every trigger run outside the §9 rules
-- that apply to a human's launch. What was missing is the *channel*: did a
-- person press Start work, or did a timer.
--
-- Two columns rather than one, and neither is derivable from the other:
--
-- - `origin` is the closed vocabulary the UI and Usage branch on (`user` |
--   `trigger`). It defaults to `user`, which is the true reading of every row
--   written before triggers existed and of every hand-started one after.
-- - `trigger_id` names *which* standing instruction, so the six assignments a
--   nightly job produced are legible as one job rather than six coincidences —
--   the same argument 0006 makes for `template_id`, one level up.
--
-- Deliberately **not** a foreign key. A trigger the owner deleted must not take
-- its history with it, and `triggers.project_id` already cascades on the one
-- deletion that genuinely invalidates the row. An id that no longer resolves
-- reads as exactly what it is: this came from a schedule that is not here any
-- more.
--
-- The index is the scheduler's, not the UI's: singleflight ("is a previous run
-- from this trigger still open?") and the `maxRunsPerDay` count are both asked
-- on every tick, and both are `WHERE trigger_id = ?` against a table that grows
-- forever.
--
-- Applied inside the migration runner's transaction: no BEGIN/COMMIT and no
-- `IF NOT EXISTS`, per foundation §1.3 and the conventions of 0001-0007.
ALTER TABLE assignments ADD COLUMN origin     TEXT NOT NULL DEFAULT 'user';
ALTER TABLE assignments ADD COLUMN trigger_id TEXT;

CREATE INDEX assignments_by_trigger ON assignments (trigger_id, status);
