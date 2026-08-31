// Tap → tile resolution with mis-tap forgiveness (spec §7, issue #11):
// "nearest-free-tile resolution within 8dp of a tap point".

import type { TileId } from '@mahjongsolitaire/core';
import { rectContains, rectDistance, tileRect } from './geometry.js';
import type { Rect } from './geometry.js';

export interface HitCandidate {
  readonly id: TileId;
  readonly slot: { readonly x: number; readonly y: number; readonly z: number };
  readonly free: boolean;
}

export type Hit =
  | { readonly kind: 'free'; readonly id: TileId; readonly forgiven: boolean }
  | { readonly kind: 'blocked'; readonly id: TileId }
  | { readonly kind: 'miss' };

/**
 * Resolve a tap at (px, py) in board pixels against the present tiles.
 * Preference order:
 *  1. the topmost tile directly under the point, if free;
 *  2. the nearest free tile within `forgiveness` board px (8dp ÷ view scale)
 *     — this also rescues taps that land on a blocked tile or empty space;
 *  3. the topmost blocked tile directly under the point (for feedback);
 *  4. miss.
 * Deterministic tie-breaks: distance, then higher layer, then lower id.
 */
export function hitTest(
  tiles: readonly HitCandidate[],
  px: number,
  py: number,
  forgiveness: number,
): Hit {
  let direct: HitCandidate | null = null;
  for (const t of tiles) {
    if (!rectContains(tileRect(t.slot), px, py)) continue;
    if (direct === null || t.slot.z > direct.slot.z) direct = t;
  }
  if (direct?.free) return { kind: 'free', id: direct.id, forgiven: false };

  let best: HitCandidate | null = null;
  let bestDist = Infinity;
  for (const t of tiles) {
    if (!t.free) continue;
    const d = rectDistance(tileRect(t.slot), px, py);
    if (d > forgiveness) continue;
    if (
      best === null ||
      d < bestDist ||
      (d === bestDist && (t.slot.z > best.slot.z || (t.slot.z === best.slot.z && t.id < best.id)))
    ) {
      best = t;
      bestDist = d;
    }
  }
  if (best) return { kind: 'free', id: best.id, forgiven: true };
  if (direct) return { kind: 'blocked', id: direct.id };
  return { kind: 'miss' };
}

export type { Rect };
