// The v1 plateau ladder (spec §4 as amended by decision 0011, issue #18).
//
// 150 levels in three flat bands — 1–20 easy, 21–60 medium, 61–150 medium-plus
// — with every 10th level spiking one band up (medium inside the easy band,
// hard elsewhere). No rising curve and no separate relief levels: the nine
// base levels of each decade are the relief.
//
// Bands are score windows over `difficultyScore`, not the provisional global
// buckets in difficulty.ts: every shipped layout is a full 144-tile set, and
// the size-dominant score puts all of them in [0.576, 0.78] (40-seed sweep per
// layout, 2026-09-01, on the issue #99 compact portrait geometry — the deeper
// stacks raised the whole range, so the windows were redrawn from that sweep
// by decision 0011's own construction). Medium-plus is decision 0011's "upper
// half of the Medium score range": the medium window is [0.592, 0.650) and
// its midpoint 0.624 splits base medium (below) from medium-plus (at or
// above). Windows are disjoint and ordered, so the ladder ordering criterion
// — a spike never scores below its decade's base levels, no medium-plus level
// below the medium median — holds by construction and is asserted directly by
// core/test/ladder.test.ts, the permanent release gate.
//
// Full holder-aware calibration (decisions 0008/0009) and concealment
// re-balance (decision 0010) are deferred; see issue #18.

import type { DifficultyBucket } from './difficulty.js';

export const LADDER_LENGTH = 150;

export type LadderBand = 'easy' | 'medium' | 'medium-plus' | 'hard';

/** Score windows per band: min inclusive, max exclusive. */
export const LADDER_WINDOWS: Record<LadderBand, { readonly min: number; readonly max: number }> = {
  easy: { min: 0, max: 0.592 },
  medium: { min: 0.592, max: 0.624 },
  'medium-plus': { min: 0.624, max: 0.65 },
  hard: { min: 0.65, max: 0.8 },
};

/**
 * Layout pools per band (issue #99): the layouts a band's levels draw from —
 * both in the shipped ladder (build-ladder searches only the level's pool)
 * and in play (New game deals the next layout from the current band's pool
 * with a fresh seed; see decision 0015). Assignment follows the 40-seed
 * sweep: the loosest, shallowest silhouettes serve easy, the densest stacks
 * serve the hard spikes.
 */
export const LADDER_POOLS: Record<LadderBand, readonly string[]> = {
  easy: ['butterfly', 'windmill'],
  medium: ['spider', 'cat', 'turtle_classic'],
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
 */
export function concealBucketForBand(band: LadderBand): DifficultyBucket {
  return band === 'medium-plus' ? 'medium' : band;
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
