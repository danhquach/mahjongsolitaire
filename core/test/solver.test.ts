// Solver: bounded DFS + memoization (spec §4, issue #8). Known-solvable and
// known-deadlocked fixtures, budget exhaustion, hint search, and validated
// generation (reseed on solver failure).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Board } from '../src/board.js';
import type { Slot, Tile, TileId } from '../src/board.js';
import { generateLevel, generateValidatedLevel } from '../src/generator.js';
import { SEED_LAYOUTS } from '../src/layouts.js';
import { matchPair } from '../src/match.js';
import { findHint, legalPairs, solve } from '../src/solver.js';

/** Tiles from single-layer rows: row i sits at y = i*4 (rows never block each
 *  other), tile j of a row at x = j*2 (adjacent within the row). '.' = gap. */
function rows(...faceRows: string[][]): Tile[] {
  const tiles: Tile[] = [];
  faceRows.forEach((faces, i) => {
    faces.forEach((face, j) => {
      if (face === '.') return;
      tiles.push({ id: tiles.length, slot: { x: j * 2, y: i * 4, z: 0 }, face, removed: false });
    });
  });
  return tiles;
}

function tile(id: TileId, face: string, slot: Slot): Tile {
  return { id, face, slot, removed: false };
}

/** Replaying the solution via the real match rules must clear the board. */
function assertSolutionClears(tiles: readonly Tile[], solution: ReadonlyArray<readonly [TileId, TileId]>) {
  const board = new Board(tiles);
  for (const [a, b] of solution) matchPair(board, a, b);
  assert.equal(board.presentTiles().length, 0);
}

// --- known-solvable fixtures ---------------------------------------------------

test('trivial pair is solvable with the one-move solution', () => {
  const tiles = rows(['dots-1', 'dots-1']);
  const result = solve(tiles);
  assert.equal(result.verdict, 'solvable');
  assert.ok(result.solution);
  assert.equal(result.solution.length, 1);
  assertSolutionClears(tiles, result.solution);
});

test('empty board is solvable with the empty solution', () => {
  const result = solve([]);
  assert.equal(result.verdict, 'solvable');
  assert.deepEqual(result.solution, []);
});

test('solvable board that punishes greedy pairing requires backtracking', () => {
  // Four dots-1: a two-tile column plus two free singles. Pairing the two
  // singles strands the column (top free, bottom covered — no pair left), so
  // only pairings that take the column top survive. Solver must backtrack.
  const tiles = [
    tile(0, 'dots-1', { x: 0, y: 0, z: 0 }),
    tile(1, 'dots-1', { x: 0, y: 0, z: 1 }),
    tile(2, 'dots-1', { x: 10, y: 0, z: 0 }),
    tile(3, 'dots-1', { x: 20, y: 0, z: 0 }),
  ];
  const result = solve(tiles);
  assert.equal(result.verdict, 'solvable');
  assert.ok(result.solution);
  assertSolutionClears(tiles, result.solution);
});

test('solve respects removed tiles (mid-game position)', () => {
  const tiles = rows(['dots-1', 'dots-2', 'dots-2', 'dots-1']);
  const board = new Board(tiles);
  matchPair(board, 0, 3);
  const result = solve(board.allTiles());
  assert.equal(result.verdict, 'solvable');
  assert.ok(result.solution);
  assert.equal(result.solution.length, 1);
});

// --- known-deadlocked fixtures ---------------------------------------------------

test('interleaved row with no legal first move is unsolvable', () => {
  // [A][B][A][B]: only the two ends are free and they mismatch.
  const result = solve(rows(['dots-1', 'dots-2', 'dots-1', 'dots-2']));
  assert.equal(result.verdict, 'unsolvable');
  assert.equal(result.solution, null);
});

test('board with legal first moves but no winning line is unsolvable', () => {
  // Cross-cover: an A sits on the only B's partner-free spot and vice versa —
  // after the forced C pair, the two free tiles mismatch forever.
  const tiles = [
    tile(0, 'dots-2', { x: 0, y: 0, z: 0 }),
    tile(1, 'dots-1', { x: 0, y: 0, z: 1 }),
    tile(2, 'dots-1', { x: 10, y: 0, z: 0 }),
    tile(3, 'dots-2', { x: 10, y: 0, z: 1 }),
    tile(4, 'dots-3', { x: 20, y: 0, z: 0 }),
    tile(5, 'dots-3', { x: 30, y: 0, z: 0 }),
  ];
  const result = solve(tiles);
  assert.equal(result.verdict, 'unsolvable');
});

