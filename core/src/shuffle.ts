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

import type { Board, Tile } from './board.js';
import { mulberry32 } from './rng.js';
import { solve } from './solver.js';
import type { SolveOptions } from './solver.js';

export const MAX_SHUFFLE_ATTEMPTS = 1000;

/** The present tiles, ascending by id — the order the permutation is indexed in. */
function presentSorted(board: Board): Tile[] {
  return [...board.presentTiles()].sort((a, b) => a.id - b.id);
}

/** One Fisher–Yates pass over `faces`, drawing from `rng`. Attempt k of a
 *  shuffle is k+1 successive passes on the same array with one continuing
 *  stream — which is why an attempt index is enough to name a candidate. */
function permuteOnce(faces: string[], rng: () => number): void {
  for (let i = faces.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [faces[i], faces[j]] = [faces[j]!, faces[i]!];
  }
}

/**
 * Shuffle the present tiles' faces until the position is solver-confirmed
 * solvable, then apply that assignment to the board. Returns the index of the
 * attempt that validated (issue #187 records it so a replay can reproduce the
 * shuffle with `applyShuffle` instead of re-running the solver), or null with
 * the board untouched when nothing was present to shuffle. Throws — leaving
 * the board unchanged — if no attempt validates (e.g. a geometry no face
 * assignment can save, such as a matching pair stacked on top of itself).
 */
export function shuffleBoard(board: Board, seed: number, options: SolveOptions = {}): number | null {
  const present = presentSorted(board);
  if (present.length === 0) return null;

  const rng = mulberry32(seed);
  const faces = present.map((t) => t.face);
  for (let attempt = 0; attempt < MAX_SHUFFLE_ATTEMPTS; attempt++) {
    permuteOnce(faces, rng);
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
      return attempt;
    }
  }
  throw new Error(`no solvable shuffle within ${MAX_SHUFFLE_ATTEMPTS} attempts (seed ${seed})`);
}

/**
 * Re-apply a shuffle that already happened (issue #187): the face assignment
 * `shuffleBoard(board, seed)` reached on its `attempt`-th try, without the
 * solver. Same board state and the same (seed, attempt) give the same faces,
 * which is what lets a replay reproduce a shuffled run in microseconds where
 * re-validating every rejected candidate costs the solver's full budget each.
 * Throws RangeError on an attempt outside what `shuffleBoard` can produce, or
 * when nothing is present to shuffle — neither is a record the game writes.
 */
export function applyShuffle(board: Board, seed: number, attempt: number): void {
  if (!Number.isInteger(attempt) || attempt < 0 || attempt >= MAX_SHUFFLE_ATTEMPTS) {
    throw new RangeError(`no shuffle attempt ${attempt}`);
  }
  const present = presentSorted(board);
  if (present.length === 0) throw new RangeError('nothing on the board to shuffle');
  const rng = mulberry32(seed);
  const faces = present.map((t) => t.face);
  for (let i = 0; i <= attempt; i++) permuteOnce(faces, rng);
  present.forEach((t, i) => board.setFace(t.id, faces[i]!));
}
