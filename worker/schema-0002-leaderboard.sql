-- D1 schema, migration 0002: the Daily Challenge leaderboard (issue #70).
--
-- Applied after worker/schema.sql, on the same database:
--
--   wrangler d1 execute lantern-tiles --remote --file worker/schema-0002-leaderboard.sql
--
-- (`--local` instead of `--remote` for `wrangler dev`.) Every statement is
-- `IF NOT EXISTS`, so re-running the file is a no-op — the next schema change
-- gets 0003, never an edit to this one.

CREATE TABLE IF NOT EXISTS daily_scores (
  -- The Daily's date key, `YYYY-MM-DD`. It is the whole reason this board is
  -- fair: the date fixes the layout and the seed for every player.
  date       TEXT    NOT NULL,
  -- The owner, from issue #138. The name shown on the board is read from
  -- `players` at query time, so a rename (or a screening refusal) reaches
  -- every entry the player has ever posted.
  player_id  TEXT    NOT NULL REFERENCES players(id),
  score      INTEGER NOT NULL,
  elapsed_ms INTEGER NOT NULL,
  -- The move history the score was submitted with. Stored, never read: the
  -- follow-up that verifies a score by replaying it needs this to exist from
  -- the day the board opens, or the first weeks of entries can never be
  -- checked. NULL for a client that sent none.
  history    TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  -- One entry per player per date; a resubmission moves it up or does nothing.
  PRIMARY KEY (date, player_id)
);

-- The board query, exactly: one date, ordered by score then by who got there
-- first. Covers the ranking count as well, which is the same predicate.
CREATE INDEX IF NOT EXISTS daily_scores_board
  ON daily_scores (date, score DESC, updated_at ASC, player_id ASC);

-- The withdraw path ("take me off the leaderboard") deletes by player across
-- every date, which the primary key cannot serve.
CREATE INDEX IF NOT EXISTS daily_scores_player ON daily_scores (player_id);
