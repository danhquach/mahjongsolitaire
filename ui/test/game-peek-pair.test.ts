// Peek-pairs (issue #124, amending decision 0013 point 4): while a peek is
// showing, a tap on any other free tile matches directly against it on the
// board — no trip through the holder — or fails the attempt on a mismatch.

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
  layoutId: 'peek-pair-fixture',
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

// AC 1: peek a face-down tile, tap its face-up partner — both clear, scored,
// no holder slot used.
test('AC1: peek, then tap the face-up partner clears both with no holder slot used', () => {
  const game = new Game(ROW, undefined, [0]); // only 0 is concealed; 2 is face-up
  game.tap(free(0), 1); // peek dots-1
  const before = game.score;
  const outcome = game.tap(free(2), 2); // face-up dots-1 partner
  assert.equal(outcome.kind, 'matched');
  assert.equal((outcome as { a: number }).a, 0);
  assert.equal((outcome as { b: number }).b, 2);
  assert.ok(game.score > before, 'score awarded');
  assert.deepEqual(game.holderSlots(), [null, null, null, null]);
  assert.equal(game.tilesLeft, 2);
});

// AC 2: peek, then tap a second face-down tile with the same face — clears on
// that tap (restores the #77 shortcut).
test('AC2: peek, then tap a second face-down tile with the same face clears both', () => {
  const game = new Game(ROW, undefined, [0, 2]); // both dots-1 concealed
  game.tap(free(0), 1); // peek
  const outcome = game.tap(free(2), 2); // still hidden, same face
  assert.equal(outcome.kind, 'matched');
  assert.equal(game.tilesLeft, 2);
  assert.deepEqual(game.holderSlots(), [null, null, null, null]);
});

// AC 3: peek, then tap a non-matching tile — a failed attempt, nothing moves.
test('AC3: peek, then tap a non-matching tile fails the attempt and changes nothing else', () => {
  const game = new Game(ROW, undefined, [0, 1]);
  game.tap(free(0), 1); // peek dots-1
  const scoreBefore = game.score;
  const undoDepthBefore = game.undoDepth;
  const outcome = game.tap(free(1), 2); // bamboo-2: mismatch
  assert.deepEqual(outcome, { kind: 'peek-mismatch', peeked: 0, id: 1 });
  assert.equal(game.peeked, null, 'the peek flips back face down');
  assert.equal(game.isFaceHidden(0), true);
  assert.equal(game.isFaceHidden(1), true, 'the tapped concealed tile is not revealed');
  assert.deepEqual(game.holderSlots(), [null, null, null, null], 'nothing parked');
  assert.equal(game.score, scoreBefore, 'no score change');
  assert.equal(game.undoDepth, undoDepthBefore, 'holder/undo stack unchanged');
  assert.equal(game.tilesLeft, 4, 'not a move');
});

// AC 4: Undo after a peek-pair does not reverse it — Undo only returns the
// newest parked tile from the holder. Peeks are never on the undo stack.
test('AC4: undo after a peek-pair does not reverse it', () => {
  const game = new Game(ROW, undefined, [0, 2]);
  game.tap(free(0), 1); // peek
  game.tap(free(2), 2); // clears immediately (AC2)
  assert.equal(game.tilesLeft, 2);
  assert.equal(game.undoDepth, 0, 'nothing in the holder to undo');
  assert.equal(game.undo(), null, 'undo has nothing to return — the match is permanent');
  assert.equal(game.tilesLeft, 2, 'still cleared');
});

// AC 5: holder-full loss cannot be triggered by a peek-pair tap — even with
// only one holder vacancy left, the peek-pair still clears on the board
// rather than taking the last slot.
test('AC5: a peek-pair with one holder vacancy left does not lose the level', () => {
  const WITH_FILLERS: GeneratedLevel = {
    layoutId: 'peek-pair-holder-fixture',
    seed: 0,
    tiles: [
      ...ROW.tiles,
      tile(4, 16, 0, 0, 'char-9'),
      tile(5, 20, 0, 0, 'char-8'),
      tile(6, 24, 0, 0, 'char-7'),
    ],
    solution: ROW.solution,
  };
  const game = new Game(WITH_FILLERS, undefined, [0, 2]);
  game.tap(free(4), 1); // park filler #1 (slot 0)
  game.tap(free(5), 2); // park filler #2 (slot 1)
  game.tap(free(6), 3); // park filler #3 (slot 2) — one vacancy left
  assert.equal(game.holderVacancies, 1);
  game.tap(free(0), 4); // peek dots-1
  const outcome = game.tap(free(2), 5); // matches — must clear, not fill the last slot
  assert.equal(outcome.kind, 'matched');
  assert.deepEqual(
    game.holderSlots().filter((s) => s !== null).length,
    3,
    'the holder is untouched by the peek-pair',
  );
  assert.notEqual(game.status(), 'lost');
});

// Mismatch on a face-down tile does not reveal it (restated for emphasis).
test('a mismatch on a face-down tile does not reveal it', () => {
  const game = new Game(ROW, undefined, [0, 1]);
  game.tap(free(0), 1); // peek dots-1
  game.tap(free(1), 2); // mismatch against concealed bamboo-2
  assert.equal(game.isFaceHidden(1), true);
});

// stateHash: a peek-pair is a move (hashes differ); a mismatch is not.
test('stateHash changes after a peek-pair match but not after a mismatch', () => {
  const matchGame = new Game(ROW, undefined, [0, 2]);
  const beforeMatch = matchGame.stateHash();
  matchGame.tap(free(0), 1);
  matchGame.tap(free(2), 2);
  assert.notEqual(matchGame.stateHash(), beforeMatch);

  const mismatchGame = new Game(ROW, undefined, [0, 1]);
  mismatchGame.tap(free(0), 1);
  const beforeMismatch = mismatchGame.stateHash();
  mismatchGame.tap(free(1), 2);
  assert.equal(mismatchGame.stateHash(), beforeMismatch);
});

// undoDepth is unaffected by a peek-pair (it was never a hold).
test('undoDepth is unchanged by a peek-pair', () => {
  const game = new Game(ROW, undefined, [0, 2]);
  assert.equal(game.undoDepth, 0);
  game.tap(free(0), 1);
  game.tap(free(2), 2);
  assert.equal(game.undoDepth, 0);
});

// pairsWithPeek: the a11y query the label logic reads.
test('pairsWithPeek reports the matching board tile and excludes the peeked tile itself', () => {
  const game = new Game(ROW, undefined, [0, 2]);
  assert.equal(game.pairsWithPeek(2), false, 'no peek showing yet');
  game.tap(free(0), 1); // peek dots-1
  assert.equal(game.pairsWithPeek(2), true, 'dots-1 matches the peek');
  assert.equal(game.pairsWithPeek(1), false, 'bamboo-2 does not match');
  assert.equal(game.pairsWithPeek(0), false, 'the peeked tile itself is excluded');
});
