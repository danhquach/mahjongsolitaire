// Holder behaviour on the game controller (issues #43, #63, #93): the one-tap
// send to the holder, pairs assembling and clearing in the holder, and the
// places the holder changes what the HUD is told — tiles left, the win check,
// the deadlock check, and — since decision 0009 — the loss.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HOLDER_SLOTS, SEED_LAYOUTS, generateLevel, legalPairs } from '@mahjongsolitaire/core';
import type { GeneratedLevel, TileId } from '@mahjongsolitaire/core';
import { Game } from '../src/game.js';
import type { GameSnapshot } from '../src/game.js';
import type { Hit } from '../src/hit-test.js';

const free = (id: TileId): Hit => ({ kind: 'free', id, forgiven: false });
const ROWS = SEED_LAYOUTS.find((l) => l.id === 'seed-rows')!;

function newGame(seed = 1): Game {
  return new Game(generateLevel(ROWS, seed));
}

/** Issue #93's park: one tap on a revealed free tile is the whole gesture. */
function park(game: Game, id: TileId, atMs: number) {
  return game.tap(free(id), atMs);
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

/**
 * Four free tiles that pair with nothing, plus a free pair that does. The pair
 * keeps the level `playing` however many singletons are parked, so filling the
 * holder is the *only* thing that can end it — which is what the loss tests
 * need to be measuring.
 */
const FILL_TO_LOSE: GeneratedLevel = {
  layoutId: 'full-holder-fixture',
  seed: 0,
  tiles: [
    ...Array.from({ length: HOLDER_SLOTS }, (_, i) => tile(i, i * 4, 0, 0, `dots-${i + 1}`)),
    tile(HOLDER_SLOTS, HOLDER_SLOTS * 4, 0, 0, 'bamboo-1'),
    tile(HOLDER_SLOTS + 1, (HOLDER_SLOTS + 1) * 4, 0, 0, 'bamboo-1'),
  ],
  solution: [[HOLDER_SLOTS, HOLDER_SLOTS + 1]],
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
 * this state — the second copy clears the pair instead of parking — but a save
 * written by an older build can, and the format did not change, so both the
 * strip and the pair clear still have to cope with it.
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

// --- the one-tap send (issue #93) ----------------------------------------------

test('one tap on a revealed free tile sends it to the holder', () => {
  const game = new Game(COVERED);

  assert.deepEqual(game.tap(free(1), 1), { kind: 'held', id: 1, slot: 0 });
  assert.deepEqual(game.holderSlots(), [1, null, null, null]);
  assert.equal(game.holdsUsed, 1);
  assert.equal(game.selection, null, 'no selection step exists any more');
  assert.equal(game.board.isFree(0), true, 'and what it covered is free');
});

test('a blocked tile is never parked', () => {
  const game = new Game(COVERED);
  assert.equal(game.tap({ kind: 'blocked', id: 0 }, 0).kind, 'blocked');
  assert.deepEqual(game.holderSlots(), [null, null, null, null]);
});

test('the park that fills the fourth slot loses the level (decision 0009)', () => {
  const game = new Game(FILL_TO_LOSE);
  for (let i = 0; i < HOLDER_SLOTS - 2; i++) {
    assert.equal(park(game, i, i * 4).kind, 'held', `slot ${i + 1}`);
    assert.equal(game.status(), 'playing', `slot ${i + 1} is survivable`);
  }
  // The third park leaves one vacancy: the board pair cannot transit any more
  // (issue #93, takeablePairs), so this is already a deadlock — the dialog
  // fires *before* the fatal park, which is the warning working as intended.
  assert.equal(park(game, HOLDER_SLOTS - 2, 50).kind, 'held');
  assert.equal(game.holderVacancies, 1, 'one slot left — the warning point');
  assert.equal(game.status(), 'stuck');

  // The fatal park reports itself as an ordinary hold; status is what changes.
  // (Unreachable through the gated input layer once the deadlock dialog is up,
  // but the controller is pure and the loss must outrank the deadlock.)
  assert.equal(park(game, HOLDER_SLOTS - 1, 100).kind, 'held');
  assert.equal(game.holderFull, true);
  assert.equal(game.holderVacancies, 0);
  assert.equal(game.status(), 'lost');
  assert.equal(game.tilesLeft, HOLDER_SLOTS + 2, 'the tiles are all still in play');
  assert.notEqual(legalPairs(game.board).length, 0, 'with a pair in plain sight — lost anyway');
  assert.equal(game.hint(), null, 'which the hint no longer dangles: no tap can play it');
});

test('the loss outranks everything a playable board would say', () => {
  // A pair sits free on the board the whole way through. Decision 0009 makes a
  // full holder final regardless, and the difference matters: 'stuck' offers
  // Shuffle and Undo, 'lost' offers neither.
  const game = new Game(FILL_TO_LOSE);
  for (let i = 0; i < HOLDER_SLOTS; i++) park(game, i, i * 4);
  assert.equal(game.status(), 'lost');
  assert.notEqual(legalPairs(game.board).length, 0, 'even with a pair in plain sight');
});

test('undo returns the last park even off a loss the dialog never offers it for', () => {
  const game = new Game(FILL_TO_LOSE);
  for (let i = 0; i < HOLDER_SLOTS - 1; i++) park(game, i, i * 4);
  const survivable = game.stateHash();
  park(game, HOLDER_SLOTS - 1, 100);
  assert.equal(game.status(), 'lost');

  // Undo can still return the losing park mechanically — the dialog just does
  // not offer it (main.ts inerts the rail behind the loss overlay), which is
  // what makes the loss final in play while the move stack stays honest. What
  // comes back is the position as it was: one vacancy, no takeable pair — a
  // deadlock, not a live board.
  assert.equal(game.undo()?.kind, 'hold');
  assert.equal(game.status(), 'stuck');
  assert.equal(game.stateHash(), survivable);
});

test('a park asked of an already-full holder changes nothing', () => {
  // Unreachable in play — the level is over by then — but the controller is
  // pure, so it answers rather than throwing.
  const game = new Game(FILL_TO_LOSE);
  for (let i = 0; i < HOLDER_SLOTS; i++) park(game, i, i * 4);
  const before = game.stateHash();
  assert.deepEqual(game.tap(free(HOLDER_SLOTS + 1), 201), {
    kind: 'holder-full',
    id: HOLDER_SLOTS + 1,
  });
  assert.equal(game.stateHash(), before, 'a refused park changes nothing at all');
  assert.equal(game.status(), 'lost');
});

// --- pairs assemble and clear in the holder (issue #93) ------------------------

test('one tap on a board tile clears it against its match in the holder', () => {
  const game = new Game(COVERED);
  park(game, 1, 0); // bamboo-2 into slot 1; tile 3 is its partner on the board

  const outcome = game.tap(free(3), 10);
  assert.equal(outcome.kind, 'matched');
  assert.ok(outcome.kind === 'matched' && outcome.a === 1 && outcome.b === 3, 'a is the held one');
  assert.deepEqual(game.holderSlots(), [null, null, null, null], 'the slot is freed');
  assert.equal(game.tilesLeft, 2);
  assert.equal(game.score, 100);
});

test('a matching tap never takes a slot, so it cannot lose the level in passing', () => {
  // Two unmatched dots plus one bamboo-1 parked — one slot left. Tapping the
  // second bamboo-1 completes a pair: it must clear in the holder, never pass
  // through the fatal fourth slot.
  const game = new Game(FILL_TO_LOSE);
  park(game, 0, 0);
  park(game, 1, 10);
  park(game, HOLDER_SLOTS, 20); // bamboo-1
  assert.equal(game.holderVacancies, 1);
  const outcome = game.tap(free(HOLDER_SLOTS + 1), 30);
  assert.equal(outcome.kind, 'matched');
  assert.notEqual(game.status(), 'lost', 'completing a pair with one slot left is safe');
  assert.equal(game.holderVacancies, 2, 'the pair freed its slot');
});

test('two copies of one face are unparkable together — the pair clears instead', () => {
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

test('a tap on empty board does nothing', () => {
  const game = new Game(COVERED);
  const before = game.stateHash();
  assert.deepEqual(game.tap({ kind: 'miss' }, 1), { kind: 'none' });
  assert.equal(game.stateHash(), before);
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

test('a park that would fill the holder is not a way out of a deadlock', () => {
  // The same board, reached with only one slot left: the park that exposes the
  // pair also ends the level, so this is a real deadlock and the dialog should
  // offer Shuffle rather than a move that loses (decision 0009).
  const game = new Game(HOLD_TO_MOVE);
  park(game, 3, 0); // char-5, pairs with nothing
  park(game, 4, 10); // char-6, likewise
  park(game, 5, 20); // wind-east, likewise
  assert.equal(game.holderVacancies, 1);
  assert.equal(game.hint(), null, 'still no pair anywhere');
  assert.equal(game.status(), 'stuck', 'and parking tile 1 would lose, not help');
});

test('hint sees a holder pair rather than reporting no moves', () => {
  const game = new Game(COVERED);
  park(game, 1, 0);
  game.tap(free(0), 10); // dots-1 to the holder…
  game.tap(free(2), 11); // …cleared by its partner, leaving 1 (held) + 3
  assert.equal(game.tilesLeft, 2);
  const pair = game.hint();
  assert.notEqual(pair, null);
  assert.deepEqual([...pair!].sort(), [1, 3]);
  assert.equal(game.status(), 'playing');
});

// --- undo ---------------------------------------------------------------------

test('undo takes back a park; a holder match is permanent (issue #100)', () => {
  const game = new Game(COVERED);
  const fresh = game.stateHash();

  game.tap(free(1), 1); // park it
  assert.equal(game.undo()?.kind, 'hold');
  assert.deepEqual(game.holderSlots(), [null, null, null, null]);
  assert.equal(game.stateHash(), fresh);

  game.tap(free(1), 2);
  game.tap(free(3), 3); // the pair clears in the holder
  assert.equal(game.tilesLeft, 2);
  assert.equal(game.undo(), null, 'matched out of the holder means gone');
  assert.equal(game.tilesLeft, 2);
  assert.deepEqual(game.holderSlots(), [null, null, null, null]);
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
