// Difficulty scorer + bucketing (spec §4, issue #9).
//
// The five spec metrics are computed by replaying the level's solution witness
// (every generated level carries one) and counting legal pairs at each turn.
// The composite score and bucket thresholds below are provisional: weights are
// hand-balanced so the small seed layouts land in 'easy' and 144-tile stacked
// deals span medium→expert. Real calibration happens in Phase 3 against the
// shipped layouts (spec §risks: remote-config level reordering is the
// backstop). Everything here is a pure function of the level, so bucket
// assignment is deterministic per (layoutId, seed).

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

/** Provisional weights (sum to 1) over normalized tightness/size signals. */
export function difficultyScore(m: DifficultyMetrics): number {
  const tightStart = unit(1 - m.initialFreePairCount / 12);
  const tightPath = unit(1 - (m.meanBranchingFactor - 1) / 12);
  const size = unit(m.tileCount / 144);
  const depth = unit((m.layerCount - 1) / 4);
  const forced = unit(m.forcedMoveRatio);
  // Size-dominant weighting: a tiny board is easy even when every move is
  // forced (no decisions to get wrong, and it's over quickly), so tightness
  // signals differentiate within a size class rather than across them.
  return 0.15 * tightStart + 0.15 * tightPath + 0.5 * size + 0.1 * depth + 0.1 * forced;
}

/** Provisional cuts on the composite score — Phase 3 recalibrates. */
function bucketFromScore(score: number): DifficultyBucket {
  if (score < 0.45) return 'easy';
  if (score < 0.65) return 'medium';
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
