# 0009 — The holder is one-way, and a full one loses the level

**Date:** 2026-08-31 · **Status:** accepted · **Supersedes:** 0008 · **Ticket:** issue #63

## Context

Decision 0008, taken the same day, made the holder unconditionally safe: a held
tile could always be returned to its own slot, a full holder simply refused the
park, and no sequence of holds could ever cost the player the level. That was a
deliberate reading of spec §3.5's "never hard-fail the player".

Playtest (#16) came back with the opposite reading. In Vita Mahjong — the box
this assist is modelled on — the holder is a *resource*, not a shelf: what you
put in it you cannot take out, and running out of slots is how you lose. Under
0008 the holder had no cost at all, so parking was never a decision. The PM's
call is that the decision is the feature.

Three questions were open on the ticket. PM answers, 2026-08-31:

1. **When does the loss fire** — the moment the fourth slot fills, or only when
   the holder is full *and* no legal match remains? **The moment it fills.** The
   ticket recommended the softer reading; the PM took the harder one, which is
   what the reference game does and what makes the fourth slot feel like a cliff
   rather than a formality.
2. **Does the free first Shuffle (#47) rescue a full holder?** **No.** A full
   holder is final.
3. **On loss: restart, or a rewarded-ad continue?** **Restart.** Decision 0004
   suspends ads for v1.0, so there is no ad path to offer; a continue would be a
   separate PM decision and a much larger ticket.

## Decision

The holder is one-way.

1. **A parked tile cannot be taken back.** The only way to free a slot is to
   match the tile in it. `unhold` stops being a move: `MoveRecord` is a match or
   a hold, and `Board.unhold` survives only as the mechanism `MoveStack.undo`
   rewinds a hold with. Undoing a hold is the move never having happened, not
   the player returning a tile.
2. **A full holder is a lost level, the moment the fourth slot fills.** It
   outranks every other reading of the position: a playable pair in plain sight
   does not save it. `Game.status()` therefore asks about the holder before it
   asks whether a move exists.
3. **Nothing rescues it.** The loss dialog offers Restart level and New game.
   Shuffle and Undo stay hidden, and the rail behind the dialog is inert, so the
   Undo that *could* rewind the fatal hold is not reachable — the move stack
   stays honest, the rules stay final.

## Consequences

**Spec §3.5 gains a loss, and §3.2's holder paragraph is rewritten.** "Never
hard-fail the player" now scopes to the *deadlock*, which keeps its boosters. A
full holder is a different state and does hard-fail — the one place v1 does.

**The safety property is now false, so it is tested as false.** 0008 asserted
that no sequence of holds can turn a solvable position unwinnable, and property-
tested it. That property is exactly what this decision reverses, so it is
replaced by two:

- what is still true, and what keeps `solve` sound while it ignores holds
  entirely: **holding never makes the *position* less winnable.** A held tile is
  off the lattice, so every winning line of the un-held position is still a
  winning line of the held one.
- what is now true and was not: **a sequence of holds CAN lose a solvable
  level**, with a witness in the test. If that test ever passes by accident, the
  one-way rule has been undone somewhere.

**The deadlock check stops one slot short.** `hasPlayableMove` searched hold
sequences up to the holder's remaining capacity. A park that fills the last slot
is now a loss rather than a move, so it cannot be a way out of a deadlock: the
search only takes a hold that leaves a vacancy behind it. A position whose only
"move" is that final park reports `stuck`, and the dialog is right to offer
Shuffle instead.

**The player has to be warned before the step, not after it.** A hard-fail you
can walk into blind is a bug, whatever the rules say. Three cues, and they do not
rely on colour alone (spec §7):

- the last empty slot in the strip is marked — amber *and* a heavier border;
- the holder group's accessible name says one slot is left and what filling it
  costs, and so does that slot's own name;
- a **selected** tile's accessible name says that activating it again would park
  into the last slot and end the level — the same sentence that carries issue
  #62's park action, now carrying its price.

The announcement on the third park says it too.

**Save format goes to version 3.** A v2 record can carry an `unhold`, and this
build has nothing that could replay one; dropping it silently would leave an undo
stack that no longer walks back to a pristine deal. So a v2 record reads as
absent and the player gets a fresh deal — the same clean break 0008 made, for the
same reason. A record whose holder is *full* is not rejected and must not be:
that is a lost level, and reloading must not be an escape hatch from one. It
resumes, and `status()` says `lost` on the first frame.

**Difficulty re-prices again, and #18 is re-flagged.** 0008 pushed the ladder
calibration on #18 to assume a holder that only ever helps, so the scorer's
no-holder position was a *lower bound* on how easily a level plays. Under 0009 it
is no longer a bound in either direction: the holder still opens positions a
no-holder scorer cannot reach, and it can now also end the level outright. #18
has to bucket against holder-aware play with the loss in the model.

## Alternatives considered

- **Loss only when the holder is full *and* no legal match remains** — the
  ticket's own recommendation, and the softer of the two. Rejected by the PM: the
  reference game fails instantly, and the delayed version makes the fourth slot
  feel free right up until it is not. The cost is real and named above: the
  fourth park is always fatal, so the holder is effectively three usable slots
  and a decision. That *is* the feature.
- **Shuffle rescues a full holder.** Rejected: if a booster undoes it, the
  holder never really costs anything and 0008 is back with extra steps.
- **A rewarded-ad continue** (spec §8). Rejected for v1.0: decision 0004
  suspends ads, so there is nothing to offer.
- **Keep `unhold` in the model as dead code, in case the PM reverses again.**
  Rejected. `Board.unhold` is still there because undo needs it; a *move* nothing
  can produce is a save-format branch nothing can test, and this codebase's save
  reader only vouches for shapes it can actually see.
