// Tutorial spotlight (issue #150): while a tutorial step (issue #59) is up,
// everything but the step's *actor* sits behind a dark scrim, and the actor
// is cut out at full brightness with a ring around it. This module is the
// geometry only — which tiles to point at, where the holes and tags go, the
// scrim's path — so all of it is unit-testable; main.ts owns the DOM.
//
// Rules (PM-reviewed prototype, 2026-09-02):
//   * a spotlighted tile must be *fully visible*: nothing on a higher layer
//     overlaps any part of its face, so the ring is around a whole tile;
//   * the two tiles of a step sit in the same half of the board, and the
//     step card takes the other half, so the card never covers an actor;
//   * step 2's FREE / BLOCKED tags fan outward from the pair's centre with a
//     leader arrow each, above the tiles when there is room, below otherwise.

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** What the picker needs to know about one present tile. `rect` is the
 *  tile's face on screen, in the same coordinate space as everything else
 *  here (page CSS px in main.ts). */
export interface SpotTile {
  readonly id: number;
  readonly z: number;
  readonly free: boolean;
  readonly face: string;
  readonly rect: Rect;
}

export type HoleKind = 'free' | 'blocked' | 'pair' | 'panel';

export interface Hole extends Rect {
  readonly kind: HoleKind;
  /** Corner radius. */
  readonly r: number;
}

/** How much of a neighbour's face may touch this one before it counts as
 *  overlapping: the renderer's side depth spills a few px right and down. */
const OVERLAP_PAD_X = 4;
const OVERLAP_PAD_Y = 8;

function intersects(a: Rect, b: Rect, px: number, py: number): boolean {
  return a.x < b.x + b.w + px && a.x + a.w + px > b.x && a.y < b.y + b.h + py && a.y + a.h + py > b.y;
}

/** No tile on a higher layer overlaps any part of this tile's face. */
export function fullyVisible(tile: SpotTile, tiles: readonly SpotTile[]): boolean {
  return !tiles.some(
    (u) => u.id !== tile.id && u.z > tile.z && intersects(u.rect, tile.rect, OVERLAP_PAD_X, OVERLAP_PAD_Y),
  );
}

const centreY = (r: Rect): number => r.y + r.h / 2;
const centreX = (r: Rect): number => r.x + r.w / 2;

/** Which half of the board a rect's centre is in. */
export function half(rect: Rect, boardMidY: number): 'top' | 'bottom' {
  return centreY(rect) < boardMidY ? 'top' : 'bottom';
}

/** Room between the nearest of these rects and the board's middle line. */
function clearance(rects: readonly Rect[], boardMidY: number): number {
  return Math.min(...rects.map((r) => Math.abs(centreY(r) - boardMidY)));
}

/**
 * Step 2's actors: one free and one blocked tile, both fully visible, in the
 * same half. Neighbours first (the contrast reads best side by side), then
 * the pair with the most room from the middle. Null when the board has no
 * such pair — the step then shows without a spotlight.
 */
export function pickFreeBlocked(
  tiles: readonly SpotTile[],
  boardMidY: number,
): { readonly free: SpotTile; readonly blocked: SpotTile } | null {
  const visible = tiles.filter((t) => fullyVisible(t, tiles));
  const frees = visible.filter((t) => t.free);
  const blocked = visible.filter((t) => !t.free);
  let best: { score: number; free: SpotTile; blocked: SpotTile } | null = null;
  for (const b of blocked) {
    for (const f of frees) {
      if (half(b.rect, boardMidY) !== half(f.rect, boardMidY)) continue;
      const d = Math.hypot(centreX(b.rect) - centreX(f.rect), centreY(b.rect) - centreY(f.rect));
      const score = -d + clearance([b.rect, f.rect], boardMidY) * 0.5;
      if (best === null || score > best.score) best = { score, free: f, blocked: b };
    }
  }
  return best === null ? null : { free: best.free, blocked: best.blocked };
}

/**
 * Step 3's actors: a matchable free pair (same face, both free), both fully
 * visible. Same half preferred, with the most room from the middle; if no
 * pair fits one half, any fully visible pair; null when there is none (the
 * caller falls back to the solver's hint, unringed).
 */
