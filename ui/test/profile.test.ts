// Player profile + record persistence (issue #69): a local identity with the
// defaults a fresh install gets, per-change persistence, and per-field
// tolerance of records we did not write — same contract as settings.ts.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AVATARS,
  DEFAULT_AVATAR_ID,
  DEFAULT_NAME,
  DEFAULT_PROFILE,
  EMPTY_RECORD,
  NAME_MAX_LENGTH,
  PROFILE_STORAGE_KEY,
  ProfileStore,
  RECORD_STORAGE_KEY,
  RecordStore,
  avatarGlyph,
  parsePlayerRecord,
  parseProfile,
  sanitizeName,
} from '../src/profile.js';
import type { KeyValueStorage } from '../src/storage.js';

function fakeStorage(seed: Record<string, string> = {}): KeyValueStorage & {
  data: Map<string, string>;
} {
  const data = new Map(Object.entries(seed));
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

const throwingStorage: KeyValueStorage = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  },
  removeItem: () => {
    throw new Error('blocked');
  },
};

// --- avatars --------------------------------------------------------------------

test('avatar ids are unique and every avatar has a glyph and a label', () => {
  assert.equal(new Set(AVATARS.map((a) => a.id)).size, AVATARS.length);
  for (const a of AVATARS) {
    assert.ok(a.glyph.length > 0, a.id);
    assert.ok(a.label.length > 0, a.id);
  }
  assert.equal(DEFAULT_AVATAR_ID, AVATARS[0]!.id);
});

test('avatarGlyph resolves a known id and falls back for a retired one', () => {
  assert.equal(avatarGlyph('dragon'), '🐉');
  assert.equal(avatarGlyph('no-such-avatar'), AVATARS[0]!.glyph);
});

// --- name rules ------------------------------------------------------------------

test('sanitizeName trims, collapses whitespace, and clamps the length', () => {
  assert.equal(sanitizeName('  Dan  '), 'Dan');
  assert.equal(sanitizeName('Dan\t\n Q'), 'Dan Q');
  assert.equal(sanitizeName('x'.repeat(NAME_MAX_LENGTH + 10)), 'x'.repeat(NAME_MAX_LENGTH));
  // A clamp that lands on a space must not leave a trailing one behind.
  assert.equal(sanitizeName(`${'x'.repeat(NAME_MAX_LENGTH - 1)} yyy`), 'x'.repeat(NAME_MAX_LENGTH - 1));
});

test('an emptied name falls back to the default identity', () => {
  assert.equal(sanitizeName(''), DEFAULT_NAME);
  assert.equal(sanitizeName('   \n\t '), DEFAULT_NAME);
});

// --- profile parsing + persistence ------------------------------------------------

test('a fresh install gets the default profile, storage or not', () => {
  assert.deepEqual(new ProfileStore(fakeStorage()).value, DEFAULT_PROFILE);
  assert.deepEqual(new ProfileStore(undefined).value, DEFAULT_PROFILE);
  assert.deepEqual(new ProfileStore(throwingStorage).value, DEFAULT_PROFILE);
});

test('parseProfile: a bad field falls back, a bad record starts fresh', () => {
  assert.deepEqual(parseProfile(null), DEFAULT_PROFILE);
  assert.deepEqual(parseProfile('nonsense'), DEFAULT_PROFILE);
  assert.deepEqual(parseProfile({ name: 42, avatar: 'dragon' }), {
    name: DEFAULT_NAME,
    avatar: 'dragon',
    choice: null,
  });
  assert.deepEqual(parseProfile({ name: 'Dan', avatar: 'not-shipped' }), {
    name: 'Dan',
    avatar: DEFAULT_AVATAR_ID,
    choice: null,
  });
  // A hand-edited stored name goes through the same sanitizer as typed input.
  assert.equal(parseProfile({ name: `  ${'y'.repeat(99)}` }).name, 'y'.repeat(NAME_MAX_LENGTH));
});

test('setName persists the sanitized name and returns the canonical form', () => {
  const storage = fakeStorage();
  const store = new ProfileStore(storage);
  assert.equal(store.setName('  Lantern  Fan '), 'Lantern Fan');
  assert.equal(store.value.name, 'Lantern Fan');
  assert.deepEqual(new ProfileStore(storage).value.name, 'Lantern Fan');
  // Clearing the field renames back to the default — never an empty identity.
  assert.equal(store.setName(''), DEFAULT_NAME);
  assert.equal(new ProfileStore(storage).value.name, DEFAULT_NAME);
});

