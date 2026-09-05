# Prompts for tile backs, board backgrounds and avatar frames

Three prompts, one per cosmetic type. Copy everything between
`=== COPY FROM HERE ===` and `=== COPY TO HERE ===`. One paste, one sheet.

These are the purchasable cosmetics for issue #229 that do not touch the tile
face. Glyph sets are in `glyph-sheet-brief.md`. Cut a returned sheet with
`cut-glyphs.py` after editing its `ROWS` table to the labels below, or by hand.

Reference values from the code: tile ratio 64:84 with radius 6 at native size
(`ui/src/geometry.ts`, `ui/src/render.ts`); default felt `#14532d`, default
face-down back `#62c98a` with keyline `#1b4d30`, face cream `#fdf6e3`, tile
border `#6b5c3a` (`ui/src/depth.ts`). Reserved looks that nothing here may
imitate: burgundy felt `#4c0519` with rose edges is the Milestone board, night
indigo `#1e1b4b` with gold is the Daily board (decision 0017).

Rules that came out of review on 2026-09-05 and apply to every prompt:

- A back must never read as a face. Dark saturated ground, all-over pattern or
  one centred motif, no cream fill, no frame-inside-a-frame.
- A back must stay 3:1 against every felt it can sit on, so nothing mid-green.
- Nothing in these sheets carries game meaning. They are decoration only.


############################################################################
#                                                                          #
#                            TILE BACKS (8)                                 #
#                                                                          #
############################################################################

=== COPY FROM HERE ===
Draw one sprite sheet of 8 face-down tile backs for the mahjong solitaire game Lantern Tiles. One row, 8 cells. Each cell shows one complete tile back: a rounded rectangle with aspect ratio 64:84 and corner radius 6/64 of the width, filling a 256 x 336 px area, with a 2 px keyline stroke around its edge in the colour the cell specifies. Below each tile write its label in small grey text exactly as given.

Background of the whole image: flat dark green #14532d, no texture, no vignette, no shadow. The tiles sit on it like tiles on a table.

Style: flat vector, clean edges, no gradients, no shading, no bevel, no gloss. Each back is a dark saturated ground with either an all-over repeating pattern or one centred motif. Pattern lines are at least 6 px wide at this size. No cream or off-white fills anywhere on a back. No inner border or second frame inside the keyline. The backs must look like the back of a game tile, never like a tile face.

Content, left to right:
back-jade: ground #62c98a, keyline #1b4d30, plain, no pattern. This is the current default, include it for reference.
back-night-sky: ground #1e1b4b, keyline #c9a227, small gold #f5d67a stars scattered, one crescent moon off centre.
back-blue-wave: ground #0f3d4a, keyline #5eead4, all-over overlapping semicircle wave pattern (seigaiha) in #5eead4.
back-lacquer-lantern: ground #7c2d12, keyline #fde68a, one centred paper lantern silhouette in #fde68a with three vertical rib lines in the ground colour.
back-plum-branch: ground #3b0764, keyline #e9d5ff, one diagonal plum branch with five-petal blossoms in #e9d5ff.
back-koi: ground #0c4a6e, keyline #fdba74, one koi fish curving around the centre in #fdba74, two small ripple arcs.
back-bamboo-grove: ground #14532d, keyline #86efac, three tall bamboo stalks with leaves in #86efac. Note the ground matches the table, so the keyline must carry the edge.
back-cloud-scroll: ground #1c1917, keyline #d6d3d1, all-over stylised auspicious cloud scroll pattern in #d6d3d1.

Rules: every back must be identifiable in greyscale by its pattern alone. Do not copy or resemble any existing commercial mahjong tile set. No text inside the artwork. One level of detail across all cells.
=== COPY TO HERE ===


############################################################################
#                                                                          #
#                         BOARD BACKGROUNDS (6)                             #
#                                                                          #
############################################################################

The board background is the play-column felt behind the tiles. It must stay
quiet: the tiles carry the contrast, and every face-down back has to hold 3:1
against it. These are low-saturation, low-detail surfaces, not pictures.

=== COPY FROM HERE ===
Draw one sprite sheet of 6 table-felt swatches for the mahjong solitaire game Lantern Tiles. One row, 6 cells. Each cell is a 320 x 420 px rectangle filled edge to edge with one felt surface. Below each swatch write its label in small grey text exactly as given. Background of the whole image outside the swatches: flat cream #fdf6e3.

Style: flat, matte, very low contrast. Each swatch is one dark base colour with at most a subtle tone-on-tone pattern whose lightness differs from the base by no more than 8 percent. No gradients, no vignette, no lighting, no photo texture, no fibres, no noise. Nothing on a swatch may be brighter than its base by more than a small step. These are backgrounds; a cream tile placed on any of them must be the brightest thing in view by far.

Content, left to right:
felt-lantern: base #14532d, plain. This is the current default, include it for reference.
felt-forest: base #052e16, faint tone-on-tone diagonal weave.
felt-teal: base #134e4a, faint tone-on-tone hexagon tile pattern.
felt-slate: base #1e293b, plain with a faint tone-on-tone diamond lattice.
felt-walnut: base #3f2a1d, faint tone-on-tone wood-grain lines running vertically.
felt-ink: base #18181b, plain, no pattern.

Rules: no base may be near burgundy #4c0519 or near indigo #1e1b4b, those are reserved. Do not add any motif, emblem, animal or object. No text inside the swatches.
=== COPY TO HERE ===


############################################################################
#                                                                          #
#                          AVATAR FRAMES (8)                                #
#                                                                          #
############################################################################

The avatar is an emoji glyph inside a circle on a cream disc (`ui/src/profile.ts`,
`AVATARS`). A frame is a ring drawn around that disc. It must leave the disc
empty so any of the eight avatars fits inside, and it must read at 40 px.

=== COPY FROM HERE ===
Draw one sprite sheet of 8 avatar frames for the mahjong solitaire game Lantern Tiles. Two rows of 4 cells. Each cell is 320 x 320 px. In the centre of every cell is an empty circle of diameter 200 px filled flat cream #fdf6e3; the frame is drawn around that circle and never inside it. The cream circle stays completely empty in every cell. Below each frame write its label in small grey text exactly as given. Background of the whole image outside the cells: flat dark green #14532d.

Style: flat vector, clean edges, no gradients, no shading, no gloss, no drop shadow. Frame thickness between 16 and 36 px. Every frame must still read as a distinct shape when the whole cell is shrunk to 40 px.

Content, left to right, top row then bottom row:
frame-none: a plain 8 px ring in #6b5c3a. This is the current look, include it for reference.
frame-gold-ring: a solid 24 px ring in #c9a227 with a thin outer line in #8a6d1f.
frame-jade-square: a rounded square in #1a6b52, corner radius 40 px, 28 px thick, sized so the cream circle touches its inner edge.
frame-vermilion-double: two concentric rings in #b91c1c, 12 px each, with a 10 px cream gap between them.
frame-lantern: a ring in #7c2d12 with a small paper-lantern silhouette in #fde68a hanging from the top edge.
frame-plum: a ring in #3b0764 with four small five-petal blossoms in #e9d5ff at the compass points.
frame-wave: a ring in #0f3d4a whose outer edge is a repeating semicircle wave in #5eead4.
frame-dragon: a ring in #334155 with a simplified dragon silhouette in #cbd5e1 wrapping the top half, head at the right.

Rules: keep the inner cream circle empty and exactly circular in every cell. Do not copy or resemble any existing game's avatar frames. No text inside the artwork. One level of detail across all cells.
=== COPY TO HERE ===
