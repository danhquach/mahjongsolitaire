# 0031 — Runs are kept for the live week plus one; abandoned players are reaped

**Date:** 2026-09-04 · **Status:** accepted · **Ticket:** issue #188
**Amends:** [0027](0027-one-weekly-score.md) ("`weekly_submissions` is not pruned yet")
and [0021](0021-profile-sync-own-backend.md) (a registration was a row for good).

## Context

Two tables only ever grew. `weekly_submissions` keeps every accepted run whole,
with the move history it was verified from, because the verification follow-up
needed the runs to exist from the day the board opened. That follow-up shipped
as [0030](0030-server-verified-runs.md): the server replays every run *before*
it counts, so a stored history has done its work the moment the row is
written. `players` gained a row per `register` call, and an abandoned first
launch or a throwaway profile was never removed. The external review of
2026-09-04 named the submissions table as the thing that would slow the app
down first. The board queries themselves run on `weekly_scores`, bounded to one
row per player per week, and were never the problem.

## Decision

1. **Runs live for the live week plus the one before it.** Once a night the
   cron from [0029](0029-shared-rate-limiter-in-d1.md) deletes every
   `weekly_submissions` row whose `week_start` is earlier than the previous
   week's Sunday (`weekStartKey(now - WEEK_MS)`). The PM's call on the window,
   2026-09-04. Two weeks is enough to look into a disputed standing while the
   board it stands on is still the one people see; the standing itself is what
   is ranked and is never pruned.
2. **Players who never synced go after a month; idle players after six.**
   Every write to a player's row sets `updated_at`, so `updated_at =
   created_at` means the profile never synced after registering, and an old
   `updated_at` means it went idle. Either is deleted — unless the player has a
   standing on any week's board, whose name and avatar are read off the
   `players` row. That player stays however idle.
3. **One `sweep`, three statements, in order.** Rate limits, then runs, then
   players: a surviving run row would block its player's delete under the
   `REFERENCES` clause, so runs go first and a withdrawn-and-forgotten player
   can leave in the same night. Each step is a single `DELETE`; a failure in
   one leaves the others' work in place and shows in the cron's log.
4. **No schema change.** The delete on runs is a range over the existing
   `weekly_submissions_week` index; `players` is small enough to scan once a
   day. The migration files are left as applied, including the comment in
   schema-0003 that said nothing pruned the table — that file is a record of
   what was run, not of what is true now.

## Rejected

- **Keep the latest N runs per player per week instead of a time window.**
  Bounds the table too, but leaves every player's runs forever, so the reaper
  could never remove a player, and "how far back can a dispute reach" would
  have no answer. A time window answers both.
- **Reap on `created_at` alone.** Would delete a long-standing player who
  syncs daily. `updated_at` is the last time the player was seen writing.
- **A separate cron for retention.** The Worker has one `scheduled` handler
  and one trigger; a second schedule adds nothing but a place for the two to
  disagree.
- **Delete idle players' standings along with the row.** A standing is a
  public record other players ranked against; removing it because its owner
  stopped playing would move everyone below them up a place, silently.

## Consequences

- The deleted history cannot be replayed later. A dispute about a run more than
  two weeks old has only the standing to go on, which is the accepted trade.
- Withdraw still deletes a player's runs on the spot; the prune never restores
  or extends anything, so it cannot undo a withdraw.
- `rate_limits` rows keyed by a reaped player go in the same sweep's first
  step or the next night's; nothing references them.
- The tests exercise the real SQL through `node:sqlite`, including the
  week-boundary millisecond and the standing that keeps a player.
