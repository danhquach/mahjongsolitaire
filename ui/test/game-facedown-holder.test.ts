// Face-down tiles follow the reference game (issue #165, decision 0025,
// superseding decision 0018): the holder IS consulted for a hidden face — a
// remembered face-down tile whose match is already held clears in one tap —
// a peek is passive (other taps are ordinary moves that drop it), and Undo
// leaves the peek alone.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GeneratedLevel, TileId } from '@mahjongsolitaire/core';
import { Game } from '../src/game.js';
import type { Hit } from '../src/hit-test.js';

const free = (id: TileId): Hit => ({ kind: 'free', id, forgiven: false });

const tile = (id: number, x: number, y: number, z: number, face: string) => ({
  id,
  slot: { x, y, z },
  face,
  removed: false,
});

/** Four free tiles in a row: two dots-1 (0, 2), two bamboo-2 (1, 3). */
const ROW: GeneratedLevel = {
  layoutId: 'facedown-holder-fixture',
  seed: 0,
  tiles: [
    tile(0, 0, 0, 0, 'dots-1'),
    tile(1, 4, 0, 0, 'bamboo-2'),
    tile(2, 8, 0, 0, 'dots-1'),
    tile(3, 12, 0, 0, 'bamboo-2'),
  ],
  solution: [
    [0, 2],
    [1, 3],
  ],
};

// AC 1: face-down tile with its match already held — one tap clears the pair
// through the holder, scored, no slot occupied, one move on the undo stack
// (the same as a visible tile's pair clear).
test('AC1: a face-down tile whose match is held clears on its first tap', () => {
  const game = new Game(ROW, undefined, [2]);
  game.tap(free(0), 1); // dots-1 parks
  assert.equal(game.undoDepth, 1);
  const before = game.score;
  const outcome = game.tap(free(2), 2); // concealed dots-1: clears, no peek
  assert.equal(outcome.kind, 'matched');
  assert.equal((outcome as { a: number }).a, 0);
  assert.equal((outcome as { b: number }).b, 2);
  assert.equal((outcome as { revealed?: boolean }).revealed, true, 'the tap flipped a hidden face');
  assert.ok(game.score > before, 'score awarded');
  assert.equal(game.tilesLeft, 2);
  assert.deepEqual(game.holderSlots(), [null, null, null, null]);
  assert.equal(game.peeked, null, 'no peek was taken');
});

test('a visible tile clearing against the holder does not report a reveal', () => {
  const game = new Game(ROW, undefined, []);
  game.tap(free(0), 1);
  const outcome = game.tap(free(2), 2);
  assert.equal(outcome.kind, 'matched');
  assert.equal((outcome as { revealed?: boolean }).revealed, undefined);
});

// AC 2: face-down tile with no match held — one tap peeks; nothing moves.
test('AC2: a face-down tile with no match held peeks and nothing else', () => {
  const game = new Game(ROW, undefined, [2]);
  game.tap(free(1), 1); // bamboo-2 parks — not a dots-1
  const depth = game.undoDepth;
  const outcome = game.tap(free(2), 2);
  assert.deepEqual(outcome, { kind: 'peeked', id: 2 });
  assert.equal(game.peeked, 2);
  assert.equal(game.undoDepth, depth);
  assert.equal(game.tilesLeft, 4);
});

// AC 3: peek showing, tap a different free tile — an ordinary move, exactly
// as if no peek were showing; the peek flips back.
test('AC3: with a peek showing, tapping a different tile parks it and drops the peek', () => {
  const game = new Game(ROW, undefined, [0]);
  game.tap(free(0), 1); // peek dots-1
  const outcome = game.tap(free(1), 2); // bamboo-2: parks like any tile
  assert.deepEqual(outcome, { kind: 'held', id: 1, slot: 0 });
  assert.equal(game.peeked, null, 'the peek flips back');
  assert.equal(game.isFaceHidden(0), true);
  assert.equal(game.undoDepth, 1, 'a real move');
});

test('AC3: with a peek showing, tapping a tile that matches the holder clears against the holder', () => {
  const game = new Game(ROW, undefined, [0]);
  game.tap(free(1), 1); // bamboo-2 parks
  game.tap(free(0), 2); // peek dots-1
  const outcome = game.tap(free(3), 3); // bamboo-2 partner: clears in the holder
  assert.equal(outcome.kind, 'matched');
  assert.equal(game.peeked, null);
  assert.equal(game.isFaceHidden(0), true);
});

