# 0034 — A player can reset their progress or close their account; both are gated by typing the name

**Date:** 2026-09-04 · **Status:** accepted · **Ticket:** issue #201
**Amends:** [0033](0033-api-limits.md) (two rows in the limits table) ·
**Relates to:** [0021](0021-profile-sync-own-backend.md) (the profile row),
[0031](0031-retention-live-week-plus-one.md) (the reaper was the only removal).

## Context

A player could leave the leaderboard (0022) but not remove the profile itself:
display name, avatar, synced progress and the `players` row stayed until the
idle reaper (0031) took them, six months on. Soft launch (#25) in any region
with an erasure obligation needs a player-initiated path, and the PM asked for
two (2026-09-05): start over without losing the account, and close the account
outright. Both are irreversible, so a single tap must not be enough.

## Decision

1. **Two routes, same shape as every other write.** `POST /api/profile/reset`
   deletes the caller's `weekly_submissions` and `weekly_scores` rows and sets
   the record columns back to `EMPTY_RECORD`; id, code, name and avatar stay.
   `DELETE /api/profile` deletes the runs, the standings, the player-keyed
   `rate_limits` rows and then the `players` row. Both authenticate with the
   bearer code, meter the address and the player (0029) and carry a daily quota
   (0032) of 5 — a player does either a handful of times ever. Once closed, the
   code is a plain 401 like any code that never existed, so a retry or a second
   device gets the same answer and treats it as "already closed".

2. **Reset replaces; it does not merge.** `mergeRecords` never regresses, so a
   device that syncs *before* it resets would merge the old progress straight
   back. The client wipes its own copy before its next sync, and a second
   device that still holds the progress restores it on its next sync. That is
   the merge rule working as designed; the confirmation text says the reset
   reaches every device that syncs to the profile, and a device that was not
   updated will bring its progress back — which is also the honest description.

3. **The device wipes by key list, then reloads.** `ui/src/account.ts` lists
   the storage keys in two sets: what the player has *done* (record, ladder
   position, level in progress, today's challenges — Reset) and everything the
   game ever wrote (Close). Booster charges survive a reset: they are a wallet,
   not a record. Every store reads its key once at boot, so the reload is what
   guarantees no half-reset session survives, and a closed account boots into
   the fresh-install welcome gate.

4. **Server first, device second.** The local wipe only runs once the server
   has agreed. A refused call (offline, unavailable, rate-limited) leaves the
   device exactly as it was and says why in the dialog. The one exception is a
   401 on close: the account is already gone, so the device forgets it too.

5. **The second step is typing the display name.** The confirmation is an
   `alertdialog` whose text says "cannot be undone" in those words; the
   destructive button is disabled until the typed name matches the display
   name (trimmed, case-insensitive). A guest still types "Player": the gate is
   the act of typing, not knowledge of a secret. Escape, Cancel and a backdrop
   tap all cancel and return focus to the row in Settings that opened it.

## Rejected

- **Hold-to-confirm.** Fine on touch, awkward for keyboard and switch users,
  and a timer is a UI pattern the game does not have anywhere else.
- **A single confirmation tap.** The ticket rules it out; one mis-tap on the
  wrong of two adjacent rows would erase an account.
- **Soft delete (flag the row, purge later).** Adds a state every read has to
  check, and a "closed" row still holds the name. The reaper already exists
  for the idle case; this path is for the player who asked now.
- **Wiping by key prefix.** `KeyValueStorage` cannot enumerate, and a list is
  reviewable: a new store has to decide which of the two sets it belongs to,
  and a test counts the entries against the stores that exist.

## Consequences

- Two more rows in the limits table (0033); the table test holds them.
- Settings gains an Account fieldset with two rows; the accessibility audit's
  control count moves from eleven to thirteen, and a new audit step exercises
  the dialog's labelling, the disabled-until-typed gate and Escape.
- Nothing else is retained for a closed account: no tombstone, no log line
  with the id. If a support need for "did this account exist" ever arises, it
  is a new decision.
