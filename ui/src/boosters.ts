// Booster charge accounting (issue #13, spec §5). Charges are the whole
// economy: every player starts with a grant of each booster and spends one
// charge per *successful* use. Replenishment is issue #51 — three
// ads-independent channels, so a player who runs dry can always earn charges
// back without enabling ads or buying anything (PM numbers, 2026-08-31):
//
//   * every third *distinct* level first-cleared: +1 of a random type — the
//     dialog announces what landed, the player never picks (issue #117; the
//     per-level first-clear grant #51 had was dropped there as too easy to
//     stock up on). Replays never count: levels are one tap from a restart,
//     and a grant per completion would mint charges off one easy level;
//   * milestone level (the decade spike — 10, 20, 30, …) first-cleared:
//     +1 of *each* type — the hard level pays the full set (issue #117);
//   * daily first launch: +1 of each, once per calendar day — the renewable
//     trickle that covers a player who is completely out.
//
// Both level channels can land on one clear (level 30 first-cleared as the
// 15th distinct clear); the dialog lists each.
//
// Every channel clamps at BOOSTER_CAP (99) rather than refusing. Rewarded
// video and an IAP bundle (spec §5) would sit on top of this later; the game
// is never dependent on ads being on to stay playable.
//
// Balances persist across restarts (issue #13 acceptance criterion) through an
// injectable key/value store — `localStorage` in the browser, a plain object in
// tests. Storage is best-effort: Safari private mode throws on write, and a
// corrupt or absent record falls back to a fresh grant rather than failing to
// boot. The daily-login date rides in the same record as the balances, so a
// failed write loses both together and the next launch simply grants again
// from the balance it actually persisted — never twice on top of a grant that
// stuck. The full board auto-save is issue #14; this only owns the charges.

import { daysBetween, isDateKey } from '@mahjongsolitaire/core';

export type BoosterKind = 'hint' | 'undo' | 'shuffle';

export const BOOSTER_KINDS: readonly BoosterKind[] = ['hint', 'undo', 'shuffle'];

/** Spec §5 / issue #13: starting grant, per booster. */
export const STARTING_GRANT = 5;

/** Issue #51 (PM, 2026-08-31): the ceiling any channel clamps to — a
 *  two-digit display, and no unbounded integer. */
export const BOOSTER_CAP = 99;
/** Every THIRD_CLEAR_EVERY distinct first-clears: THIRD_CLEAR_GRANT charges
 *  of a random type (issue #117: down from 3). */
export const THIRD_CLEAR_GRANT = 1;
export const THIRD_CLEAR_EVERY = 3;
/** First clear of a milestone level (the ladder's decade spike): this many
 *  of *each* booster (issue #117). */
export const MILESTONE_LEVEL_GRANT = 1;
/** First launch of a calendar day: this many of *each* booster. */
export const DAILY_LOGIN_GRANT = 1;

export const CHARGES_STORAGE_KEY = 'mahjong.boosters.v1';

/** The slice of the DOM Storage API this module needs (`localStorage` fits). */
export interface ChargeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type Counts = Record<BoosterKind, number>;

function freshGrant(): Counts {
  return { hint: STARTING_GRANT, undo: STARTING_GRANT, shuffle: STARTING_GRANT };
}

/** A stored count is only honoured when it is a non-negative integer; one
 *  above the cap (hand-edited) is clamped rather than thrown away. */
function readCount(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 ? Math.min(raw, BOOSTER_CAP) : null;
}

interface Stored {
  readonly counts: Counts;
  /** Date key of the last daily-login grant, or null if never granted. */
  readonly lastLoginGrant: string | null;
}

function load(storage: ChargeStorage | undefined, key: string): Stored {
  const counts = freshGrant();
  if (!storage) return { counts, lastLoginGrant: null };
  let record: unknown;
  try {
    const raw = storage.getItem(key);
    if (raw === null) return { counts, lastLoginGrant: null };
    record = JSON.parse(raw);
  } catch {
    return { counts, lastLoginGrant: null }; // unreadable storage or malformed JSON: start fresh
  }
  if (typeof record !== 'object' || record === null) return { counts, lastLoginGrant: null };
  const raw = record as Record<string, unknown>;
  for (const kind of BOOSTER_KINDS) {
    const value = readCount(raw[kind]);
    if (value !== null) counts[kind] = value;
  }
  const last = raw['lastLoginGrant'];
  return { counts, lastLoginGrant: isDateKey(last) ? last : null };
}