test('odd copy count of a face is unsolvable', () => {
  const result = solve(rows(['dots-1', 'dots-1', 'dots-1']));
  assert.equal(result.verdict, 'unsolvable');
});

// --- bounded search ---------------------------------------------------

test('exhausted state budget yields unknown, not a wrong verdict', () => {
  const layout = SEED_LAYOUTS[0]!;
  const level = generateLevel(layout, 1);
  const result = solve(level.tiles, { maxStates: 1 });
  assert.equal(result.verdict, 'unknown');
  assert.equal(result.solution, null);
});

test('solve is deterministic', () => {
  const level = generateLevel(SEED_LAYOUTS[0]!, 7);
  assert.deepEqual(solve(level.tiles), solve(level.tiles));
});

// --- generated levels ---------------------------------------------------

test('solver confirms reverse-constructed levels across seeds and layouts', () => {
  for (const layout of SEED_LAYOUTS) {
    for (let seed = 0; seed < 25; seed++) {
      const level = generateLevel(layout, seed);
      const result = solve(level.tiles);
      assert.equal(result.verdict, 'solvable', `${layout.id} seed ${seed}`);
      assert.ok(result.solution);
      assertSolutionClears(level.tiles, result.solution);
    }
  }
});

test('generateValidatedLevel returns a solver-validated, deterministic level', () => {
  const layout = SEED_LAYOUTS[1]!;
  const a = generateValidatedLevel(layout, 42);
  const b = generateValidatedLevel(layout, 42);
  assert.deepEqual(a, b);
  assert.equal(solve(a.tiles).verdict, 'solvable');
  // Regenerating from the stored seed reproduces the exact deal (spec §4).
  assert.deepEqual(generateLevel(layout, a.seed), a);
});

// --- hint search (spec §5: same search as the solver) ---------------------------------

test('legalPairs lists every free matching pair, deterministically ordered', () => {
  const board = new Board(rows(['dots-1', 'dots-2', 'dots-1'], ['dots-1', 'dots-3', 'dots-1']));
  // Free: 0, 2 (row 1 ends), 3, 5 (row 2 ends) — all dots-1.
  assert.deepEqual(legalPairs(board), [
    [0, 2],
    [0, 3],
    [0, 5],
    [2, 3],
    [2, 5],
    [3, 5],
  ]);
});

test('hint is the first move of a winning line, never a fatal pair', () => {
  // Same trap as the backtracking fixture: pairing the two ground singles
  // (ids 2, 3) loses. The hint must include the column top (id 1).
  const board = new Board([
    tile(0, 'dots-1', { x: 0, y: 0, z: 0 }),
    tile(1, 'dots-1', { x: 0, y: 0, z: 1 }),
    tile(2, 'dots-1', { x: 10, y: 0, z: 0 }),
    tile(3, 'dots-1', { x: 20, y: 0, z: 0 }),
  ]);
  const hint = findHint(board);
  assert.ok(hint);
  assert.ok(hint.includes(1), `hint ${hint} must take the column top`);
});

test('hint falls back to a legal pair when the position is lost', () => {
  // Cross-cover deadlock with one legal (but futile) dots-3 pair available.
  const board = new Board([
    tile(0, 'dots-2', { x: 0, y: 0, z: 0 }),
    tile(1, 'dots-1', { x: 0, y: 0, z: 1 }),
    tile(2, 'dots-1', { x: 10, y: 0, z: 0 }),
    tile(3, 'dots-2', { x: 10, y: 0, z: 1 }),
    tile(4, 'dots-3', { x: 20, y: 0, z: 0 }),
    tile(5, 'dots-3', { x: 30, y: 0, z: 0 }),
  ]);
  assert.deepEqual(findHint(board), [4, 5]);
});

test('hint is null when no legal pair exists', () => {
  const board = new Board(rows(['dots-1', 'dots-2', 'dots-1', 'dots-2']));
  assert.equal(findHint(board), null);
});
