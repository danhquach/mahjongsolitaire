// Where pip art goes on a tile face, and how big it may be (issue #45).
//
// Split out of render.ts because it is the part that can be wrong without
// throwing: the first cut of the redrawn pips sized each shape from the gap
// between pip *centres* and drew it centred there, which let five of the
// Bamboo ranks hang over the bottom edge of the tile and put eight ranks under
// the (since removed) corner tag. Nothing caught it but looking at a screenshot.
//
// So the layout is stated here, as geometry, with two independent guarantees:
//
//   1. `PIP_AREA` is a rect that is inside the tile, and
//   2. `pipMetrics` clamps every shape to fit inside PIP_AREA given where the
//      rank actually puts its pips — so no pip table, however hand-authored,
//      can overflow.
//
// ui/test/pips.test.ts walks the whole 144-tile set and asserts both.
//
// Issue #152 removed the corner tag and gave its room to the art: the area is
// now centred on the face at ~80% of its width and ~83% of its height, the
// glyph faces grew from 42% to 52% of the tile height, Dots rings and Bamboo
// canes got heavier, and the White Dragon became a drawn double frame.

import { TILE_H, TILE_W } from './geometry.js';
import type { Rect } from './geometry.js';
import type { Pip } from './faces.js';

/** Side and top/bottom margins of the pip area within the tile face. */
const SIDE_MARGIN = TILE_W * 0.1;
const END_MARGIN = TILE_H * 0.085;

/** The region face art may occupy: centred on the face, inside its margins. */
export const PIP_AREA: Rect = {
  x: SIDE_MARGIN,
  y: END_MARGIN,
  w: TILE_W - 2 * SIDE_MARGIN,
  h: TILE_H - 2 * END_MARGIN,
};

/** Type size of a single-glyph face (Characters, Winds, the two typed
 *  Dragons), centred in PIP_AREA. */
export const GLYPH_FONT_SIZE = TILE_H * 0.52;

// --- the White Dragon's frame (issue #152, decision 0023) ----------------------
// A drawn double frame, centred in PIP_AREA: a white-filled rounded rectangle
// with a slate outline, and a thin second outline just inside it. Stated here
// so faces.test.ts can bound it like every other piece of face art.

/** Outer frame size. */
export const FRAME_W = TILE_W * 0.5;
export const FRAME_H = TILE_H * 0.58;
/** Outer outline weight; the inner outline is a fraction of it. */
export const FRAME_STROKE = TILE_W * 0.045;
export const FRAME_INNER_STROKE = FRAME_STROKE * 0.45;
/** Where the inner outline's outer edge sits, in from the outer frame's edge. */
export const FRAME_INNER_INSET = FRAME_STROKE * 2.6;
export const FRAME_RADIUS = 4;

// --- composed season faces (issue #75, decision 0012) --------------------------
// The Seasons draw text, not pips, but their layout lives here with the rest of
// the face geometry so ui/test/faces.test.ts can bound it the way pips.test.ts
// bounds the pip art — this file's header is the story of what happens when
// face art is sized inline in the renderer with nothing checking containment.

/** Main pictogram type size. */
export const SEASON_GLYPH_SIZE = TILE_H * 0.32;
/** Scatter companion type size. */
export const SEASON_SCATTER_SIZE = TILE_H * 0.13;
/** Season name type size — the smallest ink on any face now that the corner
 *  tag is gone (issue #152). QA-confirmed legible at the smallest rendered
 *  tile; faces.test.ts pins the floor so a retheme cannot shrink it. */
export const SEASON_NAME_SIZE = TILE_H * 0.14;
/** Pictogram centre in unit pip-area coordinates — above centre so the name
 *  band underneath stays clear of it. */
export const SEASON_GLYPH_POS = { x: 0.5, y: 0.36 } as const;
/** Name-text centre in unit pip-area coordinates. */
export const SEASON_NAME_POS = { x: 0.5, y: 0.88 } as const;

/** Pip diameter as a fraction of the room it has. Issue #152 pulled it in
 *  from 0.92: a bold ring needs more air than a thin one, and this is what
 *  keeps Dots-9 at ≥ 2 board px between rings (pips.test.ts pins it). */
const RING_FILL = 0.86;
/** Ceiling on a ring's radius, for ranks with acres of room (ranks 1 and 2). */
const RING_R_MAX = TILE_W * 0.2;
/** Ring stroke as a fraction of the ring's outer radius (issue #152: bold
 *  rings, up from ≈ 0.42). Rank 9 is the tightest and keeps its gaps because
 *  the stroke is inside the radius — RING_FILL is what spaces the rings. */
export const RING_STROKE = 0.7;

/**
 * Cane size as a fraction of the room it has, and its ceilings.
 *
 * Width (issue #152): ≈ 0.42 of the column pitch, capped at 21% of the pip
 * area's width. The cap equals 0.42 of a two-column pitch, so Bamboo-3 (one
 * over two) lands exactly on it and ranks 1–3 share one width; it is also what
 * stops the sparse ranks ballooning into barrels.
 *
 * The vertical fill is well short of the room available on purpose: a cane's
 * bulges are a repeating pattern, so two canes stacked nose to tail read as
 * one long cane. The gap is what keeps a rank countable.
 */
