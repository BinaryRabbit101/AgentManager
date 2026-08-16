-- 0001_init.sql — foundation's core schema.
--
-- M4 scope: `schema_meta` only. The full core table inventory of DESIGN §1.4
-- (agents, projects, assignments, assignment_members, sessions, usage_events,
-- session_usage, messages, questions, question_recommendations, events,
-- remote_tokens, settings) is milestone M5's, which owns the call between
-- extending this file and adding 0002.
--
-- Applied inside a transaction opened by the runner: no BEGIN/COMMIT here.

-- Key/value facts about this installation: schema version, install id,
-- created_at. Seeded by `openStorage` rather than by this file, because the
-- install id is a runtime-minted ULID and created_at comes from the injectable
-- clock (§1.3, §6.1).
CREATE TABLE schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;
