# 0037 — The three-a-day Daily cap moves into the record

**Date:** 2026-09-05 · **Status:** accepted · **Ticket:** issue #227
**Supersedes:** [0028](0028-daily-challenges-not-a-daily-board.md) in part —
its "the per-day cap lives in the progress store, not in the record"
consequence is closed; everything else in 0028 stands.

## Context

0028 shipped three Daily challenges a day, each paying a trophy, and left the
cap enforcement outside the synced record: `RecordStore.creditDailyChallenge`
credited every call for a given date, and what stopped a fourth was only the
`done` flags in `mahjong.daily.v1`, a local document the record never
consulted. 0028 named the hole deliberately and left it — trophies rank
nothing and are bounded on sync by `Math.max`/`MAX_COUNTER` — and said to
revisit "the moment trophies unlock content or feed a board." Issue #227 filed
it as a bug regardless: clearing that local store and re-completing the same
day's challenges mints trophies that sync unchallenged, and a synced counter
that never checked its own cap was worth closing on its own, ahead of that
trigger.

## Decision

**A per-date count lives in the record, paired with `lastDaily` the way
`weekScore` is paired with `weekStart` (0027).**

1. **Schema.** `PlayerRecord.dailyCount: number` — how many challenges were
   credited on `lastDaily`. `EMPTY_RECORD.dailyCount = 0`.
   `parsePlayerRecord` clamps it to a non-negative integer no greater than
   `DAILY_CHALLENGE_COUNT` (3, from core) and forces it to 0 whenever
   `lastDaily` is null; a record with no stored `dailyCount` at all reads as 0.

2. **Credit rule.** `creditDailyChallenge`: the same date and `dailyCount`
   already at the cap pays nothing and writes nothing (`{credited: false,
   streak, trophies: 0}`); the same date under the cap increments it and pays
   one trophy; a new later date resets it to 1; an earlier date is unchanged
   (the existing clock-wind guard).

3. **Merge rule, identical on both sides.** `ui/src/sync.ts` and
   `worker/profile.mjs`, each carrying a header comment pointing at the other:
   `dailyCount` folds into the existing streak block, since it is anchored to
   the same `lastDaily`. One side's `lastDaily` null takes the other's count;
   equal `lastDaily` takes `Math.max`; otherwise the side with the later
   `lastDaily` wins outright. Never maxed across different dates — that would
   carry one day's count into the next, undoing the whole point of the field.
   The result is commutative, and a test asserts `merge(a,b)` deep-equals
   `merge(b,a)` for the cross-date and same-date cases.

4. **Worker persistence.** `players.daily_count`, added by
   `schema-0006-daily-count.sql` (`ALTER TABLE ... ADD COLUMN ... DEFAULT 0`,
   additive, applied before the deploy exactly as 0003 was) — not added to the
   fresh-install `schema.sql`, matching how 0003's `week_score`/`week_start`
   were also left to their own migration rather than edited into the baseline.
   `worker/scripts/check-schema.mjs` fails the deploy until the live database
   has the column.

## Why now, and not at "revisit"

0028 tied revisiting this to trophies unlocking content — a board or a shop.
#227 treats it as a bug independent of that: a synced counter whose cap is
enforced by a store the counter never reads is a hole in the counter, not a
feature waiting on a trigger. Closing it now costs one schema field and one
migration; waiting would not have made either cheaper.

## Consequences

- **A grace window for pre-#227 records.** A record synced before this change
  has no `dailyCount` and reads as 0 on its own `lastDaily` day, so it can
  still be credited up to three times that day — gated as always by the local
  Daily store, which is exactly the pre-#227 behavior for that one day.
  Trophies already earned are kept as they are; nothing is clawed back.
- **Migration must precede deploy**, the same ordering 0003 established:
  apply `schema-0006-daily-count.sql`, then deploy the Worker build that binds
  `daily_count`. Applying it after would mean every register/sync call 500s
  from the moment the new Worker is live until the column exists;
  `check-schema.mjs` is what stops that deploy from going out first.
- **Booster charges are unaffected and out of scope.** `main.ts
  payDailyChallenges` still grants a charge (`charges.grantSplit`) per
  completion regardless of `credited`; charges are a wallet, not a record, and
  #227 only closes the trophy hole. A refused credit now simply omits the
  trophy clause from the announcement rather than saying "0 trophies".
