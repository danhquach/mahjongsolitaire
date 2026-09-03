# 0025 — Face-down tiles follow the reference: the holder is consulted for a hidden face, a peek is passive, Undo keeps the peek

**Date:** 2026-09-02 · **Status:** accepted, point 2 narrowed 2026-09-03 · **Ticket:** issue #165 · **Supersedes:** 0018 · **Amends:** 0010 point 1, 0013 point 4 · **Amended by:** issue #169 (point 2 only, below)

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
   *Narrowed by issue #169, 2026-09-03: a tap on a free tile whose real face
   matches the peek also clears — see "Amendment (issue #169)" below. The
   passive rule stands exactly as written for every other tap.*
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

## Amendment (issue #169) — 2026-09-03

**Report:** with a peek showing (dots the reference recording never happened
to exercise — every peek-then-other-tap frame above was a non-match), tapping
a *different* free tile whose real face matches the peek parked the tapped
tile alone and dropped the peek, rather than clearing the pair. The player
just watched a match and the game acted as if there wasn't one.

**Decision:** narrow point 2 only, rather than restore decision 0018's
board-side matching mode wholesale:

1. A tap on a free tile whose real face matches the *current peek* clears the
   pair — same score, feedback and undo entry as any other match — hidden or
   not (consistent with point 1's "hidden or not" for a held tile). A tap on
   any other free tile keeps the passive rule exactly as point 2 states it:
   ordinary park or holder-clear, peek dropped.
2. **Precedence when a tap could match both a held tile and the peek: the
   holder wins.** Point 1 (`holderPartner`) is checked first; the peek-match
   check only runs when it finds nothing. This was already true of the code
   before this ticket — point 1 has always run first — this amendment just
   makes it an explicit rule now that a second "clears" path exists to be
   ordered against. Rationale: the holder is a real, already-committed pairing
   (the other tile has been sitting there since an earlier move); the peek is
   a transient, this-frame convenience. Resolving the more committed pairing
   first also keeps `pairsWithHeld`'s existing a11y meaning intact — it never
   has to ask "unless the peek is closer."
3. **Still through the holder (decision 0013), not a board-side vanish
   (decision 0018 stays retired).** The peeked tile is given a holder slot —
   the same booking an ordinary park would make — and is then cleared against
   the tapped tile via the existing held-partner path, in the same tap. Both
   tiles visibly travel to and clear in the strip; a still-hidden tapped tile
   flips in flight, same as point 1. The slot is never observably occupied:
   `Game.tapBoard` holds and clears synchronously before returning the
   outcome, so `status()` never sees the momentary occupancy and the
   decision-0009 full-holder loss cannot trip as a side effect. A holder with
   no spare slot for that momentary park (unreachable in real play — a full
   holder already ended the level) simply skips this path, falling through to
   an ordinary peek or park.
4. **The peeked tile's own second tap is unaffected** — it is excluded from
   matching itself, so it still parks like any visible tile (point 2,
   unchanged).
5. **Labels never leak (point 4, unchanged, extended).** A new
   `pairsWithPeek` query mirrors `pairsWithHeld`'s shape and its hidden-face
   guard: a visible tile whose tap would peek-match clears the a11y label to
   "clear it with its match in the holder" (the same wording as a held match —
   the mechanism is invisible to the player either way) instead of the plain
   "send to the holder" text, and instead of the last-slot warning it would
   otherwise wrongly earn with one vacancy left, since this tap does not
   actually end in a park.

### Consequences

- `TapOutcome.matched` gains a `slot` field (the holder slot `a` matched out
  of, at the moment of the match): a peek-match gives `a` that slot in the
  same tap that clears it, so the render layer can no longer read it off a
  "holder before the tap" snapshot the way it could when `a` was always
  already-held. `main.ts`'s `finishTap` reads `outcome.slot` directly instead
  of diffing `heldBefore`.
- `Game` gains `peekMatchPartner`/`playPeekMatch` (private) and `pairsWithPeek`
  (public, a11y/QA-facing, same shape as `pairsWithHeld`).
- The two existing tests that pinned "a same-face tile is NOT matched against
  the peek" (`game-conceal.test.ts`, `game-facedown-holder.test.ts`) are
  rewritten to assert the pair clears; a same-`peekMatchPartner` test with a
  genuinely non-matching face keeps covering the passive rule.
