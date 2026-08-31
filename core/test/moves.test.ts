// Move stack + undo (issue #10, spec §5, §11.1): unlimited-depth undo that
// restores selection state and score, and the acceptance property
// `apply(moves) → undo(n) → apply(same n)` yields an identical state hash.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Board } from '../src/board.js';
import type { Slot, Tile, TileId } from '../src/board.js';
import { generateLevel } from '../src/generator.js';
import { SEED_LAYOUTS } from '../src/layouts.js';
import { MoveStack } from '../src/moves.js';
import type { MoveStackState } from '../src/moves.js';
import { mulberry32 } from '../src/rng.js';
import { ScoreKeeper } from '../src/scoring.js';
import { legalPairs } from '../src/solver.js';

const slot = (x: number, y: number, z = 0): Slot => ({ x, y, z });

/** Four spaced single-layer tiles (gaps ≥ 2 half-units): all four free. */
function rowBoard(): Board {
  return new Board([
    { id: 0, slot: slot(0, 0), face: 'dots-1' },
    { id: 1, slot: slot(4, 0), face: 'dots-1' },
    { id: 2, slot: slot(8, 0), face: 'bamboo-2' },
    { id: 3, slot: slot(12, 0), face: 'bamboo-2' },
  ]);
}

// --- play ---------------------------------------------------------------------

test('play removes the pair, scores it, and clears the selection', () => {
  const board = rowBoard();
  const stack = new MoveStack(board);
  stack.select(0);
  const score = stack.play(0, 1, 1000);
  assert.equal(score.points, 100);
  assert.equal(board.get(0).removed, true);
  assert.equal(board.get(1).removed, true);
  assert.equal(stack.selection, null);
  assert.equal(stack.depth, 1);
  assert.equal(stack.score, 100);
});

test('play rejects unplayable pairs without changing state', () => {
  const stack = new MoveStack(rowBoard());
  const before = stack.stateHash();
  assert.throws(() => stack.play(0, 0, 0), /self/);
  assert.throws(() => stack.play(0, 2, 0), /face-mismatch/);
  assert.equal(stack.stateHash(), before);
  assert.equal(stack.depth, 0);
});

test('select requires a matchable tile', () => {
  const board = new Board([
    { id: 0, slot: slot(0, 0, 0), face: 'dots-1' },
    { id: 1, slot: slot(0, 0, 1), face: 'dots-1' }, // covers tile 0
  ]);
  const stack = new MoveStack(board);
  assert.throws(() => stack.select(0), /not matchable/);
  stack.select(1);
  assert.equal(stack.selection, 1);
});

// --- undo ---------------------------------------------------------------------

test('undo restores the pair, the score, and the selection', () => {
  const board = rowBoard();
  const scores = new ScoreKeeper();
  const stack = new MoveStack(board, scores);
  stack.select(2);
  const before = stack.stateHash();
  stack.play(2, 3, 1000);
  assert.equal(stack.undo()?.kind, 'match');
  assert.equal(board.get(2).removed, false);
  assert.equal(board.get(3).removed, false);
  assert.equal(scores.total, 0);
  assert.equal(stack.selection, 2);
  assert.equal(stack.stateHash(), before);
});

test('undo on an empty stack returns null', () => {
  assert.equal(new MoveStack(rowBoard()).undo(), null);
});

test('undo restores the combo ladder, not just the total', () => {
  const stack = new MoveStack(rowBoard());
  stack.play(0, 1, 1000);
  stack.play(2, 3, 2000); // in-window: ×1.2 → 120
  assert.equal(stack.score, 220);
  stack.undo();
  const replay = stack.play(2, 3, 2000);
  assert.equal(replay.multiplier, 1.2);
  assert.equal(stack.score, 220);
});

// --- §11.1 acceptance property --------------------------------------------------