const CANE_FILL_W = 0.42;
const CANE_FILL_H = 0.78;
const CANE_W_MAX = PIP_AREA.w * 0.21;
const CANE_H_MAX = TILE_H * 0.4;
/** Positions closer than this (in area px) are the same band, not two. */
const BAND_EPSILON = 0.5;

export interface PipMetrics {
  /** Outer radius of a Dots ring. */
  readonly ringR: number;
  readonly caneW: number;
  readonly caneH: number;
}

/** Board-px centre of a pip within the pip area. */
export function pipCenter(pip: Pip): { x: number; y: number } {
  return { x: PIP_AREA.x + pip.x * PIP_AREA.w, y: PIP_AREA.y + pip.y * PIP_AREA.h };
}

/** Half-width and half-height of one drawn pip, by shape. */
export function pipHalfExtent(
  shape: 'ring' | 'cane',
  m: PipMetrics,
): { hw: number; hh: number } {
  return shape === 'cane' ? { hw: m.caneW / 2, hh: m.caneH / 2 } : { hw: m.ringR, hh: m.ringR };
}

/**
 * How big one pip may be, measured from the pip positions themselves.
 *
 * Counting bands per axis is not enough: Dots-7 stacks a diagonal of three over
 * a square of four, so it has five distinct rows but its pips are nowhere near
 * five rows apart — sizing off the band count shrinks that rank to nothing. So
 * the limit comes from the neighbours, per shape, because a disc and a
 * rectangle do not clear each other the same way:
 *
 *   * a ring is round, so *any* direction counts: its limit is the smallest
 *     centre-to-centre distance in the rank;
 *   * a cane is a rectangle, and two rectangles clear each other by being far
 *     enough apart on **either** axis. So its width is limited only by pips
 *     sharing its row, and its height only by pips sharing its column. A pair
 *     that is offset both ways — Bamboo-5's centre cane against its corners —
 *     constrains neither, because the horizontal offset already separates them.
 *     Taking the smallest gap on each axis over *all* pairs instead is what
 *     collapsed Bamboo-5 and Bamboo-7 to slivers.
 *
 * Then everything is clamped to the room left between the outermost pips and
 * the edge of PIP_AREA. That clamp is the guarantee: a rank with one pip has no
 * neighbour and no spacing limit at all, and a hand-authored rank can put its
 * pips anywhere, so "fits inside the area" cannot rest on the constants alone.
 */
export function pipMetrics(pips: readonly Pip[]): PipMetrics {
  let minDistance = Infinity;
  let minRowGap = Infinity;
  let minColumnGap = Infinity;
  for (let i = 0; i < pips.length; i++) {
    for (let j = i + 1; j < pips.length; j++) {
      const dx = Math.abs(pips[i]!.x - pips[j]!.x) * PIP_AREA.w;
      const dy = Math.abs(pips[i]!.y - pips[j]!.y) * PIP_AREA.h;
      minDistance = Math.min(minDistance, Math.hypot(dx, dy));
      if (dy <= BAND_EPSILON) minRowGap = Math.min(minRowGap, dx);
      if (dx <= BAND_EPSILON) minColumnGap = Math.min(minColumnGap, dy);
    }
  }

  // Room between the outermost pip centres and the edges of the area.
  let hwRoom = Infinity;
  let hhRoom = Infinity;
  for (const pip of pips) {
    hwRoom = Math.min(hwRoom, pip.x * PIP_AREA.w, (1 - pip.x) * PIP_AREA.w);
    hhRoom = Math.min(hhRoom, pip.y * PIP_AREA.h, (1 - pip.y) * PIP_AREA.h);
  }

  // The fill factors apply to the edge clamp too, not just to the neighbour
  // spacing: a rank where no two pips share a column (Bamboo-3 is one over two)
  // has no spacing limit on height at all, so the edge is the only thing left
  // to bound it — and a cane grown flush to the area edge butts straight into
  // the row below.
  const caneH = Math.min(minColumnGap * CANE_FILL_H, CANE_H_MAX, 2 * hhRoom * CANE_FILL_H);
  return {
    ringR: Math.min((minDistance * RING_FILL) / 2, RING_R_MAX, hwRoom, hhRoom),
    caneW: Math.min(minRowGap * CANE_FILL_W, CANE_W_MAX, 2 * hwRoom * CANE_FILL_W),
    caneH,
  };
}

/** Bounding box of a rank's drawn pip art, in tile-face board px. */
export function pipBounds(
  pips: readonly Pip[],
  shape: 'ring' | 'cane',
  m: PipMetrics = pipMetrics(pips),
): Rect {
  const { hw, hh } = pipHalfExtent(shape, m);
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const pip of pips) {
    const c = pipCenter(pip);
    x0 = Math.min(x0, c.x - hw);
    y0 = Math.min(y0, c.y - hh);
    x1 = Math.max(x1, c.x + hw);
    y1 = Math.max(y1, c.y + hh);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