test('setAvatar stores a shipped id and ignores an unknown one', () => {
  const storage = fakeStorage();
  const store = new ProfileStore(storage);
  assert.equal(store.setAvatar('moon'), true);
  assert.equal(new ProfileStore(storage).value.avatar, 'moon');
  assert.equal(store.setAvatar('no-such-avatar'), false);
  assert.equal(store.value.avatar, 'moon');
  assert.equal(store.setAvatar('moon'), false, 're-picking the same avatar writes nothing');
});

test('a rename that changes nothing writes nothing', () => {
  const storage = fakeStorage();
  const store = new ProfileStore(storage);
  store.setName(DEFAULT_NAME);
  assert.equal(storage.data.has(PROFILE_STORAGE_KEY), false);
});

test('a storage that throws still yields a working in-memory profile', () => {
  const store = new ProfileStore(throwingStorage);
  assert.equal(store.setName('Dan'), 'Dan');
  assert.equal(store.value.name, 'Dan');
  assert.equal(store.setAvatar('koi'), true);
});

// --- the welcome-gate choice (issue #105) -----------------------------------------

test('parseProfile: only a real choice is kept — anything else means never asked', () => {
  assert.equal(parseProfile({ choice: 'guest' }).choice, 'guest');
  assert.equal(parseProfile({ choice: 'named' }).choice, 'named');
  assert.equal(parseProfile({ choice: 'admin' }).choice, null);
  assert.equal(parseProfile({ choice: true }).choice, null);
  // A profile stored before issue #105 has no choice field: asked once.
  assert.equal(parseProfile({ name: 'Dan', avatar: 'moon' }).choice, null);
});

test('setChoice persists across a reload and re-setting it writes nothing', () => {
  const storage = fakeStorage();
  const store = new ProfileStore(storage);
  store.setChoice('guest');
  assert.equal(store.value.choice, 'guest');
  assert.equal(new ProfileStore(storage).value.choice, 'guest');
  storage.data.clear();
  store.setChoice('guest'); // unchanged — must not write
  assert.equal(storage.data.has(PROFILE_STORAGE_KEY), false);
  store.setChoice('named'); // a changed answer is stored
  assert.equal(new ProfileStore(storage).value.choice, 'named');
});

test('setChoice keeps working when storage throws', () => {
  const store = new ProfileStore(throwingStorage);
  store.setChoice('guest');
  assert.equal(store.value.choice, 'guest');
});

// --- the record --------------------------------------------------------------------

test('a fresh record is all zeroes', () => {
  assert.deepEqual(new RecordStore(fakeStorage()).value, EMPTY_RECORD);
  assert.deepEqual(new RecordStore(undefined).value, EMPTY_RECORD);
});

test('parsePlayerRecord: counters are non-negative integers or zero; a pre-#19 record starts the new fields empty', () => {
  assert.deepEqual(parsePlayerRecord(null), EMPTY_RECORD);
  assert.deepEqual(parsePlayerRecord({ levelsCleared: -3, bestScore: 2.5, trophies: '9' }), EMPTY_RECORD);
  // The issue #69 shape: no totalScore, stars or lastDaily. A streak with no
  // date to anchor it is not a live streak, so it reads as 0.
  assert.deepEqual(parsePlayerRecord({ levelsCleared: 7, bestScore: 1200, dailyStreak: 3, trophies: 2 }), {
    ...EMPTY_RECORD,
    levelsCleared: 7,
    bestScore: 1200,
    trophies: 2,
  });
});

test('recordWin counts the clear, banks the total and keeps the best score', () => {
  const storage = fakeStorage();
  const record = new RecordStore(storage);
  assert.deepEqual(record.recordWin(900), {
    ...EMPTY_RECORD,
    levelsCleared: 1,
    bestScore: 900,
    totalScore: 900,
  });
  record.recordWin(450); // a worse score still counts the clear, and the total
  assert.deepEqual(record.value, { ...EMPTY_RECORD, levelsCleared: 2, bestScore: 900, totalScore: 1350 });
  record.recordWin(1500);
  assert.deepEqual(new RecordStore(storage).value, {
    ...EMPTY_RECORD,
    levelsCleared: 3,
    bestScore: 1500,
    totalScore: 2850,
  });
});

test('recordWin leaves the Daily fields alone', () => {
  const storage = fakeStorage({
    [RECORD_STORAGE_KEY]: JSON.stringify({ dailyStreak: 4, lastDaily: '2026-09-01', trophies: 1 }),
  });
  const record = new RecordStore(storage);
  assert.deepEqual(record.recordWin(100), {
    ...EMPTY_RECORD,
    levelsCleared: 1,
    bestScore: 100,
    totalScore: 100,
    dailyStreak: 4,
    lastDaily: '2026-09-01',
    trophies: 1,
  });
});
