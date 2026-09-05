# 0035 — The difficulty score follows pair density; Spider moves to the easy pool

**Date:** 2026-09-04 · **Status:** accepted · **Ticket:** issue #212
**Amends:** [0011](0011-plateau-ladder.md) (the band windows),
[0015](0015-compact-portrait-layouts-and-band-pools.md) (the pool table).

## Context

The scorer's tight-start signal read `1 - initialFreePairCount / 12`, clipped
at zero. Every shipped deal opens with 6–62 legal pairs, so the signal was
zero for the whole ladder; tile count carried half the weight and every layout
is 144 tiles, so half the score was a constant. What separated the bands was
layer depth and the forced-move ratio — not what a player feels. Measured on
the shipped ladder (2026-09-04), a player taking a random legal pair every
turn and never parking a tile cleared about half of easy and medium deals
with a dozen legal pairs on the table at every turn, and the medium pool
(Spider, Cat) dealt more opening pairs than the easy pool. The ladder could
not express any generation-side difficulty change because the scorer could
not measure one.

## Decision

1. **Pair density dominates the score.** Tight start normalizes over 48
   initial pairs (above the loosest layout's median), tight path over a
   witness-path branching of 16 above the forced floor, and the two carry
   0.35 each. Size, depth and forced moves keep 0.10 each — constant or
   near-constant across the shipped content, kept so the score still means
   something off the ladder.
2. **Windows are redrawn over the new spread** (40-seed sweep per layout):
   easy [0, 0.30), medium [0.30, 0.45), medium-plus [0.45, 0.60), hard
   [0.60, 0.80). Medium-plus stays 0011's upper half of the medium range
   [0.30, 0.60). The global bucket cuts align with the same edges.
3. **Spider moves from the medium pool to the easy pool.** It deals the most
   opening pairs of any layout (median 49); Cat and Turtle remain medium. No
   other pool changes.
4. **The ladder is rebuilt** inside the pools with the same deterministic
   search. 59 of 150 levels keep their (layout, seed); 112 keep their layout.
   A player mid-ladder sees a different deal at their next level; saves in
   progress are untouched because they carry their own (layout, seed).

## Consequences

- The scorer's 0011 obligation — ordering — now holds on the signal players
  feel. Bands are internally consistent by pair density: medium deals open
  tighter than easy deals (32 vs 44 initial pairs on the rebuilt ladder).
- **This does not make the game harder.** The easy band is looser than before
  (Spider) and the medium band tighter, but a holder-free random playout still
  clears roughly half of easy/medium deals. Absolute looseness is a layout
  property — how much of the ground layer is free at deal time (24 tiles on
  Fortress, 64 on Spider) times four identical copies per face. Reducing it is
  the layout-exposure follow-up, which this decision makes measurable.
- Holder-aware calibration (0008/0009) and concealment re-balance (0010) stay
  deferred, as in 0011.
