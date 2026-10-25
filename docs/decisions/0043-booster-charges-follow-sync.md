# 0043 — Booster charges follow a synced profile: a per-device ledger

**Date:** 2026-10-24 · **Status:** accepted · **Ticket:** issue #272
**Builds on:** issue #138 (profile sync, "take max, never regress"), issue #51
(the booster grants and the daily login grant), issue #201 (Reset keeps the
wallet).

## Context

Cloud sync carried the player record, but booster charges (Hint, Undo,
Shuffle) were stored only on the device. Restoring a profile on another
device brought everything except the charges.

A balance cannot join the record's merge. Every field there merges by max or
union, which never loses progress, but a balance goes *down* when spent:
taking the larger of two balances hands spent charges back, so the merge
would become a free-charge exploit.

## Decision

Option 1 of issue #272: sync what was earned and spent, not the balance.

1. **A ledger, per device.** Each install has a random device id. The device
   stores, and syncs, a ledger: for each device id, every charge it was ever
   granted (`earned`) and every one it spent (`spent`), per kind. A device only
   ever increments its own tally.
2. **Merge by max per device.** Both tallies only grow, so the merge takes the
   larger of each, per device and per kind. It is commutative and idempotent
   (both sides run it, repeatedly, on already-merged ledgers), a spend is
   never undone and nothing earned anywhere is lost. A per-device key, rather
   than one profile-wide total, is what makes two devices' earnings *add up*
   instead of the larger one winning.
3. **The balance is derived:** starting grant + Σ earned − Σ spent, clamped to
   0..99. The starting grant is the profile's and is paid once. A second
   device restoring the profile does not add a second one.
4. **One daily grant per profile per day.** The ledger carries `day`, the last
   date the daily login grant was paid on any device (merged as the later of
   the two). At launch the game syncs first and grants after, so a device that
   launches after another has already collected today's grant sees it was paid.
5. **Beside the record, not in it.** The ledger rides the sync request and
   profile response as `boosters`, stored in its own column
   (`worker/schema-0008-boosters.sql`). Reset leaves it alone, the way the
   device already keeps its charges through a reset (issue #201).
6. **Upgrade keeps the badge.** A device that stored a balance before this
   migrates it into its own tally: whatever moved the balance off the starting
   grant. This is written at once under the new id, so a later launch cannot
   migrate it again under a second id and count it twice.

## Accepted edges

- **Two devices launched offline on the same day** each pay the daily grant.
  At most one extra +1 of each per extra device per day.
- **The same charges spent on two devices offline** can take the sum below
  zero. The badge shows 0, and later grants pay the debt back before it
  moves. This is exact accounting: those charges were used.
- **Earnings above the cap on two devices** add up past 99. The badge shows 99
  until spends bring the sum back under it.
- **A device clock set forward** and synced pushes `day` ahead for every
  device. The daily grant then waits for that date everywhere, by the same
  rule that already stops clock-winding on one device.
- **A ledger keeps at most 32 devices** (the lowest ids, so every side cuts
  the same ones). Nothing ever removes a device, and every reinstall, cleared
  site data or fresh browser profile adds one. A profile that passes 32 loses
  whichever tallies sort last, and its balance jumps by their net. The cap is
  bounded by the 16 KB request body. Pruning old devices would need a
  different merge, and is left until a real profile gets near it.
- **Storage that reads but refuses writes** (quota full) cannot keep the id
  minted for a pre-#272 balance, so each launch migrates it again under a new
  id. With sync on, that tally counts once per launch. It needs a full quota
  and sync on together.

## Rejected

- **Server's balance wins:** spends made offline get overwritten.
- **Carry over at restore only:** fixes the reported case, but two devices
  still show two balances.
- **One profile-wide earned/spent total, merged by max:** under-counts two
  devices earning or spending between syncs. Spends going missing is the same
  exploit as merging the balance.
