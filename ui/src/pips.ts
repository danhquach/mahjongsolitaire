// Where pip art goes on a tile face, and how big it may be (issue #45).
//
// Split out of render.ts because it is the part that can be wrong without
// throwing: the first cut of the redrawn pips sized each shape from the gap
// between pip *centres* and drew it centred there, which let five of the
// Bamboo ranks hang over the bottom edge of the tile and put eight ranks under
// the corner tag. Nothing caught it but looking at a screenshot.
//
// So the layout is stated here, as geometry, with two independent guarantees:
//
//   1. `PIP_AREA` is a rect that is inside the tile and clear of `TAG_BOX`, and
//   2. `pipMetrics` clamps every shape to fit inside PIP_AREA given where the
//      rank actually puts its pips — so no pip table, however hand-authored,
//      can overflow.
//
// ui/test/pips.test.ts walks the whole 144-tile set and asserts both.

import { TILE_H, TILE_W } from './geometry.js';
import type { Rect } from './geometry.js';
import type { Pip } from './faces.js';

/** Corner-tag type size. The tag is the rank/initial that pairs with the suit
 *  symbol so identical faces are matchable at a glance (decision 0002). */
export const TAG_FONT_SIZE = TILE_H * 0.2;
/** Top-left origin the tag is drawn from. */
export const TAG_ORIGIN = { x: 5, y: 2 } as const;
/**
 * The box the tag may occupy. Deliberately generous: the tag is a single
 * character today, but the width is reserved for the widest one a font might
 * hand back rather than measured per glyph — art must not creep under it just
 * because '1' happens to be narrow.
 */
export const TAG_BOX: Rect = {
  x: TAG_ORIGIN.x,
  y: TAG_ORIGIN.y,
  w: TAG_FONT_SIZE * 0.7,
  h: TAG_FONT_SIZE * 1.05,
};

/** Clearance between the tag and the art below it. */
const TAG_CLEARANCE = 2;
/** Side and bottom margins of the pip area within the tile face. */
const SIDE_MARGIN = TILE_W * 0.09;
const BOTTOM_MARGIN = TILE_H * 0.055;

/** The region pip art may occupy: inside the face, below the corner tag. */
export const PIP_AREA: Rect = {
  x: SIDE_MARGIN,
  y: TAG_BOX.y + TAG_BOX.h + TAG_CLEARANCE,
  w: TILE_W - 2 * SIDE_MARGIN,
  h: TILE_H - (TAG_BOX.y + TAG_BOX.h + TAG_CLEARANCE) - BOTTOM_MARGIN,
};

// --- composed season faces (issue #75, decision 0012) --------------------------
// The Seasons draw text, not pips, but their layout lives here with the rest of
// the face geometry so ui/test/faces.test.ts can bound it the way pips.test.ts
// bounds the pip art — this file's header is the story of what happens when
// face art is sized inline in the renderer with nothing checking containment.

/** Main pictogram type size. */
export const SEASON_GLYPH_SIZE = TILE_H * 0.32;
/** Scatter companion type size. */
export const SEASON_SCATTER_SIZE = TILE_H * 0.13;
/** Season name type size. Floor-tested against TAG_FONT_SIZE: the corner tag
 *  is the established smallest-legible reference, and a whole word carries
 *  more shape than a lone digit, so it may run somewhat smaller — never less
 *  than 70% of it (QA-confirmed legible at the smallest rendered tile). */
export const SEASON_NAME_SIZE = TILE_H * 0.14;
/** Pictogram centre in unit pip-area coordinates — above centre so the name
 *  band underneath stays clear of it. */
export const SEASON_GLYPH_POS = { x: 0.5, y: 0.36 } as const;
/** Name-text centre in unit pip-area coordinates. */
export const SEASON_NAME_POS = { x: 0.5, y: 0.88 } as const;

/** Pip diameter as a fraction of the room it has — just short of touching. */
const RING_FILL = 0.92;
/** Ceiling on a ring's radius, for ranks with acres of room (ranks 1 and 2). */
const RING_R_MAX = TILE_W * 0.2;

/**
 * Cane size as a fraction of the room it has, and its ceilings.
 *
 * The vertical fill is well short of the room available on purpose: a cane's
 * three bulges are a repeating pattern, so two canes stacked nose to tail read
 * as one cane with six bulges. The gap is what keeps a rank countable.
 */
const CANE_FILL_W = 0.82;
const CANE_FILL_H = 0.78;
const CANE_W_MAX = TILE_W * 0.3;
const CANE_H_MAX = TILE_H * 0.4;
/**
 * Widest a cane may be relative to its own height. A cane is a tall segment;
 * the sparse ranks have enough horizontal room to draw one nearly square, and
 * a square cane reads as a barrel. Height is chosen first, then this caps the
 * width — so a rank with generous columns gets a *taller* cane, not a fatter
 * one.
 */
const CANE_ASPECT = 0.42;
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
    caneW: Math.min(
      minRowGap * CANE_FILL_W,
      caneH * CANE_ASPECT,
      CANE_W_MAX,
      2 * hwRoom * CANE_FILL_W,
    ),
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
