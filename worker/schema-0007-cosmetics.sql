-- D1 schema, migration 0007: cosmetics bought with trophies (issue #229,
-- decision 0038).
--
--   wrangler d1 execute lantern-tiles --remote --file worker/schema-0007-cosmetics.sql
--
-- (`--local` instead of `--remote` for `wrangler dev`.)
--
-- ## Additive only, and it must run BEFORE the deploy
--
-- Three columns on `players`, all with defaults, so every existing row reads
-- as owning nothing and looking Lantern:
--
--   owned     JSON array of cosmetic item ids. Read and written whole, merged
--             as a set union (like `cleared`), so a row per item buys nothing.
--   looks     JSON object, one id per look kind (`{"glyphs": "..."}`). Stored
--             opaquely — the shop's item table is client code, and a build that
--             adds an item must not need a Worker deploy.
--   looks_at  Epoch ms of the last change to `looks`, or NULL. The merge takes
--             the later stamp's whole `looks` (last-write).
--
-- Nothing here deducts from `trophies`: the spendable balance is derived on
-- the device from `trophies` and the prices of what is owned, so the
-- never-regress merge stays exactly as 0037 left it.
--
-- Same ordering as 0003 and 0006: the Worker built with issue #229's code
-- binds these columns on every profile write, so apply this file before that
-- Worker is deployed or every register/sync 500s until the columns exist.
-- `worker/scripts/check-schema.mjs` is the deploy gate that enforces it.
--
-- ## Re-running
--
-- NOT a no-op. SQLite has no `ADD COLUMN IF NOT EXISTS`, so a second run
-- errors. Check what is there before re-running:
--
--   wrangler d1 execute lantern-tiles --remote --command "PRAGMA table_info(players)"

ALTER TABLE players ADD COLUMN owned TEXT NOT NULL DEFAULT '[]';
ALTER TABLE players ADD COLUMN looks TEXT NOT NULL DEFAULT '{}';
ALTER TABLE players ADD COLUMN looks_at INTEGER;
