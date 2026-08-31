import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BOARD_MARGIN,
  HUD_PLACEMENTS,
  MAX_FIT_SCALE,
  chooseHudPlacement,
  fitScale,
} from '../src/hud-fit.js';

/** Turtle Classic's bounds, landscape-ish at ~1.43:1 (issue #37's table). */
const TURTLE = { w: 960, h: 672 };
/** A portrait-shaped board (Pyramid/Bridge-like) — the same rule, inverted. */
const PORTRAIT = { w: 672, h: 960 };

test('fitScale is the smaller of the two axis ratios, after the margin', () => {
  // Width-constrained: 366/960 < 760/672.
  assert.equal(fitScale(TURTLE, 390, 784), (390 - 2 * BOARD_MARGIN) / 960);
  // Height-constrained: 366/672 < 820/960.
  assert.equal(fitScale(TURTLE, 844, 390), (390 - 2 * BOARD_MARGIN) / 672);
});

test('fitScale never magnifies past the cap, and never goes negative', () => {
  assert.equal(fitScale(TURTLE, 100000, 100000), MAX_FIT_SCALE);
  // A viewport smaller than the margins would otherwise yield a negative scale.
  assert.equal(fitScale(TURTLE, 2 * BOARD_MARGIN, 2 * BOARD_MARGIN), 0);
  assert.equal(fitScale(TURTLE, 4, 4), 0);
});

test('chooseHudPlacement picks the placement with the larger fit scale', () => {
  // Phone landscape, from issue #37's table: the side rail wins because the
  // top bar spends the scarce axis (height), the rail spends the plentiful one.
  const best = chooseHudPlacement(TURTLE, [
    { placement: 'top', availW: 844, availH: 328 },
    { placement: 'side', availW: 724, availH: 390 },
  ]);
  assert.equal(best, 'side');
});

test('chooseHudPlacement picks the top bar when it fits larger', () => {
  // Phone portrait: height is plentiful, so the bar costs almost nothing and
  // the rail costs 120px of the constraining axis.
  const best = chooseHudPlacement(TURTLE, [
    { placement: 'top', availW: 390, availH: 784 },
    { placement: 'side', availW: 270, availH: 844 },
  ]);
  assert.equal(best, 'top');
});

test('board aspect alone flips the choice on one fixed viewport', () => {
  // Tablet landscape (1080×810), one set of candidate areas, two boards. The
  // wide board is width-bound in both placements, so the bar — which spends
  // height it does not need — wins; the tall board is height-bound in both, so
  // the rail wins for the mirror-image reason. Nothing about the viewport
  // changed, which is the point: the rule reads the board, not the orientation,
  // and so cannot have been tuned to Turtle.
  const candidates = [
    { placement: 'top' as const, availW: 1080, availH: 746 },
    { placement: 'side' as const, availW: 960, availH: 810 },
  ];
  assert.equal(chooseHudPlacement(TURTLE, candidates), 'top');
  assert.equal(chooseHudPlacement(PORTRAIT, candidates), 'side');
});

test('ties keep the earlier candidate, so the placement cannot oscillate', () => {
  // Both candidates are capped, so their scales are equal.
  const order = chooseHudPlacement(TURTLE, [
    { placement: 'side', availW: 100000, availH: 100000 },
    { placement: 'top', availW: 100000, availH: 100000 },
  ]);
  assert.equal(order, 'side');
  const reversed = chooseHudPlacement(TURTLE, [
    { placement: 'top', availW: 100000, availH: 100000 },
    { placement: 'side', availW: 100000, availH: 100000 },
  ]);
  assert.equal(reversed, 'top');
});

test('HUD_PLACEMENTS leads with the top bar, so it is the default on a tie', () => {
  assert.deepEqual([...HUD_PLACEMENTS], ['top', 'side']);
});

test('chooseHudPlacement requires at least one candidate', () => {
  assert.throws(() => chooseHudPlacement(TURTLE, []), /candidate/);
});
