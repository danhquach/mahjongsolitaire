# 0018 — A peek matches directly on the board

**Date:** 2026-09-02 · **Status:** accepted · **Ticket:** issue #124 · **Amends:** 0013 point 4

## Context

Decision 0013 point 4 retired issue #77's peek-auto-match: the tap that
reveals a face-down tile must not also move it, so a peek and a match became
two separate taps, and a matching tapped tile went through the ordinary
one-tap-to-the-holder rule like any other. In practice that meant a peeked
tile's pair always cost three taps and a holder slot — peek, park the tapped
tile, tap the peek to clear — even when the player already knew both faces
matched.

## Decision

While a peek is showing, the board is briefly in a **matching-against-the-
peek** mode: a tap on any *other* free tile compares its real face to the
peeked tile's, hidden or not.

1. **A match clears the pair right there on the board** — no trip through
   the holder, same score and match feedback as a holder clear, anchored
   where the pair sat. This applies whether the tapped tile was already
   face-up or was itself face-down (restoring issue #77's shortcut for two
   concealed tiles).
2. **A non-match is a failed attempt, not a move.** Nothing parks, nothing
   moves: the peek flips back face down, and a tapped face-down tile is *not*
   revealed by the attempt. Same shake/cue as a blocked tap. Nothing is
   pushed to the undo stack.
3. **The peeked tile's own second tap is unchanged** — tapping it again still
   sends it to the holder like any other visible tile. Rule 1/2 only applies
   to a tap on a *different* tile.
4. The holder is still never consulted for a hidden face (decision 0010) —
   this only adds a second thing a tap on a free tile can do while a peek is
   showing; it changes nothing about what a tile knows about itself.

## Consequences

- A peek-pair match never occupies a holder slot, so it cannot trip the
  decision-0009 full-holder loss in passing, same as a holder-based match.
- The tray effect gains a board-anchored variant (`TrayFx.pairClearOnBoard`)
  for the case where neither tile was ever held — same dwell/clear timings,
  score popup and particle burst as the holder version, just anchored between
  the two tiles instead of over a slot.
- A11y labels for a free tile change while a peek is showing: "activate to
  match it with the revealed tile" (matching face) or "activate to try it
  against the revealed tile" (any other free tile, concealed or not) —
  neither says "peek" or "send to the holder", since a peek is not on offer
  on someone else's tile once a peek is already showing.
- Not on the undo stack: peeks were already free and unlimited (decision
  0010); a failed match attempt is now free too, by the same logic.
