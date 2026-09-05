// Reset progress and Close account, device side (issue #201): which keys each
// wipes, and the typed-name gate in front of both.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ALL_KEYS, PROGRESS_KEYS, confirmMatches, wipeDevice, wipeProgress } from '../src/account.js';
import { CHARGES_STORAGE_KEY } from '../src/boosters.js';
import { DAILY_STORAGE_KEY } from '../src/daily.js';
import { LEADERBOARD_STORAGE_KEY } from '../src/leaderboard.js';
import { PROFILE_STORAGE_KEY, RECORD_STORAGE_KEY } from '../src/profile.js';
import { PROGRESS_STORAGE_KEY } from '../src/progress.js';
import { SAVE_STORAGE_KEY } from '../src/save.js';
import { SETTINGS_STORAGE_KEY } from '../src/settings.js';
import type { KeyValueStorage } from '../src/storage.js';
import { SYNC_STORAGE_KEY } from '../src/sync.js';

/** Every key the game writes, seeded, plus one that is not the game's. */
function seededStorage(): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map<string, string>([...ALL_KEYS, 'someone-elses-key'].map((k) => [k, '{}']));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

test('reset drops what the player has done and keeps who they are', () => {
  const storage = seededStorage();
  wipeProgress(storage);
  for (const gone of [RECORD_STORAGE_KEY, PROGRESS_STORAGE_KEY, SAVE_STORAGE_KEY, DAILY_STORAGE_KEY]) {
    assert.equal(storage.getItem(gone), null, gone);
  }
  for (const kept of [PROFILE_STORAGE_KEY, SETTINGS_STORAGE_KEY, SYNC_STORAGE_KEY, LEADERBOARD_STORAGE_KEY, CHARGES_STORAGE_KEY]) {
    assert.equal(storage.getItem(kept), '{}', kept);
  }
});

test('close drops every key the game owns and nothing else', () => {
  const storage = seededStorage();
  wipeDevice(storage);
  assert.deepEqual([...storage.data.keys()], ['someone-elses-key']);
});

test('the two lists cover every store, and reset is a strict subset of close', () => {
  assert.equal(new Set(ALL_KEYS).size, ALL_KEYS.length, 'no key listed twice');
  assert.ok(PROGRESS_KEYS.every((k) => ALL_KEYS.includes(k)));
  assert.ok(PROGRESS_KEYS.length < ALL_KEYS.length);
  assert.equal(ALL_KEYS.length, 9, 'one entry per storage key in ui/src — add the new store to a list');
});

test('wiping without storage is a no-op, and a key that will not go does not stop the rest', () => {
  wipeProgress(undefined);
  wipeDevice(undefined);
  const removed: string[] = [];
  const stubborn: KeyValueStorage = {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: (key) => {
      if (key === RECORD_STORAGE_KEY) throw new Error('locked');
      removed.push(key);
    },
  };
  wipeProgress(stubborn);
  assert.deepEqual(removed, PROGRESS_KEYS.filter((k) => k !== RECORD_STORAGE_KEY));
});

test('the typed name has to be the display name — case and edges aside', () => {
  assert.ok(confirmMatches('Alex', 'Alex'));
  assert.ok(confirmMatches('  alex ', 'Alex'));
  assert.ok(confirmMatches('player', 'Player'), 'a name the player never chose still gates');
  assert.ok(!confirmMatches('Ale', 'Alex'));
  assert.ok(!confirmMatches('', 'Alex'));
  assert.ok(!confirmMatches('Alexa', 'Alex'));
});

test('an empty field never confirms — not even for a guest, whose name is the default the sanitizer falls back to', () => {
  assert.ok(!confirmMatches('', 'Player'));
  assert.ok(!confirmMatches('   ', 'Player'));
  assert.ok(!confirmMatches('', ''));
  assert.ok(confirmMatches('Player', ''), 'a stored empty name is the default name, and typing that is the gate');
});
