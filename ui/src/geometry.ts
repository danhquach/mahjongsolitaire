// Board-space geometry: slot lattice → pixel rects (issue #11).
//
// All values here are in *board pixels* — an internal coordinate space the
// renderer scales as one unit to fit the viewport. dp-based rules (the 8dp
// mis-tap radius) are converted by the caller via the current scale factor.

import type { Slot } from '@mahjongsolitaire/core';

/** Pixels per half-unit; a tile footprint is 2×2 half-units (spec §3.1). */
export const HALF_UNIT_X = 32;
export const HALF_UNIT_Y = 42;
export const TILE_W = 2 * HALF_UNIT_X;
export const TILE_H = 2 * HALF_UNIT_Y;
/** Per-layer up-left shift of the top face — the 3D "lift" of stacked tiles.
 *  Issue #86 raised it from 7: lower layers peek out clearly instead of as a
 *  sliver, and the thicker side face (SIDE_DEPTH tracks this) reads as a
 *  block, so stack height shows in side thickness. */
export const LAYER_LIFT = 11;
/**
 * Thickness of a tile's visible side face, in board px. One tile's own depth,
 * identical on every layer: extruding by the whole stack height instead makes
 * an upper-layer tile read as a thick slab while a ground tile looks like
 * paper. Equal to LAYER_LIFT so a tile's side exactly bridges the gap down to
 * the layer below it. (Tile art proper is issue #45.)
 */
export const SIDE_DEPTH = LAYER_LIFT;

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** Top-face rect of a tile in board pixels. */
export function tileRect(slot: Slot): Rect {
  return {
    x: slot.x * HALF_UNIT_X - slot.z * LAYER_LIFT,
    y: slot.y * HALF_UNIT_Y - slot.z * LAYER_LIFT,
    w: TILE_W,
    h: TILE_H,
  };
}

export function rectContains(r: Rect, px: number, py: number): boolean {
  return px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h;
}

/** Euclidean distance from a point to a rect (0 if inside). */
export function rectDistance(r: Rect, px: number, py: number): number {
  const dx = Math.max(r.x - px, 0, px - (r.x + r.w));
  const dy = Math.max(r.y - py, 0, py - (r.y + r.h));
  return Math.hypot(dx, dy);
}

/** Bounding box of a whole layout in board pixels (lift and side faces
 *  included, so the extrusion on the right/bottom edge is never clipped). */
export function boardBounds(slots: readonly Slot[]): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const s of slots) {
    const r = tileRect(s);
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w + SIDE_DEPTH);
    maxY = Math.max(maxY, r.y + r.h + SIDE_DEPTH);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/**
 * Reading order over the lattice: layer by layer bottom-up; within a layer
 * top-to-bottom then left-to-right. The near-pair hint groups same-face tiles
 * in this order (game.ts). It was the render order until issue #220 — see
 * drawOrder for why it could not stay so.
 */
export function paintOrder(a: Slot, b: Slot): number {
  return a.z - b.z || a.y - b.y || a.x - b.x;
}

/**
 * Painter's order for rendering (issue #220): layer by layer bottom-up; within
 * a layer by x + y, the depth of an oblique projection whose extrusion runs
 * down-right. A tile's side face reaches less than a half-unit right and down
 * of its top face, so on the lattice the same-layer neighbours it can extrude
 * into are exactly (x+2, y±1..2) and (x±1..0, y+2) — every one of them has a
 * larger x + y, so every one paints later and covers the side, which is what
 * two blocks standing on the same table look like. Row-major order got this
 * wrong for a right-hand neighbour half a row up: the tile painted after it and
 * laid its side across the neighbour's face, so the neighbour read as sitting
 * underneath. Ties (x + y equal, faces never overlapping) break on x.
 */
export function drawOrder(a: Slot, b: Slot): number {
  return a.z - b.z || a.x + a.y - (b.x + b.y) || a.x - b.x;
}
