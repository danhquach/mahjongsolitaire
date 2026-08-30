// Bench entry (issue #4 contract, wired by issue #8): builds to
// core/dist/bench.js, which bench/target.js auto-loads in place of its stub.
// run() is one full generate + solvability-validate cycle — the operation the
// 150ms p95 Phase 1 gate measures (spec §9). Synchronous, deterministic per
// (layoutId, seed), side-effect free.

import { generateLevel } from './src/generator.js';
import { SEED_LAYOUTS } from './src/layouts.js';
import { solve } from './src/solver.js';

export const benchTarget = {
  name: '@mahjongsolitaire/core@0.1.0',
  layouts: SEED_LAYOUTS.map((l) => l.id),
  run(layoutId: string, seed: number): { solvable: boolean; tilesPlaced: number } {
    const layout = SEED_LAYOUTS.find((l) => l.id === layoutId);
    if (!layout) throw new RangeError(`unknown layout id: ${layoutId}`);
    const level = generateLevel(layout, seed);
    return {
      solvable: solve(level.tiles).verdict === 'solvable',
      tilesPlaced: level.tiles.length,
    };
  },
};
