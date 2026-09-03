// The player (issue #69): a local identity the game can attach results to,
// and the record it attaches them to. Two stores on two keys, both local-first
// — the game stays fully playable offline, no account or sign-in exists — so a
// later sync backend is an addition, not a rewrite.
//
//   mahjong.profile.v1   who is playing: display name + avatar
//   mahjong.record.v1    what they have done: levels cleared, best and total
//                        score, which ladder levels are cleared, Daily
//                        Challenge streak (+ the date it is anchored to),
//                        trophies
//
// The Daily Challenge fields (issue #19, decision 0016) live here rather than
// on a second record; a record written before #19 parses with them empty.
// The display name is clamped here but not screened: screening happens where
// the name leaves the device (issue #138 — worker/profile.mjs owns the
// blocklist, so shipping a better one is a Worker deploy, not an app update).
// sync.ts is the opt-in bridge between these two stores and that server.

import {
  LADDER_LENGTH,
  dailyTrophies,
  daysBetween,
  isDateKey,
  isWeekKey,
  weekStartKey,
} from '@mahjongsolitaire/core';
import { readRecord, writeRecord } from './storage.js';
import type { KeyValueStorage } from './storage.js';

/** Pickable avatars: an id the record stores, a glyph the UI shows. Emoji,
 *  like the placeholder tile art — no image assets to license or load. */
export const AVATARS: ReadonlyArray<{
  readonly id: string;
  readonly glyph: string;
  readonly label: string;
}> = [
  { id: 'lantern', glyph: '🏮', label: 'Lantern' },
  { id: 'dragon', glyph: '🐉', label: 'Dragon' },
  { id: 'bamboo', glyph: '🎋', label: 'Bamboo' },
  { id: 'blossom', glyph: '🌸', label: 'Blossom' },
  { id: 'crane', glyph: '🦩', label: 'Crane' },
  { id: 'wave', glyph: '🌊', label: 'Wave' },
  { id: 'moon', glyph: '🌙', label: 'Moon' },
  { id: 'koi', glyph: '🐟', label: 'Koi' },
];

export const DEFAULT_AVATAR_ID = AVATARS[0]!.id;

/** The glyph for a stored avatar id — the default's for an id we no longer
 *  ship, so an old record still draws something. */
export function avatarGlyph(id: string): string {
  return (AVATARS.find((a) => a.id === id) ?? AVATARS[0]!).glyph;
}

function isAvatarId(value: unknown): value is string {
  return typeof value === 'string' && AVATARS.some((a) => a.id === value);
}

/** Spec §7 wants big text; a name that fits one settings row on a phone. */
export const NAME_MAX_LENGTH = 20;

export const DEFAULT_NAME = 'Player';

/**
 * A display name as the profile stores it: trimmed, inner whitespace collapsed
 * (a name is one line), clamped to NAME_MAX_LENGTH. Nothing left after
 * trimming means the player cleared the field — fall back to the default
 * rather than storing an empty identity.
 */
export function sanitizeName(raw: string): string {
  const name = raw.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX_LENGTH).trim();
  return name === '' ? DEFAULT_NAME : name;
}

/** How the player answered the first-launch prompt (issue #105): set up a
 *  named profile, or play as a guest. */
export type PlayerChoice = 'named' | 'guest';

function isPlayerChoice(value: unknown): value is PlayerChoice {
  return value === 'named' || value === 'guest';
}

export interface Profile {
  readonly name: string;
  readonly avatar: string;
  /** `null` means the player has never been asked — the welcome gate shows.
   *  A profile stored before issue #105 parses to `null` too, so an existing
   *  player is asked once and never again. */
  readonly choice: PlayerChoice | null;
}

export const DEFAULT_PROFILE: Profile = {
  name: DEFAULT_NAME,
  avatar: DEFAULT_AVATAR_ID,
  choice: null,
};

export const PROFILE_STORAGE_KEY = 'mahjong.profile.v1';

