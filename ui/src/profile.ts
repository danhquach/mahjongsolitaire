// The player (issue #69): a local identity the game can attach results to,
// and the record it attaches them to. Two stores on two keys, both local-first
// — the game stays fully playable offline, no account or sign-in exists — so a
// later sync backend is an addition, not a rewrite.
//
//   mahjong.profile.v1   who is playing: display name + avatar
//   mahjong.record.v1    what they have done: levels cleared, best score,
//                        Daily Challenge streak, trophies
//
// The record's dailyStreak and trophies fields are parsed and shown from day
// one but written by nobody yet: the Daily Challenge (issue #19) and trophies
// arrive later and get a home here instead of a second record. The display
// name will eventually be shown to other players (issue #70) — length is
// clamped here, but profanity screening is deliberately deferred until the
// name actually leaves the device.

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

export interface Profile {
  readonly name: string;
  readonly avatar: string;
}

export const DEFAULT_PROFILE: Profile = {
  name: DEFAULT_NAME,
  avatar: DEFAULT_AVATAR_ID,
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
  /** Wins, lifetime — counts replays too, unlike the ladder position. */
  readonly levelsCleared: number;
  /** Highest final score of any won level. */
  readonly bestScore: number;
  /** Consecutive Daily Challenge days. Written by nobody until issue #19. */
  readonly dailyStreak: number;
  /** Trophies collected. Written by nobody until the trophy system lands. */
  readonly trophies: number;
}

export const EMPTY_RECORD: PlayerRecord = {
  levelsCleared: 0,
  bestScore: 0,
  dailyStreak: 0,
  trophies: 0,
};

export const RECORD_STORAGE_KEY = 'mahjong.record.v1';

/** Counters only: a non-negative integer or that field's zero. */
export function parsePlayerRecord(record: unknown): PlayerRecord {
  if (typeof record !== 'object' || record === null) return EMPTY_RECORD;
  const raw = record as Record<string, unknown>;
  const count = (key: keyof PlayerRecord): number => {
    const v = raw[key];
    return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0;
  };
  return {
    levelsCleared: count('levelsCleared'),
    bestScore: count('bestScore'),
    dailyStreak: count('dailyStreak'),
    trophies: count('trophies'),
  };
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

  /** A level was won at `score`: one more clear, and a new best if it is one. */
  recordWin(score: number): PlayerRecord {
    this.current = {
      ...this.current,
      levelsCleared: this.current.levelsCleared + 1,
      bestScore: Math.max(this.current.bestScore, Math.max(0, Math.floor(score))),
    };
    writeRecord(this.storage, this.key, this.current);
    return this.current;
  }
}
