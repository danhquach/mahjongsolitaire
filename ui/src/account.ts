// Reset progress and Close account (issue #201): the device's half.
//
// Both actions end in a reload — the stores all read their key once at boot
// and the game is dealt from what they hold, so clearing the keys and starting
// over is the one path that cannot leave a half-reset session behind. What
// differs is *which* keys go:
//
//   * Reset keeps who the player is (profile, settings, sync credentials, the
//     board opt-in) and drops what they have done (record, ladder position,
//     the level in progress, today's challenges).
//   * Close drops everything this game ever wrote, so the next boot is a fresh
//     install: the welcome gate, then the tutorial.
//
// The keys are listed here rather than swept by prefix because KeyValueStorage
// (storage.ts) cannot enumerate, and because a list is reviewable: a new store
// has to decide which of the two it belongs to.
//
// No DOM and no network here (main.ts owns the dialog, sync.ts the routes), so
// the key lists and the confirmation rule are unit-tested on their own.

import { CHARGES_STORAGE_KEY } from './boosters.js';
import { DAILY_STORAGE_KEY } from './daily.js';
import { LEADERBOARD_STORAGE_KEY } from './leaderboard.js';
import { PROFILE_STORAGE_KEY, RECORD_STORAGE_KEY, sanitizeName } from './profile.js';
import { PROGRESS_STORAGE_KEY } from './progress.js';
import { SAVE_STORAGE_KEY } from './save.js';
import { SETTINGS_STORAGE_KEY } from './settings.js';
import type { KeyValueStorage } from './storage.js';
import { SYNC_STORAGE_KEY } from './sync.js';

/** What "progress" is: everything Reset wipes. Booster charges stay — they
 *  are a wallet, not a record, and the ticket names levels, week score,
 *  streak and standing. */
export const PROGRESS_KEYS: readonly string[] = [
  RECORD_STORAGE_KEY,
  PROGRESS_STORAGE_KEY,
  SAVE_STORAGE_KEY,
  DAILY_STORAGE_KEY,
];

/** Everything the game stores on the device: what Close wipes. */
export const ALL_KEYS: readonly string[] = [
  ...PROGRESS_KEYS,
  PROFILE_STORAGE_KEY,
  SETTINGS_STORAGE_KEY,
  SYNC_STORAGE_KEY,
  LEADERBOARD_STORAGE_KEY,
  CHARGES_STORAGE_KEY,
];

function removeAll(storage: KeyValueStorage | undefined, keys: readonly string[]): void {
  if (storage === undefined) return;
  for (const key of keys) {
    try {
      storage.removeItem(key);
    } catch {
      // Best effort, like every other write to storage: a key that will not
      // go is re-read at the reload and the player sees it did not.
    }
  }
}

/** Reset progress on this device. The caller reloads afterwards. */
export function wipeProgress(storage: KeyValueStorage | undefined): void {
  removeAll(storage, PROGRESS_KEYS);
}

/** Forget this device ever had a profile. The caller reloads afterwards. */
export function wipeDevice(storage: KeyValueStorage | undefined): void {
  removeAll(storage, ALL_KEYS);
}

/**
 * The deliberate second step: the player types their display name. Judged
 * the way the name itself is stored — trimmed, one line — and without regard
 * to case, because the point is intent, not spelling. A name a player never
 * chose ("Player") still has to be typed: the gate is the act of typing, so
 * an empty field never matches — `sanitizeName` would turn it into the
 * default name, which is exactly the guest's, and arm the button on nothing.
 */
export function confirmMatches(typed: string, name: string): boolean {
  const attempt = typed.replace(/\s+/g, ' ').trim();
  if (attempt === '') return false;
  return attempt.toLocaleLowerCase() === sanitizeName(name).toLocaleLowerCase();
}
