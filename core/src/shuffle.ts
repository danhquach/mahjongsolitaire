// Shuffle booster primitive (spec §5, issue #10).
//
// Re-randomizes the faces of the tiles still *on the board* in place — a
// permutation of their face multiset, so slot occupancy, removed tiles, and
// per-face counts are all preserved. Each candidate assignment is re-validated
// with the solver; unsolvable (or budget-'unknown') ones are re-shuffled, the
// rng stream continuing so the result is deterministic per (board, seed).
//
// Held tiles (issue #43) keep their faces: a tile the player parked is on
// screen in the holder, and swapping its face under them would read as the
// game taking their pick away. Permuting only the board therefore leaves every
// per-face count across board+holder untouched, so the parity the solver checks
// still holds — and validation passes the holder through, because a shuffle is
// only solvable if the held tiles can still be paired off too.

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
    // Only the tiles being permuted are re-faced. A tile the map does not know
    // is one that was never in `present` — removed, or held (issue #43) — and
    // it keeps the face it has. Reading a missing entry as the new face is how
    // this blanked every held tile's face and made every candidate fail the
    // solver's parity precheck.
    const candidate = board.allTiles().map((t) => {
      const face = faceById.get(t.id);
      return face === undefined ? t : { ...t, face };
    });
    if (solve(candidate, { ...options, holder: board.holderSlots() }).verdict === 'solvable') {
      present.forEach((t, i) => board.setFace(t.id, faces[i]!));
      return;
    }
  }
  throw new Error(`no solvable shuffle within ${MAX_ATTEMPTS} attempts (seed ${seed})`);
}
