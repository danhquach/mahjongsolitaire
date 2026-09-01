// Face-down tile pick (issue #64): deterministic, difficulty-scaled, capped.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONCEAL_CAP, concealedCount, concealedTileIds } from '../src/conceal.js';
import type { DifficultyBucket } from '../src/difficulty.js';
import { generateLevel } from '../src/generator.js';
import { SEED_LAYOUTS } from '../src/layouts.js';

const BUCKETS: DifficultyBucket[] = ['easy', 'medium', 'hard', 'expert'];

test('easy deals no face-down tiles at all', () => {
  assert.equal(concealedCount(144, 'easy'), 0);
  const level = generateLevel(SEED_LAYOUTS[0]!, 7);
  assert.deepEqual(concealedTileIds(level, 'easy'), []);
});

test('counts grow with the bucket and are capped', () => {
  const counts = BUCKETS.map((b) => concealedCount(144, b));
  for (let i = 1; i < counts.length; i++) {
    assert.ok(counts[i]! >= counts[i - 1]!, `bucket ${BUCKETS[i]} not below ${BUCKETS[i - 1]}`);
  }
  assert.ok(counts[1]! > 0, 'medium must conceal something on a 144-tile deal');
  // A deal big enough to blow past the cap is still capped.
  assert.equal(concealedCount(100000, 'expert'), CONCEAL_CAP);
  for (const b of BUCKETS) {
    assert.ok(concealedCount(144, b) <= CONCEAL_CAP);
  }
});

test('pick is deterministic per (layoutId, seed, bucket)', () => {
  const level = generateLevel(SEED_LAYOUTS[0]!, 42);
  const again = generateLevel(SEED_LAYOUTS[0]!, 42);
  assert.deepEqual(concealedTileIds(level, 'expert'), concealedTileIds(again, 'expert'));
});

test('picked ids are unique, ascending, and belong to the deal', () => {
  for (const layout of SEED_LAYOUTS) {
    for (const seed of [1, 99, 424242]) {
      const level = generateLevel(layout, seed);
      const ids = concealedTileIds(level, 'expert');
      assert.equal(ids.length, concealedCount(level.tiles.length, 'expert'));
      assert.equal(new Set(ids).size, ids.length, 'duplicate id in pick');
      const known = new Set(level.tiles.map((t) => t.id));
      for (const id of ids) assert.ok(known.has(id), `unknown id ${id}`);
      assert.deepEqual([...ids].sort((a, b) => a - b), ids, 'not ascending');
    }
  }
});

test('different seeds pick different sets', () => {
  const layout = SEED_LAYOUTS[0]!;
  const a = concealedTileIds(generateLevel(layout, 1), 'expert');
  const b = concealedTileIds(generateLevel(layout, 2), 'expert');
  assert.notDeepEqual(a, b);
});
