# Shared rate limiter in D1 — design (issue #186)

**Date:** 2026-09-04 · **Ticket:** issue #186 · **Decision:** 0029 (written with the implementation)

## Problem

Every API route is metered by `rateLimited()` in `worker/http.mjs`: a per-isolate
`Map` keyed by `scope:CF-Connecting-IP`. Cloudflare recycles isolates and runs
many per colo, so the counter resets on eviction and is never shared across
colos. A caller rotating addresses, or simply landing on two edges, gets a fresh
allowance each time. The limiter runs before authentication, so nothing is keyed
by player either.

## Decision

A fixed-window counter table in the D1 database the Worker already binds as
`env.DB`, updated with one atomic upsert per check.

Rejected:

- **Cloudflare Rate Limiting binding** — `period` is 10 or 60 seconds only, so
  none of the existing windows (10 min, 1 h) can be expressed, and counts are
  per-colo, which is the property the issue rejects.
- **Durable Object counter** — strongest guarantees, but a new binding class, a
  migration block and a new test double for traffic this small.
- **KV with TTL** — eventually consistent and one write per second per key;
  wrong shape for a counter.

## Design

### Storage

`worker/schema-0005-rate-limits.sql`:

```sql
CREATE TABLE IF NOT EXISTS rate_limits (
  key          TEXT    PRIMARY KEY,
  window_start INTEGER NOT NULL,  -- ms since epoch
  count        INTEGER NOT NULL
);
```

Applied with `wrangler d1 execute lantern-tiles --remote --file ...` **before**
the deploy; the schema gate from issue #185 refuses the deploy until it is.

### Limiter

`rateLimitedShared(db, key, now, { max, windowMs })` in `worker/http.mjs`,
returning `true` when the caller is over the limit. One statement:

```sql
INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 1)
ON CONFLICT(key) DO UPDATE SET
  count        = CASE WHEN ?2 - window_start >= ?3 THEN 1  ELSE count + 1   END,
  window_start = CASE WHEN ?2 - window_start >= ?3 THEN ?2 ELSE window_start END
RETURNING count
```

Over the limit when `count > max`. Fixed window, same semantics as the
in-memory limiter, so the existing numbers keep their meaning.

The in-memory `rateLimited()` and `createRateLimitStore()` stay for exactly one
route: the anonymous weekly-board `GET` (public data, no credential, and a D1
write per read would double the cost of the cheapest route). Their docstrings
say so.

### Keys

- Address key: `<scope>:ip:<CF-Connecting-IP | unknown>`, checked before
  authentication on every metered route, as today.
- Player key: `<scope>:player:<id>`, checked after `authenticate` succeeds on
  `sync`, `name`, `submit`, `withdraw`, the signed board read and the profile
  read. Same `{max, windowMs}` as the address key for that route.
- `register` and `feedback` have no player and get only the address key.

### Routes and limits (unchanged numbers)

| route              | limit        | keys          |
|--------------------|--------------|---------------|
| feedback           | 5 / 10 min   | ip            |
| profile register   | 5 / 1 h      | ip            |
| profile read       | 10 / 10 min  | ip, player    |
| profile sync       | 60 / 10 min  | ip, player    |
| profile name       | 20 / 10 min  | ip, player    |
| board submit       | 20 / 10 min  | ip, player    |
| board read, signed | 10 / 10 min  | ip, player    |
| board withdraw     | 10 / 10 min  | ip, player    |
| board read, anon   | 60 / 10 min  | in-memory, ip |

### Failure

- Feedback now requires `env.DB`. Missing → `503 not_configured`, the same
  answer the profile and board give. A D1 error thrown from the limiter reaches
  `handleRequest`'s catch and becomes `503 unavailable` (issue #185). Fail
  closed; the client already falls back to `mailto:` on any non-2xx.
- Two D1 writes per authenticated request (address, then player). Accepted.

### Cleanup

Rows are reused per key, so the table is bounded by distinct keys, but a stale
key never expires on its own. A daily cron trigger (`triggers.crons` in
`wrangler.jsonc`, `scheduled` export in `worker/index.mjs`) deletes rows whose
`window_start` is more than 24 h old — longer than any window. Issue #188's
pruning can share the trigger.

## Tests (`node --test worker/test/*.test.mjs`, real SQLite via `createDb()`)

- Limiter unit: `max` calls pass and the next is refused; the window rolls over
  at exactly `windowMs`; keys are independent; a second `db` handle over the
  same database sees the same count (the "two isolates" case).
- Feedback: 6th post in the window is 429 with a fresh `deps` object per call;
  no `DB` → 503.
- Profile/board: one player from two addresses is refused on the player key;
  two players behind one address are refused on the address key; register from
  two addresses is independent; the anonymous board read never touches
  `rate_limits`.
- `check-schema.test.mjs` and `d1.mjs` pick up `schema-0005`.

## Docs

- `docs/decisions/0029-shared-rate-limiter-in-d1.md`.
- Pointers added to 0019 (its "per-isolate" caveat) and 0021 ("rate limits are
  applied before authentication" — now also after, by player).
- `wrangler.jsonc` comments for the migration and the cron.

## Out of scope

- Per-player quotas over longer horizons (issue #189) — reuses this table later.
- Score verification (#187), payload caps (#191), row pruning (#188).
