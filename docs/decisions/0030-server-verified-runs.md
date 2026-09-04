# 0030 — The server replays a run before it counts

**Date:** 2026-09-04 · **Status:** accepted · **Ticket:** issue #187
**Supersedes:** the "bounded rather than verified" position of
[0022](0022-daily-leaderboard-first.md), carried by
[0027](0027-one-weekly-score.md). **Amends:** [0007](0007-save-state-snapshot.md) is
untouched — the save state stays a snapshot; a *submission* is what carries a
replayable history, as 0022 anticipated.

## Context

A weekly-board submission was trusted on the client's word. The Worker checked
that `score` was inside what one run can pay and added it to the standing. A
holder of a valid recovery code could post the ceiling without playing, and
because the standing accumulates, a stream of such posts dominates any honest
week. The external review of 2026-09-04 put it as "make record server-auth
instead of user-token auth": the token proves who is posting, not that the run
happened.

0022 accepted this knowingly and did two things about it: every run stores the
move history it was submitted with, and it named the one gap that kept that
history from being replayable — shuffles were counted but their seeds were not
recorded. Undo turned out to be a second gap: since issue #100 it *deleted* the
hold record it undid, so a history with a hold, a match of a tile that hold had
freed, and then the undo, plays the match against a covered tile.

Measured on this machine: regenerating a deal and replaying a full 72-pair
history costs about 2.5 ms. Re-running the shuffle's solver validation on every
candidate permutation costs about 130 ms *per shuffle* (a 10-shuffle run: 1.2 s),
which no Worker plan tolerates per request.

## Decision

1. **The move stack is a complete replay log.** Core's `MoveStack` records a
   Shuffle as a move — `{kind: 'shuffle', seed, attempt}` — and Undo appends
   `{kind: 'return', tile, slotIndex}` instead of splicing the hold out.
   `holdsUsed` nets returns against holds, so the count still rolls back the way
   issue #100 meant. Both records carry the game clock like every other move.
2. **One shared replay helper in core.** `replayMoves(level, moves, multiplier)`
   validates the shape of an untrusted move list, plays it through the same
   `MoveStack` the client used on a freshly generated deal, and reports the
   score, whether the board was cleared, and the last timestamp — or the first
   record that could not have happened and why. Issue #50 (the local save's
   score) is meant to call the same function; scoring rules stay in one copy.
3. **The Worker imports core.** `worker/replay.mjs` bundles core's build plus
   `data/ladder.json` and the ten layouts as JSON modules. A submission's
   `(layoutId, seed)` must be a ladder entry — that is also where the band
   multiplier comes from — and the deal is regenerated with `generateLevel`
   (the ladder stores the seed that validated, so no reseeding).
4. **The replay is the record.** The score stored is the replay's. The client's
   `score` is a cross-check: a run that does not regenerate, does not replay
   legally, does not clear the board, does not end after its last move, or does
   not arrive at the claimed score is `422 run_rejected` with a `reason` (and
   the offending move's `index` when the replay is what refused it). A missing
   history is `history_missing`, not a 400. Nothing is written for a refused
   run; the per-week cap and the standing are untouched.
5. **A shuffle is reproduced, not re-validated.** The client's `shuffleBoard`
   runs the solver on candidate permutations until one is solvable; the record
   names the attempt it accepted, and `applyShuffle(board, seed, attempt)`
   reaches that permutation directly. The server does not re-prove that earlier
   candidates were unsolvable. Nothing about the score depends on *which*
   permutation a shuffle landed on — every move after it is still checked for
   legality on the faces it produced, and a clear is a clear — so what is given
   up is a proof about the booster's own bookkeeping, at a saving of two orders
   of magnitude in CPU. `attempt` is bounded by `MAX_SHUFFLE_ATTEMPTS` (1000),
   and a run may carry at most 99 shuffles (the booster cap), so a hostile
   history cannot make the replay expensive.
6. **Save format v8.** A v7 record's moves have neither shuffle seeds nor undo
   returns, so a deal resumed from one would finish with a history the server
   cannot replay and its clear would silently never reach the board. Same
   clean break as v5 → v7: the in-flight deal restarts; progress keeps.
7. **The bounds stay, as brakes rather than proof.** The single-run ceiling is
   now core's `MAX_RUN_SCORE`, imported rather than restated, and refuses the
   absurd before a regeneration is paid for. The 20-second floor and the
   per-week run cap stay because the replay proves the moves were legal on that
   deal, not that a person made them at that pace: the timestamps are the
   client's. The token still only proves who is posting.

## Rejected

- **Interim hardening only** (history present and consistent with `score` by
  pair count × band). Cheaper, but a fabricated history that *sums* right is
  as easy to post as a fabricated score; the ticket's own preference was
  replay, and the cost turned out to be a few milliseconds.
- **Re-validating shuffles on the server** (replay `shuffleBoard` exactly).
  Faithful, and 100–1000 ms per shuffled run; on the free plan every shuffled
  run would die at the 10 ms CPU limit and never reach the board.
- **Keeping the hold-deletion of #100 and logging returns separately.** Two
  records of the same game (an undo chain and a replay log) that the save
  format would have to carry and keep consistent. One list that is both is
  what `checkUndoChain` now walks — a return puts the tile back in its slot on
  the way backwards.
- **Correcting a mismatched score silently to the replay's.** Hides a client
  that is out of step with the server. A refusal with a reason is visible in
  the Worker's logs and in tests.

## Consequences

- `worker/replay.mjs` imports `core/dist`, so core must be built before
  `wrangler deploy`. CI's deploy job now does so; `wrangler.jsonc` says so for a
  local deploy. The Worker bundle grows by core (~150 KB unminified).
- Every accepted submission costs one regeneration plus a replay: ~2.5 ms of
  CPU on the dev machine, shuffles or not. Within the free plan's budget.
- Rows written before this change carry v7 histories (no shuffle seeds, holds
  spliced by undo) and cannot be replayed; they were bounded, not verified, and
  that is how they should be read. Issue #188's retention rule decides how
  long any row is kept.
- Level 1's flawless run now verifiably pays 20 970 and a hard-band one
  52 425; a client whose scoring drifts from core's fails `score_mismatch` in
  the Worker tests, which post real replayed runs rather than numbers.
- Issue #50 has its helper. It is not done here: the local validator's
  reject-or-repair question is still the PM's.
