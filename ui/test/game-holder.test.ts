// Holder behaviour on the game controller (issue #43): the Hold control's two
// directions, tapping a held tile, and the places the holder changes what the
// HUD is told — tiles left, the win check, and the deadlock check.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HOLDER_SLOTS, SEED_LAYOUTS, generateLevel } from '@mahjongsolitaire/core';
import type { GeneratedLevel, TileId } from '@mahjongsolitaire/core';
import { Game } from '../src/game.js';
import type { Hit } from '../src/hit-test.js';

const free = (id: TileId): Hit => ({ kind: 'free', id, forgiven: false });
const ROWS = SEED_LAYOUTS.find((l) => l.id === 'seed-rows')!;

function newGame(seed = 1): Game {
  return new Game(generateLevel(ROWS, seed));
}

const tile = (id: number, x: number, y: number, z: number, face: string) => ({
  id,
  slot: { x, y, z },
  face,
  removed: false,
});

/**
 * Tile 1 covers tile 0 and matches tile 3 across the board; tile 0's partner
 * (tile 2) is free from the start. So there is a pair on the board, and a
 * second one that only the holder can reach.
 */
const COVERED: GeneratedLevel = {
  layoutId: 'holder-fixture',
  seed: 0,
  tiles: [
    tile(0, 0, 0, 0, 'dots-1'),
    tile(1, 0, 0, 1, 'bamboo-2'),
    tile(2, 4, 0, 0, 'dots-1'),
    tile(3, 8, 0, 0, 'bamboo-2'),
  ],
  solution: [
    [1, 3],
    [0, 2],
  ],
};

/** No pair among the free tiles; parking tile 1 exposes 0 + 2. */
const HOLD_TO_MOVE: GeneratedLevel = {
  layoutId: 'hold-to-move-fixture',
  seed: 0,
  tiles: [
    tile(0, 0, 0, 0, 'dots-1'),
    tile(1, 0, 0, 1, 'bamboo-2'),
    tile(2, 4, 0, 0, 'dots-1'),
    tile(3, 8, 0, 0, 'char-5'),
    tile(4, 12, 0, 0, 'char-6'),
    tile(5, 16, 0, 0, 'wind-east'),
  ],
  solution: [],
};

// --- the Hold control ---------------------------------------------------------

test('the Hold control follows the selection, both ways', () => {
  const game = new Game(COVERED);
  assert.equal(game.holderAction(), 'none');
  assert.deepEqual(game.useHolder(0), { kind: 'none' });

  game.tap(free(1), 1);
  assert.equal(game.holderAction(), 'hold');
  assert.deepEqual(game.useHolder(2), { kind: 'held', id: 1, slot: 0 });
  assert.deepEqual(game.holderSlots(), [1, null, null, null]);
  assert.equal(game.holdsUsed, 1);
  assert.equal(game.selection, null);

  // Selecting the parked tile turns the same control into Return.
  game.tapHeld(1, 3);
  assert.equal(game.holderAction(), 'return');
  assert.deepEqual(game.useHolder(4), { kind: 'returned', id: 1 });
  assert.deepEqual(game.holderSlots(), [null, null, null, null]);
  assert.equal(game.holdsUsed, 1, 'a return does not un-count the hold');
});

test('a blocked tile is never held: it cannot even be selected', () => {
  const game = new Game(COVERED);
  assert.equal(game.tap({ kind: 'blocked', id: 0 }, 0).kind, 'blocked');
  assert.equal(game.selection, null);
  assert.equal(game.holderAction(), 'none');
  assert.deepEqual(game.holderSlots(), [null, null, null, null]);
});

test('a full holder refuses the hold and says so — the level goes on', () => {
  const game = new Game({
    layoutId: 'full-holder-fixture',
    seed: 0,
    tiles: Array.from({ length: HOLDER_SLOTS + 1 }, (_, i) =>
      tile(i, i * 4, 0, 0, `dots-${i + 1}`),
    ),
    solution: [],
  });
  for (let i = 0; i < HOLDER_SLOTS; i++) {
    game.tap(free(i), i * 2);
    assert.equal(game.useHolder(i * 2 + 1).kind, 'held');
  }
  assert.equal(game.holderFull, true);

  game.tap(free(HOLDER_SLOTS), 100);
  const before = game.stateHash();
  assert.equal(game.holderAction(), 'full');
  assert.deepEqual(game.useHolder(101), { kind: 'full' });
  assert.equal(game.stateHash(), before, 'a refused hold changes nothing at all');
  assert.equal(game.status(), 'stuck', 'and it is a deadlock, not a loss');
  assert.equal(game.tilesLeft, HOLDER_SLOTS + 1);
});

// --- tapping a held tile ------------------------------------------------------

test('a held tile can be matched against a board tile', () => {
  const game = new Game(COVERED);
  game.tap(free(1), 0);
  game.useHolder(1); // park tile 1 — frees tile 0
  game.tap(free(3), 2);
  const outcome = game.tapHeld(1, 3);
  assert.equal(outcome.kind, 'matched');
  assert.deepEqual(game.holderSlots(), [null, null, null, null]);
  assert.equal(game.tilesLeft, 2);
  assert.equal(game.score, 100);
});

