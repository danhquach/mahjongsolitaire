// Scoring + Super Combo (issue #6, spec §6, §11.1): 100 pts per pair,
// multiplier ladder ×1.2 → ×1.5 → ×2.0 → cap ×3.0 for consecutive matches
// within a 5s window, broken by mismatch or timeout, never punitive.
// Boundary tests sit exactly at the 5s window edges.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ScoreKeeper,
  BASE_PAIR_POINTS,
  COMBO_WINDOW_MS,
  FLAWLESS_RUN_POINTS,
} from '../src/scoring.js';

test('spec constants: 100 pts per pair, 5s combo window', () => {
  assert.equal(BASE_PAIR_POINTS, 100);
  assert.equal(COMBO_WINDOW_MS, 5000);
});

test('first match scores base points at multiplier 1', () => {
  const s = new ScoreKeeper();
  assert.deepEqual(s.recordMatch(1_000), { points: 100, multiplier: 1 });
  assert.equal(s.total, 100);
});

test('consecutive matches inside the window escalate ×1.2, ×1.5, ×2.0, cap ×3.0', () => {
  const s = new ScoreKeeper();
  const results = [0, 1000, 2000, 3000, 4000, 5000].map((t) => s.recordMatch(t));
  assert.deepEqual(
    results.map((r) => r.multiplier),
    [1, 1.2, 1.5, 2.0, 3.0, 3.0],
  );
  assert.deepEqual(
    results.map((r) => r.points),
    [100, 120, 150, 200, 300, 300],
  );
  assert.equal(s.total, 100 + 120 + 150 + 200 + 300 + 300);
});

test('boundary: a match exactly 5000ms after the previous one keeps the combo', () => {
  const s = new ScoreKeeper();
  s.recordMatch(0);
  assert.deepEqual(s.recordMatch(5000), { points: 120, multiplier: 1.2 });
});

test('boundary: a match 5001ms after the previous one resets to base', () => {
  const s = new ScoreKeeper();
  s.recordMatch(0);
  assert.deepEqual(s.recordMatch(5001), { points: 100, multiplier: 1 });
});

test('the window is measured from the previous match, not the combo start', () => {
  const s = new ScoreKeeper();
  s.recordMatch(0);
  s.recordMatch(4000);
  // 9000 is >5s after combo start but ≤5s after the previous match
  assert.deepEqual(s.recordMatch(9000), { points: 150, multiplier: 1.5 });
});

test('a mismatch breaks the combo but never deducts points', () => {
  const s = new ScoreKeeper();
  s.recordMatch(0);
  s.recordMatch(1000); // ×1.2
  const before = s.total;
  s.recordMismatch();
  assert.equal(s.total, before); // never punitive
  assert.deepEqual(s.recordMatch(2000), { points: 100, multiplier: 1 });
});

test('after a timeout reset the ladder restarts from the beginning', () => {
  const s = new ScoreKeeper();
  s.recordMatch(0);
  s.recordMatch(1000); // ×1.2
  s.recordMatch(10_000); // timeout → ×1
  assert.deepEqual(s.recordMatch(11_000), { points: 120, multiplier: 1.2 });
});

test('total only ever increases', () => {
  const s = new ScoreKeeper();
  let prev = s.total;
  assert.equal(prev, 0);
  for (const t of [0, 1000, 20_000, 20_500]) {
    s.recordMatch(t);
    assert.ok(s.total > prev);
    prev = s.total;
    s.recordMismatch();
    assert.equal(s.total, prev);
  }
});

test('non-monotonic timestamps are rejected', () => {
  const s = new ScoreKeeper();
  s.recordMatch(1000);
  assert.throws(() => s.recordMatch(999), /monotonic/);
});

// --- Difficulty multiplier (issue #176) --------------------------------------
//
// The weekly board ranks by score earned and the profile shows the same
// number, so a flat score would make grinding level 1 the fastest climb. Every
// pair is scaled by the level's band instead.

test('the difficulty multiplier scales every pair, combo ladder included', () => {
  const plain = new ScoreKeeper();
  const hard = new ScoreKeeper(2.5);
  for (const s of [plain, hard]) {
    s.recordMatch(0);
    s.recordMatch(1000);
    s.recordMatch(2000);
  }
  assert.equal(plain.total, 100 + 120 + 150);
  assert.equal(hard.total, 250 + 300 + 375);
  assert.equal(hard.total, plain.total * 2.5);
});

test('a multiplier of 1 is exactly today’s scoring', () => {
  const before = new ScoreKeeper();
  const after = new ScoreKeeper(1);
  for (const s of [before, after]) {
    s.recordMatch(0);
    s.recordMatch(9999);
    s.recordMatch(10000);
  }
  assert.equal(after.total, before.total);
});

test('the reported combo multiplier is the combo’s, not the difficulty’s', () => {
  // The HUD shows this as the Super Combo rung; folding difficulty into it
  // would tell the player they are on a ×2.5 combo they never earned.
  const s = new ScoreKeeper(2.5);
  assert.equal(s.recordMatch(0).multiplier, 1);
  assert.equal(s.recordMatch(1000).multiplier, 1.2);
});

test('a restored snapshot is not re-multiplied', () => {
  // The snapshot holds points already awarded. Re-applying the multiplier on
  // restore would inflate the score on every undo.
  const s = new ScoreKeeper(2.5);
  s.recordMatch(0);
  const snap = s.snapshot();
  s.recordMatch(1000);
  s.restore(snap);
  assert.equal(s.total, 250);
});

test('a flawless run pays FLAWLESS_RUN_POINTS at multiplier 1', () => {
  const s = new ScoreKeeper();
  for (let i = 0; i < 72; i++) s.recordMatch(i * 1000);
  assert.equal(s.total, FLAWLESS_RUN_POINTS);
});
