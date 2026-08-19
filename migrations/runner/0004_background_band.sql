-- 0004_background_band.sql — the third admission band: work nobody is waiting
-- for (runner DESIGN §6.2; orchestrator §2.8; WO8).
--
-- §6.2 shipped two bands. `interactive` means a human is waiting; `normal` is
-- everything else, orchestrator's worker turns included. Background triggers add
-- a third case that neither describes: a session that started **because a timer
-- said so**, which must never take a slot from work the owner asked for (D2).
--
-- ## Why this is a flag beside `priority` and not a third value of it
--
-- `priority` was added by `0001_runner.sql` as
-- `TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('interactive', 'normal'))`.
-- SQLite cannot drop or widen a CHECK: doing so means the twelve-step table
-- rebuild, and `sessions` is a STRICT table that three foreign keys point at,
-- one of them `ON DELETE CASCADE`. Rebuilding it inside the migration runner's
-- transaction — which cannot toggle `PRAGMA foreign_keys` — would risk exactly
-- the silent data loss the rest of this schema is careful to refuse. A third
-- band is not worth that price.
--
-- So the *band* becomes a pair — `(priority, background)` — read through one
-- ranking function (`bandRank` in `src/modules/runner/scheduler.ts`), which is
-- still the single ordering the one queue is sorted by. Nothing here is a second
-- queue: the scheduler makes exactly the same `list({ status: 'queued' })` read,
-- in exactly the same loop, and only the comparator learned a third case.
--
-- `INTEGER NOT NULL DEFAULT 0` so every existing row reads as "not background"
-- without a backfill — which is the true reading of every session queued before
-- triggers existed, and the safe direction to default: a row mislabelled
-- background would be starved, and a row mislabelled foreground merely competes.
--
-- The index is replaced rather than added to: `sessions_scheduler` exists to
-- cover the admission read, and a covering index that omits the column the
-- comparator now reads is an index that stopped covering it.
--
-- Applied inside a transaction opened by the migration runner: no BEGIN/COMMIT
-- here, and no `IF NOT EXISTS`.
ALTER TABLE sessions ADD COLUMN background INTEGER NOT NULL DEFAULT 0;

DROP INDEX sessions_scheduler;

CREATE INDEX sessions_scheduler ON sessions (status, priority, background, queued_at);
