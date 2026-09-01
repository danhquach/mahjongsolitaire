// Booster behavior on the game controller (issue #13, spec §5): Hint cycles
// valid pairs, Undo returns the newest parked tile from the holder (issue
// #100 — matches are permanent), Shuffle keeps the board solvable and its
// occupancy intact. Since issue #93 a pair is played as two taps — the first
// parks its tile in the holder, the second clears the pair there.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SEED_LAYOUTS, canMatch, generateLevel, legalPairs, solve } from '@mahjongsolitaire/core';
import type { GeneratedLevel, TileId } from '@mahjongsolitaire/core';
import { Game } from '../src/game.js';
import type { HintPair } from '../src/game.js';
import type { Hit } from '../src/hit-test.js';

const free = (id: TileId): Hit => ({ kind: 'free', id, forgiven: false });
const ROWS = SEED_LAYOUTS.find((l) => l.id === 'seed-rows')!;

function newGame(seed = 1): Game {
  return new Game(generateLevel(ROWS, seed));
}

/** Play the first `count` pairs of the generator's solution witness. */
function playMoves(game: Game, count: number): void {
  let t = 0;
  for (const [a, b] of game.level.solution.slice(0, count)) {
    game.tap(free(a), t++);
    game.tap(free(b), t++);
  }
}

const key = (p: HintPair): string => `${Math.min(...p)}:${Math.max(...p)}`;

const STUCK: GeneratedLevel = {
  layoutId: 'stuck-fixture',
  seed: 0,
  tiles: [
    { id: 0, slot: { x: 0, y: 0, z: 0 }, face: 'dots-1', removed: false },
    { id: 1, slot: { x: 2, y: 0, z: 0 }, face: 'dots-2', removed: false },
  ],
  solution: [],
};

// --- Hint ------------------------------------------------------------------

test('hint returns a playable pair', () => {
  const game = newGame();
  const pair = game.hint();
  assert.notEqual(pair, null);
  const [a, b] = pair!;
  assert.equal(canMatch(game.board, a, b).ok, true);
});

test("hint's first pair keeps the board solvable", () => {
  // The point of a solver-backed hint: following it never loses the deal.
  for (const seed of [1, 2, 3, 4, 5]) {
    const game = newGame(seed);
    playMoves(game, 2);
    const [a, b] = game.hint()!;
    game.tap(free(a), 1000);
    game.tap(free(b), 1001);
    assert.equal(solve(game.board.allTiles()).verdict, 'solvable', `seed ${seed}`);
  }
});

test('repeat presses cycle every legal pair, then wrap around', () => {
  // seed 5 after three moves is the seed-rows state with the most free pairs
  // (three) — the small fixtures usually offer only one.
  const game = newGame(5);
  playMoves(game, 3);
  const total = legalPairs(game.board).length;
  assert.ok(total > 1, 'fixture needs several legal pairs to cycle through');
  const seen: string[] = [];
  for (let i = 0; i < total; i++) seen.push(key(game.hint()!));
  assert.equal(new Set(seen).size, total, 'each press showed a different pair');
  assert.deepEqual(
    [...new Set(seen)].sort(),
    legalPairs(game.board).map(key).sort(),
    'the cycle covers exactly the legal pairs',
  );
  assert.equal(key(game.hint()!), seen[0], 'the next press wraps to the first pair');
});

test('the hint cycle restarts when the board changes', () => {
  const game = newGame();
  game.hint();
  game.hint(); // cursor advanced
  playMoves(game, 1);
  const pair = game.hint()!;
  assert.ok(
    legalPairs(game.board).map(key).includes(key(pair)),
    'a stale cursor would point past the new pair list',
  );
  assert.equal(canMatch(game.board, pair[0], pair[1]).ok, true);
});

test('hint returns null when no matching free pair exists', () => {
  assert.equal(new Game(STUCK).hint(), null);
});

// --- Undo (issue #100: return the newest parked tile) -----------------------

