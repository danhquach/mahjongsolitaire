// What today's play has done against today's three challenges (issue #183).
//
// One key, one small record. The date is stored *with* the counters, and a
// stored date that is not today reads as zeros — the same compute-on-read
// trick as `weekScoreNow`, so the day rolls over the moment the local calendar
// does and no timer has to fire at midnight for the panel to be right.
//
// Progress is the day's, not the board's: a loss, a restart and an abandoned
// board all keep what they earned. The only counter that ever falls is the
// clean run, which a charged hint or shuffle sends back to zero.
//
// The date is the caller's — `dailyDateKey()` in main.ts, the same local
// calendar date the streak is keyed to. Passing it in keeps this store as
// clock-free as core is.

import { DAILY_CHALLENGE_COUNT, dailyChallenges } from '@mahjongsolitaire/core';
import type { DailyChallenge, FaceSuit } from '@mahjongsolitaire/core';
import { readRecord, writeRecord } from './storage.js';
import type { KeyValueStorage } from './storage.js';

export const DAILY_STORAGE_KEY = 'mahjong.daily.v1';

/** One challenge and where the player stands on it today. */
export interface DailyStanding {
  readonly challenge: DailyChallenge;
  readonly count: number;
  readonly done: boolean;
}

interface DailyDoc {
  date: string | null;
  counts: number[];
  done: boolean[];
}

function fresh(date: string | null): DailyDoc {
  return { date, counts: [0, 0, 0], done: [false, false, false] };
}

/** Per-field tolerance, like parsePlayerRecord: anything unreadable is simply
 *  a day with no progress, never a boot failure. */
function parseDaily(record: unknown): DailyDoc {
  if (typeof record !== 'object' || record === null || Array.isArray(record)) return fresh(null);
  const raw = record as Record<string, unknown>;
  const slots = <T>(value: unknown, ok: (v: unknown) => v is T, fallback: T): T[] =>
    Array.from({ length: DAILY_CHALLENGE_COUNT }, (_, i) => {
      const v = Array.isArray(value) ? value[i] : undefined;
      return ok(v) ? v : fallback;
    });
  return {
    date: typeof raw['date'] === 'string' ? raw['date'] : null,
    counts: slots(
      raw['counts'],
      (v): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0,
      0,
    ),
    done: slots(raw['done'], (v): v is boolean => typeof v === 'boolean', false),
  };
}

export class DailyStore {
  private doc: DailyDoc;

  constructor(
    private readonly storage: KeyValueStorage | undefined = undefined,
    private readonly key = DAILY_STORAGE_KEY,
  ) {
    this.doc = parseDaily(readRecord(storage, key));
  }

  /** The day's record, reset in memory when the stored date is not `today`.
   *  Not persisted here: a day the player never touches must not overwrite the
   *  record just because the panel was opened. */
  private forDay(today: string): DailyDoc {
    if (this.doc.date !== today) this.doc = fresh(today);
    return this.doc;
  }

  /** Today's three challenges and where the player stands on each. Counts are
   *  clamped to the target, so a record written by a build with higher targets
   *  can never render "99 / 20". */
  standing(today: string): readonly DailyStanding[] {
    const doc = this.forDay(today);
    return dailyChallenges(today).map((challenge, i) => ({
      challenge,
      count: Math.min(doc.counts[i] ?? 0, challenge.target),
      done: doc.done[i] ?? false,
    }));
  }

  /** How many of today's three are complete. */
  completedCount(today: string): number {
    return this.forDay(today).done.filter(Boolean).length;
  }

  /** Add one to every unfinished slot whose challenge `feeds` accepts, and
   *  report the slots that completed on this call — the caller pays for those. */
  private advance(today: string, feeds: (challenge: DailyChallenge) => boolean): readonly number[] {
    const doc = this.forDay(today);
    const completed: number[] = [];
    dailyChallenges(today).forEach((challenge, i) => {
      if (doc.done[i] === true || !feeds(challenge)) return;
      const count = Math.min((doc.counts[i] ?? 0) + 1, challenge.target);
      doc.counts[i] = count;
      if (count >= challenge.target) {
        doc.done[i] = true;
        completed.push(i);
      }
    });
    this.persist();
    return completed;
  }

  /** A pair of `suit` was matched: the pair count, the matching suit count and
   *  the clean run all move. `suit` is any of the six — Winds, Dragons and
   *  Seasons simply match no challenge, since none names them. */
  onMatch(today: string, suit: FaceSuit): readonly number[] {
    return this.advance(
      today,
      (c) => c.kind === 'pairs' || c.kind === 'clean-run' || (c.kind === 'suit' && c.suit === suit),
    );
  }

  /** A board was finished. */
  onBoardCleared(today: string): readonly number[] {
    return this.advance(today, (c) => c.kind === 'boards');
  }

  /** A hint or a shuffle was charged: the clean run starts again. A run that
   *  already completed stays complete — the challenge was met before the
   *  assist, and nothing in this game takes a reward back. */
  onAssist(today: string): void {
    const doc = this.forDay(today);
    dailyChallenges(today).forEach((challenge, i) => {
      if (challenge.kind === 'clean-run' && doc.done[i] !== true) doc.counts[i] = 0;
    });
    this.persist();
  }

  private persist(): void {
    writeRecord(this.storage, this.key, this.doc);
  }
}

const SUIT_LABEL: Record<string, string> = { dots: 'Dots', bamboo: 'Bamboo', char: 'Characters' };

/** The goal, as the panel and the announcer both say it (issue #183). */
export function describeChallenge(challenge: DailyChallenge): string {
  const n = challenge.target;
  switch (challenge.kind) {
    case 'boards':
      return `Finish ${n} ${n === 1 ? 'board' : 'boards'}`;
    case 'pairs':
      return `Match ${n} pairs`;
    case 'suit':
      return `Match ${n} ${SUIT_LABEL[challenge.suit ?? ''] ?? 'tile'} pairs`;
    case 'clean-run':
      return `Match ${n} pairs in a row without a hint or shuffle`;
  }
}
