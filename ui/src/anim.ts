// Match feedback timeline (issue #44). Pure arithmetic: every value the match
// and mismatch animations need, as a function of elapsed milliseconds. No Pixi,
// no DOM, no clock — effects.ts supplies the time and writes the result onto
// display objects, which keeps the part worth testing testable headlessly
// (same split as geometry.ts / depth.ts).
//
// The budget is the design constraint: the ticket allows 400ms end to end, so
// a fast player is never throttled. 200ms of travel plus 120ms of fade leaves
// 80ms of headroom, and the particle burst is sized to finish inside the fade
// rather than extending the sequence.

/** Travel time from a tile's own centre to the pair's midpoint. */
export const TRAVEL_MS = 200;
/** Scale-and-fade out after the collision. */
export const FADE_MS = 120;
/** Reduced motion: no travel at all, just a cross-fade of the same two tiles. */
export const CROSSFADE_MS = 160;
/** Mismatch shake, matched to the existing red-outline flash in main.ts. */
export const SHAKE_MS = 250;
/** Reveal / re-conceal flip (issue #64). Short enough that peeking around the
 *  board never feels throttled — the peek itself is free and unlimited. */
export const FLIP_MS = 160;
/** Impact particles. Sized to end with the fade, not after it. */
export const PARTICLE_MS = FADE_MS;
export const PARTICLE_COUNT = 8;

/** Scale at the moment of impact — a punch, not a pop. */
export const PUNCH_PEAK = 1.18;
/** Scale the tile shrinks to as it fades out. */
export const END_SCALE = 0.7;
/** Peak shake displacement in board px, at the first swing. */
export const SHAKE_AMPLITUDE = 3;
/** Full oscillations across SHAKE_MS. */
export const SHAKE_CYCLES = 3;

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** One flying tile at one instant: centre, scale, opacity, white-flash strength. */
export interface TileFrame {
  readonly cx: number;
  readonly cy: number;
  readonly scale: number;
  readonly alpha: number;
  /** 0 = the tile's own colours, 1 = fully whited out. */
  readonly flash: number;
}

export interface Particle {
  readonly angle: number;
  /** Board px travelled by the time the burst ends. */
  readonly distance: number;
  readonly radius: number;
}

export interface ParticleFrame {
  /** Offset from the impact point, board px. */
  readonly x: number;
  readonly y: number;
  readonly alpha: number;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Cubic ease-in: the tiles accelerate into the hit instead of coasting. */
export function easeIn(u: number): number {
  const c = clamp01(u);
  return c * c * c;
}

/** Cubic ease-out — particles leave fast and settle. */
export function easeOut(u: number): number {
  const c = 1 - clamp01(u);
  return 1 - c * c * c;
}

/** When the collision lands. Reduced motion has no travel, so it lands at once. */
export function impactAt(reduced: boolean): number {
  return reduced ? 0 : TRAVEL_MS;
}

/** Total length of the sequence, impact included. */
export function matchDuration(reduced: boolean): number {
  return reduced ? CROSSFADE_MS : TRAVEL_MS + FADE_MS;
}

/**
 * One flying tile at `tMs`.
 *
 * `from` is the tile's own centre, `to` the midpoint of the pair — both in
 * board px. Reduced motion pins the position and scale and moves only opacity
 * and flash, which is the ticket's "plain cross-fade, keeping the flash".
 */
export function matchFrame(from: Point, to: Point, tMs: number, reduced: boolean): TileFrame {
  if (reduced) {
    const u = clamp01(tMs / CROSSFADE_MS);
    return { cx: from.x, cy: from.y, scale: 1, alpha: 1 - u, flash: 1 - u };
  }
  if (tMs < TRAVEL_MS) {
    const u = easeIn(tMs / TRAVEL_MS);
    return {
      cx: from.x + (to.x - from.x) * u,
      cy: from.y + (to.y - from.y) * u,
      scale: 1,
      alpha: 1,
      // A little pre-flash on the last stretch, so the hit is not the first
      // frame anything happens.
      flash: u * 0.35,
    };
  }
  const f = clamp01((tMs - TRAVEL_MS) / FADE_MS);
  return {
    cx: to.x,
    cy: to.y,
    scale: PUNCH_PEAK + (END_SCALE - PUNCH_PEAK) * f,
    alpha: 1 - f,
    flash: 1 - f,
  };
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
 * Mismatch shake: a damped sine, in board px along x. Exactly zero at both
 * ends so a tile is never left off its slot, whatever frame the effect ends on.
 */
export function shakeOffset(tMs: number): number {
  if (tMs <= 0 || tMs >= SHAKE_MS) return 0;
  const u = tMs / SHAKE_MS;
  return SHAKE_AMPLITUDE * (1 - u) * Math.sin(2 * Math.PI * SHAKE_CYCLES * u);
}

/**
 * The impact burst, seeded so a given match always throws the same sparks —
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

/** One particle's offset from the impact point, and its opacity. */
export function particleFrame(p: Particle, tMs: number): ParticleFrame {
  const u = clamp01(tMs / PARTICLE_MS);
  const d = p.distance * easeOut(u);
  return { x: Math.cos(p.angle) * d, y: Math.sin(p.angle) * d, alpha: 1 - u };
}
