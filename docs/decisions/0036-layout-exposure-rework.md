# 0036 — Layouts open with at most 30 free tiles; the score is re-normalized to the new spread

**Status:** accepted (2026-09-05) · **Issue:** #213 · **Amends:** [0015](0015-compact-portrait-layouts-and-band-pools.md), [0035](0035-pair-density-scorer.md)

## Context

On most compact portrait layouts (decision 0015) more than a third of the
tiles were free the moment the board was dealt: Spider opened with 64 free
tiles, Butterfly 58, Cat 56, Windmill 54, Turtle 44, Pyramid 42, Terrace 39,
Moon Gate 36, against 24 on Fortress and Bridge. With four identical copies of
every face, that many exposed tiles meant 35–50 playable pairs on turn one and
a dozen at every turn after. A player never had to plan or park a tile, and a
player taking a random legal pair every turn, never using the holder, cleared
about half of easy and medium deals (issue #212's measurement, repeated on
2026-09-05 on the shipped ladder, 30 playouts per level: easy 41%, medium
50%, medium-plus 56%, hard spikes 33%, with 13.6 / 10.6 / 7.9 / 6.2 legal
pairs on the table per turn).

The shape came from the 0015 rework itself: every layout was 9 columns wide on
the even lattice with a broad ground layer, so every row end on every
uncovered layer had an open edge. Decision 0035 made the scorer able to see
pair density, which is what makes this change measurable.

## Decision

1. **All 10 layouts are reworked in place again** — same ids, same names,
   same 144 slots, same 9-column / 10-row / 4–5-layer frame — so that no
   layout opens with more than 30 free tiles and the easy pool stays the most
   open. The construction rule that gets there: each layer is a set of
   **half-row-staggered columns whose heights step by one tile per column**.
   With the stagger, a column's end tile has a neighbour a half-row past it
   on both sides, so it is blocked; only the outermost columns, and features
   that deliberately break the rule (Spider's and Turtle's legs, Butterfly's
   wing lobes, Windmill's arms, Fortress's and Bridge's towers, Moon Gate's
   posts), are free at deal time. Upper layers cover the lower layers' outer
   columns where the band calls for it. Free tiles at deal time, before → after:

   | Layout | Before | After | Layers | Silhouette |
   |---|---|---|---|---|
   | spider | 64 | 30 | 5 | rhombus body, four leg stubs at the corners |
   | windmill | 54 | 29 | 5 | rhombus base, pinwheel of four arms on the hub |
   | butterfly | 58 | 28 | 4 | rhombus base, two wing lobes either side of a body notch, antennae |
   | cat | 56 | 26 | 5 | rhombus head with two ear tips, tower down the middle |
   | turtle_classic | 44 | 23 | 4 | rhombus shell, four two-high legs, spine ridge |
   | pyramid | 42 | 22 | 4 | stepped rhombus |
   | terrace | 39 | 20 | 4 | stepped rhombus with every step shifted up a row |
   | moon_gate | 36 | 16 | 5 | rhombus ring with a hollow centre, lintels top and bottom |
   | fortress | 24 | 15 | 4 | solid block, four corner towers, a keep |
   | bridge | 24 | 12 | 4 | two banks joined by a two-tile span, corner towers and a pylon per bank |

   `core/test/layout-files.test.ts` pins the ceiling (≤ 30 free tiles per
   layout, easy the most open, hard the tightest) alongside the 0015 frame.

