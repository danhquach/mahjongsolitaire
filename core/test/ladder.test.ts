// The shipped plateau ladder (decision 0011, issue #18) and its permanent
// release gate. Acceptance criteria under test:
//
//   1. every shipped seed regenerates a solvable deal (witness replay, the
//      same sound proof the soak uses);
//   2. no misordered pair among the bands in use — every level's score sits in
//      its band window, every spike outscores its decade's base levels, and no
//      medium-plus level scores below the medium median;
//   3. the report inputs (band, score, spike) are a pure function of the
//      shipped (layoutId, seed), so the PM report is reproducible.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';

import { Board } from '../src/board.js';
import { assessDifficulty } from '../src/difficulty.js';
import { facesMatch } from '../src/faces.js';
import { generateLevel } from '../src/generator.js';
import type { GeneratedLevel } from '../src/generator.js';
import {
  bandForLevel,
  concealBucketForBand,
  LADDER_LENGTH,
  LADDER_WINDOWS,
  parseLadder,
} from '../src/ladder.js';
import { parseLayout } from '../src/layouts.js';
import type { LayoutFile } from '../src/layouts.js';

const LAYOUT_DIR = new URL('../../../data/layouts/', import.meta.url);
const LADDER_FILE = new URL('../../../data/ladder.json', import.meta.url);

test('bandForLevel: three plateaus, spike every 10th level', () => {
  assert.deepEqual(bandForLevel(1), { band: 'easy', spike: false });
  assert.deepEqual(bandForLevel(10), { band: 'medium', spike: true });
  assert.deepEqual(bandForLevel(20), { band: 'medium', spike: true });
  assert.deepEqual(bandForLevel(21), { band: 'medium', spike: false });
  assert.deepEqual(bandForLevel(30), { band: 'hard', spike: true });
  assert.deepEqual(bandForLevel(60), { band: 'hard', spike: true });
  assert.deepEqual(bandForLevel(61), { band: 'medium-plus', spike: false });
  assert.deepEqual(bandForLevel(149), { band: 'medium-plus', spike: false });
  assert.deepEqual(bandForLevel(150), { band: 'hard', spike: true });
  assert.throws(() => bandForLevel(0), RangeError);
  assert.throws(() => bandForLevel(151), RangeError);
});

test('band windows are disjoint, ordered, and below the expert cut', () => {
  const order = ['easy', 'medium', 'medium-plus', 'hard'] as const;
  for (let i = 1; i < order.length; i++) {
    assert.equal(LADDER_WINDOWS[order[i - 1]!].max, LADDER_WINDOWS[order[i]!].min);
  }
  assert.ok(LADDER_WINDOWS.hard.max <= 0.8, 'expert does not ship in v1');
});

test('concealment follows band: easy 0%, medium/medium-plus 8%, hard 15%', () => {
  assert.equal(concealBucketForBand('easy'), 'easy');
  assert.equal(concealBucketForBand('medium'), 'medium');
  assert.equal(concealBucketForBand('medium-plus'), 'medium');
  assert.equal(concealBucketForBand('hard'), 'hard');
});

/** Same sound solvability proof as soak.ts: replay the construction witness. */
function assertWitnessSolves(level: GeneratedLevel, label: string): void {
  const board = new Board(level.tiles);
  for (const [a, b] of level.solution) {
    assert.ok(board.isFree(a) && board.isFree(b), `${label}: pair ${a},${b} not free`);
    assert.ok(facesMatch(board.get(a).face, board.get(b).face), `${label}: faces differ`);
    board.remove(a);
    board.remove(b);
  }
  assert.equal(board.presentTiles().length, 0, `${label}: witness left tiles behind`);
}

test('release gate: all shipped seeds solvable, every band window and ordering criterion holds', () => {
  // Load whatever ships (layout-files.test.ts asserts the exact set).
  const layouts = new Map<string, LayoutFile>(
    readdirSync(LAYOUT_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        const layout = parseLayout(JSON.parse(readFileSync(new URL(f, LAYOUT_DIR), 'utf8')));
        return [layout.id, layout];
      }),
  );

  const ladder = parseLadder(JSON.parse(readFileSync(LADDER_FILE, 'utf8')));
  assert.equal(ladder.length, LADDER_LENGTH);

  const scores = new Array<number>(LADDER_LENGTH + 1);
  for (const entry of ladder) {
    const layout = layouts.get(entry.layoutId);
    assert.ok(layout, `level ${entry.level}: unknown layout ${entry.layoutId}`);
    const level = generateLevel(layout, entry.seed);
    assertWitnessSolves(level, `level ${entry.level} (${entry.layoutId}, seed ${entry.seed})`);

    const { band } = bandForLevel(entry.level);
    const { score } = assessDifficulty(level);
    const window = LADDER_WINDOWS[band];
    assert.ok(
      score >= window.min && score < window.max,
      `level ${entry.level}: score ${score.toFixed(4)} outside ${band} window [${window.min}, ${window.max})`,
    );
    scores[entry.level] = score;
  }

  // Ordering, asserted directly rather than via the windows: a spike never
  // scores below any base level of its decade.
  for (let spike = 10; spike <= LADDER_LENGTH; spike += 10) {
    for (let base = spike - 9; base < spike; base++) {
      assert.ok(
        scores[spike]! > scores[base]!,
        `spike ${spike} (${scores[spike]!.toFixed(4)}) does not outscore base ${base} (${scores[base]!.toFixed(4)})`,
      );
    }
  }

  // No medium-plus level below the medium median.
  const mediumMedian = LADDER_WINDOWS['medium-plus'].min;
  for (let level = 61; level <= LADDER_LENGTH; level++) {
    if (level % 10 === 0) continue;
    assert.ok(scores[level]! >= mediumMedian, `level ${level} below the medium median`);
  }
});