/** Does the Nth distinct first-clear pay the every-third bonus (issue #51)? */
export function thirdClearDue(distinctCleared: number): boolean {
  return distinctCleared > 0 && distinctCleared % THIRD_CLEAR_EVERY === 0;
}

/**
 * Remaining charges per booster, persisted on every change.
 *
 * Accounting rule: the caller performs the booster action first and spends only
 * when it did something (`spend` after a successful Hint / Undo / Shuffle). A
 * hint with no legal pair, an undo with an empty move stack, or a shuffle the
 * solver cannot validate therefore costs the player nothing.
 */
export class BoosterCharges {
  private readonly counts: Counts;
  private lastLoginGrant: string | null;

  constructor(
    private readonly storage: ChargeStorage | undefined = undefined,
    private readonly key: string = CHARGES_STORAGE_KEY,
  ) {
    const stored = load(storage, key);
    this.counts = stored.counts;
    this.lastLoginGrant = stored.lastLoginGrant;
  }

  remaining(kind: BoosterKind): number {
    return this.counts[kind];
  }

  has(kind: BoosterKind): boolean {
    return this.counts[kind] > 0;
  }

  /** Spend one charge. Returns false, changing nothing, when none remain. */
  spend(kind: BoosterKind): boolean {
    if (!this.has(kind)) return false;
    this.counts[kind]--;
    this.persist();
    return true;
  }

  /** Add `n` charges of `kind`, clamped at the cap. Returns how many actually
   *  landed (0 at the cap), so the caller can say what was granted. */
  grant(kind: BoosterKind, n: number): number {
    if (!Number.isInteger(n) || n < 0) throw new RangeError(`grant must be a non-negative integer: ${n}`);
    const added = Math.min(n, BOOSTER_CAP - this.counts[kind]);
    if (added <= 0) return 0;
    this.counts[kind] += added;
    this.persist();
    return added;
  }

  /** Split `total` charges across the three types at random (`random` in
   *  [0, 1), injectable so a test can pin the outcome) and grant them,
   *  each type clamped at the cap. Returns what actually landed per type. */
  grantSplit(total: number, random: () => number): Counts {
    const got: Counts = { hint: 0, undo: 0, shuffle: 0 };
    for (let i = 0; i < total; i++) {
      const kind = BOOSTER_KINDS[Math.min(Math.floor(random() * BOOSTER_KINDS.length), BOOSTER_KINDS.length - 1)]!;
      got[kind] += this.grant(kind, 1);
    }
    return got;
  }

  /**
   * The daily first-launch grant (issue #51): DAILY_LOGIN_GRANT of each, once
   * per calendar day. `today` is the local date key (see core's
   * dailyDateKey). Granted only when today is strictly *after* the last
   * grant's date — a clock moved forward grants once, moved back grants
   * nothing, moved forward again to a day already granted grants nothing —
   * so the channel cannot be farmed by winding the device clock. Returns what
   * landed, or null when nothing was due.
   */
  grantDailyLogin(today: string): Counts | null {
    if (!isDateKey(today)) throw new RangeError(`not a date key: ${today}`);
    if (this.lastLoginGrant !== null && daysBetween(this.lastLoginGrant, today) < 1) return null;
    // The date is set before the single write below, so a failed write drops
    // the date and the charges together.
    this.lastLoginGrant = today;
    return this.grantEach(DAILY_LOGIN_GRANT);
  }

  /** Add `n` charges of *every* booster, each clamped at the cap, in one
   *  write. Returns what actually landed per type. */
  grantEach(n: number): Counts {
    if (!Number.isInteger(n) || n < 0) throw new RangeError(`grant must be a non-negative integer: ${n}`);
    const got: Counts = { hint: 0, undo: 0, shuffle: 0 };
    for (const kind of BOOSTER_KINDS) {
      const added = Math.min(n, BOOSTER_CAP - this.counts[kind]);
      this.counts[kind] += added;
      got[kind] = added;
    }
    this.persist();
    return got;
  }

  private persist(): void {
    if (!this.storage) return;
    try {
      this.storage.setItem(this.key, JSON.stringify({ ...this.counts, lastLoginGrant: this.lastLoginGrant }));
    } catch {
      // Write-blocked storage (private mode, quota): charges stay in memory for
      // this session rather than taking the game down.
    }
  }
}