test('undo returns the parked tile; a cleared pair is gone for good', () => {
  const game = newGame();
  const [a, b] = game.level.solution[0]!;
  game.tap(free(a), 0); // a to the holder
  assert.equal(game.undoDepth, 1);

  const returned = game.undo();
  assert.equal(returned?.kind, 'hold');
  assert.equal(returned?.tile, a);
  assert.equal(game.board.isHeld(a), false, 'back on the board');
  assert.equal(game.undoDepth, 0);

  // Play the pair through the holder; matched means gone.
  game.tap(free(a), 1);
  game.tap(free(b), 2);
  assert.equal(game.score, 100);
  assert.equal(game.undo(), null, 'nothing parked, nothing to undo');
  assert.equal(game.score, 100, 'and no charge-worthy state change');
  assert.equal(game.board.get(a).removed, true);
  assert.equal(game.board.get(b).removed, true);
});

test('undo never rewinds matches: a won game has nothing to undo', () => {
  const game = newGame();
  assert.equal(game.undo(), null, 'nothing to undo on a fresh deal');
  playMoves(game, game.level.solution.length);
  assert.equal(game.status(), 'won');
  assert.equal(game.undoDepth, 0, 'every park was matched out — none are candidates');
  assert.equal(game.undo(), null);
  assert.equal(game.tilesLeft, 0, 'no tile came back');
});

test('undo leaves later matches and their score alone', () => {
  const game = newGame();
  const [a1, b1] = game.level.solution[0]!;
  const [a2] = game.level.solution[1]!;
  game.tap(free(a2), 0); // park a tile from the second pair
  game.tap(free(a1), 1); // then clear the first pair through the holder
  game.tap(free(b1), 2);
  const scoreAfter = game.score;
  assert.ok(scoreAfter > 0);

  const returned = game.undo();
  assert.equal(returned?.tile, a2, 'the parked tile, not the match, comes back');
  assert.equal(game.score, scoreAfter, 'score does not rewind');
  assert.equal(game.board.get(a1).removed, true, 'the later match stays played');
  assert.equal(game.board.get(b1).removed, true);
});

test('shuffle keeps occupancy and the face multiset, and stays solvable', () => {
  const game = newGame();
  playMoves(game, 3);
  const before = game.board.allTiles().map((t) => ({ ...t }));
  const faceCount = (tiles: readonly { face: string; removed: boolean }[]) => {
    const counts = new Map<string, number>();
    for (const t of tiles) {
      if (!t.removed) counts.set(t.face, (counts.get(t.face) ?? 0) + 1);
    }
    return [...counts].sort();
  };

  assert.equal(game.shuffle(12345), true);
  const after = game.board.allTiles();
  assert.deepEqual(
    after.map((t) => [t.id, t.slot, t.removed]),
    before.map((t) => [t.id, t.slot, t.removed]),
    'slot occupancy and removals are untouched',
  );
  assert.deepEqual(faceCount(after), faceCount(before), 'the face multiset is preserved');
  assert.equal(solve(after).verdict, 'solvable', 'spec §5: post-shuffle board is solvable');
});

test('shuffle is deterministic per seed', () => {
  const gameA = newGame();
  playMoves(gameA, 2);
  assert.equal(gameA.shuffle(777), true);

  const gameB = newGame();
  playMoves(gameB, 2);
  assert.equal(gameB.shuffle(777), true);
  assert.deepEqual(
    gameA.board.presentTiles().map((t) => [t.id, t.face]),
    gameB.board.presentTiles().map((t) => [t.id, t.face]),
  );
});

test('shuffle refuses a cleared board instead of charging for nothing', () => {
  const game = newGame();
  playMoves(game, game.level.solution.length);
  assert.equal(game.tilesLeft, 0);
  assert.equal(game.shuffle(1), false);
});

test('undo across a shuffle still returns the parked tile', () => {
  const game = newGame();
  playMoves(game, 2);
  const parked = game.board.freeTileIds()[0]!;
  game.tap(free(parked), 1000);
  game.shuffle(4242);
  const returned = game.undo();
  assert.equal(returned?.tile, parked);
  assert.equal(game.board.isHeld(parked), false);
  assert.equal(game.board.get(parked).removed, false);
});
