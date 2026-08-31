// Board fit and HUD placement (issue #37).
//
// The board is drawn at a single uniform scale into whatever area the HUD
// leaves it. Which edge the HUD takes therefore decides how big the tiles get,
// and the best edge depends on the board's aspect ratio *and* the viewport's:
// a top bar spends height, a side rail spends width, and only one of those is
// the scarce axis at any given moment.
//
// Rather than branch on orientation (or on which layout is loaded — there are
// 10 of them coming in issue #17, each with its own aspect ratio), we compute
// the fit scale that each candidate placement would produce and keep the
// larger. Phone landscape on Turtle picks the rail, phone portrait picks the
// bar, and a portrait-shaped layout inverts both — with no special cases.
//
// This module is deliberately DOM-free and Pixi-free: `availW`/`availH` are
// measured by the caller. The renderer fits with the same `fitScale()` used to
// pick the placement, so the two can never disagree.

/** Gutter left around the board on every side, in CSS px. */
export const BOARD_MARGIN = 12;
/**
 * Upper bound on magnification. Placeholder tile art (issue #45) has no detail
 * to reward blowing a 12-tile board up to fill a tablet, and an unbounded fit
 * would put the tap targets absurdly far apart.
 */
export const MAX_FIT_SCALE = 2;

export type HudPlacement = 'top' | 'side';

/**
 * Candidate placements, in preference order: ties resolve to the earlier entry,
 * so an over-large viewport (both candidates capped) keeps the top bar rather
 * than flipping between the two.
 */
export const HUD_PLACEMENTS: readonly HudPlacement[] = ['top', 'side'];

/** A placement and the board area, in CSS px, that it would leave behind. */
export interface HudCandidate {
  readonly placement: HudPlacement;
  readonly availW: number;
  readonly availH: number;
}

/** Just the part of a board's bounds that the fit depends on. */
export interface BoardExtent {
  readonly w: number;
  readonly h: number;
}

/**
 * Uniform scale that fits `board` into an `availW` × `availH` area, inset by
 * BOARD_MARGIN on every side and capped at MAX_FIT_SCALE. Clamped at 0 so a
 * viewport narrower than its own margins cannot mirror the board.
 */
export function fitScale(board: BoardExtent, availW: number, availH: number): number {
  const innerW = Math.max(availW - 2 * BOARD_MARGIN, 0);
  const innerH = Math.max(availH - 2 * BOARD_MARGIN, 0);
  return Math.min(innerW / board.w, innerH / board.h, MAX_FIT_SCALE);
}

/**
 * The placement whose leftover area fits `board` largest. Candidates carry
 * their own measured areas, so this stays honest about a HUD whose size the
 * caller cannot predict (wrapped buttons, Dynamic Type, a longer locale).
 */
export function chooseHudPlacement(
  board: BoardExtent,
  candidates: readonly HudCandidate[],
): HudPlacement {
  let best: HudPlacement | null = null;
  let bestScale = -Infinity;
  for (const candidate of candidates) {
    const scale = fitScale(board, candidate.availW, candidate.availH);
    if (scale > bestScale) {
      best = candidate.placement;
      bestScale = scale;
    }
  }
  if (best === null) throw new Error('chooseHudPlacement needs a candidate');
  return best;
}