export function pickVisiblePair(
  tiles: readonly SpotTile[],
  boardMidY: number,
): readonly [SpotTile, SpotTile] | null {
  const byFace = new Map<string, SpotTile[]>();
  for (const t of tiles) {
    if (!t.free || !fullyVisible(t, tiles)) continue;
    const list = byFace.get(t.face);
    if (list) list.push(t);
    else byFace.set(t.face, [t]);
  }
  let sameHalf: { score: number; pair: readonly [SpotTile, SpotTile] } | null = null;
  let any: readonly [SpotTile, SpotTile] | null = null;
  for (const ids of byFace.values()) {
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const pair = [ids[i]!, ids[j]!] as const;
        any ??= pair;
        if (half(pair[0].rect, boardMidY) !== half(pair[1].rect, boardMidY)) continue;
        const score = clearance([pair[0].rect, pair[1].rect], boardMidY);
        if (sameHalf === null || score > sameHalf.score) sameHalf = { score, pair };
      }
    }
  }
  return sameHalf?.pair ?? any;
}

/** A tile's hole: the face plus a little of the side depth below it. */
export function tileHole(rect: Rect, kind: 'free' | 'blocked' | 'pair'): Hole {
  return { x: rect.x, y: rect.y, w: rect.w, h: rect.h + 6, r: 8, kind };
}

/** A HUD element's hole: the element with a 6px halo. */
export function panelHole(rect: Rect): Hole {
  return { x: rect.x - 6, y: rect.y - 6, w: rect.w + 12, h: rect.h + 12, r: 12, kind: 'panel' };
}

/**
 * Where the step card goes: the half of the board that holds no actor.
 * Bottom (the card's usual place) unless some hole's centre is in the lower
 * half.
 */
export function cardSide(holes: readonly Hole[], boardMidY: number): 'top' | 'bottom' {
  return holes.some((h) => centreY(h) > boardMidY) ? 'top' : 'bottom';
}

/** True when a hole would sit under the card's rect — the fallback case
 *  where the card shrinks to leave room. */
export function cardCoversHole(card: Rect, holes: readonly Hole[]): boolean {
  return holes.some((h) => intersects(card, h, 0, 0));
}

/** The scrim: the whole viewport with the holes cut out (even-odd fill). */
export function scrimPath(width: number, height: number, holes: readonly Hole[]): string {
  const rounded = (h: Hole): string => {
    const r = Math.min(h.r, h.w / 2, h.h / 2);
    return (
      `M${h.x + r},${h.y}h${h.w - 2 * r}a${r},${r} 0 0 1 ${r},${r}v${h.h - 2 * r}` +
      `a${r},${r} 0 0 1 -${r},${r}h-${h.w - 2 * r}a${r},${r} 0 0 1 -${r},-${r}v-${h.h - 2 * r}` +
      `a${r},${r} 0 0 1 ${r},-${r}z`
    );
  };
  return [`M0,0H${width}V${height}H0z`, ...holes.map(rounded)].join(' ');
}

export interface Tag {
  readonly kind: 'free' | 'blocked';
  readonly text: string;
  /** The pill. */
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** The leader arrow, pill end → tile end. */
  readonly from: { readonly x: number; readonly y: number };
  readonly to: { readonly x: number; readonly y: number };
  readonly above: boolean;
}

export const TAG_H = 22;
const TAG_GAP = 36; // pill-to-tile distance, arrow included
const TAG_SIDE = 30; // how far the pill's centre sits beyond the tile's edge

/**
 * FREE / BLOCKED pills for step 2. Each fans *outward* from the pair's
 * centre (left tile → left, right tile → right) so two adjacent tiles never
 * share a pill's space, and a leader arrow points at its own tile. Above the
 * tile when there is `TAG_GAP + TAG_H` of room over `minY` (the top of the
 * area the scrim covers), below it otherwise.
 */
export function layoutTags(holes: readonly Hole[], minY: number): Tag[] {
  const tagged = holes.filter((h) => h.kind === 'free' || h.kind === 'blocked');
  if (tagged.length === 0) return [];
  const meanX = tagged.reduce((sum, h) => sum + centreX(h), 0) / tagged.length;
  return tagged.map((h, i) => {
    const cx = centreX(h);
    const side = cx < meanX ? -1 : cx > meanX ? 1 : i % 2 === 0 ? -1 : 1;
    const text = h.kind === 'free' ? 'FREE' : 'BLOCKED';
    const w = text.length * 9 + 20;
    const tx = cx + side * (h.w / 2 + TAG_SIDE);
    const above = h.y - TAG_GAP - TAG_H >= minY + 8;
    const y = above ? h.y - TAG_GAP - TAG_H : h.y + h.h + TAG_GAP;
    return {
      kind: h.kind as 'free' | 'blocked',
      text,
      x: tx - w / 2,
      y,
      w,
      h: TAG_H,
      from: { x: tx, y: above ? y + TAG_H : y },
      to: { x: cx + side * 6, y: above ? h.y - 4 : h.y + h.h + 4 },
      above,
    };
  });
}
