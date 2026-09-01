// Issue #44: the match sequence has to be *felt*, but what a test can hold is
// its arithmetic — that the two tiles actually meet, that they accelerate into
// the hit rather than drift, that the whole thing fits the 400ms budget, and
// that reduced motion removes travel without removing the flash.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CROSSFADE_MS,
  FADE_MS,
  FLIP_MS,
  flipScaleX,
  PARTICLE_COUNT,
  PARTICLE_MS,
  SHAKE_AMPLITUDE,
  SHAKE_MS,
  TRAVEL_MS,
  impactAt,
  matchDuration,
  matchFrame,
  particleBurst,
  particleFrame,
  shakeOffset,
} from '../src/anim.js';

const A = { x: 100, y: 100 };
const B = { x: 300, y: 180 };
const MID = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 };

test('both tiles arrive at the pair midpoint on impact', () => {
  const t = impactAt(false);
  for (const from of [A, B]) {
    const f = matchFrame(from, MID, t, false);
    assert.ok(Math.abs(f.cx - MID.x) < 1, `cx ${f.cx}`);
    assert.ok(Math.abs(f.cy - MID.y) < 1, `cy ${f.cy}`);
  }
});

test('travel starts at the tile and accelerates into the hit', () => {
  const start = matchFrame(A, MID, 0, false);
  assert.equal(start.cx, A.x);
  assert.equal(start.cy, A.y);
  // Each successive slice covers more ground than the one before it.
  const step = TRAVEL_MS / 10;
  let previous = -Infinity;
  for (let i = 0; i < 10; i++) {
    const a = matchFrame(A, MID, step * i, false);
    const b = matchFrame(A, MID, step * (i + 1), false);
    const covered = Math.hypot(b.cx - a.cx, b.cy - a.cy);
    assert.ok(covered > previous, `slice ${i} covered ${covered} <= ${previous}`);
    previous = covered;
  }
});

test('the sequence fits the 400ms budget and its phases sum to it', () => {
  assert.equal(matchDuration(false), TRAVEL_MS + FADE_MS);
  assert.ok(matchDuration(false) < 400, `${matchDuration(false)}ms`);
  // Particles start at impact and must not outlive the sequence.
  assert.ok(impactAt(false) + PARTICLE_MS <= matchDuration(false));
});

test('the tile is gone by the end and never before the impact', () => {
  assert.equal(matchFrame(A, MID, impactAt(false), false).alpha, 1);
  assert.equal(matchFrame(A, MID, matchDuration(false), false).alpha, 0);
});

test('flash peaks at impact and decays to nothing', () => {
  const at = impactAt(false);
  assert.equal(matchFrame(A, MID, at - 1, false).flash < 1, true);
  assert.equal(matchFrame(A, MID, at, false).flash, 1);
  assert.equal(matchFrame(A, MID, matchDuration(false), false).flash, 0);
});

test('reduced motion cross-fades in place, keeping the flash', () => {
  assert.equal(matchDuration(true), CROSSFADE_MS);
  assert.equal(impactAt(true), 0);
  for (let t = 0; t <= CROSSFADE_MS; t += 10) {
    const f = matchFrame(A, MID, t, true);
    assert.equal(f.cx, A.x, `travelled at t=${t}`);
    assert.equal(f.cy, A.y, `travelled at t=${t}`);
    assert.equal(f.scale, 1, `scaled at t=${t}`);
  }
  assert.equal(matchFrame(A, MID, 0, true).flash, 1);
  assert.equal(matchFrame(A, MID, CROSSFADE_MS, true).alpha, 0);
});

test('shake starts and ends at rest, decays, and changes direction', () => {
  assert.equal(shakeOffset(0), 0);
  assert.equal(shakeOffset(SHAKE_MS), 0);
  assert.equal(shakeOffset(SHAKE_MS + 50), 0);
  let signChanges = 0;
  let peakEarly = 0;
  let peakLate = 0;
  let previous = 0;
  for (let t = 1; t < SHAKE_MS; t++) {
    const v = shakeOffset(t);
    assert.ok(Math.abs(v) <= SHAKE_AMPLITUDE, `overshoot ${v} at ${t}`);
    if (previous !== 0 && Math.sign(v) !== 0 && Math.sign(v) !== Math.sign(previous)) signChanges++;
    if (t < SHAKE_MS / 2) peakEarly = Math.max(peakEarly, Math.abs(v));
    else peakLate = Math.max(peakLate, Math.abs(v));
    previous = v;
  }
  assert.ok(signChanges >= 2, `only ${signChanges} direction changes`);
  assert.ok(peakLate < peakEarly, `no decay: ${peakEarly} -> ${peakLate}`);
});

test('the particle burst is deterministic, radial, and fully faded by the end', () => {
  const burst = particleBurst(7);
  assert.equal(burst.length, PARTICLE_COUNT);
  assert.deepEqual(burst, particleBurst(7));
  assert.notDeepEqual(burst, particleBurst(8));
  // Radial: every quadrant gets at least one particle.
  const quadrants = new Set(
    burst.map((p) => {
      const f = particleFrame(p, PARTICLE_MS / 2);
      return `${Math.sign(Math.round(f.x))}:${Math.sign(Math.round(f.y))}`;
    }),
  );
  assert.ok(quadrants.size >= 4, `spread only ${quadrants.size} directions`);
  for (const p of burst) {
    const start = particleFrame(p, 0);
    assert.equal(Math.hypot(start.x, start.y), 0);
    assert.equal(particleFrame(p, PARTICLE_MS).alpha, 0);
    const half = particleFrame(p, PARTICLE_MS / 2);
    assert.ok(Math.hypot(half.x, half.y) > 0, 'particle never left the impact point');
  }
});

test('the reveal flip unfolds from the centreline and never overshoots (issue #64)', () => {
  assert.equal(flipScaleX(0), 0);
  assert.equal(flipScaleX(FLIP_MS), 1);
  // Past the end — whatever frame the effect lands on, the tile is full width.
  assert.equal(flipScaleX(FLIP_MS * 3), 1);
  let previous = 0;
  for (let t = 0; t <= FLIP_MS; t += 10) {
    const s = flipScaleX(t);
    assert.ok(s >= previous && s <= 1, `scale not monotonic in [0,1] at ${t}ms (${s})`);
    previous = s;
  }
  // Ease-out: the first half covers more than half the distance.
  assert.ok(flipScaleX(FLIP_MS / 2) > 0.5);
});
