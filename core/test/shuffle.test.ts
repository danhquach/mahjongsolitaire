// Shuffle booster primitive (issue #10, spec §5, §11.1): post-shuffle board is
// always solvable; slot occupancy unchanged; face multiset preserved.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

import { Board } from '../src/board.js';
import type { Slot } from '../src/board.js';
import { generateLevel } from '../src/generator.js';
import { SEED_LAYOUTS, parseLayout } from '../src/layouts.js';
import { MAX_SHUFFLE_ATTEMPTS, applyShuffle, shuffleBoard } from '../src/shuffle.js';
import { solve } from '../src/solver.js';

const LAYOUT_DIR = new URL('../../../data/layouts/', import.meta.url);

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

test('shuffle of an empty board is a no-op, and says so', () => {
  const board = new Board([
    { id: 0, slot: slot(0, 0), face: 'dots-1', removed: true },
    { id: 1, slot: slot(2, 0), face: 'dots-1', removed: true },
  ]);
  assert.equal(shuffleBoard(board, 1), null);
  assert.equal(board.get(0).face, 'dots-1');
  assert.throws(() => applyShuffle(board, 1, 0), /nothing on the board/);
});

test('issue #187: applyShuffle reproduces the attempt shuffleBoard accepted, without the solver', () => {
  for (const layout of SEED_LAYOUTS) {
    for (const seed of [1, 2, 3, 99, 424242]) {
      const level = generateLevel(layout, seed);
      const played = new Board(level.tiles);
      const replayed = new Board(level.tiles);
      for (const [a, b] of level.solution.slice(0, 3)) {
        played.remove(a);
        played.remove(b);
        replayed.remove(a);
        replayed.remove(b);
      }
      const attempt = shuffleBoard(played, seed * 31 + 7);
      assert.ok(attempt !== null && attempt >= 0 && attempt < MAX_SHUFFLE_ATTEMPTS);
      applyShuffle(replayed, seed * 31 + 7, attempt);
      assert.deepEqual(
        replayed.allTiles().map((t) => t.face),
        played.allTiles().map((t) => t.face),
        `${layout.id} seed ${seed}: attempt ${attempt}`,
      );
    }
  }
});

test('applyShuffle refuses an attempt shuffleBoard could not have produced', () => {
  const board = new Board(generateLevel(SEED_LAYOUTS[0]!, 11).tiles);
  const before = board.allTiles().map((t) => t.face);
  assert.throws(() => applyShuffle(board, 1, -1), RangeError);
  assert.throws(() => applyShuffle(board, 1, 1.5), RangeError);
  assert.throws(() => applyShuffle(board, 1, MAX_SHUFFLE_ATTEMPTS), RangeError);
  assert.deepEqual(board.allTiles().map((t) => t.face), before, 'the board is untouched');
});

test('shuffle throws, board unchanged, when no face assignment is solvable', () => {
  // A matching pair stacked vertically: the bottom tile is covered by the top,
  // so no permutation of the two identical faces is winnable.
  const board = new Board([
    { id: 0, slot: slot(0, 0, 0), face: 'dots-1' },
    { id: 1, slot: slot(0, 0, 1), face: 'dots-1' },
  ]);
  assert.throws(() => shuffleBoard(board, 9), /no solvable shuffle/);
  assert.deepEqual(board.allTiles().map((t) => t.face), ['dots-1', 'dots-1']);
});

test('issue #213: every shipped layout shuffles at once, at any stage, with or without a parked tile', () => {
  // The original shuffle drew random permutations and kept the first the
  // solver accepted. On the dense layouts of decision 0036 a random
  // permutation is solvable well under one time in ten (0% of 100 on most
  // layouts before 24 pairs are played), so a shuffle exhausted its budget —
  // about a minute of solver time — and refused. Reverse construction has to
  // complete on the first attempt or two and stay solvable with the holder.
  // Attempts are deterministic per (board, seed); the wall clock is checked
  // once over all 80 cases (1–7 ms each measured) so a slow runner cannot
  // flip a single case.
  const started = Date.now();
  for (const file of readdirSync(LAYOUT_DIR).filter((f) => f.endsWith('.json'))) {
    const layout = parseLayout(JSON.parse(readFileSync(new URL(file, LAYOUT_DIR), 'utf8')));
    for (const played of [0, 8, 24, 48]) {
      for (const parked of [0, 1]) {
        const level = generateLevel(layout, 104729);
        const board = new Board(level.tiles);
        for (const [a, b] of level.solution.slice(0, played)) {
          board.remove(a);
          board.remove(b);
        }
        if (parked) board.hold(board.freeTileIds()[0]!);
        const label = `${layout.id}, ${played} pairs played, ${parked} parked`;
        const attempt = shuffleBoard(board, 0xbeef);
        assert.ok(attempt !== null && attempt < 4, `${label}: took ${attempt} attempts`);
        assert.equal(
          solve(board.allTiles(), { holder: board.holderSlots() }).verdict,
          'solvable',
          `${label}: not solvable after shuffle`,
        );
      }
    }
  }
  assert.ok(Date.now() - started < 10_000, `80 shuffles took ${Date.now() - started} ms`);
});
