// Benchmark harness core loop (issue #4).
// Runs a seeded generate+solve loop against a bench target and reports latency
// stats. Pure ES module, no DOM/Node deps — usable from the browser page
// (index.html) and the Node runner (run-node.mjs).

import { summarize } from './stats.js';

/** Phase 1 exit gate: gen+solve p95 budget in ms (spec §9). */
export const P95_GATE_MS = 150;

/**
 * A bench target is the contract `/core` must export from its bench entry
 * (see target.js):
 *   { name: string, layouts: string[], run(layoutId, seed) -> { solvable, tilesPlaced } }
 * run() performs one full generate + solve for the given seed and must be
 * deterministic and side-effect free.
 */

/**
 * Run the benchmark.
 *
 * options:
 *   target      bench target (see above)
 *   layoutId    layout to benchmark (must be in target.layouts)
 *   baseSeed    first seed; iteration i uses seed baseSeed + i (deterministic run set)
 *   iterations  timed iterations
 *   warmup      untimed iterations before measuring (JIT warm-up)
 *   now         clock returning ms (default: performance.now)
 *   onProgress  optional (done, total) callback for timed iterations
 *   yieldEvery  optional: await a macrotask every N iterations so a browser
 *               tab stays responsive (0/undefined = never yield)
 *
 * Returns { stats, samples, failures, checksum } where failures counts
 * iterations whose result was not solvable, and checksum folds tilesPlaced
 * across runs (defeats dead-code elimination, doubles as a determinism probe).
 */
export async function runBenchmark({
  target,
  layoutId,
  baseSeed = 1,
  iterations = 200,
  warmup = 20,
  now = () => performance.now(),
  onProgress,
  yieldEvery = 0,
}) {
  if (!target.layouts.includes(layoutId)) {
    throw new Error(`target "${target.name}" does not provide layout "${layoutId}"`);
  }

  const maybeYield = async (i) => {
    if (yieldEvery > 0 && (i + 1) % yieldEvery === 0) {
      await new Promise((r) => setTimeout(r, 0));
    }
  };

  for (let i = 0; i < warmup; i++) {
    target.run(layoutId, baseSeed + i);
    await maybeYield(i);
  }

  const samples = new Array(iterations);
  let failures = 0;
  let checksum = 0;
  for (let i = 0; i < iterations; i++) {
    const seed = baseSeed + i;
    const t0 = now();
    const result = target.run(layoutId, seed);
    const t1 = now();
    samples[i] = t1 - t0;
    if (!result.solvable) failures++;
    checksum = (checksum + result.tilesPlaced * (i + 1)) >>> 0;
    onProgress?.(i + 1, iterations);
    await maybeYield(i);
  }

  return { stats: summarize(samples), samples, failures, checksum };
}
