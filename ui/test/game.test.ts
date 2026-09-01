// Tap semantics on the core engine (issue #11, reworked by issue #93): every
// tap on a revealed free tile sends it to the holder, pairs assemble and clear
// there, plus win and stuck detection.

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

test('one tap sends a free tile to the holder; its partner clears the pair', () => {
  const game = newGame();
  const [a, b] = game.level.solution[0]!;
  assert.deepEqual(game.tap(free(a), 0), { kind: 'held', id: a, slot: 0 });
  assert.equal(game.selection, null, 'selection is not a concept any more (issue #93)');
  const outcome = game.tap(free(b), 1);
  assert.equal(outcome.kind, 'matched');
  assert.ok(outcome.kind === 'matched' && outcome.a === a && outcome.b === b);
  assert.equal(game.score, 100);
  assert.equal(game.tilesLeft, game.level.tiles.length - 2);
  assert.equal(game.board.get(a).removed, true);
  assert.equal(game.board.get(b).removed, true);
  assert.deepEqual(
    game.holderSlots(),
    [null, null, null, null],
    'the pair cleared out of the holder — the slot is free again',
  );
});

test('a non-matching tap is a park, never a mismatch — the combo only times out', () => {
  const game = newGame();
  const [[a1, b1], [a2, b2]] = [game.level.solution[0]!, game.level.solution[1]!];
  game.tap(free(a1), 0);
  game.tap(free(b1), 100); // match #1 → 100 points
  // A tile of a different face goes to the holder; nothing breaks the combo.
  game.tap(free(a2), 200);
  const m = game.tap(free(b2), 300); // still inside the 5s window of match #1
  assert.equal(m.kind, 'matched');
  assert.equal(m.kind === 'matched' && m.score.multiplier, 1.2, 'the combo survived the park');

  // Out of window: back to ×1 base points.
  const game2 = newGame();
  const [[c1, d1], [c2, d2]] = [game2.level.solution[0]!, game2.level.solution[1]!];
  game2.tap(free(c1), 0);
  game2.tap(free(d1), 10);
  game2.tap(free(c2), 20);
  const late = game2.tap(free(d2), 10 + COMBO_WINDOW_MS + 1);
  assert.equal(late.kind === 'matched' && late.score.multiplier, 1, 'the window expired');
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

test('a blocked tap and a miss change nothing', () => {
  const game = newGame();
  const buried = game.hitCandidates().find((t) => !t.free)!;
  const before = game.stateHash();
  assert.deepEqual(game.tap(blocked(buried.id), 0), { kind: 'blocked', id: buried.id });
  assert.deepEqual(game.tap(miss, 1), { kind: 'none' });
  assert.equal(game.stateHash(), before);
  assert.deepEqual(game.holderSlots(), [null, null, null, null]);
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
