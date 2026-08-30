// Difficulty scorer + bucketing (spec §4, issue #9). Metric values on
// handcrafted fixtures, bucket thresholds on crafted metrics, and determinism
// per (layoutId, seed) via the generator.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Tile } from '../src/board.js';
import {
  assessDifficulty,
  bucketDifficulty,
  difficultyScore,
  scoreDifficulty,
} from '../src/difficulty.js';
import type { DifficultyMetrics } from '../src/difficulty.js';
import { generateLevel } from '../src/generator.js';
import { SEED_LAYOUTS } from '../src/layouts.js';

/** Tiles from single-layer rows: row i at y = i*4 (rows never interact),
 *  tile j of a row at x = j*2 (adjacent within the row). */
function rows(...faceRows: string[][]): Tile[] {
  const tiles: Tile[] = [];
  faceRows.forEach((faces, i) => {
    faces.forEach((face, j) => {
      tiles.push({ id: tiles.length, slot: { x: j * 2, y: i * 4, z: 0 }, face, removed: false });
    });
  });
  return tiles;
}

function metrics(overrides: Partial<DifficultyMetrics>): DifficultyMetrics {
  return {
    initialFreePairCount: 4,
    meanBranchingFactor: 4,
    layerCount: 1,
    tileCount: 16,
    forcedMoveRatio: 0,
    ...overrides,
  };
}

// --- scoreDifficulty: metric values on fixtures ---------------------------------

test('single-pair board: every metric at its floor', () => {
  const tiles = rows(['A', 'A']);
  const m = scoreDifficulty(tiles, [[0, 1]]);
  assert.deepEqual(m, {
    initialFreePairCount: 1,
    meanBranchingFactor: 1,
    layerCount: 1,
    tileCount: 2,
    forcedMoveRatio: 1,
  });
});

test('two independent rows: branching averages over the solution path', () => {
  // Both pairs free at turn 1 (2 legal pairs), one pair left at turn 2 (1).
  const tiles = rows(['A', 'A'], ['B', 'B']);
  const m = scoreDifficulty(tiles, [[0, 1], [2, 3]]);
  assert.equal(m.initialFreePairCount, 2);
  assert.equal(m.meanBranchingFactor, 1.5);
  assert.equal(m.forcedMoveRatio, 0.5); // only turn 2 is forced
  assert.equal(m.tileCount, 4);
});

test('edge-blocked row A B B A: forced all the way down', () => {
  // Only the ends are free initially; each turn has exactly one legal pair.
  const tiles = rows(['A', 'B', 'B', 'A']);
  const m = scoreDifficulty(tiles, [[0, 3], [1, 2]]);
  assert.equal(m.initialFreePairCount, 1);
  assert.equal(m.meanBranchingFactor, 1);
  assert.equal(m.forcedMoveRatio, 1);
});

test('layerCount counts distinct z levels', () => {
  const pyramid = SEED_LAYOUTS.find((l) => l.id === 'seed-pyramid')!;
  const level = generateLevel(pyramid, 42);
  const m = scoreDifficulty(level.tiles, level.solution);
  assert.equal(m.layerCount, 2);
  assert.equal(m.tileCount, 20);
});

test('empty board yields zeroed metrics rather than NaN', () => {
  const m = scoreDifficulty([], []);
  assert.equal(m.meanBranchingFactor, 0);
  assert.equal(m.forcedMoveRatio, 0);
  assert.equal(m.tileCount, 0);
});

// --- difficultyScore + bucketDifficulty ------------------------------------------

test('score is in [0, 1] and rises as free pairs tighten', () => {
  const loose = difficultyScore(metrics({ initialFreePairCount: 10 }));
  const tight = difficultyScore(metrics({ initialFreePairCount: 2 }));
  assert.ok(loose >= 0 && loose <= 1);
  assert.ok(tight >= 0 && tight <= 1);
  assert.ok(tight > loose);
});

test('score rises with lower branching, more tiles, more layers, more forced moves', () => {
  const base = metrics({});
  assert.ok(difficultyScore(metrics({ meanBranchingFactor: 2 })) > difficultyScore(base));
  assert.ok(difficultyScore(metrics({ tileCount: 144 })) > difficultyScore(base));
  assert.ok(difficultyScore(metrics({ layerCount: 5 })) > difficultyScore(base));
  assert.ok(difficultyScore(metrics({ forcedMoveRatio: 0.5 })) > difficultyScore(base));
});

test('bucket thresholds: crafted metrics land in each of the four buckets', () => {
  const easy = metrics({
    initialFreePairCount: 8, meanBranchingFactor: 6, layerCount: 1, tileCount: 16, forcedMoveRatio: 0.1,
  });
  const medium = metrics({
    initialFreePairCount: 10, meanBranchingFactor: 12, layerCount: 5, tileCount: 144, forcedMoveRatio: 0.02,
  });
  const hard = metrics({
    initialFreePairCount: 8, meanBranchingFactor: 8, layerCount: 5, tileCount: 144, forcedMoveRatio: 0.05,
  });
  const expert = metrics({
    initialFreePairCount: 2, meanBranchingFactor: 2, layerCount: 5, tileCount: 144, forcedMoveRatio: 0.5,
  });
  assert.equal(bucketDifficulty(easy), 'easy');
  assert.equal(bucketDifficulty(medium), 'medium');
  assert.equal(bucketDifficulty(hard), 'hard');
  assert.equal(bucketDifficulty(expert), 'expert');
});

// --- assessDifficulty: determinism per seed --------------------------------------

test('assessment is deterministic per (layoutId, seed)', () => {
  for (const layout of SEED_LAYOUTS) {
    for (const seed of [1, 77, 4242]) {
      const a = assessDifficulty(generateLevel(layout, seed));
      const b = assessDifficulty(generateLevel(layout, seed));
      assert.deepEqual(a, b);
      assert.ok(['easy', 'medium', 'hard', 'expert'].includes(a.bucket));
      assert.equal(a.bucket, bucketDifficulty(a.metrics));
    }
  }
});
