# 0028 — The Daily is three challenges on the ladder, not a board of its own

**Date:** 2026-09-03 · **Status:** accepted · **Ticket:** issue #183
**Supersedes:** [0016](0016-daily-challenge-stars-and-progression.md) in part —
the deterministic board per date is replaced; its date-key rule, trophy
schedule and once-per-date credit stand. [0026](0026-daily-locks-after-a-clear.md)
in full — the replay lock existed to protect a board that no longer exists.

## Context

0016 shipped the Daily Challenge as a *board*: the date hashed to a layout and
a seed, the chip dealt it, and clearing it locked the date until tomorrow. It
paid a trophy and a streak, and after 0027 nothing else — no score, no level,
no boosters.

Playing it therefore meant leaving the game. The ladder level on the table was
dropped for a one-off board that advanced nothing, and the player had to come
back afterwards. The daily hook competed with the climb instead of riding on
it, and the reward for taking the detour was the smallest in the game.

The property 0016 was really buying — *everyone gets the same thing today* —
never depended on it being a board.

## Decision

**A date names three challenges, and they are completed by playing the ladder.**

1. **Three goals a date, dealt by the date.** `dailyChallenges(dateKey)` is a
   pure function, like the board deal it replaces: the same three for everyone,
   with no server and no account. The four kinds — finish N boards, match N
   pairs, match N pairs of one suit, match N pairs in a row with no hint or
   shuffle — are shuffled by the date and the first three taken, so a day never
   asks one question three times. Slots run light, medium, heavy.

2. **Targets are a pinned table, not a formula.** A formula would make every
   re-balance a silent re-deal of every past date. `boards` caps at 2 even in
   the heavy slot (PM): a finished board is the longest unit of play there is,
   and three on a slow level is a whole evening. Suit challenges name Dots,
   Bamboo or Characters only — Winds, Dragons and Seasons have 8, 6 and 4 pairs
   on a full board, so no target worth setting fits them.

3. **All of the day's play counts, and a loss keeps it.** Progress accumulates
   across boards, restarts and abandoned deals. Spec §6's scoring is explicitly
   never punitive, and a rule that wiped an hour's progress because a holder
   filled would be exactly that. The one counter that falls is the clean run,
   and only to zero, and only on a *charged* hint or shuffle — the goal names
   those two, and it starts again immediately. Undo does not reset it: undo
   returns a parked tile, it never takes back a match.

4. **Each completion pays; the day's first carries the streak.** One trophy and
   one booster charge per challenge, and the day's first completion also
   extends the streak and pays its tier bonus (0016's schedule, unchanged). So
   a full day pays 3 trophies, 4 on a 7-day streak, 5 on a 30-day one.

5. **The streak counts days, not challenges.** It advances on the first
   completion of the day rather than on all three. A streak that a short
   session could break would punish the player for the one thing this change is
   meant to reward: playing normally.

6. **The board, its palette, its band and its replay lock are deleted.** There
   is one mode — the ladder — and the Daily is a set of goals laid over it.

7. **Still no score and still not a level cleared.** 0027 is untouched: the
   weekly board ranks ladder clears, and the Daily pays trophies, the streak
   and now a booster charge.

## Why not keep the board as well

Two daily systems would mean two locks, two sets of copy, a palette and a band
that exist for one screen, and a player having to be told which of the two
"Daily" things a trophy came from. The board's only unique property — a shared
deal — is not something anyone could see: nothing compared boards across
players once 0027 removed the Daily leaderboard.

## Consequences

- **A save captured mid-Daily resumes as an ordinary ladder board.** The deal
  is still a real `(layoutId, seed)`, so `parseSave` ignores the retired
  `daily` field rather than rejecting the record, and main.ts reopens it at the
  level's own concealment ratio and score multiplier. No version bump, no lost
  in-flight board, and no chance of the retired medium-plus ×2.0 paying out on
  an easy level.

- **A completion is announced on the line of the move that earned it.** Two
  live-region writes in the same tick coalesce and the first is never spoken —
  the same hazard `finishTap` already documents — so the payout is queued and
  appended to the match (or win) announcement rather than said on its own. On a
  level-ending tap, where `showStatus` owns the line, it follows on its own
  beat.

- **Progress is per local calendar date, computed on read.** The stored date
  rides with the counters and a date that is not today reads as zeros — the
  `weekScoreNow` pattern — so the day rolls over the moment the player's
  calendar does, with no timer at midnight.

- **Clock-winding earns nothing.** `creditDailyChallenge` keeps 0016's guard: a
  date earlier than the last credited one pays nothing at all. Within a day the
  three payouts are bounded by the per-date `done` flags.

- **The layout/pool invariant moved.** "The pools name exactly the shipped
  layout files" was asserted through `DAILY_LAYOUTS`; it is the ladder's
  invariant and now lives in `ladder.test.ts`.

- **A day's three challenges can be re-balanced freely, but not silently.**
  Changing the table changes what a past date asked for. Nothing reads a past
  date, so this is safe today; it would stop being safe the moment anything
  displays history.
