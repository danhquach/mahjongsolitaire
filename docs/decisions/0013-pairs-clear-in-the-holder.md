# 0013 — Every tap sends the tile to the holder; pairs assemble and clear there

**Date:** 2026-09-01 · **Status:** accepted · **Supersedes:** the gesture halves of issue #62 and issue #77 · **Ticket:** issue #93 (subsumes #73)

## Context

Issue #62 made parking a select-then-activate-again gesture, and matching kept
the classic two-tap select/match model with a one-tap shortcut against the
holder. The reference recording (HolderMechanism.mp4, Vita Mahjong) shows a
different machine: every tapped tile *travels to the tray*, and matching is
nothing but getting both tiles of a pair into it — the pair is shown side by
side in the tray for a beat, then clears with a score popup and a leaf/petal
burst. Playtest feedback (#93) was that our select-first model made the tray
feel bolted on and matches never involved it visually (#73).

## Decision

1. **One tap on a revealed free tile sends it to the holder.** If its face
   matches a held tile, the pair clears (the tapped tile never occupies a
   slot, so completing a pair cannot trip the decision-0009 loss in passing);
   otherwise it parks, and the park that fills the fourth slot still loses.
2. **Selection stops existing as an input concept.** No select, deselect,
   mismatch, or Escape handling; the Super Combo now breaks only by timeout.
   `MoveStack.selection` survives in the model and the save format (a pre-#93
   save can restore one) but no tap ever sets it.
3. **A held tile is not tappable.** It leaves the holder only via its board
   partner's tap, or Undo. The strip's slot buttons become pure information
   (face, slot, the last-slot warning) — always disabled, still labelled.
4. **Face-down tiles keep decision 0010's tap-time shield**, simplified: the
   first tap reveals in place and does nothing else (issue #77's
   peek-auto-match is retired — the reveal must not also move the tile); the
   second tap sends the tile to the holder like any other.
   *Amended by decision 0018 (issue #124, 2026-09-02), then superseded by
   decision 0025 (issue #165, 2026-09-02):* the holder **is** consulted for a
   hidden face — a face-down tile whose match is held clears on its first
   tap, flipping in flight — and only otherwise does the first tap peek. A
   peek is passive: a tap on any other free tile is an ordinary park or clear
   and drops the peek. The peeked tile's own second tap is unchanged.
5. **The match feedback moves to the tray** (subsumes #73): a DOM flight from
   board to slot, a side-by-side dwell, a +score popup and a particle burst at
   the strip (tray-fx.ts). Reduced motion degrades to the instant state swap,
   keeping only a static popup fade.

## Consequences

- Every pair costs two moves on the undo stack (a hold, then a match), and
  every pair transits a holder slot. With **one vacancy left, a board-board
  pair is no longer safely playable** — its first tile would fill the fatal
  fourth slot. The solver gained `takeablePairs` (the gesture filter over
  `legalPairs`) and `hasPlayableMove` uses it at every node, so such positions
  now read `stuck` (Shuffle/Undo offered) instead of `playing`, and the Hint
  booster never points at a pair whose first tap would lose.
- The save format bumps to v4: a v3 record can carry live state the new input
  layer cannot operate or clear (a selection pinning a concealed reveal, two
  identical faces parked with no gesture to pair them), so — as with the
  v2→v3 bump — older records read as absent and the player gets a fresh deal.
- Open PM question: mis-tap forgiveness (spec §7, 8dp) now snaps a near-miss
  onto a one-way park; with one vacancy left, a forgiven tap can lose the
  level. Left as designed for now — the per-tile warning label is the guard —
  but worth a look alongside the reference game's behaviour.
- No mismatch means no mismatch shake/flash; the blocked tap keeps them.
- Spec §3.3/§3.5/§5/§6 amended; a11y labels now name the action per tile
  ("send it to the holder" / "clear it with its match in the holder" / the
  last-slot warning).
