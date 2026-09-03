# 0010 — Face-down tiles: one peek at a time, a selection pins its reveal

**Date:** 2026-08-31 · **Status:** accepted · **Ticket:** issue #64

## Context

Playtest (#16) asked for a memory element: some tiles dealt face-down, flipped
by tapping. PM answers on the ticket, 2026-08-31:

1. A face-down tile behaves exactly like a normal tile otherwise — it occupies
   its slot, blocks what is under and beside it, and the free-tile rule applies
   unchanged.
2. Flipping is free and unlimited — no move, no booster, no score.
3. The reveal is a peek, not a permanent flip. Only one concealed tile is
   revealed at a time: revealing another re-conceals the first, and a mismatch
   re-conceals too.
4. Difficulty-scaled: none on easy, growing from the next band up, capped so a
   board never becomes a memory-test slog.

The ticket left one question open: **can two concealed tiles be matched with
each other?** Under a literal "one revealed at a time", peeking the second
re-conceals the first, so a concealed–concealed pair would be unmatchable —
and the generator would have to guarantee every concealed tile a face-up
partner, a much tighter constraint on level generation.

## Decision

**A revealed tile that is then selected stays face-up while selected** — the
ticket's own recommended assumption, adopted. "One at a time" therefore means
one *unselected* peek: the player can hold one tile up by selecting it, peek a
second, and match. Concealment never constrains generation.

The consequences, as built:

1. **Tap semantics.** *(Amended by decision 0025, issue #165, 2026-09-02: the
   holder auto-clear now does apply to a hidden face — a face-down tile whose
   match is already held clears on its first tap, the reference game's memory
   payoff; the rest of this point stands for a tile with no match held.)*
   The first tap on a face-down free tile peeks it —
   nothing else, not even the holder auto-clear (issue #62 rule 2), which
   would otherwise act on a face the player has not seen. The next tap acts
   under the ordinary rules. Peeking another concealed tile re-conceals the
   first; deselecting (Escape, tap on empty board) re-conceals a pinned tile;
   a mismatch involving a concealed tile re-conceals both and clears the
   selection outright (moving the selection to the new tile would pin it
   face-up through the very mismatch that is supposed to hide it).
2. **Derived, not saved.** The concealed set is a pure function of
   (layoutId, seed, difficulty bucket) — `concealedTileIds` in core, on its
   own rng stream. A resumed game re-derives it, so the save format is
   untouched and a reload can never reveal-all; the transient peek is
   deliberately dropped on reload (re-conceal is the safe direction).
3. **Fixed for the level.** Nothing ever leaves the concealed set: an undone
   match brings a concealed tile back face-down. A parked tile shows its face
   in the holder — the player parked it knowingly, and the strip is their own
   shelf.
4. **Knowledge, not legality.** Solvability, the deal validator, Shuffle's
   re-solvability check, the solver, Hint and the deadlock check all read real
   faces, unchanged. Hint pointing at a concealed tile is an intended leak
   (PM) — worth a tutorial line (#59).
5. **Accessibility.** A face-down tile announces as "Face-down tile", never by
   its face; a free one offers "activate to peek at it". The peek is an
   ordinary activation — no new gesture, spec §7 intact.
6. **Ladder impact.** Concealment raises effective difficulty; re-flagged for
   the Phase 3 calibration (#18). The provisional ratios (easy 0, medium 8%,
   hard 15%, expert 22%, cap 24) live in core/src/conceal.ts.