test('property: apply(moves) → undo(n) → apply(same n) yields identical state hash', () => {
  const rng = mulberry32(0xdecafbad);
  for (const layout of SEED_LAYOUTS) {
    for (const seed of [1, 42, 90210]) {
      const level = generateLevel(layout, seed);
      const board = new Board(level.tiles);
      const stack = new MoveStack(board);

      // Play a random-length prefix of random legal moves.
      const total = 1 + Math.floor(rng() * (level.solution.length - 1));
      const played: Array<readonly [TileId, TileId]> = [];
      for (let i = 0; i < total; i++) {
        const pairs = legalPairs(board);
        if (pairs.length === 0) break;
        const move = pairs[Math.floor(rng() * pairs.length)]!;
        stack.play(move[0], move[1], (i + 1) * 1000);
        played.push(move);
      }

      const hashAfterApply = stack.stateHash();
      const n = 1 + Math.floor(rng() * played.length);

      // undo(n), then re-apply the same n moves with the same timestamps.
      const undone = played.slice(played.length - n);
      const baseMs = (played.length - n) * 1000;
      for (let i = 0; i < n; i++) assert.notEqual(stack.undo(), null);
      assert.notEqual(stack.stateHash(), hashAfterApply);
      undone.forEach((move, i) => stack.play(move[0], move[1], baseMs + (i + 1) * 1000));

      assert.equal(stack.stateHash(), hashAfterApply, `${layout.id} seed ${seed}`);
    }
  }
});

test('unlimited depth: a full game can be undone back to the initial state', () => {
  const level = generateLevel(SEED_LAYOUTS[0]!, 7);
  const board = new Board(level.tiles);
  const stack = new MoveStack(board);
  const initial = stack.stateHash();
  level.solution.forEach((move, i) => stack.play(move[0], move[1], (i + 1) * 1000));
  assert.equal(board.presentTiles().length, 0);
  while (stack.undo());
  assert.equal(stack.depth, 0);
  assert.equal(stack.score, 0);
  assert.equal(board.presentTiles().length, level.tiles.length);
  assert.equal(stack.stateHash(), initial);
});

// --- state / restoreState (issue #14) -----------------------------------------

/** Rebuild a board + stack from a captured state, the way a resume does. */
function reopen(tiles: readonly Tile[], state: MoveStackState) {
  const board = new Board(tiles);
  const stack = new MoveStack(board, new ScoreKeeper());
  stack.restoreState(state);
  return { board, stack };
}

test('state + allTiles round-trip a mid-game stack hash-identically', () => {
  const level = generateLevel(SEED_LAYOUTS[0]!, 4242);
  const board = new Board(level.tiles);
  const stack = new MoveStack(board);
  level.solution.slice(0, 9).forEach((move, i) => stack.play(move[0], move[1], (i + 1) * 1000));
  // A live selection is part of the state, not a detail of it.
  stack.select(board.freeTileIds()[0]!);

  const reopened = reopen(board.allTiles(), stack.state);
  assert.equal(reopened.stack.stateHash(), stack.stateHash());
  assert.equal(reopened.stack.depth, stack.depth);
  assert.equal(reopened.stack.score, stack.score);
  assert.equal(reopened.stack.selection, stack.selection);
  assert.deepEqual(reopened.stack.moves(), stack.moves());
});

test('a restored stack keeps its full undo depth, back to the initial state', () => {
  const level = generateLevel(SEED_LAYOUTS[0]!, 99);
  const board = new Board(level.tiles);
  const stack = new MoveStack(board);
  const initial = stack.stateHash();
  level.solution.slice(0, 12).forEach((move, i) => stack.play(move[0], move[1], (i + 1) * 1000));

  const reopened = reopen(board.allTiles(), stack.state);
  while (reopened.stack.undo());
  assert.equal(reopened.stack.depth, 0);
  assert.equal(reopened.stack.score, 0);
  assert.equal(reopened.board.presentTiles().length, level.tiles.length);
  assert.equal(reopened.stack.stateHash(), initial);
});

test('the combo ladder survives a round-trip: the next match keeps multiplying', () => {
  const board = rowBoard();
  const stack = new MoveStack(board);
  stack.play(0, 1, 1000); // ×1
  const live = new MoveStack(new Board(board.allTiles()));
  live.restoreState(stack.state);
  // 1s later — inside the 5s window (§6), so this is the 2nd rung, not the 1st.
  assert.equal(live.play(2, 3, 2000).multiplier, 1.2);
});

test('restoreState rejects a selection the restored board cannot select', () => {
  const board = rowBoard();
  const stack = new MoveStack(board);
  stack.play(0, 1, 1000);
  const corrupt = { ...stack.state, selection: 0 as TileId }; // 0 was removed
  assert.throws(
    () => new MoveStack(new Board(board.allTiles())).restoreState(corrupt),
    /not a matchable tile/,
  );
});
