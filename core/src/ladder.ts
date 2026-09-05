// The v1 plateau ladder (spec §4 as amended by decision 0011, issue #18).
//
// 150 levels in three flat bands — 1–20 easy, 21–60 medium, 61–150 medium-plus
// — with every 10th level spiking one band up (medium inside the easy band,
// hard elsewhere). No rising curve and no separate relief levels: the nine
// base levels of each decade are the relief.
//
// Bands are score windows over `difficultyScore`. Issue #212 rebalanced the
// score around pair density (initial free pairs and witness-path branching);
// the 40-seed sweep per layout on 2026-09-04 puts the ten compact portrait
// layouts' unconstrained medians at spider 0.22, butterfly 0.26, windmill
// 0.30, cat 0.32, turtle_classic 0.47, pyramid 0.50, terrace 0.54, moon_gate
// 0.63, fortress 0.67, bridge 0.71. The windows below are drawn over that
// spread; build-ladder then picks, per level, a seed inside its band window,
// so a layout whose median sits just outside its window (turtle_classic,
// medium) still ships only seeds that are in it.
// Medium-plus is decision 0011's "upper half of the Medium score range": the
// medium window is [0.30, 0.60) and its midpoint 0.45 splits base medium
// (below) from medium-plus (at or above). Windows are disjoint and ordered, so
// the ladder ordering criterion — a spike never scores below its decade's
// base levels, no medium-plus level below the medium median — holds by
// construction and is asserted directly by core/test/ladder.test.ts, the
// permanent release gate.
//
// Full holder-aware calibration (decisions 0008/0009) and concealment
// re-balance (decision 0010) are deferred; see issue #18.

import { CONCEAL_RATIO } from './conceal.js';
import { FLAWLESS_RUN_POINTS } from './scoring.js';
import type { DifficultyBucket } from './difficulty.js';

export const LADDER_LENGTH = 150;

export type LadderBand = 'easy' | 'medium' | 'medium-plus' | 'hard';

/** Score windows per band: min inclusive, max exclusive. */
export const LADDER_WINDOWS: Record<LadderBand, { readonly min: number; readonly max: number }> = {
  easy: { min: 0, max: 0.3 },
  medium: { min: 0.3, max: 0.45 },
  'medium-plus': { min: 0.45, max: 0.6 },
  hard: { min: 0.6, max: 0.8 },
};

/**
 * Layout pools per band (issue #99): the layouts a band's levels draw from —
 * both in the shipped ladder (build-ladder searches only the level's pool)
 * and in play (New game deals the next layout from the current band's pool
 * with a fresh seed; see decision 0015). Assignment follows the 40-seed
 * sweep on the pair-density score (issue #212): the loosest silhouettes serve
 * easy, the densest stacks serve the hard spikes. Spider moved from medium to
 * easy with that sweep — it deals the most initial pairs of any layout.
 */
export const LADDER_POOLS: Record<LadderBand, readonly string[]> = {
  easy: ['spider', 'butterfly', 'windmill'],
  medium: ['cat', 'turtle_classic'],
  'medium-plus': ['pyramid', 'terrace'],
  hard: ['fortress', 'moon_gate', 'bridge'],
};

/**
 * The layout New game deals next (issue #99): the entry after `currentId` in
 * the band's pool, wrapping around. A current layout from outside the pool
 * (an older save) starts the rotation at the pool's first entry.
 */
export function nextPoolLayout(band: LadderBand, currentId: string): string {
  const pool = LADDER_POOLS[band];
  const index = pool.indexOf(currentId);
  return pool[(index + 1) % pool.length]!;
}

export interface LadderPosition {
  readonly band: LadderBand;
  /** True on every 10th level — the decade's milestone, one band up. */
  readonly spike: boolean;
}

function baseBand(level: number): LadderBand {
  if (level <= 20) return 'easy';
  if (level <= 60) return 'medium';
  return 'medium-plus';
}

export function bandForLevel(level: number): LadderPosition {
  if (!Number.isInteger(level) || level < 1 || level > LADDER_LENGTH) {
    throw new RangeError(`level out of ladder range 1..${LADDER_LENGTH}: ${level}`);
  }
  const base = baseBand(level);
  if (level % 10 !== 0) return { band: base, spike: false };
  return { band: base === 'easy' ? 'medium' : 'hard', spike: true };
}

/**
 * The concealment band a ladder level plays at (decision 0011): easy 0%,
 * medium and medium-plus 8%, hard spikes 15%. Expert never ships in v1.
 *
 * Still the whole story for the Daily, which has a fixed band and no level
 * number; the ladder now goes through `concealRatioForLevel` instead.
 */
