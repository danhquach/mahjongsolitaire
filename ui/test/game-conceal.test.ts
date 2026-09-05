// Face-down tiles on the game controller (issue #64, decision 0010; gesture
// reworked by issue #93): first tap reveals in place, second tap sends the
// tile to the holder, holder reveal, undo, shuffle, resume.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assessDifficulty } from '@mahjongsolitaire/core';
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

test('a four-tile deal conceals nothing by default at any bucket ratio', () => {
  // The bucket fallback in the Game constructor is not what the ladder uses
  // (main.ts and save.ts pass the band's concealed set). Under the pair-density
  // score (issue #212) this tiny deal reads as tight — bucket 'hard' — and
  // floor(4 × 0.15) is still 0, so no tile is dealt face-down either way.
  const game = new Game(ROW);
  assert.equal(assessDifficulty(ROW).bucket, 'hard');
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

test('peeking a second concealed tile re-conceals the first: one peek at a time', () => {
  // Issue #124 briefly made this a failed match attempt; issue #165 restores
  // the decision 0010 reading — a fresh, independent peek that swaps.
  const game = new Game(ROW, undefined, [0, 1]);
  game.tap(free(0), 1); // peek dots-1
  const outcome = game.tap(free(1), 2); // bamboo-2: a second peek
  assert.deepEqual(outcome, { kind: 'peeked', id: 1 });
  assert.equal(game.isFaceHidden(0), true, 'the first peek re-conceals');
  assert.equal(game.isFaceHidden(1), false);
  assert.equal(game.peeked, 1);
  assert.equal(game.tilesLeft, 4, 'not a move: nothing changed on the board');
});

test('the reveal tap never matches with an empty holder — the first tile alone (issue #93)', () => {
  const game = new Game(ROW, undefined, [0]);
  const outcome = game.tap(free(0), 1); // peek dots-1, nothing else
  assert.deepEqual(outcome, { kind: 'peeked', id: 0 });
  assert.equal(game.tilesLeft, 4, 'nothing matched on the reveal');
});

test('peeking, then tapping a second concealed tile with a DIFFERENT face peeks it — no board match (issue #165)', () => {
  // Decision 0018's board-side pair is gone: a non-matching second tile is
  // just the new peek.
  const game = new Game(ROW, undefined, [0, 1]);
  game.tap(free(0), 1); // peek dots-1
  const outcome = game.tap(free(1), 2); // bamboo-2: does not match the peek
  assert.deepEqual(outcome, { kind: 'peeked', id: 1 });
  assert.equal(game.tilesLeft, 4);
  assert.equal(game.isFaceHidden(0), true);
});

test('peeking, then tapping a second concealed tile with the SAME face clears both (issue #169, amending decision 0025)', () => {
  // The narrow amendment: a tap matching the current peek clears through the
  // holder, even blind (both tiles are still concealed here) — the flight
  // shows both flips landing in the strip, not a board-side vanish (decision
  // 0018 stays retired; decision 0013 still resolves pairs in the holder).
  const game = new Game(ROW, undefined, [0, 2]);
  game.tap(free(0), 1); // peek dots-1
  const outcome = game.tap(free(2), 2);
  assert.equal(outcome.kind, 'matched');
  assert.equal((outcome as { a: number }).a, 0);
  assert.equal((outcome as { b: number }).b, 2);
  assert.equal((outcome as { revealed?: boolean }).revealed, true, 'b was never shown on the board');
  assert.equal(game.tilesLeft, 2);
  assert.equal(game.peeked, null);
});

test('the holder IS consulted for a hidden tile (issue #165, amending decision 0010)', () => {
  const game = new Game(ROW, undefined, [2]);
  game.tap(free(0), 1); // dots-1 to the holder
  const outcome = game.tap(free(2), 3); // concealed dots-1: clears on this tap, no peek
  assert.equal(outcome.kind, 'matched');
  assert.equal(game.tilesLeft, 2);
  assert.equal(game.peeked, null);
});

test('a parked concealed tile shows its face in the holder', () => {
  const game = new Game(ROW, undefined, [0]);
  game.tap(free(0), 1); // peek
  const outcome = game.tap(free(0), 2); // send to the holder
  assert.equal(outcome.kind, 'held');
  assert.equal(game.isFaceHidden(0), false);
  assert.equal(game.peeked, null);
});

test('a returned concealed tile comes back face-down (issue #100)', () => {
  const game = new Game(ROW, undefined, [0, 1]);
  game.tap(free(0), 1); // reveal
  game.tap(free(0), 2); // to the holder (face-up there)
  game.tap(free(1), 3); // peek an unrelated concealed tile (bamboo-2)
  assert.equal(game.undo()?.kind, 'hold');
  // Tile 0 comes back to the board face-down (the concealed set is fixed);
  // tile 1's peek is untouched by the undo (issue #165, reference behaviour).
  assert.equal(game.board.isHeld(0), false);
  assert.equal(game.isFaceHidden(0), true);
  assert.equal(game.isFaceHidden(1), false);
  assert.equal(game.peeked, 1);
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
  assert.equal(game.tap(free(2), 3).kind, 'matched'); // its match is held: clears (issue #165)
  assert.equal(game.isFaceHidden(0), false);
  assert.equal(game.isFaceHidden(2), false);
});
