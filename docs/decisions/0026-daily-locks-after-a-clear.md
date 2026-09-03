# 0026 — A cleared Daily locks until the next local date; a lost one stays replayable

**Date:** 2026-09-02 · **Status:** accepted · **Ticket:** issue #166 · **Amends:** 0016 point 7

## Context

Decision 0016 point 7 says a cleared Daily's chip "goes static" but never
says it stops being tappable, and neither the chip nor the always-visible HUD
Restart ever refused to re-deal the board. Since credit is once per date
(0016 point 4), a replay pays nothing — but the board itself stayed
replayable without limit, which undercuts the Daily leaderboard (decision
0022): a player can grind the same shared seed for a better score.

PM call, 2026-09-02: a *clear* locks the board for the rest of the local
day; a *loss* (the holder full — decision 0009) never sets `lastDaily`, so
it never locks and stays replayable without limit; leaving a Daily unfinished
is neither, and the board stays playable.

## Decision

1. **A cleared Daily locks until the next local calendar date.** The lock is
   `record.lastDaily === today` (`dailyLockedFor`, `ui/src/profile.ts`) —
   the same `dailyDateKey()` that already picks the day's layout/seed and
   drives streak arithmetic (0016 point 1), so the lock can never disagree
   with the board the player sees. It derives from the persisted record, so
   it survives a reload for free.
2. **The chip is disabled, not just static.** `syncDailyChip` (`main.ts`)
   adds a `locked` state alongside `active`/`pending`: the button's own
   `disabled` is set (closing its click route natively, not just visually —
   `#app header .stat.daily:disabled`, `ui/index.html`), and its
   `aria-label`/`title` say the board is cleared for today and that a new one
   arrives tomorrow.
3. **Every replay route closes.** `startDaily` refuses a locked date (belt
   and suspenders behind the disabled chip); the HUD's always-visible
   Restart (`startLevel('replay')`) refuses to re-deal a Daily that is locked
   for the date it is pinned to. The win screen already hides its own
   Restart on a win, so between the two guards no control can re-deal a
   cleared Daily.
4. **A loss stays replayable without limit.** `recordDailyWin` is only ever
   called from the win branch; a loss records nothing on `lastDaily`, so
   `dailyLockedFor` stays false and the chip stays whatever it already was
   (`pending`, most likely — the Daily wasn't credited).
5. **The lock re-syncs on the date rolling over while the app stays open.**
   `syncDailyChip` already runs on every redraw; it now also runs on
   `visibilitychange` (returning visible) and `window focus`, so a page left
   open across midnight — or backgrounded and returned to the next day —
   does not keep showing yesterday's locked chip until the next move.
