// Scoring + Super Combo (spec §6, issue #6).
//
// Deterministic: timestamps are inputs (ms, monotonic — e.g. elapsed game
// time), never read from a clock, so replays (spec §9) score identically.

export const BASE_PAIR_POINTS = 100;
export const COMBO_WINDOW_MS = 5000;

/** Multiplier for the Nth consecutive in-window match after the first. */
const COMBO_LADDER = [1.2, 1.5, 2.0, 3.0] as const;

/** The best a flawless 144-tile run can pay at a difficulty multiplier of 1:
 *  the first match at ×1, then the ladder's ×1.2, ×1.5, ×2.0, and ×3.0 for
 *  every match after that.
 *
 *      100 + 120 + 150 + 200 + 68 × 300 = 20970
 *
 *  Nothing in the game deducts points, so this is a hard ceiling. The
 *  leaderboard's per-submission bound is this times the highest difficulty
 *  multiplier any level can carry (issue #176). */
export const FLAWLESS_RUN_POINTS = 20970;

export interface MatchScore {
  readonly points: number;
  readonly multiplier: number;
}

/** Full ScoreKeeper state, opaque to callers — for undo (spec §5, issue #10). */
export interface ScoreSnapshot {
  readonly score: number;
  readonly streak: number;
  readonly lastMatchMs: number | null;
}

/**
 * Tracks total score and the Super Combo ladder. Consecutive matches ≤5s
 * apart (measured from the previous match, boundary inclusive) escalate
 * ×1.2 → ×1.5 → ×2.0 → cap ×3.0. A mismatch or timeout resets the ladder to
 * ×1. Purely additive — nothing ever deducts points.
 *
 * `difficulty` (issue #176) scales every pair by the level's band, so a hard
 * level pays more per match than an easy one and grinding level 1 is the
 * worst way to earn. It multiplies the *pair*, not the total, so it survives
 * undo and a resumed snapshot without being re-applied: a snapshot stores the
 * points already awarded, never a pre-multiplier figure.
 */
export class ScoreKeeper {
  private score = 0;
  private streak = 0; // consecutive in-window matches so far
  private lastMatchMs: number | null = null;

  constructor(private readonly difficulty: number = 1) {}

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
    const points = Math.round(BASE_PAIR_POINTS * multiplier * this.difficulty);
    this.score += points;
    return { points, multiplier };
  }

  /** A failed pair attempt breaks the combo; it never costs points (§6). */
  recordMismatch(): void {
    this.streak = 0;
    this.lastMatchMs = null;
  }

  snapshot(): ScoreSnapshot {
    return { score: this.score, streak: this.streak, lastMatchMs: this.lastMatchMs };
  }

  /** Undo (spec §5): rewind to a prior snapshot, combo ladder included. */
  restore(s: ScoreSnapshot): void {
    this.score = s.score;
    this.streak = s.streak;
    this.lastMatchMs = s.lastMatchMs;
  }
}
