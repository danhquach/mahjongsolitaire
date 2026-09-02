// Issue #44 / #93: the feedback sequences have to be *felt*, but what a test
// can hold is their arithmetic — the shake decays, the flip never overshoots,
// the particle burst is deterministic and radial, and the tray timeline fits
// a budget that never throttles a fast player.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CASCADE_COLUMN_STAGGER_MS,
  CASCADE_TILE_MS,
  CONFETTI_MS,
  FLIP_MS,
  LANTERN_MS,
  LOSS_DIALOG_DELAY_MS,
  LOSS_WASH_MS,
  PAIR_CLEAR_MS,
  PAIR_SHOW_MS,
  PARTICLE_COUNT,
  PARTICLE_MS,
  SCORE_COUNT_MS,
  SHAKE_AMPLITUDE,
  SHAKE_MS,
  SLAM_MS,
  STUCK_DIALOG_DELAY_MS,
  STUCK_PULSE_MAX,
  STUCK_PULSE_MS,
  STUCK_PULSE_STAGGER_MS,
  STUCK_PULSE_START_MS,
  STUCK_WASH_MS,
  TRAY_FLY_MS,
  WIN_DIALOG_DELAY_MS,
  cascadeDurationMs,
  cascadeFrame,
  confettiFrame,
  confettiLayout,
  flipScaleX,
  holderShakeOffset,
  lanternFrame,
  lanternLayout,
  lossSchedule,
  particleBurst,
  particleFrame,
  scheduleDialogDelay,
  scoreCountUp,
  shakeOffset,
  slamProgress,
  slamSquash,
  slumpFrame,
  slumpLayout,
  stuckGreyOut,
  stuckPulseAlpha,
  stuckSchedule,
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

// --- Win celebration (issue #120) --------------------------------------

test('the win dialog delay is skipped under reduced motion', () => {
  assert.equal(scheduleDialogDelay(false), WIN_DIALOG_DELAY_MS);
  assert.equal(scheduleDialogDelay(true), 0);
});

test('the score count-up starts at 0, lands exactly on the final value, and eases out', () => {
  const final = 1234;
  assert.equal(scoreCountUp(0, final), 0);
  assert.equal(scoreCountUp(SCORE_COUNT_MS, final), final);
  assert.equal(scoreCountUp(SCORE_COUNT_MS * 5, final), final, 'never left mid-count');
  let previous = -1;
  for (let t = 0; t <= SCORE_COUNT_MS; t += 15) {
    const v = scoreCountUp(t, final);
    assert.ok(v >= previous, `not monotonic at ${t}ms (${v} < ${previous})`);
    previous = v;
  }
  // Ease-out: the first half covers more than half the distance.
  assert.ok(scoreCountUp(SCORE_COUNT_MS / 2, final) > final / 2);
});

test('a zero score counts up to zero without going negative or throwing', () => {
  assert.equal(scoreCountUp(0, 0), 0);
  assert.equal(scoreCountUp(SCORE_COUNT_MS / 2, 0), 0);
  assert.equal(scoreCountUp(SCORE_COUNT_MS, 0), 0);
});

test('the cascade staggers by column and finishes every tile off and transparent', () => {
  // Column 0 starts at once; column 3 waits three stagger steps.
  const start0 = cascadeFrame(1, 0);
  assert.ok(start0.dx >= 0 && start0.dx < 5, `column 0 already swept far at t=1ms (${start0.dx})`);
  assert.ok(start0.alpha > 0 && start0.alpha <= 1);
  const start3 = cascadeFrame(1, 3);
  assert.deepEqual(start3, { dx: 0, dy: 0, alpha: 1 }, 'column 3 has not started at t=1ms');

  const columns = 4;
  const total = cascadeDurationMs(columns);
  assert.equal(total, (columns - 1) * CASCADE_COLUMN_STAGGER_MS + CASCADE_TILE_MS);
  for (let column = 0; column < columns; column++) {
    const end = cascadeFrame(total, column);
    assert.equal(end.alpha, 0, `column ${column} not transparent by the cascade's own end`);
    assert.ok(end.dx > 0, `column ${column} not swept off by the cascade's own end`);
  }
  assert.equal(cascadeDurationMs(0), 0, 'no tiles, no duration');
});

test('lanterns rise (y strictly decreasing) and fade out over their duration', () => {
  const [spec] = lanternLayout(11, 1);
  let previousY = Infinity;
  let previousAlpha = Infinity;
  for (let t = 0; t <= LANTERN_MS; t += 100) {
    const f = lanternFrame(spec!, t);
    assert.ok(f.y <= previousY, `y rose at ${t}ms`);
    assert.ok(f.alpha <= previousAlpha + 1e-9, `alpha rose at ${t}ms`);
    previousY = f.y;
    previousAlpha = f.alpha;
  }
  assert.ok(lanternFrame(spec!, 0).alpha > 0.9);
  assert.ok(lanternFrame(spec!, LANTERN_MS).alpha < 1e-9);
});

