-- D1 schema, migration 0004: what issue #176 removes. Part 2 of 2.
--
--   wrangler d1 execute lantern-tiles --remote --file worker/schema-0004-drop-daily-board.sql
--
-- (`--local` instead of `--remote` for `wrangler dev`.)
--
-- ## Run this AFTER the Worker deploy, not before
--
-- Ordering, in full:
--
--   1. apply schema-0003   — creates the weekly tables and columns
--   2. deploy the Worker   — stops reading and writing everything below
--   3. apply this file     — removes it
--
-- Applying this before step 2 would break the running Worker: its profile
-- register and sync statements still bind `best_score` and `total_score`, so
-- every profile write would 500 until the new build is live.
--
-- ## This one destroys data, and it is not reversible
--
--   * `daily_scores` — every Daily Challenge board entry ever posted. The
--     Daily board is gone and the Daily no longer pays score to anything.
--   * `players.best_score`, `players.total_score` — the best-run score and the
--     lifetime total, both replaced by the single weekly score. Leaving them
--     would leave two numbers that nothing writes and that a later reader could
--     mistake for live.
--
-- Nothing here can be undone by re-running anything. Take a D1 export first if
-- the Daily history is worth keeping for anything (it is not read by any code
-- after this change).
--
-- ## Re-running
--
-- NOT a no-op. `DROP TABLE IF EXISTS` is guarded, but SQLite has no
-- `IF EXISTS` for `ALTER TABLE ... DROP COLUMN`, so the two statements below it
-- error on a second run and `wrangler d1 execute --file` stops there. On an
-- already-migrated database that is harmless — the work is done — but do not
-- read the error as "the migration failed".

DROP TABLE IF EXISTS daily_scores;

ALTER TABLE players DROP COLUMN best_score;
ALTER TABLE players DROP COLUMN total_score;