test('two held tiles can be matched against each other', () => {
  const game = new Game(COVERED);
  game.tap(free(1), 0);
  game.useHolder(1);
  game.tap(free(3), 2);
  game.useHolder(3);
  assert.deepEqual(game.holderSlots(), [1, 3, null, null]);
  game.tapHeld(1, 4);
  assert.equal(game.tapHeld(3, 5).kind, 'matched');
  assert.deepEqual(game.holderSlots(), [null, null, null, null]);
  assert.equal(game.tilesLeft, 2);
});

test('a held tile deselects and mismatches like a board tile', () => {
  const game = new Game(COVERED);
  game.tap(free(1), 0);
  game.useHolder(1);
  assert.equal(game.tapHeld(1, 2).kind, 'selected');
  assert.equal(game.tapHeld(1, 3).kind, 'deselected');
  game.tapHeld(1, 4);
  assert.equal(game.tap(free(2), 5).kind, 'mismatch');
  assert.equal(game.selection, 2, 'the selection moves to the tile just tapped');
  assert.equal(game.tapHeld(2, 6).kind, 'none', 'a tile that is not held is not a holder tap');
});

// --- what the HUD is told -----------------------------------------------------

test('held tiles still count as tiles left, so parking is not winning', () => {
  const game = new Game({
    layoutId: 'last-pair-fixture',
    seed: 0,
    tiles: [tile(0, 0, 0, 0, 'dots-1'), tile(1, 4, 0, 0, 'dots-1')],
    solution: [[0, 1]],
  });
  game.tap(free(0), 0);
  game.useHolder(1);
  game.tap(free(1), 2);
  game.useHolder(3);
  assert.deepEqual(game.holderSlots(), [0, 1, null, null]);
  assert.equal(game.tilesLeft, 2);
  assert.equal(game.status(), 'playing', 'an empty board is not a cleared level');
  game.tapHeld(0, 4);
  game.tapHeld(1, 5);
  assert.equal(game.tilesLeft, 0);
  assert.equal(game.status(), 'won');
});

test('a board with no pair is not stuck while a hold would expose one', () => {
  const game = new Game(HOLD_TO_MOVE);
  assert.equal(game.hint(), null, 'no pair is playable right now');
  assert.equal(game.status(), 'playing', 'but the holder is a way through');
  game.tap(free(1), 0);
  game.useHolder(1);
  assert.notEqual(game.hint(), null);
  assert.equal(game.status(), 'playing');
});

test('hint sees a holder pair rather than reporting no moves', () => {
  const game = new Game(COVERED);
  game.tap(free(1), 0);
  game.useHolder(1);
  game.tap(free(0), 2);
  game.tap(free(2), 3); // clears the board pair, leaving 1 (held) + 3
  assert.equal(game.tilesLeft, 2);
  const pair = game.hint();
  assert.notEqual(pair, null);
  assert.deepEqual([...pair!].sort(), [1, 3]);
  assert.equal(game.status(), 'playing');
});

// --- undo ---------------------------------------------------------------------

test('undo takes back a hold, a return and a holder match', () => {
  const game = new Game(COVERED);
  game.tap(free(1), 0);
  const start = game.stateHash();

  game.useHolder(1);
  assert.equal(game.undo()?.kind, 'hold');
  assert.deepEqual(game.holderSlots(), [null, null, null, null]);
  assert.equal(game.stateHash(), start);

  game.useHolder(2);
  const parked = game.stateHash();
  game.tapHeld(1, 3);
  game.useHolder(4); // return it
  assert.equal(game.undo()?.kind, 'unhold');
  assert.deepEqual(game.holderSlots(), [1, null, null, null]);

  game.tap({ kind: 'miss' }, 5); // start the pair from a clean selection
  game.tapHeld(1, 6);
  game.tap(free(3), 7);
  assert.equal(game.undo()?.kind, 'match');
  assert.deepEqual(game.holderSlots(), [1, null, null, null]);
  assert.equal(game.tilesLeft, 4);
  // Back to where the tile was first parked. The selection is part of the hash
  // and undo restores the one each move was made from, so clear it to compare
  // against a state captured with nothing selected.
  while (game.undoDepth > 1) game.undo();
  game.tap({ kind: 'miss' }, 8);
  assert.equal(game.stateHash(), parked);
});

test('the shuffle booster leaves the holder alone', () => {
  const game = newGame(3);
  const firstFree = game.board.freeTileIds()[0]!;
  game.tap(free(firstFree), 0);
  game.useHolder(1);
  const heldFace = game.board.get(firstFree).face;
  assert.equal(game.shuffle(4242), true);
  assert.deepEqual(game.holderSlots(), [firstFree, null, null, null]);
  assert.equal(game.board.get(firstFree).face, heldFace, 'a parked tile keeps its face');
});