test('lantern layout is deterministic given a seed, and lands 4-6 lanterns', () => {
  const a = lanternLayout(3);
  const b = lanternLayout(3);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, lanternLayout(4));
  assert.ok(a.length >= 4 && a.length <= 6);
});

test('confetti falls (y increasing) and fades out, invisible before its own delay', () => {
  const spec = { x0: 0.5, driftPx: 0, rotationSpeedDeg: 0, delayMs: 200, colorIndex: 0 };
  assert.equal(confettiFrame(spec, 0).alpha, 0, 'not visible before its delay');
  assert.equal(confettiFrame(spec, spec.delayMs - 1).alpha, 0);
  assert.equal(confettiFrame(spec, spec.delayMs).alpha, 1, 'fully visible the instant it starts');
  let previousY = -Infinity;
  let previousAlpha = Infinity;
  for (let t = spec.delayMs; t <= spec.delayMs + CONFETTI_MS; t += 100) {
    const f = confettiFrame(spec, t);
    assert.ok(f.y >= previousY - 1e-9, `y fell backwards at ${t}ms`);
    assert.ok(f.alpha <= previousAlpha + 1e-9, `alpha rose at ${t}ms`);
    previousY = f.y;
    previousAlpha = f.alpha;
  }
  assert.equal(confettiFrame(spec, spec.delayMs + CONFETTI_MS).alpha, 0);
});

test('confetti layout is deterministic given a seed', () => {
  const a = confettiLayout(9);
  const b = confettiLayout(9);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, confettiLayout(10));
});

// --- Holder-full loss (issue #121) --------------------------------------

test('constants: the slam is shorter than a normal park, and the dialog outlasts the wash', () => {
  assert.ok(SLAM_MS < TRAY_FLY_MS, 'the slam should read as heavier and faster, not slower');
  assert.ok(LOSS_DIALOG_DELAY_MS > LOSS_WASH_MS, 'the wash should finish well before the dialog');
});

test('the slam lands exactly at 1 at SLAM_MS and never overshoots on the way there', () => {
  assert.equal(slamProgress(0), 0);
  assert.equal(slamProgress(SLAM_MS), 1);
  assert.equal(slamProgress(SLAM_MS * 2), 1, 'never left mid-flight');
  let previous = 0;
  for (let t = 0; t <= SLAM_MS; t += 5) {
    const p = slamProgress(t);
    assert.ok(p >= previous && p <= 1, `not monotonic in [0,1] at ${t}ms (${p})`);
    previous = p;
  }
  // Ease-in: the first half covers less than half the distance.
  assert.ok(slamProgress(SLAM_MS / 2) < 0.5);
});

test('the landing squash returns to scale 1 at both ends of SLAM_MS and dips in between', () => {
  assert.equal(slamSquash(0), 1);
  assert.equal(slamSquash(SLAM_MS), 1, 'never left squashed at the end of the slam');
  assert.equal(slamSquash(SLAM_MS * 2), 1, 'and not past it either');
  let sawDip = false;
  for (let t = 0; t <= SLAM_MS; t += 2) {
    const s = slamSquash(t);
    assert.ok(s <= 1, `squash overshot past 1 at ${t}ms (${s})`);
    if (s < 0.99) sawDip = true;
  }
  assert.ok(sawDip, 'the squash never actually compressed');
});

test('the holder shake returns to 0 at both ends, reusing SHAKE_MS, and swings twice', () => {
  assert.equal(holderShakeOffset(0), 0);
  assert.equal(holderShakeOffset(SHAKE_MS), 0);
  assert.equal(holderShakeOffset(SHAKE_MS + 10), 0);
  let previous = 0;
  let peaks = 0;
  for (let t = 1; t < SHAKE_MS; t++) {
    const v = holderShakeOffset(t);
    assert.ok(Math.abs(v) <= SHAKE_AMPLITUDE, `overshoot ${v} at ${t}ms`);
    if (Math.sign(previous) !== 0 && Math.sign(v) !== Math.sign(previous)) peaks++;
    previous = v;
  }
  // Two swings back and forth cross zero three times inside the span (two
  // full cycles), which is what makes it read as "twice" rather than once.
  assert.ok(peaks >= 2, `only ${peaks} direction changes — does not read as two swings`);
});

test('the loss dialog waits out LOSS_DIALOG_DELAY_MS, or nothing when the theatre is skipped', () => {
  assert.deepEqual(lossSchedule(false), { dialogAtMs: LOSS_DIALOG_DELAY_MS });
  assert.deepEqual(lossSchedule(true), { dialogAtMs: 0 });
});

