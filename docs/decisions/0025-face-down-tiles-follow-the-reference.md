# 0025 — Face-down tiles follow the reference: the holder is consulted for a hidden face, a peek is passive, Undo keeps the peek

**Date:** 2026-09-02 · **Status:** accepted · **Ticket:** issue #165 · **Supersedes:** 0018 · **Amends:** 0010 point 1, 0013 point 4

## Context

A frame-by-frame read of the reference recording (FaceDownTileMatchBehavior.mp4,
Vita Mahjong, 88 s, two face-down tiles in the board centre; undo counter
constant through every peek, so peeks are free there too) showed three ways our
face-down tiles differed:

1. At 78.5 s a face-down 4 Circles was tapped with a 4 Circles already on its
   way to the tray, and went straight in — one flip-and-fly animation of about
   150 ms, unlike the ~400 ms in-place flip of a peek. The player had peeked
   it earlier and remembered it. Ours only peeks on the first tap, whatever the
   holder holds (decision 0010 point 1: "the holder is never consulted for a
   hidden face").
2. At 12.8 s and 37.0 s, with a peek showing, the player tapped another tile:
   it parked in the tray as any tile would, and the peek flipped back. Ours
   (decision 0018) turned every such tap into a match attempt against the
   peek — a match cleared on the board, a non-match parked nothing.
3. At 65.5 s an Undo returned a parked tile and the peek stayed showing. Ours
   dropped the peek on every board change, Undo included.

Also confirmed: a peek has no timeout (held ~12 s, ~20 s), only one peek shows
at a time and a second peek swaps in the same frame (18.0 s, 44.8 s, 67.7 s),
and the peeked tile's own second tap sends it to the tray (73.5 s).

## Decision

1. **The holder is consulted for a hidden face.** A tap on a free tile whose
   real face matches a held tile clears the pair through the holder, hidden or
   not. The flight shows the flip; the board never showed the face. A tap on a
   face-down tile with no match held is the peek, exactly as before: reveal in
   place, nothing moves, nothing on the undo stack. A blind tap therefore
   either clears or peeks — it never mis-parks, so the direct send adds no
   holder-full risk.
2. **A peek is passive.** While a peek shows, a tap on any other free tile does
   what it would do with no peek showing — parks, or clears against the holder
   — and drops the peek. Decision 0018's "matching against the peek" mode, its
   board-anchored pair-clear effect, its failed-attempt outcome and its a11y
   labels are removed. Two concealed partners are cleared by holding one and
   tapping the other from memory.
3. **Undo does not re-conceal the peek.** The peek is the player's knowledge
   about a board tile; taking a held tile back out of the holder changes
   nothing about it. The peek still drops when the peeked tile itself changes:
   its own tap parks it, Shuffle re-faces it, a move on another tile is made.
4. **Labels never leak.** A face-down free tile announces "activate to peek at
   it" even when its match is held and the activation would clear it; saying
   so would name the face by implication. `pairsWithHeld` stays false for a
   hidden face for the same reason.

## Consequences

- `TapOutcome.matched` gains an optional `revealed` flag; `peek-mismatch` is
  gone. The tray effect's `pairClear` takes an optional back picture and flips
  the incoming copy mid-flight (back → edge → face over `TRAY_FLY_MS`); reduced
  motion keeps the instant state swap. `pairClearOnBoard` is deleted.
- Solver, Hint, deadlock check and the holder-full rule are untouched: they
  already read real faces (decision 0010 point 4), so a face-down tile whose
  match is held was always a playable move to them.
- The save format is untouched: the peek was never saved, and nothing new is.
- Spec §3.3's face-down paragraphs are rewritten; decision 0018 is marked
  superseded. The tutorial has no face-down step yet (#59 still open); when it
  gets one it should say "tap to peek, or tap from memory when its match is
  in the holder".
- Test and QA harness helpers that "spend the peek tap" on a hidden tile now
  stop when that first tap already acted, instead of tapping the vacated
  spot again.
