// Shuffle booster primitive (spec §5, issue #10).
//
// Re-randomizes the faces of the *remaining* (present) tiles in place — a
// permutation of their face multiset, so slot occupancy, removed tiles, and
// per-face counts are all preserved. Each candidate assignment is re-validated
// with the solver; unsolvable (or budget-'unknown') ones are re-shuffled, the
// rng stream continuing so the result is deterministic per (board, seed).

import type { Board } from './board.js';
import { mulberry32 } from './rng.js';
import { solve } from './solver.js';
import type { SolveOptions } from './solver.js';

const MAX_ATTEMPTS = 1000;

/**
 * Shuffle the present tiles' faces until the position is solver-confirmed
 * solvable, then apply that assignment to the board. Throws — leaving the
 * board unchanged — if no attempt validates (e.g. a geometry no face
 * assignment can save, such as a matching pair stacked on top of itself).
 */
export function shuffleBoard(board: Board, seed: number, options: SolveOptions = {}): void {
  const present = [...board.presentTiles()].sort((a, b) => a.id - b.id);
  if (present.length === 0) return;

  const rng = mulberry32(seed);
  const faces = present.map((t) => t.face);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    for (let i = faces.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [faces[i], faces[j]] = [faces[j]!, faces[i]!];
    }
    const faceById = new Map(present.map((t, i) => [t.id, faces[i]!]));
    const candidate = board
      .allTiles()
      .map((t) => (t.removed ? t : { ...t, face: faceById.get(t.id)! }));
    if (solve(candidate, options).verdict === 'solvable') {
      present.forEach((t, i) => board.setFace(t.id, faces[i]!));
      return;
    }
  }
  throw new Error(`no solvable shuffle within ${MAX_ATTEMPTS} attempts (seed ${seed})`);
}
