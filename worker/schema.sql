-- D1 schema for the synced player profile (issue #138).
--
-- Apply it to the bound database before the profile routes can serve:
--
--   wrangler d1 create lantern-tiles
--   wrangler d1 execute lantern-tiles --remote --file worker/schema.sql
--
-- (`--local` instead of `--remote` for `wrangler dev`.) The statements are
-- `IF NOT EXISTS`, so re-running the file on a live database is a no-op —
-- schema *changes* get a new numbered file, never an edit to this one.

CREATE TABLE IF NOT EXISTS players (
  -- The public tag shown next to the display name (`Alex #7K3MQ2R9WD`).
  -- Random Crockford base32, not sequential: it must not leak signup order
  -- or how many players exist.
  id            TEXT    PRIMARY KEY,
  -- SHA-256 (hex) of the recovery code. The plaintext code is minted once,
  -- returned once, and never stored — this column is the password hash.
  code_hash     TEXT    NOT NULL UNIQUE,
  -- Display name: screened, but deliberately NOT unique (see profile.mjs).
  name          TEXT    NOT NULL,
  avatar        TEXT    NOT NULL,
  levels_cleared INTEGER NOT NULL DEFAULT 0,
  best_score     INTEGER NOT NULL DEFAULT 0,
  total_score    INTEGER NOT NULL DEFAULT 0,
  -- JSON array of cleared ladder levels. It is only ever read and written
  -- whole (the merge is a set union), so a row per level would buy nothing.
  cleared        TEXT    NOT NULL DEFAULT '[]',
  daily_streak   INTEGER NOT NULL DEFAULT 0,
  last_daily     TEXT,
  trophies       INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
