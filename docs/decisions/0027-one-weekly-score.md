# 0027 — One weekly score: the board ranks the ladder, the Daily pays trophies

**Date:** 2026-09-03 · **Status:** accepted · **Ticket:** issue #176
**Supersedes:** [0022](0022-daily-leaderboard-first.md) in part — the Daily
board it chose is replaced; its "bounded, not verified" position stands.

## Context

0022 shipped a Daily Challenge board: one run, on one shared deal, per date. It
picked the Daily because the date fixes the layout and the seed, so comparing
scores is fair without verifying them.

What that leaves out is the game. A player climbing the ladder — which is
almost all of playing — has nothing on the board, and there is no board for
score earned over time. Meanwhile a Daily clear banked its final score into the
player's lifetime total like any ladder win, so the Daily paid score into a
number the board did not rank, and the ladder paid score into a number nothing
ranked at all.

Three numbers were competing to be "your score": a lifetime `totalScore`, a
`bestScore` high-water mark, and a per-date board position. None of them was
the one the game was about.

## Decision

**One score, and it is the week's.**

1. **The board is weekly and ranks the ladder.** Every ladder clear adds its
   final score to the player's standing for the current week. The standing
   accumulates across runs, unlike the Daily board's one-row-per-deal that only
   ever moved up.

2. **The week starts Sunday 00:00 UTC, on the server's clock.** Not the
   player's local week: a client-supplied week key would split one board into
   overlapping buckets across ~27 hours of local boundaries, and would need the
   skew and age guards the Daily board carried. No route accepts a week from a
   caller. The accepted cost is a reset at an odd local hour — Saturday
   afternoon in the Americas — and the board shows a live countdown so nobody
   has to work it out.

3. **Only the live week is browsable.** No archive, no past weeks, no daily
   board. There is no parameter to pass, which is what makes the guards
   unnecessary rather than merely absent.

4. **The Daily Challenge stops paying score.** A Daily clear pays trophies and
   the streak and nothing else: not the weekly standing, not a lifetime total,
   not the cleared count, and (as before) no boosters. Its score HUD stays up
   during the run because it drives the Super Combo feedback; nothing is banked
   from it. The once-per-date credit and the clear-locks-replay rule (0026) are
   unchanged.

5. **The profile shows that same weekly number.** `bestScore` and the lifetime
   `totalScore` are removed outright. Two tallies that disagreed with the board
   were two chances to be wrong about what a score means.

6. **Score is multiplied by the level's band** — easy ×1.0, medium ×1.5,
   medium-plus ×2.0, hard spikes ×2.5 — and the multiplier is visible
   everywhere the score is, in the HUD and on the win dialog.

## Why the band multiplier, and not a first-clear-per-week rule

Ranking by score earned makes grinding the easiest level a strategy: level 1 is
short, safe, and repeatable. The obvious guard is to count only a level's first
clear each week.

The multiplier is better because it changes the incentive rather than policing
it. Under a first-clear rule the honest player and the grinder are told
different things by the same screen — the grinder's score simply stops moving,
with no explanation on the board. Under the multiplier every clear always
counts, and level 1 is visibly the *worst* board to farm because it says so in
the score it pays. It also needs no per-level state on the server, which a
first-clear-per-week rule would.

It is keyed on the band rather than the level number so a decade spike is paid
at the band it actually plays at: `bandForLevel` reports level 10 as medium and
level 30 as hard, and each is worth its spike.

## Consequences

- **A resetting counter breaks "take max, never regress" (0021).** Every other
  synced field only grows, so `Math.max` was the whole merge rule. Taking the
  larger of two weeks' scores would resurrect last week's total at the rollover
  and then keep winning every merge after it, so the reset could never stick on
  any device. The merge is week-aware: the later week wins outright, and only
  within one shared week does the larger score win.