test('with a peek showing, a same-face tile is NOT matched against the peek on the board', () => {
  // Decision 0018's board-matching mode is retired: the tapped partner parks.
  const game = new Game(ROW, undefined, [0]);
  game.tap(free(0), 1); // peek dots-1
  const outcome = game.tap(free(2), 2); // the other dots-1, face-up
  assert.deepEqual(outcome, { kind: 'held', id: 2, slot: 0 });
  assert.equal(game.tilesLeft, 4);
  assert.equal(game.peeked, null);
  // …and the peeked tile, now hidden again, clears against it on the next tap
  // (AC1), from memory.
  assert.equal(game.isFaceHidden(0), true);
  assert.equal(game.tap(free(0), 3).kind, 'matched');
  assert.equal(game.tilesLeft, 2);
});

// AC 4: peek showing, tap a second face-down tile — it peeks (or clears per
// AC1); the first flips back in the same frame.
test('AC4: peeking a second face-down tile swaps the peek', () => {
  const game = new Game(ROW, undefined, [0, 1]);
  game.tap(free(0), 1);
  const outcome = game.tap(free(1), 2);
  assert.deepEqual(outcome, { kind: 'peeked', id: 1 });
  assert.equal(game.isFaceHidden(0), true);
  assert.equal(game.isFaceHidden(1), false);
});

test('AC4: peeking, then tapping a second face-down tile whose match is held clears it', () => {
  const game = new Game(ROW, undefined, [0, 3]);
  game.tap(free(1), 1); // bamboo-2 parks
  game.tap(free(0), 2); // peek dots-1
  const outcome = game.tap(free(3), 3); // concealed bamboo-2: clears
  assert.equal(outcome.kind, 'matched');
  assert.equal(game.peeked, null);
  assert.equal(game.tilesLeft, 2);
});

// AC 5: peek showing, Undo returns a parked tile — the peek is still showing.
test('AC5: undo leaves the peek showing', () => {
  const game = new Game(ROW, undefined, [0]);
  game.tap(free(1), 1); // bamboo-2 parks
  game.tap(free(0), 2); // peek dots-1
  assert.equal(game.undo()?.kind, 'hold');
  assert.equal(game.peeked, 0);
  assert.equal(game.isFaceHidden(0), false);
  assert.equal(game.board.isHeld(1), false);
});

// AC 6: the peeked tile leaves the board — peek cleared, still concealed, and
// an undo brings it back face down.
test('AC6: the peeked tile parked then undone comes back face-down with no peek', () => {
  const game = new Game(ROW, undefined, [0]);
  game.tap(free(0), 1); // peek
  game.tap(free(0), 2); // its own second tap: to the holder
  assert.equal(game.peeked, null);
  assert.equal(game.isFaceHidden(0), false, 'face shown in the holder');
  assert.equal(game.undo()?.kind, 'hold');
  assert.equal(game.isFaceHidden(0), true);
  assert.equal(game.peeked, null);
});

test('AC6: shuffle still drops the peek', () => {
  const game = new Game(ROW, undefined, [0]);
  game.tap(free(0), 1);
  assert.equal(game.shuffle(7), true);
  assert.equal(game.peeked, null);
  assert.equal(game.isFaceHidden(0), true);
});

// Holder-full loss: a face-down tile clearing against the holder never takes
// a slot, so it cannot fill the fatal fourth one.
test('a face-down clear with one vacancy left does not lose the level', () => {
  const WITH_FILLERS: GeneratedLevel = {
    layoutId: 'facedown-holder-fill-fixture',
    seed: 0,
    tiles: [...ROW.tiles, tile(4, 16, 0, 0, 'char-9'), tile(5, 20, 0, 0, 'char-8')],
    solution: ROW.solution,
  };
  const game = new Game(WITH_FILLERS, undefined, [2]);
  game.tap(free(4), 1);
  game.tap(free(5), 2);
  game.tap(free(0), 3); // dots-1 fills slot 2 — one vacancy left
  assert.equal(game.holderVacancies, 1);
  const outcome = game.tap(free(2), 4); // concealed dots-1
  assert.equal(outcome.kind, 'matched');
  assert.equal(game.holderVacancies, 2);
  assert.notEqual(game.status(), 'lost');
});

// AC 8 support: the a11y query must not leak a hidden face — a face-down tile
// whose match is held still reads as "peek".
test('pairsWithHeld stays false for a hidden face even when its match is held', () => {
  const game = new Game(ROW, undefined, [2]);
  game.tap(free(0), 1);
  assert.equal(game.pairsWithHeld(2), false);
  assert.equal(game.pairsWithHeld(3), false);
  game.tap(free(1), 2); // bamboo-2 parks
  assert.equal(game.pairsWithHeld(3), true, 'a visible match still announces the clear');
});