test('slump layout is deterministic per seed, and signed both ways across seeds', () => {
  const a = slumpLayout(5);
  const b = slumpLayout(5);
  assert.deepEqual(a, b);
  const seeds = Array.from({ length: 20 }, (_, i) => i + 1);
  const signs = new Set(seeds.map((seed) => Math.sign(slumpLayout(seed).tiltRad)));
  assert.ok(signs.has(1) && signs.has(-1), 'every tile tilting the same way would look robotic');
});

test('a slumping tile drops and desaturates monotonically, exactly final at LOSS_WASH_MS', () => {
  const spec = slumpLayout(3);
  const start = slumpFrame(spec, 0);
  assert.deepEqual(start, { dy: 0, rotationRad: 0, saturation: 1 });
  const end = slumpFrame(spec, LOSS_WASH_MS);
  assert.equal(end.saturation, 0, 'fully desaturated by the end of the wash');
  assert.ok(end.dy > 0, 'settled downward');
  assert.equal(end.rotationRad, spec.tiltRad, 'tilted all the way to its own spec');
  // Never left mid-slump past the wash's own duration.
  assert.deepEqual(slumpFrame(spec, LOSS_WASH_MS * 3), end);
  let previousDy = -Infinity;
  let previousSaturation = Infinity;
  for (let t = 0; t <= LOSS_WASH_MS; t += 25) {
    const f = slumpFrame(spec, t);
    assert.ok(f.dy >= previousDy - 1e-9, `dy fell backwards at ${t}ms`);
    assert.ok(f.saturation <= previousSaturation + 1e-9, `saturation rose at ${t}ms`);
    previousDy = f.dy;
    previousSaturation = f.saturation;
  }
});

// --- Deadlock (issue #122) -----------------------------------------------

test('constants: the stuck dialog outlasts the grey-out wash', () => {
  assert.ok(
    STUCK_DIALOG_DELAY_MS > STUCK_WASH_MS,
    'the wash should finish well before the dialog interrupts it',
  );
});

test('the stuck dialog waits out STUCK_DIALOG_DELAY_MS, or nothing when the theatre is skipped', () => {
  assert.deepEqual(stuckSchedule(false), { dialogAtMs: STUCK_DIALOG_DELAY_MS });
  assert.deepEqual(stuckSchedule(true), { dialogAtMs: 0 });
});

test('the grey-out is monotonic and exactly final at STUCK_WASH_MS', () => {
  assert.equal(stuckGreyOut(0), 0, 'full colour at rest');
  assert.equal(stuckGreyOut(STUCK_WASH_MS), 1, 'fully desaturated at the end of the wash');
  // Never left mid-fade past the wash's own duration.
  assert.equal(stuckGreyOut(STUCK_WASH_MS * 3), 1);
  let previous = -Infinity;
  for (let t = 0; t <= STUCK_WASH_MS; t += 25) {
    const v = stuckGreyOut(t);
    assert.ok(v >= previous - 1e-9, `desaturation fell backwards at ${t}ms`);
    assert.ok(v >= 0 && v <= 1, `out of range at ${t}ms (${v})`);
    previous = v;
  }
});

test('a pulsing pair is silent outside its own staggered window and peaks once inside it', () => {
  // index 0 starts at STUCK_PULSE_START_MS.
  assert.equal(stuckPulseAlpha(0, 0), 0, 'nothing before its own start');
  assert.equal(stuckPulseAlpha(STUCK_PULSE_START_MS, 0), 0, 'exactly zero at the start edge');
  assert.equal(
    stuckPulseAlpha(STUCK_PULSE_START_MS + STUCK_PULSE_MS, 0),
    0,
    'exactly zero at the end edge',
  );
  assert.equal(
    stuckPulseAlpha(STUCK_PULSE_START_MS + STUCK_PULSE_MS * 2, 0),
    0,
    'never left glowing past its own window',
  );
  let peak = 0;
  for (let t = STUCK_PULSE_START_MS; t <= STUCK_PULSE_START_MS + STUCK_PULSE_MS; t += 10) {
    const a = stuckPulseAlpha(t, 0);
    assert.ok(a >= 0 && a <= 1, `alpha out of [0,1] at ${t}ms (${a})`);
    peak = Math.max(peak, a);
  }
  assert.ok(peak > 0.9, 'the pulse should read as a real flash, not a flicker');
});

test('pulsing pairs are staggered — a later index starts later by STUCK_PULSE_STAGGER_MS', () => {
  for (let index = 0; index < STUCK_PULSE_MAX; index++) {
    const start = STUCK_PULSE_START_MS + index * STUCK_PULSE_STAGGER_MS;
    assert.equal(stuckPulseAlpha(start, index), 0, `index ${index} should not have started yet`);
    assert.ok(stuckPulseAlpha(start + STUCK_PULSE_MS / 2, index) > 0, `index ${index} mid-pulse`);
  }
});
