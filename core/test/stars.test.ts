// Star ratings (issue #19, spec §6): two axes, one star each — unaided, and
// inside the band's baseline time — on top of the one star every clear earns.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PAIR_BASELINE_MS, baselineMs, parseStarRating, starRating } from '../src/stars.js';

const clean = { hints: 0, undos: 0, shuffles: 0 };

test('baseline is pairs × the band budget, and grows with the band', () => {
  assert.equal(baselineMs(144, 'easy'), 72 * PAIR_BASELINE_MS.easy);
  assert.equal(baselineMs(144, 'easy'), 432_000);
  assert.equal(baselineMs(144, 'hard'), 720_000);
  assert.ok(PAIR_BASELINE_MS.easy < PAIR_BASELINE_MS.medium);
  assert.ok(PAIR_BASELINE_MS.medium < PAIR_BASELINE_MS['medium-plus']);
  assert.ok(PAIR_BASELINE_MS['medium-plus'] < PAIR_BASELINE_MS.hard);
  for (const bad of [0, -2, 143, 1.5]) assert.throws(() => baselineMs(bad, 'easy'), RangeError, String(bad));
});

test('three stars: no assists, at or under the baseline (boundary inclusive)', () => {
  const baseline = baselineMs(144, 'medium');
  assert.equal(starRating({ ...clean, elapsedMs: 0 }, baseline), 3);
  assert.equal(starRating({ ...clean, elapsedMs: baseline }, baseline), 3);
  assert.equal(starRating({ ...clean, elapsedMs: baseline + 1 }, baseline), 2);
});

test('any assist costs one star, however many', () => {
  const baseline = baselineMs(144, 'medium');
  assert.equal(starRating({ ...clean, hints: 1, elapsedMs: 0 }, baseline), 2);
  assert.equal(starRating({ ...clean, undos: 1, elapsedMs: 0 }, baseline), 2);
  assert.equal(starRating({ ...clean, shuffles: 1, elapsedMs: 0 }, baseline), 2);
  assert.equal(starRating({ hints: 5, undos: 5, shuffles: 5, elapsedMs: 0 }, baseline), 2);
});

test('one star: assisted and over the baseline; never zero', () => {
  const baseline = baselineMs(144, 'easy');
  assert.equal(starRating({ ...clean, hints: 1, elapsedMs: baseline * 10 }, baseline), 1);
  assert.equal(starRating({ hints: 9, undos: 9, shuffles: 9, elapsedMs: Number.MAX_SAFE_INTEGER }, baseline), 1);
});

test('negative or NaN inputs are rejected', () => {
  const baseline = baselineMs(144, 'easy');
  assert.throws(() => starRating({ ...clean, hints: -1, elapsedMs: 0 }, baseline), RangeError);
  assert.throws(() => starRating({ ...clean, elapsedMs: NaN }, baseline), RangeError);
});

test('parseStarRating accepts exactly 1, 2, 3', () => {
  assert.equal(parseStarRating(1), 1);
  assert.equal(parseStarRating(2), 2);
  assert.equal(parseStarRating(3), 3);
  for (const bad of [0, 4, 2.5, '3', null, undefined, true]) assert.equal(parseStarRating(bad), null, String(bad));
});