/** Per-field validation, like parseSettings: a bad field falls back, a bad
 *  record starts fresh. A stored name is re-sanitized — it may be hand-edited
 *  or from a build with different rules. */
export function parseProfile(record: unknown): Profile {
  if (typeof record !== 'object' || record === null) return DEFAULT_PROFILE;
  const raw = record as Record<string, unknown>;
  return {
    name: typeof raw['name'] === 'string' ? sanitizeName(raw['name']) : DEFAULT_NAME,
    avatar: isAvatarId(raw['avatar']) ? raw['avatar'] : DEFAULT_AVATAR_ID,
    choice: isPlayerChoice(raw['choice']) ? raw['choice'] : null,
  };
}

/** The player's identity, persisted on every change (no Save button). */
export class ProfileStore {
  private current: Profile;

  constructor(
    private readonly storage: KeyValueStorage | undefined = undefined,
    private readonly key = PROFILE_STORAGE_KEY,
  ) {
    this.current = parseProfile(readRecord(storage, key));
  }

  get value(): Profile {
    return this.current;
  }

  /** Rename. The stored name is the sanitized one; returns it so the caller
   *  can push the canonical form back into the input. */
  setName(raw: string): string {
    const name = sanitizeName(raw);
    if (name !== this.current.name) {
      this.current = { ...this.current, name };
      writeRecord(this.storage, this.key, this.current);
    }
    return name;
  }

  /** Record the welcome-gate answer (issue #105) so it is never asked again. */
  setChoice(choice: PlayerChoice): void {
    if (choice === this.current.choice) return;
    this.current = { ...this.current, choice };
    writeRecord(this.storage, this.key, this.current);
  }

  /** Pick an avatar. An unknown id is ignored rather than stored. */
  setAvatar(id: string): boolean {
    if (!isAvatarId(id) || id === this.current.avatar) return false;
    this.current = { ...this.current, avatar: id };
    writeRecord(this.storage, this.key, this.current);
    return true;
  }
}

// --- the record ---------------------------------------------------------------

export interface PlayerRecord {
  /** Ladder wins, lifetime — counts replays, unlike the ladder position. A
   *  Daily clear is not a level and no longer counts here (issue #176). */
  readonly levelsCleared: number;
  /**
   * Score earned this week. The one score the game records (issue #176): the
   * lifetime total is gone, and this is both what the profile shows and what
   * the weekly leaderboard ranks. Reset when `weekStart` is not the current
   * week — see `currentWeek`.
   *
   * Deliberately renamed from `totalScore` rather than repurposed. An older
   * record's lifetime total must not become a week-one score: it would put
   * every established player at the top of the first board. Under the new name
   * an old record simply has no week score, which parses to 0 — the migration
   * is the rename.
   */
  readonly weekScore: number;
  /** The week `weekScore` belongs to (`weekStartKey`), or null when nothing
   *  has been scored yet. */
  readonly weekStart: string | null;
  /** Ladder levels that have been cleared at least once (issue #119: a clear
   *  is a clear, no rating attached). */
  readonly cleared: readonly number[];
  /** Consecutive Daily Challenge days, as of `lastDaily`. */
  readonly dailyStreak: number;
  /** The date key of the last Daily Challenge credited, or null. The streak
   *  is only meaningful next to it: a streak whose last day was the day
   *  before today is alive, anything older is over (see `liveStreak`). */
  readonly lastDaily: string | null;
  /** Trophies collected from Daily clears (`dailyTrophies` per clear). */
  readonly trophies: number;
}

export const EMPTY_RECORD: PlayerRecord = {
  levelsCleared: 0,
  weekScore: 0,
  weekStart: null,
  cleared: [],
  dailyStreak: 0,
  lastDaily: null,
  trophies: 0,
};

export const RECORD_STORAGE_KEY = 'mahjong.record.v1';