export function concealBucketForBand(band: LadderBand): DifficultyBucket {
  return band === 'medium-plus' ? 'medium' : band;
}

/**
 * How much a level's band multiplies every pair's score (issue #176).
 *
 * The weekly leaderboard ranks by score earned, and the profile shows that
 * same number, so a flat score would make grinding the easiest level the best
 * way to climb. Scaling by band means a harder level is worth more per match
 * and level 1 is the *worst* board to farm — the ordering does the work, so no
 * once-per-week or first-clear-only rule is needed (PM, 2026-09-03).
 *
 * Keyed on the band rather than the level number so a decade spike is paid at
 * the band it actually plays at: `bandForLevel` reports level 10 as medium and
 * level 30 as hard, and each is worth its spike.
 */
export const BAND_SCORE_MULTIPLIER: Record<LadderBand, number> = {
  easy: 1,
  medium: 1.5,
  'medium-plus': 2,
  hard: 2.5,
};

/** The score multiplier a ladder level plays at. */
export function scoreMultiplierForLevel(level: number): number {
  return BAND_SCORE_MULTIPLIER[bandForLevel(level).band];
}

/** The most any single run can pay: a flawless 144-tile board on the highest
 *  multiplier the ladder can deal. The leaderboard bounds each submitted score
 *  by this — never the standing it accumulates into (issue #176). */
export const MAX_RUN_SCORE = FLAWLESS_RUN_POINTS * Math.max(...Object.values(BAND_SCORE_MULTIPLIER));

/**
 * Face-down tiles inside the easy band (issue #175). Concealment used to
 * follow the band alone, so the easy band concealed nothing and the first
 * face-down tile a player ever met was on level 10 — nine levels before the
 * peek mechanic was introduced. Levels 1–4 stay the teaching levels; from 5
 * on, every level deals some tiles face-down, ramping once inside the band.
 */
export const EASY_CONCEAL_RATIO = {
  /** Levels 1–4: fully face-up while the game is still being taught. */
  teaching: 0,
  /** Levels 5–9: the introduction, 5 tiles of a 144-tile deal. */
  lower: 0.04,
  /** Levels 11–19: 8 tiles of a 144-tile deal. */
  upper: 0.06,
} as const;

/** First level that deals any tile face-down. */
export const FIRST_CONCEALED_LEVEL = 5;

/**
 * The fraction of a deal dealt face-down at ladder `level`.
 *
 * Only the easy band's *base* levels ramp. Every other level keeps its band's
 * bucket ratio, so the decade spikes are untouched: `bandForLevel` already
 * reports level 10 and level 20 as medium, and they keep concealing at 8% —
 * a step above the base levels on either side, the way every other spike sits
 * above its decade (PM, 2026-09-03). That is why this reads `band`, not
 * `level <= 20`.
 */
export function concealRatioForLevel(level: number): number {
  const { band } = bandForLevel(level);
  if (band !== 'easy') return CONCEAL_RATIO[concealBucketForBand(band)];
  if (level < FIRST_CONCEALED_LEVEL) return EASY_CONCEAL_RATIO.teaching;
  return level <= 9 ? EASY_CONCEAL_RATIO.lower : EASY_CONCEAL_RATIO.upper;
}

export interface LadderEntry {
  /** 1-based ladder position. */
  readonly level: number;
  readonly layoutId: string;
  readonly seed: number;
}

/** Validates the shape of data/ladder.json (150 entries, levels 1..150 in order). */
export function parseLadder(doc: unknown): LadderEntry[] {
  if (!Array.isArray(doc)) throw new TypeError('ladder file: expected an array');
  if (doc.length !== LADDER_LENGTH) {
    throw new RangeError(`ladder file: expected ${LADDER_LENGTH} entries, got ${doc.length}`);
  }
  return doc.map((raw: unknown, i) => {
    if (typeof raw !== 'object' || raw === null) {
      throw new TypeError(`ladder entry ${i}: expected an object`);
    }
    const { level, layoutId, seed } = raw as Record<string, unknown>;
    if (level !== i + 1) throw new RangeError(`ladder entry ${i}: expected level ${i + 1}, got ${String(level)}`);
    if (typeof layoutId !== 'string' || layoutId.length === 0) {
      throw new TypeError(`ladder entry ${i}: bad layoutId`);
    }
    if (typeof seed !== 'number' || !Number.isInteger(seed) || seed < 0) {
      throw new TypeError(`ladder entry ${i}: bad seed`);
    }
    return { level, layoutId, seed };
  });
}
