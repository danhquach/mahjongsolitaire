// Replay a move history against a regenerated deal (issue #187, decision 0030).
//
// The leaderboard stopped believing a client's score: the server regenerates
// the deal from `(layoutId, seed)`, plays the submitted moves through the same
// MoveStack the client used, and the score is whatever that produces. This is
// the one place that knows how to do that, shared by the Worker and — issue
// #50, when it lands — the save validator, so scoring rules stay in one copy.
//
// The input is untrusted: it is whatever a client posted. Every record is
// shape-checked here before it reaches the stack, and every RangeError the
// board or the scorer throws for an impossible move becomes a rejection naming
// the record, never an exception for the caller to catch. A run is rejected
// on the first record that does not fit; nothing about a partial replay is
// reported, because nothing about it can be trusted either.
//
// What replaying does *not* need: concealment (which tiles were face-down
// changes what the player knew, never what was legal — issue #64), the
// selection, or the per-record `prevScores`/`prevSelection` undo bookkeeping
// the client already strips (ui's compactHistory). The compact record is the
// contract: kind, the ids the move touched, and when.

import { Board } from './board.js';
import type { TileId } from './board.js';
import type { GeneratedLevel } from './generator.js';
import { MoveStack } from './moves.js';
import { ScoreKeeper } from './scoring.js';
import { applyShuffle } from './shuffle.js';

/** One move as a client submits it: a MoveRecord without the undo bookkeeping. */
export type ReplayMove =
  | {
      readonly kind: 'match';
      readonly a: TileId;
      readonly b: TileId;
      readonly heldA: number | null;
      readonly heldB: number | null;
      readonly atMs: number;
    }
  | { readonly kind: 'hold'; readonly tile: TileId; readonly slotIndex: number; readonly atMs: number }
  | { readonly kind: 'return'; readonly tile: TileId; readonly slotIndex: number; readonly atMs: number }
  | { readonly kind: 'shuffle'; readonly seed: number; readonly attempt: number; readonly atMs: number };

/**
 * Why a history was refused. `malformed` is a record that is not a move at
 * all; the rest are moves the game could not have made at that point:
 * `time_backwards` (an earlier timestamp than the record before it),
 * `illegal` (the board or scorer refused it — a covered tile, a face
 * mismatch, a return of a tile that was not the newest parked one),
 * `holder_disagrees` (the record's slot or held-ness is not what the holder
 * says). A shuffle record naming an attempt `shuffleBoard` could not have
 * produced, or a shuffle of an empty board, is `illegal` like any other
 * impossible move.
 */
export type ReplayRejection =
  | 'not_a_list'
  | 'malformed'
  | 'time_backwards'
  | 'illegal'
  | 'holder_disagrees';

export type ReplayResult =
  | {
      readonly ok: true;
      /** The score the moves earn at `scoreMultiplier`. */
      readonly score: number;
      readonly matches: number;
      /** Every tile removed — a finished level. */
      readonly cleared: boolean;
      /** The last record's timestamp: the run cannot have ended before it. */
      readonly lastMs: number;
    }
  | { readonly ok: false; readonly reason: ReplayRejection; readonly index: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** Timestamps are game-clock milliseconds; the client's clock is fractional. */
function isMs(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function parseMove(raw: unknown): ReplayMove | null {
  if (!isRecord(raw) || !isMs(raw['atMs'])) return null;
  const atMs = raw['atMs'];
  switch (raw['kind']) {
    case 'match': {
      const { a, b, heldA, heldB } = raw;
      if (!isId(a) || !isId(b)) return null;
      if (heldA !== null && !isId(heldA)) return null;
      if (heldB !== null && !isId(heldB)) return null;
      return { kind: 'match', a, b, heldA: heldA as number | null, heldB: heldB as number | null, atMs };
    }
    case 'hold':
    case 'return': {
      const { tile, slotIndex } = raw;
      if (!isId(tile) || !isId(slotIndex)) return null;
      return { kind: raw['kind'], tile, slotIndex, atMs };
    }
    case 'shuffle': {
      const { seed, attempt } = raw;
      return isId(seed) && isId(attempt) ? { kind: 'shuffle', seed, attempt, atMs } : null;
    }
    default:
      return null;
  }
}

/**
 * Play `moves` from a fresh deal of `level` and report what they earn.
 *
 * `scoreMultiplier` is the level's band multiplier (issue #176); the caller
 * looks it up, because the deal alone does not say which ladder level it is.
 * Returns the score, whether the board was cleared, and the last timestamp —
 * or the first record that could not have happened and why.
 */
export function replayMoves(
  level: GeneratedLevel,
  moves: unknown,
  scoreMultiplier: number = 1,
): ReplayResult {
  if (!Array.isArray(moves)) return { ok: false, reason: 'not_a_list', index: -1 };
  const board = new Board(level.tiles);
  const stack = new MoveStack(board, new ScoreKeeper(scoreMultiplier));
  const reject = (reason: ReplayRejection, index: number): ReplayResult => ({ ok: false, reason, index });
  const slotOf = (id: TileId): number | null => {
    const index = board.holderSlots().indexOf(id);
    return index === -1 ? null : index;
  };

  let lastMs = 0;
  let matches = 0;
  for (let i = 0; i < moves.length; i++) {
    const move = parseMove(moves[i]);
    if (move === null) return reject('malformed', i);
    if (move.atMs < lastMs) return reject('time_backwards', i);
    lastMs = move.atMs;
    try {
      switch (move.kind) {
        case 'match':
          // The record says which holder slot each tile came out of. The stack
          // works that out for itself, so this is a consistency check — a
          // history that lies about the holder is not one the game wrote.
          if (slotOf(move.a) !== move.heldA || slotOf(move.b) !== move.heldB) {
            return reject('holder_disagrees', i);
          }
          stack.play(move.a, move.b, move.atMs);
          matches += 1;
          break;
        case 'hold':
          if (stack.hold(move.tile, move.atMs) !== move.slotIndex) return reject('holder_disagrees', i);
          break;
        case 'return': {
          if (slotOf(move.tile) !== move.slotIndex) return reject('holder_disagrees', i);
          // Undo returns the newest parked tile, and only that one (issue
          // #100): a record naming any other tile is a move the game refuses.
          const undone = stack.undo(move.atMs);
          if (undone === null || undone.tile !== move.tile) return reject('illegal', i);
          break;
        }
        case 'shuffle':
          // Reproduced, not re-validated. `shuffleBoard` runs the solver on
          // every candidate until one is solvable, which measured at ~130 ms a
          // shuffle — far past a Worker's budget. The record names the attempt
          // that was accepted, so the same permutation is reached directly.
          // Nothing about the score depends on which candidate it was: every
          // move after it is still checked for legality on the faces it made.
          applyShuffle(board, move.seed, move.attempt);
          break;
      }
    } catch (error) {
      // Board, match and ScoreKeeper all refuse an impossible move with a
      // RangeError; anything else is a bug here, not a bad history.
      if (error instanceof RangeError) return reject('illegal', i);
      throw error;
    }
  }
  return { ok: true, score: stack.score, matches, cleared: board.inPlayTiles().length === 0, lastMs };
}
