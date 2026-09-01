# 0014 — New game re-rolls the current level; Restart replays the deal

**Date:** 2026-09-01 · **Status:** accepted (default taken in implementation — PM may reverse) · **Ticket:** issue #94

## Context

The ladder (decision 0011) fixes each level's layout *and* seed, and issue #79
deliberately made Restart and New game the same deal, with variety intended to
come from advancing levels. The result (#94): two buttons with different labels
doing the same thing, and — with no moves made — a New game click that visibly
does nothing at all.

The ticket names the options and calls the choice a PM call: re-roll a
different seed for the same level, restart the ladder run, or remove/rename
the button.

## Decision (default)

**New game re-rolls: a fresh random seed for the same ladder level.** Restart
keeps replaying the deal being played — including a re-rolled one — and the
win dialog's "Next level" still deals the ladder's own fixed seed, so level
variety keeps coming from the ladder; re-rolling is for the level you are on.

Consequences:

- The re-rolled seed is random (not derived): determinism only matters within
  a deal, and the save carries whatever seed was dealt, so force-quit resume
  and the Shuffle booster's seed sequence work unchanged.
- A re-rolled save's `(layoutId, seed)` no longer names a ladder entry, so the
  resume path derives its concealment band from the ladder *position* instead
  (a save is always the current level's).
- Rejected alternatives: restarting the ladder run (destroys progress for a
  button players press casually) and removing the button (Restart alone cannot
  offer a fresh board). Reversal is cheap: the mode switch lives in one
  `startLevel(mode)` argument.

## Follow-up (issue #99, 2026-09-01)

Amended by decision 0015: New game now deals the **next layout from the
current band's pool** with the fresh seed, instead of re-rolling the same
layout. Everything else here stands — Restart replays the deal on the table
(rotated or not), "Next level" deals the ladder's pinned `(layoutId, seed)`,
and the save carries whatever was dealt.
