// Holder behaviour on the game controller (issues #43, #62): parking from the
// board, the one-tap clear against a held tile, tapping a held tile, and the
// places the holder changes what the HUD is told — tiles left, the win check,
// and the deadlock check.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HOLDER_SLOTS, SEED_LAYOUTS, generateLevel } from '@mahjongsolitaire/core';
import type { GeneratedLevel, TileId } from '@mahjongsolitaire/core';
import { Game } from '../src/game.js';
import type { GameSnapshot } from '../src/game.js';
import type { Hit } from '../src/hit-test.js';

const free = (id: TileId): Hit => ({ kind: 'free', id, forgiven: false });
const ROWS = SEED_LAYOUTS.find((l) => l.id === 'seed-rows')!;

function newGame(seed = 1): Game {
  return new Game(generateLevel(ROWS, seed));
}

/** Issue #62's park gesture: select the tile, then activate it again. Two
 *  ordinary taps, no timing window — that is the whole mechanism. */
function park(game: Game, id: TileId, atMs: number) {
  game.tap(free(id), atMs);
  return game.tap(free(id), atMs + 1);
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

/** Four free tiles that pair with nothing, plus a fifth — enough to fill the
 *  holder and then ask for one slot too many. */
const FIVE_SINGLETONS: GeneratedLevel = {
  layoutId: 'full-holder-fixture',
  seed: 0,
  tiles: Array.from({ length: HOLDER_SLOTS + 1 }, (_, i) => tile(i, i * 4, 0, 0, `dots-${i + 1}`)),
  solution: [],
};

/** Four identical free tiles in a row. */
const FOUR_DOTS: GeneratedLevel = {
  layoutId: 'four-dots-fixture',
  seed: 0,
  tiles: [0, 1, 2, 3].map((i) => tile(i, i * 4, 0, 0, 'dots-1')),
  solution: [
    [0, 1],
    [2, 3],
  ],
};

/**
 * A resumed game holding two tiles of the *same* face. Play can no longer reach
 * this state — rule 2 clears the pair instead of parking the second copy — but a
 * save written by the issue #43 build can, and the format did not change, so
 * both the strip and the one-tap clear still have to cope with it.
 */
function twoIdenticalParked(): Game {
  const snapshot: GameSnapshot = {
    faces: ['dots-1', 'dots-1', 'dots-1', 'dots-1'],
    removed: [],
    holder: [1, 2, null, null],
    stack: { moves: [], selection: null, scores: { score: 0, streak: 0, lastMatchMs: null } },
  };
  return new Game(FOUR_DOTS, snapshot);
}

// --- parking from the board (issue #62 rule 1) --------------------------------

test('activating the selected free tile again parks it', () => {
  const game = new Game(COVERED);

  assert.deepEqual(game.tap(free(1), 1), { kind: 'selected', id: 1 });
  assert.deepEqual(game.tap(free(1), 2), { kind: 'held', id: 1, slot: 0 });
  assert.deepEqual(game.holderSlots(), [1, null, null, null]);
  assert.equal(game.holdsUsed, 1);
  assert.equal(game.selection, null, 'the tile is off the board; the selection goes with it');
  assert.equal(game.board.isFree(0), true, 'and what it covered is free');
});

test('a blocked tile is never parked: it cannot even be selected', () => {
  const game = new Game(COVERED);
  assert.equal(game.tap({ kind: 'blocked', id: 0 }, 0).kind, 'blocked');
  assert.equal(game.tap({ kind: 'blocked', id: 0 }, 1).kind, 'blocked');
  assert.equal(game.selection, null);
  assert.deepEqual(game.holderSlots(), [null, null, null, null]);
});

test('a parked tile cannot be parked again — the second tap deselects it', () => {
  const game = new Game(COVERED);
  park(game, 1, 0);
  assert.deepEqual(game.tapHeld(1, 2), { kind: 'selected', id: 1 });
  assert.deepEqual(game.tapHeld(1, 3), { kind: 'deselected', id: 1 });
  assert.deepEqual(game.holderSlots(), [1, null, null, null], 'still exactly one slot used');
});

test('a full holder refuses the park and says so — the level goes on', () => {
  const game = new Game(FIVE_SINGLETONS);
  for (let i = 0; i < HOLDER_SLOTS; i++) {
    assert.equal(park(game, i, i * 4).kind, 'held', `slot ${i + 1}`);
  }
  assert.equal(game.holderFull, true);

  game.tap(free(HOLDER_SLOTS), 100);
  const before = game.stateHash();
  assert.deepEqual(game.tap(free(HOLDER_SLOTS), 101), { kind: 'holder-full', id: HOLDER_SLOTS });
  assert.equal(game.stateHash(), before, 'a refused park changes nothing at all');
  assert.equal(game.selection, HOLDER_SLOTS, 'and the tile stays selected, still playable');
  assert.equal(game.status(), 'stuck', 'it is a deadlock, not a loss');
  assert.equal(game.tilesLeft, HOLDER_SLOTS + 1);
});

// --- the one-tap clear against the holder (issue #62 rule 2) ------------------

test('one tap on a board tile clears it against a matching held tile', () => {
  const game = new Game(COVERED);
  park(game, 1, 0); // bamboo-2 into slot 1; tile 3 is its partner on the board

  const outcome = game.tap(free(3), 10);
  assert.equal(outcome.kind, 'matched');
  assert.deepEqual(game.holderSlots(), [null, null, null, null], 'the slot is freed');
  assert.equal(game.tilesLeft, 2);
  assert.equal(game.score, 100);
  assert.equal(game.selection, null);
});

test('the holder clear fires past a stale, non-matching selection', () => {
  const game = new Game(COVERED);
  park(game, 1, 0);
  game.tap(free(0), 10); // dots-1: matches neither the holder nor tile 3
  assert.equal(game.selection, 0);

  const outcome = game.tap(free(3), 11);
  assert.equal(outcome.kind, 'matched', 'not a mismatch against the stale selection');
  assert.equal(game.score, 100, 'so no mismatch broke the combo either');
  assert.deepEqual(game.holderSlots(), [null, null, null, null]);
});

test('rule 2 makes two copies of one face unparkable — the pair clears instead', () => {
  const game = new Game(FOUR_DOTS);
  park(game, 0, 0);
  assert.deepEqual(game.holderSlots(), [0, null, null, null]);
  // The first tap on the next dots-1 is already the whole move.
  assert.equal(game.tap(free(1), 10).kind, 'matched');
  assert.deepEqual(game.holderSlots(), [null, null, null, null]);
  assert.equal(game.tilesLeft, 2);
});

test('a resumed game with two identical tiles parked clears the first slot', () => {
  const game = twoIdenticalParked();
  assert.deepEqual(game.holderSlots(), [1, 2, null, null]);
  const outcome = game.tap(free(0), 10);
  assert.equal(outcome.kind, 'matched');
  assert.deepEqual(game.holderSlots(), [null, 2, null, null], 'slot 1 cleared, slot 2 kept');
});

// --- deselecting -------------------------------------------------------------

test('a tap on empty board is what deselects now', () => {
  const game = new Game(COVERED);
  game.tap(free(1), 0);
  assert.deepEqual(game.tap({ kind: 'miss' }, 1), { kind: 'selection-cleared' });
  assert.equal(game.selection, null);
  assert.deepEqual(game.holderSlots(), [null, null, null, null], 'and nothing was parked');
  assert.deepEqual(game.tap({ kind: 'miss' }, 2), { kind: 'none' }, 'nothing left to clear');
});

// --- tapping a held tile ------------------------------------------------------

test('a held tile selected from the strip matches a board tile', () => {
  const game = new Game(COVERED);
  park(game, 1, 0); // bamboo-2
  assert.deepEqual(game.tapHeld(1, 10), { kind: 'selected', id: 1 });
  const outcome = game.tap(free(3), 11);
  assert.equal(outcome.kind, 'matched');
  assert.deepEqual(game.holderSlots(), [null, null, null, null]);
  assert.equal(game.tilesLeft, 2);
  assert.equal(game.score, 100);
});

test('two held tiles can still be matched against each other', () => {
  const game = twoIdenticalParked();
  game.tapHeld(1, 10);
  assert.equal(game.tapHeld(2, 11).kind, 'matched');
  assert.deepEqual(game.holderSlots(), [null, null, null, null]);
  assert.equal(game.tilesLeft, 2);
});

test('a held tile mismatches like a board tile', () => {
  const game = new Game(COVERED);
  park(game, 1, 0); // bamboo-2
  game.tapHeld(1, 10);
  assert.equal(game.tap(free(0), 11).kind, 'mismatch', 'dots-1 against bamboo-2');
  assert.equal(game.selection, 0, 'the selection moves to the tile just tapped');
});

test('a tap on a tile that is not held is not a holder tap', () => {
  const game = new Game(COVERED);
  park(game, 1, 0);
  assert.deepEqual(game.tapHeld(2, 10), { kind: 'none' });
});

// --- what the HUD is told -----------------------------------------------------

test('an empty board with tiles still parked is not a win', () => {
  const game = new Game({
    layoutId: 'parked-singletons-fixture',
    seed: 0,
    tiles: [tile(0, 0, 0, 0, 'dots-1'), tile(1, 4, 0, 0, 'dots-2')],
    solution: [],
  });
  park(game, 0, 0);
  park(game, 1, 10);
  assert.deepEqual(game.holderSlots(), [0, 1, null, null]);
  assert.equal(game.board.presentTiles().length, 0, 'the board itself is empty');
  assert.equal(game.tilesLeft, 2);
  assert.notEqual(game.status(), 'won');
});

test('clearing the last pair out of the holder wins the level', () => {
  const game = twoIdenticalParked();
  game.tap(free(0), 0); // clears 0 against slot 1
  game.tap(free(3), 10); // clears 3 against slot 2
  assert.equal(game.tilesLeft, 0);
  assert.equal(game.status(), 'won');
});

test('a board with no pair is not stuck while a hold would expose one', () => {
  const game = new Game(HOLD_TO_MOVE);
  assert.equal(game.hint(), null, 'no pair is playable right now');
  assert.equal(game.status(), 'playing', 'but the holder is a way through');
  park(game, 1, 0);
  assert.notEqual(game.hint(), null);
  assert.equal(game.status(), 'playing');
});

test('hint sees a holder pair rather than reporting no moves', () => {
  const game = new Game(COVERED);
  park(game, 1, 0);
  game.tap(free(0), 10);
  game.tap(free(2), 11); // clears the board pair, leaving 1 (held) + 3
  assert.equal(game.tilesLeft, 2);
  const pair = game.hint();
  assert.notEqual(pair, null);
  assert.deepEqual([...pair!].sort(), [1, 3]);
  assert.equal(game.status(), 'playing');
});

// --- undo ---------------------------------------------------------------------

test('undo takes back a park and a holder match', () => {
  const game = new Game(COVERED);
  game.tap(free(1), 0);
  const selected = game.stateHash();

  game.tap(free(1), 1); // park it
  assert.equal(game.undo()?.kind, 'hold');
  assert.deepEqual(game.holderSlots(), [null, null, null, null]);
  assert.equal(game.stateHash(), selected, 'selection and all');

  game.tap(free(1), 2);
  const parked = game.stateHash();
  game.tap(free(3), 3); // one-tap clear against the holder
  assert.equal(game.tilesLeft, 2);
  assert.equal(game.undo()?.kind, 'match');
  assert.deepEqual(game.holderSlots(), [1, null, null, null], 'back into its own slot');
  assert.equal(game.tilesLeft, 4);
  assert.equal(game.stateHash(), parked);
});

test('the shuffle booster leaves the holder alone', () => {
  const game = newGame(3);
  const firstFree = game.board.freeTileIds()[0]!;
  assert.equal(park(game, firstFree, 0).kind, 'held');
  const heldFace = game.board.get(firstFree).face;
  assert.equal(game.shuffle(4242), true);
  assert.deepEqual(game.holderSlots(), [firstFree, null, null, null]);
  assert.equal(game.board.get(firstFree).face, heldFace, 'a parked tile keeps its face');
});
