// Difficulty scorer + bucketing (spec §4, issue #9; rebalanced by issue #212).
//
// The five spec metrics are computed by replaying the level's solution witness
// (every generated level carries one) and counting legal pairs at each turn.
// The composite weights the two pair-density signals — how many legal pairs
// the deal opens with, and how many stay available along the path — because
// that is what a player feels (issue #212: a dozen visible pairs on every turn
// and the holder is never a decision). Size, depth and forced moves are minor
// terms: every shipped layout is a full 144-tile set, so tile count is a
// constant across the ladder and must not dominate. Normalizers are set from
// the 40-seed sweep of the ten compact portrait layouts (2026-09-04): initial
// pairs span 6–62, witness-path branching 5.5–21. Holder-aware calibration
// (decisions 0008/0009) stays deferred. Everything here is a pure function of
// the level, so bucket assignment is deterministic per (layoutId, seed).

import { Board } from './board.js';
import type { Tile, TileId } from './board.js';
import type { GeneratedLevel } from './generator.js';
import { legalPairs } from './solver.js';

export interface DifficultyMetrics {
  /** Legal pairs available on the untouched board. */
  readonly initialFreePairCount: number;
  /** Mean legal-pair count per turn across the solution path. */
  readonly meanBranchingFactor: number;
  /** Distinct z levels occupied by the layout. */
  readonly layerCount: number;
  readonly tileCount: number;
  /** Fraction of solution turns with exactly one legal pair. */
  readonly forcedMoveRatio: number;
}

export type DifficultyBucket = 'easy' | 'medium' | 'hard' | 'expert';

export interface DifficultyAssessment {
  readonly metrics: DifficultyMetrics;
  /** Composite difficulty in [0, 1] — the value the thresholds cut. */
  readonly score: number;
  readonly bucket: DifficultyBucket;
}

export function scoreDifficulty(
  tiles: readonly Tile[],
  solution: ReadonlyArray<readonly [TileId, TileId]>,
): DifficultyMetrics {
  const board = new Board(tiles);
  const initialFreePairCount = legalPairs(board).length;

  let branchingSum = 0;
  let forcedTurns = 0;
  for (const [a, b] of solution) {
    const options = legalPairs(board).length;
    branchingSum += options;
    if (options === 1) forcedTurns++;
    board.remove(a);
    board.remove(b);
  }

  const turns = solution.length;
  return {
    initialFreePairCount,
    meanBranchingFactor: turns === 0 ? 0 : branchingSum / turns,
    layerCount: new Set(tiles.map((t) => t.slot.z)).size,
    tileCount: tiles.length,
    forcedMoveRatio: turns === 0 ? 0 : forcedTurns / turns,
  };
}

function unit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Initial free pairs at which the tight-start signal bottoms out. The old
 * value, 12, was below every shipped deal (issue #212): the signal read zero
 * for the whole ladder. 48 sits above the median of the loosest layout, so
 * only the loosest seeds clip.
 */
export const LOOSE_START_PAIRS = 48;
/** Witness-path branching (above the forced floor of 1) that reads as fully loose. */
export const LOOSE_PATH_BRANCHING = 16;

/** Pair-density-dominant weights (sum to 1) over normalized signals. */
export function difficultyScore(m: DifficultyMetrics): number {
  const tightStart = unit(1 - m.initialFreePairCount / LOOSE_START_PAIRS);
  const tightPath = unit(1 - (m.meanBranchingFactor - 1) / LOOSE_PATH_BRANCHING);
  const size = unit(m.tileCount / 144);
  const depth = unit((m.layerCount - 1) / 4);
  const forced = unit(m.forcedMoveRatio);
  return 0.35 * tightStart + 0.35 * tightPath + 0.1 * size + 0.1 * depth + 0.1 * forced;
}

/** Global bucket cuts, aligned with the ladder's band windows (`LADDER_WINDOWS`):
 *  easy below the medium window, medium across medium and medium-plus, hard
 *  across the hard window, expert above the v1 ceiling. */
function bucketFromScore(score: number): DifficultyBucket {
  if (score < 0.3) return 'easy';
  if (score < 0.6) return 'medium';
  if (score < 0.8) return 'hard';
  return 'expert';
}

export function bucketDifficulty(m: DifficultyMetrics): DifficultyBucket {
  return bucketFromScore(difficultyScore(m));
}

export function assessDifficulty(level: GeneratedLevel): DifficultyAssessment {
  const metrics = scoreDifficulty(level.tiles, level.solution);
  const score = difficultyScore(metrics);
  return { metrics, score, bucket: bucketFromScore(score) };
}
