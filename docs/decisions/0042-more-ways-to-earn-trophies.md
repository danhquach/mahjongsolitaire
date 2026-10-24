# 0042 — More ways to earn trophies: the Daily sweep and ladder milestones

**Date:** 2026-10-24 · **Status:** accepted · **Ticket:** issue #268
**Builds on:** [0016](0016-daily-challenge-stars-and-progression.md) (the
streak schedule), [0038](0038-cosmetics-shop-glyph-sets.md) (the balance is
derived, never stored). Keeps issue #227's rule: a trophy is earned only
through the synced record, never through a local store.

## Context

Trophies came from one place, the Daily: at most three a day, plus one at a
7-day streak and one more at 30. That is 3–5 a day against a shop of about
645 trophies. Climbing the ladder, the part of the game most play goes into,
paid none.

## Decision

### 1. The Daily sweep: +2 for finishing all three

`DAILY_SWEEP_TROPHIES` (core/daily.ts) is paid by `creditDailyChallenge` on
top of the trophy for the day's third challenge. It rides on the existing
`dailyCount`, so the #227 cap covers it too: the sweep pays at most once a
date, and a fourth credit still pays nothing. `DailyCredit.sweep` tells the
UI to say so. A full day now pays 5 trophies (7 with both streak tiers).

### 2. Ladder milestones: +5 per decade level, derived from `cleared`

Each milestone level (10, 20, … 150, the decision-0011 spike levels) pays
`MILESTONE_TROPHIES` = 5 once cleared, 75 for the whole ladder.

These trophies are **not added to the `trophies` counter**. They are worked
out from the record's `cleared` set by `ladderTrophies` (core/ladder.ts), and
`earnedTrophies(record) = trophies + ladderTrophies(cleared)` (ui/profile.ts)
is what the profile, the Daily panel and the shop balance read.

Why derived, not counted:

- `cleared` already merges by union on the client and the Worker, so a
  milestone can't be paid twice by a replay, a wiped local store, two devices
  clearing the same level offline, or a sync merge. A counter merged by
  `max` would lose one device's payout or invite a second one.
- No new field, no schema migration, and no Worker change: the server never
  computes a balance (0038).
- Players who already cleared milestone levels get those trophies at once,
  which is intended.

The cost is that `record.trophies` alone no longer means "all trophies". Code
that shows or spends trophies must go through `earnedTrophies` or
`trophyBalance`.

## Consequences

- Changing `MILESTONE_TROPHIES` re-prices every past milestone, the same way
  a price change re-prices past purchases (0038). Raising it is safe. Lowering
  it could put a player's balance below what they have already spent, which
  `trophyBalance` shows as 0.
- An endless ladder past `LADDER_LENGTH` (#230) earns no milestone trophies
  until this function is extended to cover it.
