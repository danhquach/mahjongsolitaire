# 0032 — Every write route has a daily quota per identity

**Date:** 2026-09-04 · **Status:** accepted · **Ticket:** issue #189
**Amends:** [0029](0029-shared-rate-limiter-in-d1.md) (its consequence "issue
#189 can reuse the table with a longer window" — it does, and this is how).

## Context

0029 gave every route a fixed-window limiter in D1, keyed by address before the
code is checked and by player after it. Those windows are minutes long: they
slow a burst, but a patient loop is never told "enough". Sixty syncs per ten
minutes is 8,640 a day for one credential; registration, which mints a row per
call and has no player to key on, had only its five-an-hour address bucket and
no ceiling across addresses. The external review of 2026-09-04 (issue #189)
asked for a quota tied to the identity doing the writing on every write route,
enforced durably, answering `429 rate_limited`.

The issue was written before #186 landed and overstates the gap: sync, rename
and withdraw were already metered per player by then. What was missing was the
horizon, and any bound at all on registration.

## Decision

1. **A quota is the same limiter over a day.** `quotaExceeded` in http.mjs is
   `rateLimitedShared` with a 24-hour window and the route's `-day` scope
   (`sync-day:player:<id>`), so the quota row never shares a key with the
   minutes bucket. Same table, same atomic upsert, no migration. The
   leaderboard's "restate the cap in the write" pattern is not needed here:
   that exists because its check and insert are two round trips, and the
   limiter is one statement.
2. **Each route's limit entry carries its quota.** `perDay` on `RATE_LIMITS`
   in profile.mjs and leaderboard.mjs; `playerLimited` checks the minutes
   bucket first, then the quota, so a burst already refused does not also spend
   the day. Sync 200, rename 20, withdraw 10 per player per day.
3. **Register is quotaed by address and globally.** There is no player yet, so
   the address is the identity: 10 a day (`register-day:ip:<address>`), and
   1,000 a day across everyone (`register-day:global`). Both are checked before
   the body is read.
4. **Submit gets no new quota.** `MAX_RUNS_PER_WEEK` (0027) is already the
   quota that route needed, enforced against the standing itself.
5. **A day is the longest window there is.** The nightly sweep deletes
   `rate_limits` rows whose window opened more than a day ago; a longer window
   would be reset by the sweep mid-count. `QUOTA_WINDOW_MS` and the sweep TTL
   are the same number for that reason, and the sweep's comment says so.
6. **The answer stays `429 rate_limited`.** The client already maps every 429
   to that failure and retries later; a new code would buy nothing it can act
   on.

## Rejected

- **Counters on the `players` row** (`syncs_today`, a day column) with the cap
  restated in the `UPDATE ... WHERE`. Durable and atomic too, but a migration,
  a column per quotaed action, and a second place that counts. The limiter
  table already does this job.
- **A weekly horizon for sync**, to mirror the submit cap. Would need the sweep
  TTL raised or a separate sweep; a day bounds the loop just as well.
- **Skipping the global register ceiling** because one shared key is a lever
  an attacker with many addresses can pull to lock out new players for a day.
  The review asked for it, the row is cheap, and the number is high enough
  that pulling the lever costs a thousand distinct addresses a day. Noted, not
  avoided; raise the number if it ever bites.

## Consequences

- One more D1 write per authenticated write request (three: address, player,
  player-day) and per registration (three: address-hour, address-day, global).
  Still noise against the free tier at playtest volume.
- Fixed windows: a player's day starts at their first write, not at midnight.
  The client's copy for `rate_limited` says "a few minutes"; for a quota it is
  a day. Left as is — a player who hits 200 syncs in a day is not a player.
- No migration and no client change; the deploy gate (#185) is unaffected.
- Tests exercise the real SQL through `node:sqlite`, paced past the minutes
  buckets so only the quota can refuse, and confirm the window turns after a
  day.
