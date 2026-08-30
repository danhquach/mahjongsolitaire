// Scoring + Super Combo (spec §6, issue #6).
//
// Deterministic: timestamps are inputs (ms, monotonic — e.g. elapsed game
// time), never read from a clock, so replays (spec §9) score identically.

export const BASE_PAIR_POINTS = 100;
export const COMBO_WINDOW_MS = 5000;

/** Multiplier for the Nth consecutive in-window match after the first. */
const COMBO_LADDER = [1.2, 1.5, 2.0, 3.0] as const;

export interface MatchScore {
  readonly points: number;
  readonly multiplier: number;
}

/**
 * Tracks total score and the Super Combo ladder. Consecutive matches ≤5s
 * apart (measured from the previous match, boundary inclusive) escalate
 * ×1.2 → ×1.5 → ×2.0 → cap ×3.0. A mismatch or timeout resets the ladder to
 * ×1. Purely additive — nothing ever deducts points.
 */
export class ScoreKeeper {
  private score = 0;
  private streak = 0; // consecutive in-window matches so far
  private lastMatchMs: number | null = null;

  get total(): number {
    return this.score;
  }

  recordMatch(nowMs: number): MatchScore {
    if (this.lastMatchMs !== null && nowMs < this.lastMatchMs) {
      throw new RangeError(`timestamps must be monotonic: ${nowMs} < ${this.lastMatchMs}`);
    }
    const inWindow = this.lastMatchMs !== null && nowMs - this.lastMatchMs <= COMBO_WINDOW_MS;
    this.streak = inWindow ? this.streak + 1 : 1;
    this.lastMatchMs = nowMs;

    const rung = Math.min(this.streak - 2, COMBO_LADDER.length - 1);
    const multiplier = rung < 0 ? 1 : COMBO_LADDER[rung]!;
    const points = Math.round(BASE_PAIR_POINTS * multiplier);
    this.score += points;
    return { points, multiplier };
  }

  /** A failed pair attempt breaks the combo; it never costs points (§6). */
  recordMismatch(): void {
    this.streak = 0;
    this.lastMatchMs = null;
  }
}