- **The same-week merge takes the larger score, not the sum.** Summing looks
  right and is not: sync runs repeatedly, and merging two already-merged
  records would double the total each time, with no per-run identity to
  deduplicate on. Under-counting is the safe direction. The cost is that two
  devices playing disjoint levels in one week keep only the higher of the two,
  so the profile can read lower than the server's standing, which accumulates
  each submission independently and stays correct. Merge-by-max has always
  under-counted multi-device play; this change does not make it worse, it only
  makes the gap visible next to a board that adds up properly. **Open for the
  PM:** making the profile adopt the server's weekly standing when synced would
  close it, at the cost of coupling the profile to the leaderboard.

- **Existing lifetime totals are not carried onto the first board.** The field
  was *renamed* (`totalScore` → `weekScore`, beside a `weekStart`) rather than
  repurposed, so a pre-#176 record simply has no week score and parses to zero.
  The rename is the migration. Without it, every established player would open
  week one already at the top of it. Past lifetime totals are not preserved and
  not retroactively adjusted — the information needed to separate Daily score
  from ladder score inside an aggregate was never recorded.

- **The save format goes to v7.** A v6 snapshot holds a score accumulated at
  the old flat rate; resuming one would keep those points and then pay a
  different rate for every match after the reload — one deal scored two ways,
  with the seam invisible. Older records read as absent, as with every previous
  bump: the in-flight deal restarts, level progress keeps.

- **The score bound applies per run, not per standing** — and a *second*
  bound had to be added because of it. A flawless 144-tile board pays 20,970 at
  ×1 and 52,425 at the ×2.5 spike multiplier, which bounds each score being
  added; a week of good runs is supposed to exceed it. But under the Daily
  board's `max()` semantics that per-run bound was also an absolute ceiling on
  any standing, so the rate limiter was pure defence in depth. Accumulation
  removes that ceiling, which would leave an IP-keyed, best-effort, per-isolate
  limiter as the only thing bounding a standing — not where score integrity can
  live. So the database caps each player at **300 runs a week**, with the score
  ceiling derived from it (`MAX_RUNS_PER_WEEK × MAX_RUN_SCORE`) so the two
  cannot disagree. `elapsedMs` also gains a floor: 72 pairs in under 20 seconds
  is not a fast player.

- **`weekly_submissions` is not pruned yet.** The run cap bounds how fast one
  player can grow it, but the move history is kept indefinitely and never read.
  A retention rule — drop rows older than N weeks — is a follow-up, and is
  wanted before this has been live long.

- **Move history is stored per submission**, in its own table, because the
  standing accumulates and has nowhere to put it. The verification follow-up
  still needs the individual runs, and needs them from the day the board opens.

- **The win dialog loses its Leaderboard button.** It was only ever shown on a
  Daily win (issue #174 fixed its stacking), and the Daily now pays nothing
  into the board. The header button is the only route in. The stacking rule
  itself is kept and still asserted, so a future route over a dialog starts
  correct.

- **The migration is two files, and the order matters.** 0003 is additive
  (the weekly tables and columns); 0004 is destructive (`daily_scores`,
  `players.best_score`, `players.total_score`). They go either side of the
  Worker deploy — 0003, deploy, 0004 — so there is no window in which the
  running Worker is writing columns that no longer exist. A single combined
  file would have meant every profile write failing from the moment the
  migration landed until the new build was live. Neither file is a no-op on a
  re-run: SQLite has no `IF EXISTS` for `ALTER TABLE ... DROP COLUMN` and no
  `IF NOT EXISTS` for `ADD COLUMN`, and both files say so rather than claiming
  a safety they do not have.

- **Withdraw does not clear `players.week_score`.** It looks like a survivor,
  but nothing rebuilds a board row from it: only `submit` writes
  `weekly_scores`, and that needs a fresh clear with the opt-in back on. It is
  the player's own profile number, not a public entry, and zeroing it would
  erase their private score as a side effect of leaving a public board.

## What does not change

Scores are still **bounded, not verified** — 0022's central position and its
reasoning are untouched, and the reason every run still stores its history.
The board opt-in stays a second consent, separate from sync; the displayed name
is still the screened, server-held one; "withdraw removes every entry" still
means every entry, now including the stored runs; and reading the board still
needs no account.
