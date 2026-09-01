// Issue #44 / #93: the feedback sequences have to be *felt*, but what a test
// can hold is their arithmetic — the shake decays, the flip never overshoots,
// the particle burst is deterministic and radial, and the tray timeline fits
// a budget that never throttles a fast player.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  FLIP_MS,
  flipScaleX,
  PAIR_CLEAR_MS,
  PAIR_SHOW_MS,
  PARTICLE_COUNT,
  PARTICLE_MS,
  SHAKE_AMPLITUDE,
  SHAKE_MS,
  TRAY_FLY_MS,
  particleBurst,
  particleFrame,
  shakeOffset,
} from '../src/anim.js';

test('the tray sequence stays inside a fast-play budget (issue #93)', () => {
  // Flight + dwell + clear: the board is already correct underneath, so the
  // whole show is decoration — it must never feel like a lock-out.
  assert.ok(TRAY_FLY_MS + PAIR_SHOW_MS + PAIR_CLEAR_MS <= 600);
  // Particles ride the clear and must not outlive it.
  assert.ok(PARTICLE_MS <= PAIR_CLEAR_MS);
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
