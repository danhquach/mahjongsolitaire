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
import { CONCEAL_RATIO, concealedCount } from '../src/conceal.js';
import {
  bandForLevel,
  concealBucketForBand,
  concealRatioForLevel,
  EASY_CONCEAL_RATIO,
  FIRST_CONCEALED_LEVEL,
  LADDER_LENGTH,
  LADDER_POOLS,
  LADDER_WINDOWS,
  nextPoolLayout,
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

test('layout pools partition the 10 shipped layouts across the bands (issue #99)', () => {
  const all = Object.values(LADDER_POOLS).flat();
  assert.equal(all.length, new Set(all).size, 'no layout serves two bands');
  assert.deepEqual(
    [...all].sort(),
    [
      'bridge',
      'butterfly',
      'cat',
      'fortress',
      'moon_gate',
      'pyramid',
      'spider',
      'terrace',
      'turtle_classic',
      'windmill',
    ],
    'every shipped layout is in exactly one pool',
  );
  for (const pool of Object.values(LADDER_POOLS)) {
    assert.ok(pool.length >= 2, 'every pool can rotate: at least two layouts');
  }
});

test('nextPoolLayout rotates the band pool and wraps (issue #99)', () => {
  const pool = LADDER_POOLS.medium;
  for (let i = 0; i < pool.length; i++) {
    assert.equal(nextPoolLayout('medium', pool[i]!), pool[(i + 1) % pool.length]);
  }
  // A layout from outside the pool (an older save) restarts the rotation.
  assert.equal(nextPoolLayout('medium', 'butterfly'), pool[0]);
});

test('every shipped ladder entry pins a layout from its own band pool (issue #99)', () => {
  const ladder = parseLadder(
    JSON.parse(readFileSync(new URL('../../../data/ladder.json', import.meta.url), 'utf8')),
  );
  for (const entry of ladder) {
    const { band } = bandForLevel(entry.level);
    assert.ok(
      LADDER_POOLS[band].includes(entry.layoutId),
      `level ${entry.level}: ${entry.layoutId} is not in the ${band} pool`,
    );
  }
});

test('concealment follows band: easy 0%, medium/medium-plus 8%, hard 15%', () => {
  assert.equal(concealBucketForBand('easy'), 'easy');
  assert.equal(concealBucketForBand('medium'), 'medium');
  assert.equal(concealBucketForBand('medium-plus'), 'medium');
  assert.equal(concealBucketForBand('hard'), 'hard');
});

// --- Face-down tiles start at level 5 (issue #175) ---------------------------
//
// Concealment used to follow the band alone, so the whole easy band concealed
// nothing and level 10 — the first decade spike — was the first face-down tile
// a player ever saw. The easy band's base levels now ramp by level number.
// Spikes are deliberately excluded: level 10 and level 20 keep the medium 8%
// they have today (PM, 2026-09-03), so concealment never dips going into a
// milestone.

test('levels 1-4 are the teaching levels and conceal nothing', () => {
  for (let level = 1; level < FIRST_CONCEALED_LEVEL; level++) {
    assert.equal(concealRatioForLevel(level), 0, `level ${level} must be all face-up`);
  }
});

test('every level from 5 on conceals something', () => {
  for (let level = FIRST_CONCEALED_LEVEL; level <= LADDER_LENGTH; level++) {
    assert.ok(concealRatioForLevel(level) > 0, `level ${level} conceals nothing`);
    // A ratio above zero is not enough — it has to round up to a real tile on
    // the 144-tile deals every shipped layout uses.
    assert.ok(concealedCount(144, concealRatioForLevel(level)) > 0, `level ${level}: 0 tiles`);
  }
});

test('the easy band ramps 4% then 6%, and the decade spikes keep their 8%', () => {
  const expected = new Map<number, number>();
  for (let level = 1; level <= 4; level++) expected.set(level, EASY_CONCEAL_RATIO.teaching);
  for (let level = 5; level <= 9; level++) expected.set(level, EASY_CONCEAL_RATIO.lower);
  for (let level = 11; level <= 19; level++) expected.set(level, EASY_CONCEAL_RATIO.upper);
  expected.set(10, CONCEAL_RATIO.medium);
  expected.set(20, CONCEAL_RATIO.medium);
  for (const [level, ratio] of expected) {
    assert.equal(concealRatioForLevel(level), ratio, `level ${level}`);
  }
});

test('on a 144-tile deal that is 0, 5, 8 and 11 tiles', () => {
  // Pinned as tile counts rather than against EASY_CONCEAL_RATIO, so the ramp
  // is fixed independently of the constants the implementation reads. Both
  // edges of each step are named: moving 9 or 19 would slide the ramp without
  // failing a test that only checked one end.
  assert.equal(concealedCount(144, concealRatioForLevel(1)), 0);
  assert.equal(concealedCount(144, concealRatioForLevel(4)), 0);
  assert.equal(concealedCount(144, concealRatioForLevel(5)), 5);
  assert.equal(concealedCount(144, concealRatioForLevel(9)), 5);
  assert.equal(concealedCount(144, concealRatioForLevel(10)), 11);
  assert.equal(concealedCount(144, concealRatioForLevel(11)), 8);
  assert.equal(concealedCount(144, concealRatioForLevel(19)), 8);
  assert.equal(concealedCount(144, concealRatioForLevel(20)), 11);
});

test('level 20 and up are untouched: the ratio is still the band bucket', () => {
  for (let level = 20; level <= LADDER_LENGTH; level++) {
    const { band } = bandForLevel(level);
    assert.equal(
      concealRatioForLevel(level),
      CONCEAL_RATIO[concealBucketForBand(band)],
      `level ${level} (${band})`,
    );
  }
});

test('concealment never dips on the way into a decade milestone', () => {
  // The property the level-10 decision protects. Not strict everywhere: level
  // 20 is the easy band's spike at 8% and level 21 is base medium at the same
  // 8%, so a milestone is never *below* its neighbours rather than always
  // above them. (The dip after a hard spike — 15% back down to 8% — is the
  // decade's relief and is what `>=` on each side allows.)
  for (let level = 10; level <= LADDER_LENGTH; level += 10) {
    const spike = concealRatioForLevel(level);
    assert.ok(bandForLevel(level).spike, `level ${level} should be a spike`);
    assert.ok(spike >= concealRatioForLevel(level - 1), `level ${level} dips below ${level - 1}`);
    if (level < LADDER_LENGTH) {
      assert.ok(spike >= concealRatioForLevel(level + 1), `level ${level} dips below ${level + 1}`);
    }
  }
});

test('level 10 is strictly a step up from the base levels around it', () => {
  // The bug the level-10 fork would have introduced: the ticket as written put
  // levels 5-10 at 4%, which would have made the first milestone conceal less
  // than levels 11-19 that follow it.
  assert.ok(concealRatioForLevel(10) > concealRatioForLevel(9), '10 must beat 9');
  assert.ok(concealRatioForLevel(10) > concealRatioForLevel(11), '10 must beat 11');
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

test('the pools name exactly the shipped layout files', () => {
  // Was asserted through DAILY_LAYOUTS until issue #183 retired the Daily
  // board; the invariant is the ladder's, so it lives here now: a layout file
  // no pool draws from is dead weight, and a pool naming a missing file is a
  // failed fetch at runtime.
  const pooled = [...new Set(Object.values(LADDER_POOLS).flat())].sort();
  const files = readdirSync(LAYOUT_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -'.json'.length))
    .sort();
  assert.deepEqual(pooled, files);
});

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
