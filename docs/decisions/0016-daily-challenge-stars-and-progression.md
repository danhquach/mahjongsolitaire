# 0016 — Daily Challenge, star ratings, and the progression record

> **Superseded in part, 2026-09-01 (issue #119, PM):** the star rating this
> decision specifies was removed — a clear is a clear. The Daily Challenge
> and progression-record parts of this decision stand.

**Date:** 2026-09-01 · **Status:** accepted · **Ticket:** issue #19 · **Amends:** spec §6 (fills in what it left open)

## Context

Spec §6 asks for three things it does not fully define: a Daily Challenge
("one deterministic board per calendar date, seed = date hash, shared across
all users; trophy + streak with escalating rewards"), a star rating "from
moves used, hints used, and completion time relative to the level's
baseline", and persistence of "level index, stars, total score, streak,
trophies". Issue #51 already noted that two of the rating's three inputs
collapse: a full board clears in exactly 72 matches, and since decision 0013
every match consumes exactly one parked tile, so "moves used" only varies
through the boosters. The spec names neither the baseline nor the 1/2/3
thresholds, nor what "escalating rewards" pays, nor what the calendar date
means across time zones.

## Decision

1. **The calendar date is the player's local date**, as `Intl` resolves it in
   the device zone (`dailyDateKey`, `core/src/daily.ts`). Two players in
   different zones get each other's board a few hours apart — that is what
   "shared" means for a calendar-date challenge. What must never happen, and
   is fixture-tested (`core/test/daily.test.ts`, spec §11.2), is the same date
   producing two boards, or a DST gap/overlap producing a date the OS clock
   disagrees with. Streak arithmetic runs on the date keys in UTC
   (`daysBetween`), so a 23- or 25-hour local day is still one day.

2. **Seed and layout are FNV-1a hashes of the key string** — `dailySeed` of
   `"daily:YYYY-MM-DD"`, `dailyLayoutId` of `"daily-layout:YYYY-MM-DD"` over
   the pinned alphabetical list of all ten layouts (`DAILY_LAYOUTS`). No Date
   math, no locale, no float, so every runtime agrees bit-for-bit; a pinned
   value in the test guards the hash against silent re-deals of past dates.
   The Daily plays at the `medium-plus` band (concealment 8%, baseline 9 s per
   pair) — it draws from hard-pool layouts too, so it sits one band above the
   ladder's middle.

3. **Star rating = 3 − [any assist] − [over baseline]**, floor 1
   (`core/src/stars.ts`). *Assists* are Hints, Undos and Shuffles charged on
   the deal (refused presses cost nothing and count nothing). The *baseline*
   is pairs × a per-band budget: easy 6 s, medium 8 s, medium-plus 9 s, hard
   10 s per pair — 7.2 to 12 minutes for a 144-tile board — generous enough
   for an unhesitating clear, not for one the player walked away from. The
   elapsed clock already pauses while the page is hidden. Three stars means
   "unaided and inside the baseline"; nothing about the rating touches the
   score, the ladder advance or the clear count.

4. **Trophies escalate by streak tier**: a Daily clear pays 1 trophy, 2 from a
   7-day streak, 3 from 30 (`dailyTrophies`, `STREAK_TIERS`). Credit is once
   per date — a replay of a cleared board pays nothing — and never out of
   order (a past date cleared after a later one is not credited). A Daily
   board dealt before midnight and finished after it *is* credited for its
   own date; the streak simply continues from there. The profile shows the
   streak *as it stands today* (`liveStreak`): the stored count if the last
   clear was today or yesterday, else 0.

5. **Everything persists on the existing player record**
   (`mahjong.record.v1`, `ui/src/profile.ts`): `totalScore` (every won level's
   final score summed, Daily included), `stars` (best rating per ladder level;
   the Daily pays in trophies, not stars), `dailyStreak` + `lastDaily` (the
   date the streak is anchored to — a streak with no date, or a malformed
   one, reads as 0), `trophies`. A pre-#19 record parses with the new fields
   empty. The ladder index stays on its own key (issue #79).

6. **The save format goes to v6**: `hints`, `undos` (alongside `shuffles` —
   the assists a resumed deal is rated on; an undone hold leaves no trace in
   the move stack, so Undo cannot be recounted) and `daily` (the date key, or
   null for a ladder deal, so a Daily resumes as a Daily). A v5 record reads
   as absent, the same clean break as v2→v3→v4→v5: the in-flight deal
   restarts, progress keeps.

7. **UI**: the Daily is a row in Settings (two taps from the board, spec §7)
   showing today's date and where the player stands; on a Daily board the
   Level chip reads "Daily" over the date, Restart replays the Daily, and both
   New game and the dialog's secondary action become **Back to the ladder**,
   which re-deals the ladder's pinned level. The win dialog shows the stars
   (glyphs plus "N of 3 stars" for AT) and, on a Daily, the payout.

## Alternatives considered

- **UTC date for everyone.** Truly simultaneous, but the board would roll over
  at 5 pm in Los Angeles and 9 am in Auckland — "the daily" would not match
  anyone's day. Rejected; the streak logic is DST-immune either way.
- **Rating on holds as "moves".** Holds at a win equal pairs exactly (0013), so
  the axis is constant. Rejected; documented so nobody re-adds it.
- **Graduated assist penalty (1–2 assists −1, 3+ −2).** Would let time and
  assists interact in ways hard to explain in a dialog. Rejected for the
  two-binary-axes rule; revisit with playtest data.
- **Booster charges as the streak reward.** Issue #51's replenishment economy
  is not built yet; wiring rewards into it here would couple the tickets.
  Trophies are the spec's own currency. Revisit when #51 lands.
- **Dropping a stale Daily save at boot.** Simpler, but loses a board mid-play
  at midnight for no player benefit. Rejected; credit goes to the board's own
  date.
