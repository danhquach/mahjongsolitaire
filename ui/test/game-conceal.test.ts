// Face-down tiles on the game controller (issue #64, decision 0010; gesture
// reworked by issue #93): first tap reveals in place, second tap sends the
// tile to the holder, holder reveal, undo, shuffle, resume.

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
  layoutId: 'conceal-fixture',
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

test('a small deal is easy, so nothing is concealed by default', () => {
  const game = new Game(ROW);
  for (const t of game.board.allTiles()) assert.equal(game.isFaceHidden(t.id), false);
});

test('tap on a hidden free tile peeks: face shown, nothing moves', () => {
  const game = new Game(ROW, undefined, [0, 2]);
  assert.equal(game.isFaceHidden(0), true);
  const outcome = game.tap(free(0), 1);
  assert.deepEqual(outcome, { kind: 'peeked', id: 0 });
  assert.equal(game.peeked, 0);
  assert.equal(game.isFaceHidden(0), false);
  assert.deepEqual(game.holderSlots(), [null, null, null, null], 'the reveal moved nothing');
});

test('the second tap sends the revealed tile to the holder (issue #93)', () => {
  const game = new Game(ROW, undefined, [0]);
  game.tap(free(0), 1); // reveal
  const outcome = game.tap(free(0), 2); // send
  assert.deepEqual(outcome, { kind: 'held', id: 0, slot: 0 });
  assert.equal(game.peeked, null, 'the board changed, so the peek is spent');
});

test('peeking a second tile re-conceals the first (one at a time)', () => {
  const game = new Game(ROW, undefined, [0, 1]);
  game.tap(free(0), 1);
  const outcome = game.tap(free(1), 2);
  assert.deepEqual(outcome, { kind: 'peeked', id: 1 });
  assert.equal(game.isFaceHidden(0), true);
  assert.equal(game.isFaceHidden(1), false);
});

test('the reveal tap never matches — even when the face pairs with a peek (issue #93)', () => {
  // Under issue #77 a fresh peek that turned up the peeked tile's partner
  // matched in that same tap. Issue #93 retires that: the first tap on a
  // concealed tile is the reveal and only the reveal.
  const game = new Game(ROW, undefined, [0, 2]);
  game.tap(free(0), 1); // peek dots-1
  const outcome = game.tap(free(2), 2); // concealed partner: still just a peek
  assert.deepEqual(outcome, { kind: 'peeked', id: 2 });
  assert.equal(game.tilesLeft, 4, 'nothing matched on the reveal');
  assert.equal(game.isFaceHidden(0), true, 'the earlier peek dropped — one at a time');
  // The second tap on the revealed tile plays it into the holder…
  assert.equal(game.tap(free(2), 3).kind, 'held');
  // …and its partner (hidden again) needs its own reveal before it can follow.
  game.tap(free(0), 4);
  assert.equal(game.tap(free(0), 5).kind, 'matched');
  assert.equal(game.tilesLeft, 2);
});

test('the holder is never consulted for a hidden tile (decision 0010)', () => {
  const game = new Game(ROW, undefined, [2]);
  game.tap(free(0), 1); // dots-1 to the holder
  const outcome = game.tap(free(2), 3); // concealed dots-1: must peek, not auto-clear
  assert.deepEqual(outcome, { kind: 'peeked', id: 2 });
  assert.equal(game.tilesLeft, 4);
  // The second tap is the move, and it clears the pair in the holder.
  assert.equal(game.tap(free(2), 4).kind, 'matched');
  assert.equal(game.tilesLeft, 2);
});

test('a parked concealed tile shows its face in the holder', () => {
  const game = new Game(ROW, undefined, [0]);
  game.tap(free(0), 1); // peek
  const outcome = game.tap(free(0), 2); // send to the holder
  assert.equal(outcome.kind, 'held');
  assert.equal(game.isFaceHidden(0), false);
  assert.equal(game.peeked, null);
});

test('undoing a match brings concealed tiles back face-down', () => {
  const game = new Game(ROW, undefined, [0, 2]);
  game.tap(free(0), 1); // reveal
  game.tap(free(0), 2); // to the holder (face-up there)
  game.tap(free(2), 3); // reveal the partner
  game.tap(free(2), 4); // matched in the holder
  assert.equal(game.undo()?.kind, 'match');
  // Tile 0 comes back *held* (the match took it from the holder), so it stays
  // face-up on the player's shelf; tile 2 comes back to the board, and its
  // peek does not survive the undo — face-down again.
  assert.equal(game.board.isHeld(0), true);
  assert.equal(game.isFaceHidden(0), false);
  assert.equal(game.isFaceHidden(2), true);
  assert.equal(game.peeked, null);
});

test('shuffle drops the peek and keeps the tile hidden', () => {
  const game = new Game(ROW, undefined, [0]);
  game.tap(free(0), 1); // peek
  assert.equal(game.shuffle(7), true);
  assert.equal(game.peeked, null);
  assert.equal(game.isFaceHidden(0), true);
});

test('resume re-derives concealment: the injected set never persists', () => {
  // The snapshot stores nothing about concealment, so a resumed game falls back
  // to the derived set — for this easy deal, nothing hidden. What matters is
  // the safe direction: a reload cannot reveal what the derivation conceals.
  const game = new Game(ROW, undefined, [0, 2]);
  const resumed = new Game(ROW, game.snapshot());
  assert.equal(resumed.isFaceHidden(0), false);
  assert.deepEqual(new Game(ROW).snapshot(), new Game(ROW).snapshot());
});

test('a removed concealed tile is not reported hidden', () => {
  const game = new Game(ROW, undefined, [0, 2]);
  game.tap(free(0), 1); // reveal
  game.tap(free(0), 2); // to the holder
  game.tap(free(2), 3); // reveal
  game.tap(free(2), 4); // matched
  assert.equal(game.isFaceHidden(0), false);
  assert.equal(game.isFaceHidden(2), false);
});
