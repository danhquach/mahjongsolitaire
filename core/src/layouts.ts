// Layout = ordered slot list (spec §4: "Load layout geometry (ordered slot
// list)"). Layouts ship as JSON data files in Phase 3 (issue #17); these three
// seed layouts live in code only to gate the generator (issue #7 acceptance:
// 10,000 seeds × 3 seed layouts).

import type { Slot } from './board.js';

export interface Layout {
  readonly id: string;
  readonly slots: readonly Slot[];
}

function grid(xs: number[], ys: number[], z: number): Slot[] {
  const slots: Slot[] = [];
  for (const y of ys) for (const x of xs) slots.push({ x, y, z });
  return slots;
}

function range(from: number, count: number, step = 2): number[] {
  return Array.from({ length: count }, (_, i) => from + i * step);
}

/** 4×4 base with a 2×2 second layer — exercises the cover rule. 20 tiles. */
const PYRAMID: Layout = {
  id: 'seed-pyramid',
  slots: [...grid(range(0, 4), range(0, 4), 0), ...grid([2, 4], [2, 4], 1)],
};

/** Two flat 8-tile rows — exercises left/right edge blocking. 16 tiles. */
const ROWS: Layout = {
  id: 'seed-rows',
  slots: [...grid(range(0, 8), [0], 0), ...grid(range(0, 8), [4], 0)],
};

/** Brick rows with half-offset upper tiles straddling two supporters —
 *  exercises half-unit lattice overlap. 18 tiles. */
const BRICKS: Layout = {
  id: 'seed-bricks',
  slots: [
    ...grid(range(0, 6), [0], 0),
    ...grid([1, 3, 5, 7], [0], 1),
    ...grid(range(0, 6), [3], 0),
    ...grid([2, 8], [3], 1),
  ],
};

export const SEED_LAYOUTS: readonly Layout[] = [PYRAMID, ROWS, BRICKS];
