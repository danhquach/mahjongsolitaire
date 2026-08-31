// Tap semantics on the core engine (issue #11): select / deselect / match /
// mismatch / blocked / miss, plus win and stuck detection.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COMBO_WINDOW_MS, SEED_LAYOUTS, generateLevel } from '@mahjongsolitaire/core';
import type { GeneratedLevel, TileId } from '@mahjongsolitaire/core';
import { Game } from '../src/game.js';
import type { Hit } from '../src/hit-test.js';

const free = (id: TileId): Hit => ({ kind: 'free', id, forgiven: false });
const blocked = (id: TileId): Hit => ({ kind: 'blocked', id });
const miss: Hit = { kind: 'miss' };

const ROWS = SEED_LAYOUTS.find((l) => l.id === 'seed-rows')!;

function newGame(seed = 1): Game {
  return new Game(generateLevel(ROWS, seed));
}

test('select then deselect the same tile', () => {
  const game = newGame();
  const [a] = game.level.solution[0]!;
  assert.deepEqual(game.tap(free(a), 0), { kind: 'selected', id: a });
  assert.equal(game.selection, a);
  assert.deepEqual(game.tap(free(a), 1), { kind: 'deselected', id: a });
  assert.equal(game.selection, null);
});

test('matching pair removes both tiles and scores', () => {
  const game = newGame();
  const [a, b] = game.level.solution[0]!;
  game.tap(free(a), 0);
  const outcome = game.tap(free(b), 1);
  assert.equal(outcome.kind, 'matched');
  assert.equal(game.score, 100);
  assert.equal(game.tilesLeft, game.level.tiles.length - 2);
  assert.equal(game.selection, null);
  assert.equal(game.board.get(a).removed, true);
  assert.equal(game.board.get(b).removed, true);
});

test('mismatch moves the selection and breaks the combo, never deducts', () => {
  const game = newGame();
  const [[a1, b1], [a2]] = [game.level.solution[0]!, game.level.solution[1]!];
  game.tap(free(a1), 0);
  game.tap(free(b1), 100); // match #1 → 100 points
  // In-window match would be ×1.2; force a mismatch first.
  const boardFaces = (id: TileId) => game.board.get(id).face;
  assert.notEqual(boardFaces(a2), undefined);
  const other = game
    .hitCandidates()
    .find((t) => t.free && boardFaces(t.id) !== boardFaces(a2) && t.id !== a2)!;
  game.tap(free(a2), 200);
  const outcome = game.tap(free(other.id), 300);
  assert.equal(outcome.kind, 'mismatch');
  assert.equal(game.selection, other.id); // selection moved to the second tile
  assert.equal(game.score, 100); // no deduction (spec §6)
  // Next match is out of combo: back to ×1 base points.
  game.tap(miss, 400);
  const [x, y] = game.level.solution[1]!;
  game.tap(free(x), 500);
  const m = game.tap(free(y), 600);
  assert.equal(m.kind, 'matched');
  assert.equal(m.kind === 'matched' && m.score.multiplier, 1);
});

test('consecutive in-window matches escalate the combo', () => {
  const game = newGame();
  const [p1, p2] = [game.level.solution[0]!, game.level.solution[1]!];
  game.tap(free(p1[0]), 0);
  game.tap(free(p1[1]), 10);
  game.tap(free(p2[0]), 20);
  const m = game.tap(free(p2[1]), COMBO_WINDOW_MS); // within window of match #1
  assert.equal(m.kind === 'matched' && m.score.multiplier, 1.2);
});

test('blocked tap keeps the selection; miss clears it', () => {
  const game = newGame();
  const [a] = game.level.solution[0]!;
  const buried = game.hitCandidates().find((t) => !t.free)!;
  game.tap(free(a), 0);
  assert.deepEqual(game.tap(blocked(buried.id), 1), { kind: 'blocked', id: buried.id });
  assert.equal(game.selection, a);
  assert.deepEqual(game.tap(miss, 2), { kind: 'selection-cleared' });
  assert.equal(game.selection, null);
  assert.deepEqual(game.tap(miss, 3), { kind: 'none' });
});

test('playing the full solution wins the game', () => {
  const game = newGame();
  let t = 0;
  for (const [a, b] of game.level.solution) {
    assert.equal(game.status(), 'playing');
    game.tap(free(a), t++);
    const outcome = game.tap(free(b), t++);
    assert.equal(outcome.kind, 'matched');
  }
  assert.equal(game.tilesLeft, 0);
  assert.equal(game.status(), 'won');
});

test('a board with free tiles but no matching pair is stuck', () => {
  const level: GeneratedLevel = {
    layoutId: 'stuck-fixture',
    seed: 0,
    tiles: [
      { id: 0, slot: { x: 0, y: 0, z: 0 }, face: 'dots-1', removed: false },
      { id: 1, slot: { x: 2, y: 0, z: 0 }, face: 'dots-2', removed: false },
    ],
    solution: [],
  };
  const game = new Game(level);
  assert.equal(game.status(), 'stuck');
});
