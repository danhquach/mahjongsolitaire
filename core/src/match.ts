// Pair matching on a board (spec §3.3, issue #6).

import type { Board, TileId } from './board.js';
import { facesMatch } from './faces.js';

export type MatchRejection = 'self' | 'not-free' | 'face-mismatch';
export type MatchCheck = { ok: true } | { ok: false; reason: MatchRejection };

/** §3.3: a pair is playable iff A ≠ B, both tiles matchable, and their faces
 *  match. Matchable is free-on-the-board *or* held (issue #43): a tile in the
 *  holder is off the lattice, so nothing can block it. Removed tiles are
 *  neither, so they reject as 'not-free'. */
export function canMatch(board: Board, a: TileId, b: TileId): MatchCheck {
  if (a === b) return { ok: false, reason: 'self' };
  if (!board.isMatchable(a) || !board.isMatchable(b)) return { ok: false, reason: 'not-free' };
  if (!facesMatch(board.get(a).face, board.get(b).face)) {
    return { ok: false, reason: 'face-mismatch' };
  }
  return { ok: true };
}

/** Remove a playable pair from the board; throws (removing nothing) otherwise. */
export function matchPair(board: Board, a: TileId, b: TileId): void {
  const check = canMatch(board, a, b);
  if (!check.ok) throw new RangeError(`cannot match tiles ${a}, ${b}: ${check.reason}`);
  board.remove(a);
  board.remove(b);
}