/** Per-field tolerance, like parseProfile: counters are non-negative integers
 *  or zero, the cleared set keeps only well-formed (1..LADDER_LENGTH) levels,
 *  and the last Daily date must be a real date key or it is forgotten (with
 *  the streak it vouched for). A record from before issue #19 has no cleared
 *  or lastDaily and simply starts those at empty; one from before issue #176
 *  has a lifetime `totalScore` and no `weekStart`, which is exactly why it
 *  reads as no week score at all rather than as this week's.
 *
 *  A record written before issue #119 stored a `stars` map (level → 1-3
 *  rating) instead of a `cleared` list. Any level key present in that old map
 *  migrates straight to cleared — the rating is discarded, but no player
 *  loses a clear, and hasCleared/clearedLevelCount (and the booster grants
 *  built on them, #51/#117) keep seeing the same levels as cleared. */
export function parsePlayerRecord(record: unknown): PlayerRecord {
  if (typeof record !== 'object' || record === null) return EMPTY_RECORD;
  const raw = record as Record<string, unknown>;
  const count = (key: string): number => {
    const v = raw[key];
    return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0;
  };
  const cleared = new Set<number>();
  const addLevel = (level: number): void => {
    if (Number.isInteger(level) && level >= 1 && level <= LADDER_LENGTH) cleared.add(level);
  };
  const rawCleared = raw['cleared'];
  if (Array.isArray(rawCleared)) {
    for (const v of rawCleared) if (typeof v === 'number') addLevel(v);
  }
  const rawStars = raw['stars'];
  if (typeof rawStars === 'object' && rawStars !== null && !Array.isArray(rawStars)) {
    // JSON object keys are always strings — unlike the array case above,
    // Number(key) is the only way to read them back as levels.
    for (const key of Object.keys(rawStars as Record<string, unknown>)) addLevel(Number(key));
  }
  const lastDaily = isDateKey(raw['lastDaily']) ? raw['lastDaily'] : null;
  // A week score is only meaningful next to the week it was earned in; without
  // one it is not a score, it is a number of unknown age. This is what stops a
  // pre-#176 record's lifetime total from being read as this week's.
  const weekStart = isWeekKey(raw['weekStart']) ? raw['weekStart'] : null;
  return {
    levelsCleared: count('levelsCleared'),
    weekScore: weekStart === null ? 0 : count('weekScore'),
    weekStart,
    cleared: Array.from(cleared).sort((a, b) => a - b),
    dailyStreak: lastDaily === null ? 0 : count('dailyStreak'),
    lastDaily,
    trophies: count('trophies'),
  };
}

/**
 * The score to *show* for this record right now (issue #176).
 *
 * Not simply `record.weekScore`: a record written last week still carries last
 * week's number, and the board it is ranked on has already emptied. The stored
 * value only counts while its week is the current one — otherwise the week has
 * rolled over and the player starts from zero, whether or not they have played
 * since. Reading it this way means no timer has to fire at the boundary for
 * the profile to be right.
 */
export function weekScoreNow(record: PlayerRecord, nowMs: number): number {
  return record.weekStart === weekStartKey(nowMs) ? record.weekScore : 0;
}

/** Has this ladder level ever been cleared (issue #51 keys first-clear grants
 *  off it, #117 the every-third and milestone grants). */
export function hasCleared(record: PlayerRecord, level: number): boolean {
  return record.cleared.includes(level);
}

/** Distinct ladder levels cleared — what the every-third-clear grant counts
 *  (issue #51), never completions. */
export function clearedLevelCount(record: PlayerRecord): number {
  return record.cleared.length;
}

/** The streak as it stands on `today`: the stored count if the last Daily
 *  was today or yesterday, else 0 — a missed day ends it, and the profile
 *  must not keep showing a streak that is already over. */
export function liveStreak(record: PlayerRecord, today: string): number {
  if (record.lastDaily === null) return 0;
  const gap = daysBetween(record.lastDaily, today);
  return gap === 0 || gap === 1 ? record.dailyStreak : 0;
}

