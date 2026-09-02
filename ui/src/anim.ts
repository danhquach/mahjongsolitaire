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
  const random = lcg(seed);
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

// --- Win celebration (issue #120) ---------------------------------------
//
// Clearing a level plays four effects around the dialog rather than under
// it: a cascade of whatever tile pictures are still on the board (decision
// 0013 means that is usually none — every pair clears in the holder — so the
// effect has to be a graceful no-op on zero tiles, not just a small number),
// lanterns rising from the felt, a light confetti fall, and the dialog's own
// score counting up. All four are driven from here; effects.ts and win-fx.ts
// only own the display objects the curves below are painted onto. The dialog
// itself is never delayed by *these* — main.ts's own timing (WIN_DIALOG_DELAY_MS)
// decides when it appears, and reduced motion cancels all four in favour of a
// plain fade with the final score shown at once.

/** A small linear congruential generator, shared by every seeded layout below
 *  (and by particleBurst) — same constants (Numerical Recipes), so a given
 *  seed always lays out the same burst, lanterns, or confetti. */
function lcg(seed: number): () => number {
  let state = Math.imul(seed, 2654435761) >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/** Delay before the win dialog appears (main.ts's `showStatus`): long enough
 *  for the cascade/lanterns/confetti to read as the reward, short enough that
 *  the dialog and its buttons are live well within the 1s the AC gives a
 *  player who wants straight out. Zero under reduced motion — nothing to wait
 *  for. */
export const WIN_DIALOG_DELAY_MS = 600;
export function scheduleDialogDelay(reduced: boolean): number {
  return reduced ? 0 : WIN_DIALOG_DELAY_MS;
}

/** Score count-up: 0 → final over SCORE_COUNT_MS, eased out (fast start,
 *  gentle landing), exactly `final` from the duration on so the dialog is
 *  never left mid-count whatever frame it stops on. */
export const SCORE_COUNT_MS = 900;
export function scoreCountUp(tMs: number, final: number): number {
  if (tMs <= 0) return 0;
  if (tMs >= SCORE_COUNT_MS) return final;
  return Math.round(final * easeOut(tMs / SCORE_COUNT_MS));
}

/** Tile cascade: remaining board tiles lift and sweep off, column by column.
 *  `column` is any non-negative number that orders tiles left to right (main.ts
 *  passes the tile's own slot.x) — the stagger is proportional to it, so the
 *  wave reads the same whether columns are packed or sparse. */
export const CASCADE_TILE_MS = 700;
export const CASCADE_COLUMN_STAGGER_MS = 40;
export const CASCADE_LIFT_PX = 14;
export const CASCADE_SWEEP_PX = 220;

export interface CascadeFrame {
  readonly dx: number;
  readonly dy: number;
  readonly alpha: number;
}

/** Total span of a cascade across `columns` columns (0-based count) — the
 *  last column's tile finishes CASCADE_TILE_MS after its own stagger start. */
export function cascadeDurationMs(columns: number): number {
  return columns <= 0 ? 0 : (columns - 1) * CASCADE_COLUMN_STAGGER_MS + CASCADE_TILE_MS;
}

export function cascadeFrame(tMs: number, column: number): CascadeFrame {
  const start = column * CASCADE_COLUMN_STAGGER_MS;
  const local = tMs - start;
  if (local <= 0) return { dx: 0, dy: 0, alpha: 1 };
  if (local >= CASCADE_TILE_MS) return { dx: CASCADE_SWEEP_PX, dy: 0, alpha: 0 };
  const u = easeOut(local / CASCADE_TILE_MS);
  return {
    dx: CASCADE_SWEEP_PX * u,
    dy: -CASCADE_LIFT_PX * Math.sin(Math.PI * u),
    alpha: 1 - u,
  };
}

/** 4–6 lanterns (issue #120): fixed at 5, drifting up with a gentle sway,
 *  fading as they rise. Tint comes from the board palette, at the call site —
 *  the curve here only owns position and opacity. */
export const LANTERN_MS = 3000;
export const LANTERN_COUNT = 5;
export const LANTERN_RISE_PX = 260;
export const LANTERN_SWAY_PX = 16;

export interface LanternSpec {
  /** Horizontal start, as a fraction (0..1) of the celebration area. */
  readonly x0: number;
  readonly swayPhase: number;
}

export function lanternLayout(seed: number, count: number = LANTERN_COUNT): readonly LanternSpec[] {
  const random = lcg(seed);
  return Array.from({ length: count }, (_, i) => ({
    x0: (i + 0.5 + (random() - 0.5) * 0.6) / count,
    swayPhase: random() * Math.PI * 2,
  }));
}

export interface LanternFrame {
  readonly x: number;
  readonly y: number;
  readonly alpha: number;
}

/** A lantern's offset from its start point, and its opacity — `y` decreases
 *  (rises) monotonically over LANTERN_MS while `alpha` fades from 1 to 0, so a
 *  lantern is never left half-risen and opaque past its own duration. */
export function lanternFrame(spec: LanternSpec, tMs: number): LanternFrame {
  const u = clamp01(tMs / LANTERN_MS);
  return {
    x: Math.sin(u * Math.PI * 2 + spec.swayPhase) * LANTERN_SWAY_PX,
    y: -LANTERN_RISE_PX * easeOut(u),
    alpha: 1 - u,
  };
}

/** A light confetti fall (issue #120): ~2.5s, gold/cream/green (colour picked
 *  at the call site by `colorIndex`), gone well within the 3s the lanterns
 *  take. */
export const CONFETTI_MS = 2500;
export const CONFETTI_COUNT = 20;
export const CONFETTI_FALL_PX = 300;
export const CONFETTI_SPREAD_MS = 500;

export interface ConfettiSpec {
  readonly x0: number;
  readonly driftPx: number;
  readonly rotationSpeedDeg: number;
  readonly delayMs: number;
  readonly colorIndex: number;
}

export function confettiLayout(seed: number, count: number = CONFETTI_COUNT): readonly ConfettiSpec[] {
  const random = lcg(seed);
  return Array.from({ length: count }, () => ({
    x0: random(),
    driftPx: (random() - 0.5) * 120,
    rotationSpeedDeg: (random() - 0.5) * 720,
    delayMs: random() * CONFETTI_SPREAD_MS,
    colorIndex: Math.floor(random() * 3),
  }));
}

export interface ConfettiFrame {
  readonly x: number;
  readonly y: number;
  readonly rotationDeg: number;
  readonly alpha: number;
}

/** A confetti piece's offset and opacity, `tMs` since the burst started (its
 *  own `delayMs` staggers the fall inside that). `y` grows monotonically
 *  (falling) over its own CONFETTI_MS while `alpha` fades 1 → 0, deterministic
 *  given the spec — a replay throws the same piece the same way twice. */
export function confettiFrame(spec: ConfettiSpec, tMs: number): ConfettiFrame {
  const local = tMs - spec.delayMs;
  if (local < 0) return { x: 0, y: 0, rotationDeg: 0, alpha: 0 };
  const u = clamp01(local / CONFETTI_MS);
  return {
    x: spec.driftPx * u,
    y: CONFETTI_FALL_PX * u,
    rotationDeg: spec.rotationSpeedDeg * u,
    alpha: 1 - u,
  };
}
