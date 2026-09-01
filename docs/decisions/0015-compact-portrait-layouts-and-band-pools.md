# 0015 — Compact portrait layouts, and New game rotates the band's layout pool

**Date:** 2026-09-01 · **Status:** accepted · **Ticket:** issue #100's sibling, issue #99 · **Amends:** 0014

## Context

The original 10 layouts spanned up to 16 tile columns with only 2–5 layers.
The renderer scales the whole board to fit the viewport, so on a phone a
16-wide layout shrank tiles to roughly 23px — faces illegible, taps
error-prone (issue #99, per the Vita Mahjong reference recording). Separately,
decision 0014 made New game re-roll only the seed on the level's fixed layout,
so the button never showed a different shape.

## Decision

1. **All 10 layouts are reworked in place** — same ids, same 144 slots each —
   to a compact portrait profile: at most 9 tile columns wide, up to 10 rows
   tall, stacked 4–5 layers deep toward the center (PM decision on the ticket:
   rework all, not just the wide ones, and no per-device variant set). Each
   keeps a recognizable silhouette. The frame test in
   `core/test/layout-files.test.ts` pins the profile: width ≤ 18 half-units,
   height ≤ 20, depth ≥ 4 layers.

2. **Each ladder band owns a layout pool**, `LADDER_POOLS` in
   `core/src/ladder.ts`, assigned from a 40-seed difficulty sweep per layout
   (2026-09-01): the loosest, shallowest silhouettes serve easy, the densest
   stacks the hard spikes.

   | Band | Pool |
   |---|---|
   | easy | butterfly, windmill |
   | medium | spider, cat, turtle_classic |
   | medium-plus | pyramid, terrace |
   | hard | fortress, moon_gate, bridge |

3. **New game rotates the pool** (amending decision 0014): starting a new game
   deals the *next* layout in the current band's pool with a fresh random
   seed, wrapping around. Restart still replays the deal on the table —
   rotated or not — and "Next level" still deals the ladder's own pinned
   `(layoutId, seed)`. The rotation needs no stored state: the save carries
   the current layout, and the next one is a pure function of it.

4. **The ladder is regenerated inside the pools**: `build-ladder` searches
   only the level's band pool, so every pinned layout is one New game can
   rotate back to. The deeper stacks raised the whole difficulty range
   (`difficultyScore` is size- and depth-weighted), so the band windows were
   redrawn from the new sweep by decision 0011's own construction — easy
   below 0.592, medium [0.592, 0.624), medium-plus [0.624, 0.650) (the upper
   half of the medium range), hard [0.650, 0.8). The release gates re-ran
   green: 10,000 seeds × 10 layouts solvable, `ladder.test.ts` windows and
   ordering criteria.

5. **Existing saves are invalidated by a version bump** (`SAVE_VERSION` 4→5):
   a v4 record's `(layoutId, seed)` regenerates a *different* deal on the new
   geometry — same tile count, same-looking ids, silently incoherent state —
   so the in-flight deal is dropped the way the v2→v3 and v3→v4 breaks were.
   Level progress is stored separately and keeps.

## Alternatives considered

- **Rework only the wide layouts / add a per-device variant set.** Rejected by
  the PM on the ticket: one geometry everywhere keeps the ladder, the soak and
  the save format single-sourced.
- **Migrate v4 saves onto the new geometry.** Rejected: the record validates
  structurally against the new deal (144 ids either way) but captures a board
  the player never saw; the repo's save reader vouches only for what it can
  verify, and the established pattern for a geometry break is the version bump.
- **Persist a rotation cursor per band.** Rejected: deriving the next layout
  from the one on the table is stateless, survives force-quit for free, and a
  save from outside the pool (an older build) just restarts the rotation.
