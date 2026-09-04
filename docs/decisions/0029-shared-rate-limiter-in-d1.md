# 0029 — The rate limiter counts in D1, keyed by address and by player

**Date:** 2026-09-04 · **Status:** accepted · **Ticket:** issue #186
**Amends:** [0019](0019-feedback-worker-endpoint.md) (its per-isolate caveat) and
[0021](0021-profile-sync-own-backend.md) ("rate limits are applied before
authentication" — now also after, by player).

## Context

Every API route was metered by a `Map` inside one Worker isolate, keyed by
`CF-Connecting-IP`. Cloudflare recycles isolates and runs many per colo, so the
count reset on every eviction and was never shared between the isolates and
colos serving one caller. 0019 said so ("slow down obvious abuse, not a hard
cap"). The external review of 2026-09-04 asked for a real limit on the write
routes; feedback — unauthenticated, up to 36 MB a request — is the most
expensive of them.

## Decision

1. **The count lives in D1.** One `rate_limits` row per key
   (schema-0005), updated by a single upsert that opens, resets or increments
   the window and returns the count — atomic, so two isolates cannot both
   read four and both write five. Fixed windows, the same numbers as before:
   the store was the problem, not the ceilings.
2. **Two keys per authenticated route.** `<route>:ip:<address>` before the
   code is checked, so guesses are metered; `<route>:player:<id>` after, with
   the same allowance, so a player cannot exceed it by changing address.
   Feedback and register have no player and get the address key only.
3. **Feedback meters before it reads the body.** The point of a limit on a
   36 MB write is to not pay for the over-limit bodies. Malformed requests now
   spend allowance too; a real client does not send those.
4. **Feedback needs the database.** Without `DB` it answers `503
   not_configured`, as the profile does; the client already falls back to
   `mailto:`. A D1 error from the limiter reaches `handleRequest` and becomes
   the 503 of issue #185. Fail closed.
5. **The anonymous board read stays in memory.** Public data, no credential; a
   database write per read would double the cost of the cheapest route.
6. **A daily cron deletes rows older than a day.** Rows are reused per key, so
   the table is bounded by distinct callers, but nothing else would ever
   remove a caller seen once.

## Rejected

- **Cloudflare's Rate Limiting binding.** `period` is 10 or 60 seconds, so no
  existing window (10 min, 1 h) is expressible, and counts are per-colo — the
  property this ticket exists to remove.
- **A Durable Object counter.** The strongest guarantee, but a new binding
  class, a migration block and a new test double, for traffic this small. If
  the D1 write per request ever matters, this is the upgrade.
- **KV with TTL.** Eventually consistent, one write per second per key. Not a
  counter.

## Consequences

- Two D1 writes per authenticated request (signed board reads included); one
  per feedback or register; none for an anonymous board read.
  At playtest volume this is noise against the free tier's daily row budget.
- Migration 0005 must be applied before the deploy; the #185 gate enforces it.
- Issue #189 (per-player quotas over longer horizons) can reuse the table with
  a longer window and its own scope.
- The tests exercise the real SQL through `node:sqlite`; nothing about the
  limiter is faked.