/** Whether today's Daily is locked against replay (issue #166): true once
 *  `today`'s board has been credited (`lastDaily === today`). A loss never
 *  sets `lastDaily`, so it never locks; the lock itself lifts the moment
 *  `today` rolls to the next local calendar date — `dailyDateKey()` picks
 *  `today`, so calling this again after midnight reopens the board. */
export function dailyLockedFor(record: PlayerRecord, today: string): boolean {
  return record.lastDaily === today;
}

/** What a Daily clear paid out (issue #19). `credited` is false when the
 *  date was already cleared — a replay earns nothing twice. */
export interface DailyCredit {
  readonly credited: boolean;
  readonly streak: number;
  readonly trophies: number;
}

/** The player's own record, updated once per win (main.ts calls this inside
 *  the same once-per-level transition that advances the ladder). */
export class RecordStore {
  private current: PlayerRecord;

  constructor(
    private readonly storage: KeyValueStorage | undefined = undefined,
    private readonly key = RECORD_STORAGE_KEY,
  ) {
    this.current = parsePlayerRecord(readRecord(storage, key));
  }

  get value(): PlayerRecord {
    return this.current;
  }

  /**
   * A ladder level was won at `score`: one more clear, the score added to this
   * week's, and the level marked cleared.
   *
   * Ladder only (issue #176). A Daily clear pays trophies and the streak and
   * nothing else — it does not bank score and is not a level cleared — so it
   * calls `recordDailyWin` alone and never comes through here.
   *
   * `nowMs` decides the week. When the stored week is not the current one the
   * score starts again from this win rather than adding to a standing that has
   * already been ranked and reset: the board and the profile show one number,
   * so they have to roll over together.
   */
  recordWin(score: number, rated: { readonly level: number }, nowMs: number): PlayerRecord {
    const earned = Math.max(0, Math.floor(score));
    const week = weekStartKey(nowMs);
    const carried = this.current.weekStart === week ? this.current.weekScore : 0;
    const cleared = this.current.cleared.includes(rated.level)
      ? this.current.cleared
      : [...this.current.cleared, rated.level].sort((a, b) => a - b);
    this.current = {
      ...this.current,
      levelsCleared: this.current.levelsCleared + 1,
      weekScore: carried + earned,
      weekStart: week,
      cleared,
    };
    writeRecord(this.storage, this.key, this.current);
    return this.current;
  }

  /** Adopt a record wholesale — the merge of this device's record with the
   *  synced one (issue #138, sync.ts owns the merge rule). Nothing else may
   *  replace the record: every other path here only ever moves it forward. */
  adopt(record: PlayerRecord): PlayerRecord {
    this.current = record;
    writeRecord(this.storage, this.key, this.current);
    return this.current;
  }

  /** The Daily Challenge for `dateKey` was cleared: extend or restart the
   *  streak (consecutive calendar days, `daysBetween` — DST-immune), pay the
   *  trophies the streak earns, once per date. Clearing a *past* date's board
   *  is credited too (a board dealt before midnight and finished after it),
   *  but never re-credited and never counted out of order. */
  recordDailyWin(dateKey: string): DailyCredit {
    const { lastDaily, dailyStreak } = this.current;
    if (lastDaily !== null && daysBetween(lastDaily, dateKey) <= 0) {
      return { credited: false, streak: dailyStreak, trophies: 0 };
    }
    const streak = lastDaily !== null && daysBetween(lastDaily, dateKey) === 1 ? dailyStreak + 1 : 1;
    const trophies = dailyTrophies(streak);
    this.current = {
      ...this.current,
      dailyStreak: streak,
      lastDaily: dateKey,
      trophies: this.current.trophies + trophies,
    };
    writeRecord(this.storage, this.key, this.current);
    return { credited: true, streak, trophies };
  }
}
