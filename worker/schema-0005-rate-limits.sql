-- D1 schema, migration 0005: the shared rate limiter (issue #186).
--
-- Applied on the same database, before the Worker that reads it is deployed:
--
--   wrangler d1 execute lantern-tiles --remote --file worker/schema-0005-rate-limits.sql
--
-- (`--local` instead of `--remote` for `wrangler dev`.) `IF NOT EXISTS`, so
-- re-running the file is a no-op — the next schema change gets 0006, never an
-- edit to this one. The deploy gate (worker/scripts/check-schema.mjs) refuses
-- to ship a Worker while this table is missing from the live database.
--
-- One row per limiter key: `<route>:ip:<address>` or `<route>:player:<id>`.
-- The old limiter was a Map inside one Worker isolate, so its count reset
-- whenever Cloudflare recycled the isolate and was never shared between the
-- many isolates and colos serving the same caller. This table is the one
-- place every isolate agrees on. Rows are reused per key (an upsert), so the
-- table is bounded by the number of distinct keys; a daily cron in
-- worker/index.mjs deletes rows whose window ended more than a day ago.

CREATE TABLE IF NOT EXISTS rate_limits (
  key          TEXT    PRIMARY KEY,
  -- ms since epoch when the current fixed window opened.
  window_start INTEGER NOT NULL,
  -- Requests seen in that window, including the one that opened it.
  count        INTEGER NOT NULL
);
