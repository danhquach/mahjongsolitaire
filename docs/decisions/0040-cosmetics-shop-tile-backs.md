# 0040 — Tile backs in the shop: one bitmap per back, proven on its keyline

**Date:** 2026-09-05 · **Status:** accepted · **Ticket:** issue #229 (slice 2, backs half)
**Builds on:** [0038](0038-cosmetics-shop-glyph-sets.md) (shop, owning, the
`looks` stamp), [0039](0039-cosmetics-shop-felts.md) (felts, opaque look kinds),
[0017](0017-board-palettes.md) (palettes) and issue #82 (the back never sinks
into the felt).

## Context

0039 shipped the felts and left tile backs waiting on art. The back sheet was
generated from the brief in `docs/design/cosmetics-prompts.md` and dropped in
`docs/design/` on 2026-09-05: eight cells on the Lantern felt, the first the
plain jade default, seven with a dark ground, a light keyline and a motif or
all-over pattern.

Two things about the sheet shape the decision. Its cells are ~250 × 377 px,
aspect 0.66, not the tile's 64:84 (0.76). And the issue's rule for backs —
"must hold 3:1 against every felt" — was written for a *plain* back like the
jade one, whose ground is the light variant of the felt. These grounds are
dark by design (a back must never read as a face), and the brief's own
bamboo-grove ground is the Lantern felt itself. Ground-vs-felt 3:1 is not
attainable for them, and was never what the brief asked for: it asked that
every back be identifiable in greyscale by its pattern, which is a claim about
the light work on the back, not its ground.

## Decision

### 1. A back is a bitmap over the ground

- `BACKS` in `ui/src/depth.ts` holds each back's id, label, and the brief's
  `ground` and `keyline` colours. The default `lantern` entry is the palette's
  own back and keyline and has no bitmap.
- The seven bitmaps ship under `data/backs/<id>.png`, cut by
  `docs/design/cut-backs.py` at their native crop with a rounded-rectangle
  alpha mask (radius 6/64 of the width, the tile's own) so the felt-coloured
  corners of the JPEG never ship. Nothing is resampled at cut time.
- The renderer (`render.ts`) fills the face with the back's ground as before,
  then **stretches the sprite to the face rect**. A centre crop to 64:84 would
  cut the keyline off two edges; a ~13% vertical squash keeps it on all four,
  and no motif depends on its exact proportion. The sprite is tinted by the
  same per-layer factor as the ground under it, so a deep face-down tile
  recedes with its neighbours. The tile outline is redrawn on top.
- While a bitmap is loading, or for the default, the drawn back is what it
  was: the ground fill with the inset keyline, in the back's own colours.
  The bitmaps load lazily (`ui/src/backs.ts`, same caching and forget-on-
  failure as the glyph loader), one per back, only when in use or previewed.

### 2. The proof moves to the keyline

`ui/test/depth.test.ts` proves, for every bitmap back, on every undimmed layer:
the keyline holds 3:1 against every felt in `FELTS` and against its own
ground, and the ground stays at least 3:1 from the cream face so a back cannot
be mistaken for a blank tile. The plain default keeps issue #82's proof (the
light ground itself against the felt). What separates a face-down bitmap tile
from the table is its keyline and motif, plus the border, side and shadow
every tile carries; nothing on a back has game meaning, so 4.5:1 is not owed.

### 3. Where a back applies

The back follows the palette rule of 0039: the record's pick on ordinary
levels, the palette's own on a decade spike. `applyPalette` re-applies the
back, because the level can change under a chosen back and a spike must not
inherit it. The Daily board is untouched. `looks.back` joins `looks` under the
same stamp and rules as `glyphs` and `felt`; `DEFAULT_LOOKS` is
`{ back, felt, glyphs }`, still in sorted order. No schema or Worker change
beyond the default.

### 4. Shop

