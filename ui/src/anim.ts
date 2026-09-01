// Feedback timelines. Pure arithmetic: every value the board and tray effects
// need, as a function of elapsed milliseconds. No Pixi, no DOM, no clock —
// effects.ts / tray-fx.ts supply the time and write the result onto display
// objects, which keeps the part worth testing testable headlessly (same split
// as geometry.ts / depth.ts).
//
// Issue #93 moved the match to the tray: a tapped tile flies to the holder
// strip, and a completed pair dwells side by side there before clearing with a
// score popup and a particle burst. The budget stays the issue #44 constraint —
// travel short enough that a fast player is never throttled — and the burst is
// sized to finish inside the clear rather than extending the sequence.

/** Travel time from a tile's board position to its holder slot (issue #93). */
export const TRAY_FLY_MS = 220;
/** How long a completed pair is shown side by side in the tray. */
export const PAIR_SHOW_MS = 180;
/** Scale-and-fade out of the shown pair. */
export const PAIR_CLEAR_MS = 150;
/** Rise-and-fade of the +score popup anchored at the tray. */
export const SCORE_POP_MS = 650;
/** Blocked-tap shake, matched to the red-outline flash in main.ts. */
export const SHAKE_MS = 250;
/** Reveal / re-conceal flip (issue #64). Short enough that peeking around the
 *  board never feels throttled — the peek itself is free and unlimited. */
export const FLIP_MS = 160;
/** Scale the shown pair shrinks to as it clears out of the tray. */
export const END_SCALE = 0.7;
/** Pair-clear particles. Sized to end with the clear, not after it. */
export const PARTICLE_MS = PAIR_CLEAR_MS;
export const PARTICLE_COUNT = 8;

/** Peak shake displacement in board px, at the first swing. */
export const SHAKE_AMPLITUDE = 3;
/** Full oscillations across SHAKE_MS. */
export const SHAKE_CYCLES = 3;

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Particle {
  readonly angle: number;
  /** Board px travelled by the time the burst ends. */
  readonly distance: number;
  readonly radius: number;
}

export interface ParticleFrame {
  /** Offset from the burst centre, px. */
  readonly x: number;
  readonly y: number;
  readonly alpha: number;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Cubic ease-out — particles leave fast and settle. */
export function easeOut(u: number): number {
  const c = 1 - clamp01(u);
  return 1 - c * c * c;
}

/**
 * Reveal / re-conceal flip (issue #64): horizontal scale of the tile at `tMs`.
 *
 * The redraw at tap time has already swapped the art (face or back), so the
 * animation is the *unfold*: the tile opens from its vertical centreline to
 * full width, 0 → 1 with an ease-out so it lands softly. Exactly 1 from
 * FLIP_MS on, so a tile is never left squashed, whatever frame the effect
 * ends on (same guarantee shakeOffset gives).
 */
export function flipScaleX(tMs: number): number {
  return tMs >= FLIP_MS ? 1 : easeOut(tMs / FLIP_MS);
}

/**
 * Blocked-tap shake: a damped sine, in board px along x. Exactly zero at both
 * ends so a tile is never left off its slot, whatever frame the effect ends on.
 */
export function shakeOffset(tMs: number): number {
  if (tMs <= 0 || tMs >= SHAKE_MS) return 0;
  const u = tMs / SHAKE_MS;
  return SHAKE_AMPLITUDE * (1 - u) * Math.sin(2 * Math.PI * SHAKE_CYCLES * u);
}

/**
 * The pair-clear burst, seeded so a given match always throws the same sparks —
 * a test can assert the spread, and a replay looks the same twice.
 *
 * Particles are spaced evenly around the circle and then jittered, so the
 * burst is radial by construction rather than by luck.
 */
export function particleBurst(seed: number): readonly Particle[] {
  // Small LCG (Numerical Recipes constants); a burst needs 3 values apiece.
  let state = Math.imul(seed, 2654435761) >>> 0;
  const random = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  const step = (2 * Math.PI) / PARTICLE_COUNT;
  return Array.from({ length: PARTICLE_COUNT }, (_, i) => ({
    // Jitter stays inside ±40% of a step, so no two particles cross over.
    angle: i * step + (random() - 0.5) * step * 0.8,
    distance: 14 + random() * 10,
    radius: 1.5 + random() * 1.5,
  }));
}

/** One particle's offset from the burst centre, and its opacity. */
export function particleFrame(p: Particle, tMs: number): ParticleFrame {
  const u = clamp01(tMs / PARTICLE_MS);
  const d = p.distance * easeOut(u);
  return { x: Math.cos(p.angle) * d, y: Math.sin(p.angle) * d, alpha: 1 - u };
}
