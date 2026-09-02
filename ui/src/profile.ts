// The player (issue #69): a local identity the game can attach results to,
// and the record it attaches them to. Two stores on two keys, both local-first
// — the game stays fully playable offline, no account or sign-in exists — so a
// later sync backend is an addition, not a rewrite.
//
//   mahjong.profile.v1   who is playing: display name + avatar
//   mahjong.record.v1    what they have done: levels cleared, best and total
//                        score, stars per ladder level, Daily Challenge
//                        streak (+ the date it is anchored to), trophies
//
// The Daily Challenge and star fields (issue #19, decision 0016) live here
// rather than on a second record; a record written before #19 parses with
// them empty. The display name will eventually be shown to other players
// (issue #70) — length is clamped here, but profanity screening is
// deliberately deferred until the name actually leaves the device.

import {
  LADDER_LENGTH,
  dailyTrophies,
  daysBetween,
  isDateKey,
  parseStarRating,
} from '@mahjongsolitaire/core';
import type { StarRating } from '@mahjongsolitaire/core';
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
  /** Wins, lifetime — counts replays and Daily clears too, unlike the ladder
   *  position. */
  readonly levelsCleared: number;
  /** Highest final score of any won level. */
  readonly bestScore: number;
  /** Every won level's final score, summed (spec §6 "total score"). */
  readonly totalScore: number;
  /** Best star rating per ladder level, keyed by the level number as a string
   *  (JSON object keys). Absent means never cleared. */
  readonly stars: Readonly<Record<string, StarRating>>;
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
  bestScore: 0,
  totalScore: 0,
  stars: {},
  dailyStreak: 0,
  lastDaily: null,
  trophies: 0,
};

export const RECORD_STORAGE_KEY = 'mahjong.record.v1';

/** Per-field tolerance, like parseProfile: counters are non-negative integers
 *  or zero, the stars map keeps only well-formed (level, 1–3) entries, and the
 *  last Daily date must be a real date key or it is forgotten (with the
 *  streak it vouched for). A record from before issue #19 has no totalScore,
 *  stars or lastDaily and simply starts those at empty. */
export function parsePlayerRecord(record: unknown): PlayerRecord {
  if (typeof record !== 'object' || record === null) return EMPTY_RECORD;
  const raw = record as Record<string, unknown>;
  const count = (key: string): number => {
    const v = raw[key];
    return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0;
  };
  const stars: Record<string, StarRating> = {};
  const rawStars = raw['stars'];
  if (typeof rawStars === 'object' && rawStars !== null && !Array.isArray(rawStars)) {
    for (const [key, value] of Object.entries(rawStars as Record<string, unknown>)) {
      const level = Number(key);
      const rating = parseStarRating(value);
      if (!Number.isInteger(level) || level < 1 || level > LADDER_LENGTH || rating === null) continue;
      stars[String(level)] = rating;
    }
  }
  const lastDaily = isDateKey(raw['lastDaily']) ? raw['lastDaily'] : null;
  return {
    levelsCleared: count('levelsCleared'),
    bestScore: count('bestScore'),
    totalScore: count('totalScore'),
    stars,
    dailyStreak: lastDaily === null ? 0 : count('dailyStreak'),
    lastDaily,
    trophies: count('trophies'),
  };
}

/** Has this ladder level ever been cleared? Every ladder win writes a star
 *  rating, so the stars map is the clear record (issue #51 keys first-clear
 *  grants off it). */
export function hasCleared(record: PlayerRecord, level: number): boolean {
  return String(level) in record.stars;
}

/** Distinct ladder levels cleared — what the milestone grant counts
 *  (issue #51), never completions. */
export function clearedLevelCount(record: PlayerRecord): number {
  return Object.keys(record.stars).length;
}

/** Stars earned across the ladder — the profile's headline star count. */
export function totalStars(record: PlayerRecord): number {
  return Object.values(record.stars).reduce((n, s) => n + s, 0);
}

/** The streak as it stands on `today`: the stored count if the last Daily
 *  was today or yesterday, else 0 — a missed day ends it, and the profile
 *  must not keep showing a streak that is already over. */
export function liveStreak(record: PlayerRecord, today: string): number {
  if (record.lastDaily === null) return 0;
  const gap = daysBetween(record.lastDaily, today);
  return gap === 0 || gap === 1 ? record.dailyStreak : 0;
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

  /** A level was won at `score`: one more clear, the score banked into the
   *  total, a new best if it is one — and, for a ladder level, its star
   *  rating kept if it beats the stored one (a Daily clear passes no level:
   *  stars are per ladder level, the Daily pays in trophies). */
  recordWin(score: number, rated?: { readonly level: number; readonly stars: StarRating }): PlayerRecord {
    const banked = Math.max(0, Math.floor(score));
    const stars = { ...this.current.stars };
    if (rated !== undefined) {
      const key = String(rated.level);
      stars[key] = Math.max(stars[key] ?? 0, rated.stars) as StarRating;
    }
    this.current = {
      ...this.current,
      levelsCleared: this.current.levelsCleared + 1,
      bestScore: Math.max(this.current.bestScore, banked),
      totalScore: this.current.totalScore + banked,
      stars,
    };
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