2. **The scorer's normalizers follow the new sweep**, by 0035's own rule
   ("set from the 40-seed sweep of the shipped layouts"): tight start
   normalizes over 16 initial pairs (just above Spider's median of 15; it was
   48) and tight path over a witness-path branching of 8 above the forced
   floor (just above Spider's median 7.5; it was 16). Weights are unchanged.
   Without this the ten layouts' medians all landed in 0.65–0.76 of the old
   scale — every layout would have read as "hard", and the windows could not
   have been drawn under the 0.8 expert ceiling.

3. **Windows are redrawn over the new spread**: easy [0, 0.36), medium
   [0.36, 0.44), medium-plus [0.44, 0.52), hard [0.52, 0.80). Medium-plus
   stays 0011's upper half of the medium range [0.36, 0.52). The global bucket
   cuts align with the same edges. Medians on the re-normalized score
   (40 seeds per layout, 2026-09-05):

   | Layout | Score median | Initial pairs (median) | Branching (median) |
   |---|---|---|---|
   | spider | 0.305 | 15 | 7.5 |
   | windmill | 0.335 | 15 | 7.2 |
   | butterfly | 0.369 | 12 | 6.4 |
   | cat | 0.378 | 11 | 7.0 |
   | turtle_classic | 0.400 | 10 | 6.9 |
   | pyramid | 0.428 | 9 | 6.7 |
   | terrace | 0.489 | 8 | 6.2 |
   | fortress | 0.548 | 6 | 6.1 |
   | bridge | 0.581 | 4 | 5.9 |
   | moon_gate | 0.583 | 5 | 6.0 |

4. **The pools do not change.** The rework was tuned until the 0035 pools
   held in score order on the new sweep — easy spider/butterfly/windmill,
   medium cat/turtle, medium-plus pyramid/terrace, hard fortress/moon_gate/
   bridge — so New game's rotation and every pool comment stay true.

5. **The ladder is rebuilt** inside the pools with the same deterministic
   search. Every level keeps its layout; every deal is new, because the same
   `(layoutId, seed)` regenerates on different geometry. The first Turtle
   level is now 21 (it was 47).

6. **Existing saves are invalidated by a version bump** (`SAVE_VERSION`
   8→9), the way 0015 did for the v4→v5 break: a v8 record's `(layoutId,
   seed)` would regenerate a different deal than its snapshot. Level progress
   is stored separately and keeps.

7. **Shuffle deals its faces by reverse construction.** The original shuffle
   (issue #10) drew random permutations of the board's faces and kept the
   first the solver accepted, up to 1,000 tries. On the dense boards a random
   permutation is solvable far less often — 0% of 100 permutations on most
   layouts before 24 pairs are played, against 33–84% on the 0015 geometry
   (Moon Gate, the densest 0015 layout, was already at 5–7% and took up to
   22 s) — so a shuffle burned the whole budget, a minute of solver time, and
   then reported "This board cannot be shuffled." `shuffleBoard` now takes the
   remaining position apart from its free tiles pair by pair and names each
   pair as it goes, exactly as the generator deals a level: solvable by
   construction, no solver run, 1–7 ms on every layout at every stage
   measured (3 seeds × 0/8/24/48 pairs played). Held tiles keep their
   faces and each is dealt one board partner, which the construction takes off
   alone, as the player will. The replay contract is unchanged — the recorded
   `attempt` is now the construction attempt that completed, and
   `applyShuffle` re-draws the same attempts from the same seed — but a shuffle
   recorded under the old algorithm reproduces different faces, so a history
   with a shuffle in it verifies only against the code that wrote it. Every
   such history is already void: its deal regenerates on the new geometry.
   `core/test/shuffle.test.ts` pins every shipped layout shuffling within four
   attempts and half a second at 0/8/24/48 pairs played, with and without a
   parked tile.

## Consequences

- **A legal pair is no longer always in view.** On the rebuilt ladder the
  holder-free random playout (30 per level) clears easy 28% (was 41%), medium
  28% (50%), medium-plus 23% (56%); legal pairs on the table per turn fall to
  5.7 / 5.3 / 4.7 (from 13.6 / 10.6 / 7.9), and deals open with 15 / 10 / 8
  pairs (from 44 / 32 / 22). The hard spikes' clear rate does not fall (39%,
  was 33%, on 15 levels): at 4–5 opening pairs the random player is close to
  forced along the witness, so "clears without the holder" stops being a
  difficulty signal at the tight end. Their pairs-per-turn still fall,
  6.2 → 4.2.
- The whole game is tighter than before, not only the ordering. Absolute
  difficulty is now a PM call to make on the rebuilt ladder report and by
  play, and the knobs are all in the layout files: an outer column one tile
  taller loosens a layout by two free tiles.
- `ui/qa/e2e-slice.mjs` seeds the ladder position to the first Turtle level;
  it moved from 47 to 21. Its geometry thresholds were calibrated on the 0015
  Turtle and may need re-tuning on the new one.
- Holder-aware dealing (the witness parking tiles) is the next lever and is
  now worth its cost, since it only bites on dense layouts. Holder-aware
  calibration (0008/0009) and concealment re-balance (0010) stay deferred.

## Alternatives considered

- **Two copies per face instead of four.** Halves pair density at any
  exposure, but needs 30-plus new face designs and touches decisions 0005 and
  0012. Layout exposure was the largest lever with no rules change.
- **Keep the 0035 normalizers and draw the windows inside 0.65–0.76.** Keeps
  the score comparable with the old sweep, but leaves eight of the windows'
  cuts within a hundredth of each other, most seeds outside their band, and no
  room under the 0.8 expert ceiling for the hard window. 0035's rule already
  says the normalizers come from the shipped layouts' sweep.
- **Rework only the loosest layouts.** Would have left Turtle and Terrace at
  39–44 free tiles and the easy/medium bands still cleared by a random player
  half the time; the issue asked for every layout to tighten with its band.
