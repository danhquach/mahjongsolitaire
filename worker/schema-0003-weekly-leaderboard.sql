-- D1 schema, migration 0003: the weekly leaderboard (issue #176), part 1 of 2.
--
--   wrangler d1 execute lantern-tiles --remote --file worker/schema-0003-weekly-leaderboard.sql
--
-- (`--local` instead of `--remote` for `wrangler dev`.)
--
-- ## Additive only, and that is deliberate
--
-- This file only creates and adds. Everything issue #176 *removes* is in
-- schema-0004, so the two can be applied either side of the Worker deploy:
--
--   1. apply 0003          — old Worker still works: the columns it writes
--                            (`best_score`, `total_score`) are still there
--   2. deploy the Worker   — it now writes `week_score` / `week_start` and the
--                            `weekly_*` tables, all of which exist by now
--   3. apply 0004          — drops what nothing reads any more
--
-- Doing it in one file would mean the old Worker's profile writes 500 from the
-- moment the migration lands until the new one is live: a mandatory outage
-- window, for no benefit.
--
-- ## Re-running, and recovering from a partial run
--
-- NOT a no-op, unlike schema.sql and schema-0002. SQLite has no
-- `ADD COLUMN IF NOT EXISTS`, so the two `ALTER TABLE` statements at the end
-- error on a second run, and `wrangler d1 execute --file` is not transactional
-- across statements and stops at the first error. The `CREATE`s above them are
-- all `IF NOT EXISTS` and will have succeeded.
--
-- So do NOT re-run the file to fix a partial run: it would abort on the first
-- `ADD COLUMN` (already exists) and never reach the second, leaving
-- `week_start` missing while looking like it failed for an unrelated reason.
-- Check what is actually there and add only what is missing:
--
--   wrangler d1 execute lantern-tiles --remote --command "PRAGMA table_info(players)"
--   wrangler d1 execute lantern-tiles --remote --command \
--     "ALTER TABLE players ADD COLUMN week_score INTEGER NOT NULL DEFAULT 0"
--   wrangler d1 execute lantern-tiles --remote --command \
--     "ALTER TABLE players ADD COLUMN week_start TEXT"
--
-- The Worker's profile register and sync both bind `week_score` and
-- `week_start`, so if either column is missing every profile write fails.

-- --- the weekly standing ------------------------------------------------------

CREATE TABLE IF NOT EXISTS weekly_scores (
  -- The Sunday that opens the week, `YYYY-MM-DD`, in UTC. Decided by the
  -- server's own clock and never accepted from a client: a client-supplied
  -- week would split the board into overlapping buckets across ~27 hours of
  -- local boundaries.
  week_start TEXT    NOT NULL,
  -- The owner, from issue #138. The name shown is read from `players` at query
  -- time, so a rename (or a screening refusal) reaches every entry at once.
  player_id  TEXT    NOT NULL REFERENCES players(id),
  -- Score *accumulated* over the week, unlike the Daily board's one-row-per-
  -- deal-that-only-moves-up. Every ladder clear adds to it, up to the ceiling
  -- `MAX_WEEK_SCORE` applies in the ON CONFLICT clause.
  score      INTEGER NOT NULL DEFAULT 0,
  -- How many runs went into `score`, and the column the per-week run cap is
  -- enforced against. Accumulation removed the absolute ceiling a max()
  -- standing had, and an IP-keyed rate limiter is not where score integrity
  -- can live — so the cap lives here, where it cannot be evaded.
  runs       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  -- One standing per player per week.
  PRIMARY KEY (week_start, player_id)
);

-- The board query, exactly: one week, ordered by score then by who got there
-- first. Covers the ranking count as well, which is the same predicate.
CREATE INDEX IF NOT EXISTS weekly_scores_board
  ON weekly_scores (week_start, score DESC, updated_at ASC, player_id ASC);

-- The withdraw path ("take me off the leaderboard") deletes by player across
-- every week, which the primary key cannot serve.
CREATE INDEX IF NOT EXISTS weekly_scores_player ON weekly_scores (player_id);

-- --- one row per run, for score verification ----------------------------------
--
-- The standing accumulates, so it cannot also hold the move history of the run
-- that produced it. Issue #176 keeps history "stored per submission" for the
-- verification follow-up, which needs the individual runs, so the runs get
-- their own table: the standing is what is ranked, this is what is checkable.
--
-- Nothing prunes this table yet. The per-week run cap bounds how fast one
-- player can grow it; a retention rule (drop rows older than N weeks) is the
-- follow-up, and is wanted before this has been live long.

CREATE TABLE IF NOT EXISTS weekly_submissions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  week_start TEXT    NOT NULL,
  player_id  TEXT    NOT NULL REFERENCES players(id),
  -- The single run's score, bounded by what one flawless board can pay at the
  -- highest difficulty multiplier. The bound applies here, to each score being
  -- added — never to the standing it accumulates into.
  score      INTEGER NOT NULL,
  elapsed_ms INTEGER NOT NULL,
  -- Stored, never read: the follow-up that verifies a score by replaying it
  -- needs this to exist from the day the board opens, or the first weeks can
  -- never be checked. NULL for a client that sent none.
  history    TEXT,
  created_at INTEGER NOT NULL
);

-- Withdraw deletes a player's runs as well as their standing: "withdraw
-- removes every entry" has to mean every entry.
CREATE INDEX IF NOT EXISTS weekly_submissions_player ON weekly_submissions (player_id);
CREATE INDEX IF NOT EXISTS weekly_submissions_week ON weekly_submissions (week_start, player_id);

-- --- the weekly score on the player row ---------------------------------------
--
-- It syncs like the other counters, so a device that has been offline can merge
-- against it. Deliberately new columns rather than a reuse of `total_score`:
-- a lifetime total read as "this week's score" would put every established
-- player at the top of the first weekly board.

ALTER TABLE players ADD COLUMN week_score INTEGER NOT NULL DEFAULT 0;
ALTER TABLE players ADD COLUMN week_start TEXT;
