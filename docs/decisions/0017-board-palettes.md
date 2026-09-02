# 0017 — Board palettes: special levels wear their own felt and tile edges

**Date:** 2026-09-01 · **Status:** accepted · **Ticket:** issue #67 · **Builds on:** 0002 (art direction), 0011 (spike levels), 0016 (Daily Challenge)

## Context

Every board rendered the same felt and tile border, so a Daily Challenge or a
decade milestone level was visually indistinguishable from level 37. Decision
0002 fixed the face linework as theme-independent, and the depth work (issue
#45/#86) pinned contrast and greyscale floors in `ui/test/depth.test.ts` that
any new colour has to keep. Spec §2.2 lists themes/tile sets for v1.1+.

## Decision

1. **A palette is a value the renderer is handed** — `BoardPalette` in
   `ui/src/depth.ts`: felt, tile border, side base, face-down back and its
   keyline, plus an id and a label. `tileShade` takes it as an argument
   (lantern by default) and `BoardRenderer.setPalette` swaps it, dropping the
   holder's baked tile pictures so parked tiles follow. Nothing in the
   renderer is a per-level special case; v1.1+ themes add entries here.

2. **Three shipped palettes, chosen by level kind** in `main.ts`
   (`paletteInPlay`): ordinary ladder level → **lantern** (the existing
   constants, unchanged); Daily Challenge → **daily** (night indigo felt
   `#1e1b4b`, gold edges); decision 0011's every-tenth-level spike →
   **milestone** (burgundy felt `#4c0519`, rose edges). The spike is the
   ladder's "milestone/reward level" — it is already what the ladder calls
   special, so no new level kind is introduced.

3. **Only felt, border, side and back change.** The face fill and every ink
   stay exactly as they are, so the 4.5:1 ink-vs-face proof is one proof for
   all palettes; the border (3:1 vs face), side ramp, back-vs-felt (3:1) and
   keyline-vs-back proofs run once per palette in `depth.test.ts`, as does
   the soft-felt / strong-back rule from issue #82. Measured worst cases on
   2026-09-01: back/felt 3.93 (lantern), 5.22 (daily), 6.03 (milestone);
   border/face 5.57 / 7.15 / 8.41; base side band/face 5.31 / 5.28 / 5.67.

4. **Colour never carries the meaning alone** (spec §7): the Level chip's
   label reads "Daily" or "Milestone" for those boards, and the deal
   announcement says ", a milestone level" on a spike. The felt also paints
   the whole play column (`--felt` on `#app`, read by `#play-area`), not just
   the canvas, so the strip and board share one surface.

## Alternatives considered

- **Tinting the face too.** Would make every palette re-prove ink contrast
  against a different face on every layer and fight decision 0002's
  theme-independent linework. Rejected.
- **A palette per band (easy/medium/hard).** Reads as difficulty signalling
  the ladder deliberately avoids (decision 0011's flat plateaus). Rejected;
  kinds, not bands.
- **CSS-only theming of the page around an unchanged board.** The tiles are
  the board; a green table with the same tiles does not read as special.
  Rejected, though the play-column felt does use CSS for the non-canvas part.
