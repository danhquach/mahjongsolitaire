# 0008 — The holder is a free, always-available 4-slot assist

**Date:** 2026-08-31 · **Status:** superseded by [0009](0009-holder-is-one-way.md) · **Ticket:** issue #43

> **Superseded the same day.** Answers 1 (4 slots) and 3 (no score penalty, but
> holds are counted) still stand. Answer 2's *consequences* do not: decision 0009
> makes the holder **one-way** — a parked tile cannot be returned, and filling the
> fourth slot loses the level. Everything below about a held tile always being
> returnable, a full holder refusing the park, and holds never being able to cost
> the player the level was reversed by playtest #16 / issue #63. Read 0009 for
> what is true now.

## Context

Issue #43 asked for the Vita Mahjong-style holder: a small box above the board
where a free tile can be parked so the player can reach what is under it. The
ticket left three questions open for the PM, because each one changes what gets
built and what it costs downstream:

1. how many slots,
2. charged booster (like Hint / Undo / Shuffle) or always available,
3. score penalty per hold.

The ROADMAP had the feature in the v1.1+ backlog with a condition attached:
pull it into Phase 3 **only** if those answers arrive before the 500-level
ladder (#18) is calibrated, because an always-available assist changes every
level's effective difficulty and re-bucketing after the fact is the expensive
part.

## Decision

PM answers, 2026-08-31:

1. **4 slots**, matching the Vita Mahjong box. Exported as `HOLDER_SLOTS` and
   configurable per board, so the count is a number to tune rather than a
   number baked into the move types.
2. **Always available.** No charge, no balance, no new `BoosterKind`. The only
   thing that can refuse a hold is a full holder.
3. **No score penalty, but holds are counted.** Spec §6 is explicit that scoring
   is purely additive — nothing ever deducts points — so a penalty would need a
   spec amendment. `holdsUsed` is tracked anyway (derived from the move stack, so
   undo rolls it back and a resumed game carries it), because Vita reports a
   per-level holder average and a later star rating may want it.

#18 was still open when this landed, so the pull-in condition is satisfied.

## Consequences

**The ladder must be calibrated with the holder in the model.** This is the
price of answer 2 and the one item that outlives this ticket: `assessDifficulty`
still scores a no-holder position, which is now a lower bound on how easy a
level plays. #18 has to bucket against holder-aware play, not against the
scorer's current output. Flagged on #18 rather than pre-solved here — the
scorer's weights are calibration work, not engine work.

**Deadlock means something new.** Holding does not match a tile, but it does
unblock: parking a free tile vacates its slot, which can free the tile under it
and expose a pair. So "no legal pair" is no longer "no moves left", and the
stuck check (`hasPlayableMove`) searches hold sequences up to the holder's
remaining capacity before it offers the deadlock dialog. Bounded, memoised on
the set of held tiles, and conservative when the budget runs out — it will say
stuck, never invent a move.

**Holding can only help, and that is provable.** A held tile is off the lattice,
so every tile is at least as free as before and any winning line of the un-held
position is still one of the held position. Combined with "a held tile can
always be returned to its own slot" (nothing can take or cover a slot a tile has
vacated, because tiles only ever leave the board), no sequence of holds can turn
a solvable level unwinnable. Property-tested rather than assumed.

**Save format goes to version 2.** A move is no longer always a pair, and the
holder's contents ride alongside the faces and removed flags. Version 2 is a
clean break: a v1 record reads as absent and the player gets a fresh deal, which
costs one in-progress playtest level and keeps `parseSave` honest about vouching
only for shapes it can actually see. The reader also walks the undo stack
backwards now, checking every step is one the board and holder could perform and
that it ends at a pristine deal — a stack that merely *loads* is not enough when
undo runs several moves later out of a click handler.

**The strip is DOM, not canvas.** The holder is HUD furniture, so it is a flex
sibling of `#board`: its height comes out of the board's fit automatically, and
each slot is a real `<button>` rather than a second mirror layer over a second
canvas. It follows the HUD's own axis — a row when the HUD took the top edge, a
column when it took a side — because a 68px row in landscape cost the board a
sixth of its height while a 60px column costs it a fourteenth of its width. The
board is measurably smaller either way: tablet landscape loses ~9% of its tile
width, and the e2e fit floors were lowered to match.

## Alternatives considered

- **Charged booster** (the ROADMAP's own preference, to limit the blast radius on
  #18). Rejected by the PM: the holder is a comprehension aid, and a player who
  runs out of charges is back to not being able to see under a tile. The cost
  lands on #18's calibration instead, which had not started.
- **A score penalty per hold**, to price the assist. Rejected: it contradicts
  spec §6's additive-only rule for a v1 with no scoreboard to protect. The count
  is kept so this stays reversible.
- **Solver plans holds too.** Rejected. `solve` answers the question the
  generator and Shuffle ask — is this *deal* winnable — and holds only make that
  easier, so ignoring them is sound and cheaper. Only the deadlock check needs
  to look through them, and only it does.
