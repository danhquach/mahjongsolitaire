// Tests for the benchmark harness (issue #4). Run: node --test bench/test/
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { percentileSorted, summarize } from '../stats.js';
import { runBenchmark } from '../harness.js';
import { benchTarget } from '../target-stub.js';

test('percentileSorted uses nearest-rank', () => {
  const s = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(percentileSorted(s, 50), 5);
  assert.equal(percentileSorted(s, 95), 10);
  assert.equal(percentileSorted(s, 100), 10);
  assert.equal(percentileSorted([42], 95), 42);
});

test('summarize computes min/max/mean and percentiles', () => {
  const st = summarize([5, 1, 3, 2, 4]);
  assert.equal(st.n, 5);
  assert.equal(st.min, 1);
  assert.equal(st.max, 5);
  assert.equal(st.mean, 3);
  assert.equal(st.p50, 3);
  assert.equal(st.p95, 5);
  assert.throws(() => summarize([]));
});

test('runBenchmark times each iteration with the injected clock', async () => {
  let clock = 0;
  const calls = [];
  const fake = {
    name: 'fake',
    layouts: ['l'],
    run(layoutId, seed) { calls.push(seed); clock += 10; return { solvable: true, tilesPlaced: 144 }; },
  };
  const r = await runBenchmark({
    target: fake, layoutId: 'l', baseSeed: 100, iterations: 5, warmup: 2,
    now: () => clock,
  });
  // warmup seeds 100,101 then timed 100..104, each taking exactly 10 "ms"
  assert.deepEqual(calls, [100, 101, 100, 101, 102, 103, 104]);
  assert.equal(r.stats.n, 5);
  assert.equal(r.stats.p50, 10);
  assert.equal(r.stats.p95, 10);
  assert.equal(r.failures, 0);
});

test('runBenchmark counts unsolvable results as failures', async () => {
  const fake = {
    name: 'fake', layouts: ['l'],
    run: (l, seed) => ({ solvable: seed % 2 === 0, tilesPlaced: 0 }),
  };
  const r = await runBenchmark({ target: fake, layoutId: 'l', baseSeed: 0, iterations: 4, warmup: 0 });
  assert.equal(r.failures, 2);
});

test('runBenchmark rejects unknown layout', async () => {
  await assert.rejects(
    runBenchmark({ target: benchTarget, layoutId: 'nope', iterations: 1 }),
    /does not provide layout/,
  );
});

test('stub target: seeded runs are deterministic and solvable', () => {
  for (const seed of [1, 42, 987654321]) {
    const a = benchTarget.run('stub_144', seed);
    const b = benchTarget.run('stub_144', seed);
    assert.deepEqual(a, b);
    assert.equal(a.solvable, true, `seed ${seed} should produce a solvable board`);
    assert.equal(a.tilesPlaced, 144);
  }
});

test('stub target: 50-seed sweep all solvable (harness smoke)', async () => {
  const r = await runBenchmark({ target: benchTarget, layoutId: 'stub_144', baseSeed: 1, iterations: 50, warmup: 5 });
  assert.equal(r.failures, 0);
  assert.ok(r.stats.p95 > 0);
});
