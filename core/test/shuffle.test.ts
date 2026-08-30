// Shuffle booster primitive (issue #10, spec §5, §11.1): post-shuffle board is
// always solvable; slot occupancy unchanged; face multiset preserved.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Board } from '../src/board.js';
import type { Slot } from '../src/board.js';
import { generateLevel } from '../src/generator.js';
import { SEED_LAYOUTS } from '../src/layouts.js';
import { shuffleBoard } from '../src/shuffle.js';
import { solve } from '../src/solver.js';

const slot = (x: number, y: number, z = 0): Slot => ({ x, y, z });

function sortedFaces(board: Board, removed: boolean): string[] {
  return board
    .allTiles()
    .filter((t) => t.removed === removed)
    .map((t) => t.face)
    .sort();
}

test('post-shuffle board is always solvable (all seed layouts, several seeds)', () => {
  for (const layout of SEED_LAYOUTS) {
    for (const seed of [1, 2, 3, 99, 424242]) {
      const board = new Board(generateLevel(layout, seed).tiles);
      // Play a few moves first so removed tiles are in the mix.
      const witness = generateLevel(layout, seed).solution.slice(0, 4);
      for (const [a, b] of witness) {
        board.remove(a);
        board.remove(b);
      }
      shuffleBoard(board, seed * 31 + 7);
      assert.equal(
        solve(board.allTiles()).verdict,
        'solvable',
        `${layout.id} seed ${seed} not solvable after shuffle`,
      );
    }
  }
});

test('shuffle preserves slot occupancy, removed flags, and the face multiset', () => {
  const board = new Board(generateLevel(SEED_LAYOUTS[1]!, 5).tiles);
  const level = generateLevel(SEED_LAYOUTS[1]!, 5);
  for (const [a, b] of level.solution.slice(0, 6)) {
    board.remove(a);
    board.remove(b);
  }
  const beforeSlots = board
    .allTiles()
    .map((t) => ({ id: t.id, slot: t.slot, removed: t.removed }));
  const beforePresentFaces = sortedFaces(board, false);
  const beforeRemoved = board.allTiles().filter((t) => t.removed).map((t) => [t.id, t.face]);

  shuffleBoard(board, 12345);

  assert.deepEqual(
    board.allTiles().map((t) => ({ id: t.id, slot: t.slot, removed: t.removed })),
    beforeSlots,
  );
  assert.deepEqual(sortedFaces(board, false), beforePresentFaces);
  // Removed tiles keep their exact faces — only remaining tiles re-randomize.
  assert.deepEqual(board.allTiles().filter((t) => t.removed).map((t) => [t.id, t.face]), beforeRemoved);
});

test('shuffle is deterministic per (board, seed)', () => {
  const faces = (seed: number) => {
    const board = new Board(generateLevel(SEED_LAYOUTS[0]!, 11).tiles);
    shuffleBoard(board, seed);
    return board.allTiles().map((t) => t.face);
  };
  assert.deepEqual(faces(777), faces(777));
  assert.notDeepEqual(faces(777), faces(778));
});

test('shuffle of an empty board is a no-op', () => {
  const board = new Board([
    { id: 0, slot: slot(0, 0), face: 'dots-1', removed: true },
    { id: 1, slot: slot(2, 0), face: 'dots-1', removed: true },
  ]);
  shuffleBoard(board, 1);
  assert.equal(board.get(0).face, 'dots-1');
});

test('shuffle throws, board unchanged, when no face assignment is solvable', () => {
  // A matching pair stacked vertically: the bottom tile is covered by the top,
  // so no permutation of the two identical faces is winnable.
  const board = new Board([
    { id: 0, slot: slot(0, 0, 0), face: 'dots-1' },
    { id: 1, slot: slot(0, 0, 1), face: 'dots-1' },
  ]);
  assert.throws(() => shuffleBoard(board, 9, { maxStates: 1000 }), /no solvable shuffle/);
  assert.deepEqual(board.allTiles().map((t) => t.face), ['dots-1', 'dots-1']);
});
