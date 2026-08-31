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
/** Per-layer up-left shift of the top face — the 3D "lift" of stacked tiles. */
export const LAYER_LIFT = 7;
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
 * Painter's order for rendering: layer by layer bottom-up; within a layer
 * top-to-bottom then left-to-right, so each tile's down-right bevel is
 * overdrawn by its right/lower neighbors and upper layers cover lower ones.
 */
export function paintOrder(a: Slot, b: Slot): number {
  return a.z - b.z || a.y - b.y || a.x - b.x;
}
