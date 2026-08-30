// Bench target contract (issue #4 harness ↔ issue #8 solver): core/dist/bench.js
// must export benchTarget = { name, layouts, run } where run(layoutId, seed)
// performs one full generate + solvability-validate cycle.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { benchTarget } from '../bench.js';
import { SEED_LAYOUTS } from '../src/layouts.js';

test('benchTarget exposes the harness contract', () => {
  assert.equal(typeof benchTarget.name, 'string');
  assert.deepEqual(
    benchTarget.layouts,
    SEED_LAYOUTS.map((l) => l.id),
  );
});

test('run performs a deterministic generate + solve cycle', () => {
  const layoutId = SEED_LAYOUTS[0]!.id;
  const a = benchTarget.run(layoutId, 3);
  assert.equal(a.solvable, true);
  assert.equal(a.tilesPlaced, SEED_LAYOUTS[0]!.slots.length);
  assert.deepEqual(benchTarget.run(layoutId, 3), a);
});

test('run rejects unknown layout ids', () => {
  assert.throws(() => benchTarget.run('no-such-layout', 1), RangeError);
});
