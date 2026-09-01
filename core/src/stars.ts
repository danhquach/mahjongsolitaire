// Star rating per level (spec §6, issue #19): 1–3 stars "from moves used,
// hints used, and completion time relative to the level's baseline".
//
// Two of the spec's three inputs collapse into one (issue #51 called it): a
// full board always clears in exactly tiles/2 matches, and since decision
// 0013 every match consumes exactly one parked tile, so the hold count at a
// win is tiles/2 too. The only way "moves used" varies is through the
// boosters — an Undo un-parks a tile that then has to be parked again, a
// Shuffle re-deals the remaining faces. So the rating reads two independent
// axes, each worth one star:
//
//   * assists — any Hint, Undo or Shuffle spent on this deal costs a star;
//   * pace — finishing over the level's baseline time costs a star.
//
// Three stars is therefore "unaided and inside the baseline", one star is a
// clear that was neither. Nothing here is punitive beyond the rating itself:
// the score, the ladder advance and the record's clear count are untouched.
//
// The baseline is a per-pair budget scaled by band (decision 0016): a harder
// band's deeper stacks and concealed tiles cost more time per pair, and the
// budget is deliberately generous — a relaxed but unhesitating clear should
// make it, a player who walks away from the board should not.

import type { LadderBand } from './ladder.js';

export type StarRating = 1 | 2 | 3;

/** Baseline seconds per pair, by band, as ms. 144 tiles → 72 pairs → an easy
 *  board's budget is 7.2 min, a hard spike's 12 min. */
export const PAIR_BASELINE_MS: Record<LadderBand, number> = {
  easy: 6_000,
  medium: 8_000,
  'medium-plus': 9_000,
  hard: 10_000,
};

/** The level's baseline completion time (spec §6), in ms. */
export function baselineMs(tileCount: number, band: LadderBand): number {
  if (!Number.isInteger(tileCount) || tileCount <= 0 || tileCount % 2 !== 0) {
    throw new RangeError(`tile count must be a positive even integer: ${tileCount}`);
  }
  return (tileCount / 2) * PAIR_BASELINE_MS[band];
}

/** What a cleared level is rated on. Counts are the boosters *spent* on this
 *  deal (charged uses — a refused press cost nothing and counts nothing). */
export interface StarInputs {
  readonly hints: number;
  readonly undos: number;
  readonly shuffles: number;
  readonly elapsedMs: number;
}

export function starRating(inputs: StarInputs, baseline: number): StarRating {
  for (const [name, v] of Object.entries(inputs)) {
    if (!Number.isFinite(v) || v < 0) throw new RangeError(`${name} must be a non-negative number: ${v}`);
  }
  const assists = inputs.hints + inputs.undos + inputs.shuffles;
  let stars = 3;
  if (assists > 0) stars--;
  if (inputs.elapsedMs > baseline) stars--;
  return stars as StarRating;
}

/** A stored rating, or null for anything that is not exactly 1, 2 or 3. */
export function parseStarRating(value: unknown): StarRating | null {
  return value === 1 || value === 2 || value === 3 ? value : null;
}
