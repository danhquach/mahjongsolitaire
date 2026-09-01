// Move stack + undo (issue #10, spec §5, §11.1; reworked by issue #100):
// matches are permanent, and undo returns the most recently parked tile from
// the holder to its own slot — score, combo ladder and later matches
// untouched. The §11.1 acceptance property: `park(k) → undo(k)` restores the
// pre-park state hash exactly.

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

// --- undo (issue #100: return the newest parked tile; matches are permanent) --

test('undo returns the newest parked tile to its own slot', () => {
  const board = rowBoard();
  const stack = new MoveStack(board);
  stack.hold(0, 1000);
  stack.hold(2, 2000);
  const undone = stack.undo();
  assert.equal(undone?.kind, 'hold');
  assert.equal(undone?.tile, 2, 'newest parked tile comes back first');
  assert.equal(board.isHeld(2), false);
  assert.equal(board.isFree(2), true, 'back on its own layout slot');
  assert.equal(board.isHeld(0), true, 'older parked tile stays parked');
  assert.equal(stack.undoDepth, 1);
});

test('undo with an empty holder returns null — matches are not undoable', () => {
  const stack = new MoveStack(rowBoard());
  assert.equal(stack.undo(), null, 'fresh deal: nothing parked');
  stack.play(0, 1, 1000);
  assert.equal(stack.undo(), null, 'a played match is permanent');
  assert.equal(stack.depth, 1, 'the match record stays');
  assert.equal(stack.score, 100, 'and so does its score');
});

test('undo leaves later matches, their score, and the combo ladder untouched', () => {
  const board = rowBoard();
  const stack = new MoveStack(board);
  stack.hold(0, 1000);
  stack.play(2, 3, 2000); // played after the park
  const scoreAfterMatch = stack.score;
  const undone = stack.undo();
  assert.equal(undone?.tile, 0, 'the parked tile returns');
  assert.equal(board.get(2).removed, true, 'the later match stays played');
  assert.equal(board.get(3).removed, true);
  assert.equal(stack.score, scoreAfterMatch, 'score does not rewind');
  // The ladder is untouched too: the return did not reset the streak, so an
  // in-window follow-up match still multiplies.
  const replay = stack.play(0, 1, 2500);
  assert.equal(replay.multiplier, 1.2, 'combo ladder kept its streak');
});

test('a parked tile later matched out of the holder is not a candidate', () => {
  const board = rowBoard();
  const stack = new MoveStack(board);
  stack.hold(0, 1000); // dots-1 parked
  stack.play(0, 1, 2000); // matched out of the holder — gone for good
  assert.equal(stack.undo(), null, 'nothing left to return');
  assert.equal(board.get(0).removed, true);
});

test('undo removes the hold record: holdsUsed rolls back, history reads clean', () => {
  const stack = new MoveStack(rowBoard());
  stack.hold(0, 1000);
  assert.equal(stack.holdsUsed, 1);
  stack.undo();
  assert.equal(stack.holdsUsed, 0);
  assert.equal(stack.depth, 0, 'the park never happened');
});

test('undo clears the selection — the return can re-cover the selected tile', () => {
  const board = new Board([
    { id: 0, slot: slot(0, 0, 1), face: 'dots-1' }, // covers tile 1
    { id: 1, slot: slot(0, 0, 0), face: 'dots-1' },
    { id: 2, slot: slot(4, 0), face: 'bamboo-2' },
    { id: 3, slot: slot(8, 0), face: 'bamboo-2' },
  ]);
  const stack = new MoveStack(board);
  stack.hold(0, 1000); // frees tile 1
  stack.select(1);
  stack.undo(); // tile 0 returns and covers tile 1 again
  assert.equal(stack.selection, null);
  assert.equal(board.isFree(1), false, 'the returned tile re-covers it');
});

// --- §11.1 acceptance property --------------------------------------------------

test('property: park(k) → undo(k) restores the pre-park state hash exactly', () => {
  const rng = mulberry32(0xdecafbad);
  for (const layout of SEED_LAYOUTS) {
    for (const seed of [1, 42, 90210]) {
      const level = generateLevel(layout, seed);
      const board = new Board(level.tiles);
      const stack = new MoveStack(board);

      // Play a random-length prefix of random legal moves.
      const total = 1 + Math.floor(rng() * (level.solution.length - 1));
      for (let i = 0; i < total; i++) {
        const pairs = legalPairs(board);
        if (pairs.length === 0) break;
        const move = pairs[Math.floor(rng() * pairs.length)]!;
        stack.play(move[0], move[1], (i + 1) * 1000);
      }

      const hashBeforeParks = stack.stateHash();
      // Park up to 3 free tiles (the 4th would lose the level).
      const free = board.freeTileIds();
      const k = Math.min(3, free.length, 1 + Math.floor(rng() * 3));
      for (let i = 0; i < k; i++) stack.hold(free[i]!, (total + i + 1) * 1000);
      assert.equal(stack.undoDepth, k, `${layout.id} seed ${seed}: undoDepth counts the parks`);

      // Undo returns them newest-first, back to exactly the pre-park state.
      for (let i = k - 1; i >= 0; i--) {
        const undone = stack.undo();
        assert.equal(undone?.tile, free[i], `${layout.id} seed ${seed}: newest-first`);
      }
      assert.equal(stack.undo(), null);
      assert.equal(stack.stateHash(), hashBeforeParks, `${layout.id} seed ${seed}`);
    }
  }
});

test('a fully played game has nothing to undo — matched means gone', () => {
  const level = generateLevel(SEED_LAYOUTS[0]!, 7);
  const board = new Board(level.tiles);
  const stack = new MoveStack(board);
  level.solution.forEach((move, i) => stack.play(move[0], move[1], (i + 1) * 1000));
  assert.equal(board.presentTiles().length, 0);
  assert.equal(stack.undo(), null);
  assert.equal(stack.depth, level.solution.length, 'the full history stays');
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

test('a restored stack keeps its parked tiles returnable, newest-first', () => {
  const level = generateLevel(SEED_LAYOUTS[0]!, 99);
  const board = new Board(level.tiles);
  const stack = new MoveStack(board);
  level.solution.slice(0, 6).forEach((move, i) => stack.play(move[0], move[1], (i + 1) * 1000));
  const [first, second] = board.freeTileIds();
  stack.hold(first!, 7000);
  stack.hold(second!, 8000);

  // The holder travels with the board occupancy (issue #14 / #43).
  const reopenedBoard = new Board(board.allTiles(), { holder: board.holderSlots() });
  const reopened = { board: reopenedBoard, stack: new MoveStack(reopenedBoard, new ScoreKeeper()) };
  reopened.stack.restoreState(stack.state);
  assert.equal(reopened.stack.undoDepth, 2, 'both parks survive the round-trip');
  assert.equal(reopened.stack.undo()?.tile, second, 'newest-first after a resume');
  assert.equal(reopened.stack.undo()?.tile, first);
  assert.equal(reopened.stack.undo(), null, 'matches stay permanent');
  assert.equal(reopened.stack.score, stack.score, 'returns never touch the score');
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
