// Face-down tiles (issue #64): which tiles of a deal are dealt concealed.
//
// Concealment changes what the player *knows*, never what is legally matchable
// (PM answers 1–3 on the ticket): faces stay fixed at deal time, a concealed
// tile occupies its slot and obeys the free-tile rule unchanged, and the
// solver, deal validator and Shuffle all keep reading the real faces. So this
// module is only a deterministic *pick* — the reveal/peek state machine lives
// in the game controller, and nothing here touches Board.
//
// The pick is a pure function of (layoutId, seed, bucket), on its own rng
// stream so it can never perturb generation. Deriving it beats storing it: a
// resumed game re-derives the same set, so a reload is never a free reveal-all
// and the save format does not change (spec §9 stays `(layoutId, seed)` + what
// play changed).

import type { TileId } from './board.js';
import type { DifficultyBucket } from './difficulty.js';
import type { GeneratedLevel } from './generator.js';
import { hashString, mulberry32 } from './rng.js';

/**
 * Fraction of the deal dealt face-down, per difficulty bucket (ticket answer
 * 4: none on easy, growing from the next band up). Provisional like the
 * difficulty weights themselves — Phase 3 ladder calibration (#18) re-balances.
 */
export const CONCEAL_RATIO: Record<DifficultyBucket, number> = {
  easy: 0,
  medium: 0.08,
  hard: 0.15,
  expert: 0.22,
};

/** Hard cap on concealed tiles per deal, whatever the ratio says — the ticket's
 *  guard against a board becoming a memory-test slog. */
export const CONCEAL_CAP = 24;

/** Tiles dealt face-down for a deal of `tileCount` tiles in `bucket`. */
export function concealedCount(tileCount: number, bucket: DifficultyBucket): number {
  return Math.min(CONCEAL_CAP, Math.floor(tileCount * CONCEAL_RATIO[bucket]));
}

/**
 * The ids dealt face-down, ascending. Deterministic per (layoutId, seed,
 * bucket); any tile is eligible — a concealed pair stays matchable because
 * selection pins a reveal (decision 0010), so the generator needs no
 * partner-must-be-face-up constraint.
 */
export function concealedTileIds(level: GeneratedLevel, bucket: DifficultyBucket): TileId[] {
  const count = concealedCount(level.tiles.length, bucket);
  if (count === 0) return [];
  // '#conceal' forks the stream: same (layoutId, seed) as the generator, but
  // never the generator's own sequence.
  const rng = mulberry32(hashString(`${level.layoutId}#conceal`) ^ level.seed);
  const ids = level.tiles.map((t) => t.id).sort((a, b) => a - b);
  // Partial Fisher–Yates: the first `count` entries are a uniform sample.
  for (let i = 0; i < count; i++) {
    const j = i + Math.floor(rng() * (ids.length - i));
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
  }
  return ids.slice(0, count).sort((a, b) => a - b);
}