A **Tile backs** fieldset after the felts, one `ShopRow` per back, spoken as
"<name> tile back". The preview is a face-down tile baked by the board renderer
wearing that back (`backImage`), re-baked once its bitmap is in. Prices are the
issue's tiers until the PM sets final ones: Night Sky 10, Blue Wave 10,
Bamboo Grove 25, Cloud Scroll 25, Lacquer Lantern 25, Plum Branch 60, Koi 60.

### 5. Felt textures (a PM call on 0039 §1)

0039 shipped the felts flat, reading the brief's 8% tone-on-tone ceiling as
invisible at phone size. A composite of the generated felt sheet into a real
board screenshot (2026-09-05) showed the wood grain, hex tile and weave
reading clearly in the gaps between tiles, and the PM chose to ship them, at
one sheet pixel per CSS pixel, asking that the repeats join without visible
seams. So:

- `docs/design/cut-felts.py` cuts each swatch and makes it a seamless tile
  before writing `data/felts/<id>.png`: a lattice (hex, diamond, weave) is
  cropped to a whole number of its periods, read off the swatch's
  autocorrelation and refined to the crop whose wrap-around seam is smallest,
  so plain tiling continues the lattice with no mirror axis to break it on a
  wide screen; a non-periodic surface (wood grain, plain) is mirrored into a
  2 × 2 block so opposite edges match by construction. The seam is measured
  either way and the script refuses one worse than 1.5 × the interior. Sizes
  therefore differ per felt and ship in `FELTS[id].texture`. Quantised to 48
  colours (the JPEG noise, not the weave, is what made a truecolour PNG
  ~350 KB).
- The felt is painted by the **page**, not the canvas: the pixi canvas is
  transparent (`backgroundAlpha: 0`) and `#play-area` carries
  `--felt` (colour), `--felt-image` (texture, or `none`) and `--felt-size`
  (one repeat, the tile's own size). The board and the holder strip were already one surface
  through `--felt`; now they are through the texture too, and the colour
  stays under the image until it loads. The default felt and the milestone
  burgundy stay flat colours.
- `Felt.light` is the texture's brightest pixel (the cutter prints it). The
  back-vs-felt proof and the back-keyline proof run against `light`, not the
  base: a back has to clear the lightest thing on the table. A guard keeps
  `light` within 1.6:1 of its base, so a texture cannot drift into a new
  colour without failing the suite.

The sheet's slate and walnut swatches were generated lighter than the brief's
bases and land within a few units of the corrected colours 0039 shipped, so
no colour moved again.

## Alternatives considered

- **Crop the cells to 64:84 at cut time.** Loses the keyline on two edges;
  the keyline is what the proof rests on. Rejected.
- **Key the felt colour to alpha, like the glyph cutter keys cream.** Erases
  bamboo-grove's ground, which is that colour. The geometric mask needs no
  colour assumption. Rejected.
- **Prove ground-vs-felt 3:1 as the issue wrote it.** Fails for every dark
  ground on every dark felt, including the brief's own colours; satisfying it
  would mean light backs, which the brief forbids because they read as faces.
  Rejected for the keyline proof.
- **Tile the felt texture as a sprite inside the canvas.** Would leave the
  holder strip flat while the board was textured, undoing issue #67's one
  surface. A transparent canvas over a CSS background costs one composite and
  keeps the strip and board identical. Rejected.
- **Snap the sheet to its brief colours.** Not attempted here; the JPEG is
  shipped as drawn, as the glyph sets were (0038 §1's open gap applies).

## Consequences

- `Looks` is `{ back, felt, glyphs, …unknown }`; fixtures gained `back: 'lantern'`.
- ~870 KB of PNG under `data/backs/`, fetched one at a time on demand; the
  default costs nothing.
- The tile key carries the back id, so a back change redraws only face-down
  tiles' pictures; the holder never parks one, so its cache is untouched.
- Issue #229 has one slice left: avatar frames, whose sheet is also in
  `docs/design/`, plus the leaderboard re-review from 0038's security note.
