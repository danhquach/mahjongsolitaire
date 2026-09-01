// Face-down tiles on the game controller (issue #64, decision 0010): peek,
// selection pinning, mismatch re-conceal, holder reveal, undo, shuffle, resume.

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

test('tap on a hidden free tile peeks: face shown, nothing selected', () => {
  const game = new Game(ROW, undefined, [0, 2]);
  assert.equal(game.isFaceHidden(0), true);
  const outcome = game.tap(free(0), 1);
  assert.deepEqual(outcome, { kind: 'peeked', id: 0 });
  assert.equal(game.selection, null);
  assert.equal(game.peeked, 0);
  assert.equal(game.isFaceHidden(0), false);
});

test('peeking a second tile re-conceals the first (one at a time)', () => {
  const game = new Game(ROW, undefined, [0, 2]);
  game.tap(free(0), 1);
  const outcome = game.tap(free(2), 2);
  assert.deepEqual(outcome, { kind: 'peeked', id: 2 });
  assert.equal(game.isFaceHidden(0), true);
  assert.equal(game.isFaceHidden(2), false);
});

test('selecting a peeked tile pins the reveal, so a concealed pair can match', () => {
  const game = new Game(ROW, undefined, [0, 2]);
  game.tap(free(0), 1); // peek
  const selected = game.tap(free(0), 2); // second tap: ordinary select
  assert.equal(selected.kind, 'selected');
  game.tap(free(2), 3); // peek the partner — the pinned tile stays up
  assert.equal(game.isFaceHidden(0), false);
  const matched = game.tap(free(2), 4);
  assert.equal(matched.kind, 'matched');
  assert.equal(game.tilesLeft, 2);
});

test('a mismatch involving a concealed tile re-conceals and drops the selection', () => {
  const game = new Game(ROW, undefined, [0, 1]);
  game.tap(free(0), 1); // peek dots-1
  game.tap(free(0), 2); // select it (pinned)
  game.tap(free(1), 3); // peek bamboo-2
  const outcome = game.tap(free(1), 4); // mismatch against the pinned dots-1
  assert.equal(outcome.kind, 'mismatch');
  assert.equal(game.selection, null);
  assert.equal(game.peeked, null);
  assert.equal(game.isFaceHidden(0), true);
  assert.equal(game.isFaceHidden(1), true);
});

test('a mismatch against a parked concealed tile follows the ordinary rule', () => {
  // Tile 0 (concealed dots-1) is parked — permanently face-up in the holder —
  // so a mismatch against it has nothing to re-conceal: selection moves on.
  const game = new Game(ROW, undefined, [0]);
  game.tap(free(0), 1); // peek
  game.tap(free(0), 2); // select
  game.tap(free(0), 3); // park
  game.tapHeld(0, 4); // select it in the holder
  const outcome = game.tap(free(1), 5); // bamboo-2: mismatch
  assert.equal(outcome.kind, 'mismatch');
  assert.equal(game.selection, 1);
  assert.equal(game.isFaceHidden(0), false);
});

test('a mismatch between two face-up tiles still moves the selection', () => {
  const game = new Game(ROW, undefined, [0]);
  game.tap(free(1), 1); // select bamboo-2 (face-up)
  const outcome = game.tap(free(2), 2); // dots-1, face-up: ordinary mismatch
  assert.equal(outcome.kind, 'mismatch');
  assert.equal(game.selection, 2);
});

test('a hidden tile never answers the holder auto-clear on the peek tap', () => {
  // Park bamboo-2 (1), then tap its hidden partner (3): first tap must peek,
  // not clear the pair; the second tap clears it.
  const game = new Game(ROW, undefined, [3]);
  game.tap(free(1), 1);
  game.tap(free(1), 2); // park
  assert.equal(game.holderSlots()[0], 1);
  const first = game.tap(free(3), 3);
  assert.deepEqual(first, { kind: 'peeked', id: 3 });
  assert.equal(game.holderSlots()[0], 1);
  const second = game.tap(free(3), 4);
  assert.equal(second.kind, 'matched');
});

test('a parked concealed tile shows its face in the holder', () => {
  const game = new Game(ROW, undefined, [0]);
  game.tap(free(0), 1); // peek
  game.tap(free(0), 2); // select
  const outcome = game.tap(free(0), 3); // park
  assert.equal(outcome.kind, 'held');
  assert.equal(game.isFaceHidden(0), false);
  assert.equal(game.peeked, null);
});

test('undoing a match brings concealed tiles back face-down', () => {
  const game = new Game(ROW, undefined, [0, 2]);
  game.tap(free(0), 1);
  game.tap(free(0), 2);
  game.tap(free(2), 3);
  game.tap(free(2), 4); // matched
  assert.equal(game.undo()?.kind, 'match');
  // Undo restores the pre-move selection (tile 0 was selected), and a selection
  // pins its reveal — so 0 comes back face-up-by-selection while 2, whose peek
  // does not survive the undo, comes back concealed.
  assert.equal(game.selection, 0);
  assert.equal(game.isFaceHidden(0), false);
  assert.equal(game.isFaceHidden(2), true);
  assert.equal(game.peeked, null);
  // Dropping the restored selection re-conceals tile 0 too.
  game.tap({ kind: 'miss' }, 5);
  assert.equal(game.isFaceHidden(0), true);
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
  game.tap(free(0), 1);
  game.tap(free(0), 2);
  game.tap(free(2), 3);
  game.tap(free(2), 4);
  assert.equal(game.isFaceHidden(0), false);
  assert.equal(game.isFaceHidden(2), false);
});
