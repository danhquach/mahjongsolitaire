// What a calendar date asks for (issue #183): three challenges the player
// completes by playing the ladder — there is no Daily board any more.
//
// A pure function of the date key, like the board deal it replaces: two
// players on the same calendar date get the same three goals, with no server
// and no account. The four kinds are shuffled by the date and the first three
// taken, so a day never serves two of a kind — "match 20 pairs / 40 pairs /
// 60 pairs" would be one challenge asked three times.
//
// Targets are a pinned table rather than a formula. A formula would make every
// re-balance a silent re-deal of every past date, and these numbers are a
// product decision (design 2026-09-03), not arithmetic.

import { isDateKey } from './daily.js';
import type { FaceSuit } from './faces.js';
import { hashString } from './rng.js';

export type ChallengeKind = 'boards' | 'pairs' | 'suit' | 'clean-run';

/** The suits a challenge may name. Dots, Bamboo and Characters have 18 pairs
 *  each on a full board; Winds, Dragons and Seasons top out at 8, 6 and 4, so
 *  no target worth setting fits them. */
export type ChallengeSuit = Extract<FaceSuit, 'dots' | 'bamboo' | 'char'>;

export interface DailyChallenge {
  readonly kind: ChallengeKind;
  /** Matches, boards or consecutive matches to reach — always ≥ 1. */
  readonly target: number;
  /** Only on `suit`. */
  readonly suit?: ChallengeSuit;
}

export const CHALLENGE_KINDS: readonly ChallengeKind[] = ['boards', 'pairs', 'suit', 'clean-run'];

export const CHALLENGE_SUITS: readonly ChallengeSuit[] = ['dots', 'bamboo', 'char'];

/** How many challenges a date serves. */
export const DAILY_CHALLENGE_COUNT = 3;

/** Targets by kind and slot: light, medium, heavy. `boards` caps at 2 even in
 *  the heavy slot (PM, 2026-09-03) — three finished boards on a slow level is
 *  a whole evening. */
const TARGETS: Record<ChallengeKind, readonly [number, number, number]> = {
  boards: [1, 2, 2],
  pairs: [20, 40, 60],
  suit: [6, 10, 16],
  'clean-run': [5, 8, 12],
};

/** The four kinds in a date-determined order: a Fisher-Yates driven by one
 *  hash, stepped with xorshift32 between draws so consecutive dates do not
 *  shuffle alike. Integer-only, like every other hash here, so every runtime
 *  agrees bit-for-bit. */
function shuffledKinds(dateKey: string): ChallengeKind[] {
  const kinds = [...CHALLENGE_KINDS];
  let state = hashString(`daily-challenges:${dateKey}`);
  for (let i = kinds.length - 1; i > 0; i--) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    const j = state % (i + 1);
    [kinds[i], kinds[j]] = [kinds[j]!, kinds[i]!];
  }
  return kinds;
}

/**
 * The three challenges for `dateKey`, light first. Same date, same three, on
 * every device and every runtime.
 */
export function dailyChallenges(
  dateKey: string,
): readonly [DailyChallenge, DailyChallenge, DailyChallenge] {
  if (!isDateKey(dateKey)) throw new RangeError(`not a date key: ${dateKey}`);
  const kinds = shuffledKinds(dateKey);
  const suit = CHALLENGE_SUITS[hashString(`daily-suit:${dateKey}`) % CHALLENGE_SUITS.length]!;
  const slot = (index: 0 | 1 | 2): DailyChallenge => {
    const kind = kinds[index]!;
    const target = TARGETS[kind][index];
    return kind === 'suit' ? { kind, target, suit } : { kind, target };
  };
  return [slot(0), slot(1), slot(2)];
}
