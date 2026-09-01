// Progression persistence (issue #19, spec §6): stars per ladder level, total
// score, and the Daily Challenge streak + trophies — all on the player record.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LADDER_LENGTH } from '@mahjongsolitaire/core';
import {
  EMPTY_RECORD,
  RECORD_STORAGE_KEY,
  RecordStore,
  liveStreak,
  parsePlayerRecord,
  totalStars,
} from '../src/profile.js';
import type { KeyValueStorage } from '../src/storage.js';

function fakeStorage(seed: Record<string, string> = {}): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(seed));
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

// --- stars ----------------------------------------------------------------------

test('recordWin keeps the best star rating per ladder level', () => {
  const storage = fakeStorage();
  const record = new RecordStore(storage);
  record.recordWin(500, { level: 3, stars: 2 });
  assert.deepEqual(record.value.stars, { '3': 2 });
  record.recordWin(500, { level: 3, stars: 1 }); // a worse replay does not lower it
  assert.deepEqual(record.value.stars, { '3': 2 });
  record.recordWin(500, { level: 3, stars: 3 });
  record.recordWin(500, { level: 10, stars: 1 });
  assert.deepEqual(record.value.stars, { '3': 3, '10': 1 });
  assert.equal(totalStars(record.value), 4);
  // Persisted, and read back through the parser.
  assert.deepEqual(new RecordStore(storage).value.stars, { '3': 3, '10': 1 });
});

test('a Daily clear (no level) banks score and the clear but no stars', () => {
  const record = new RecordStore(fakeStorage());
  record.recordWin(700);
  assert.deepEqual(record.value.stars, {});
  assert.equal(record.value.levelsCleared, 1);
  assert.equal(record.value.totalScore, 700);
});

test('parsePlayerRecord keeps only well-formed star entries', () => {
  const parsed = parsePlayerRecord({
    stars: {
      '1': 3,
      '2': 4, // out of range
      '3': '2', // wrong type
      '0': 1, // no level 0
      [String(LADDER_LENGTH)]: 2,
      [String(LADDER_LENGTH + 1)]: 2, // past the ladder
      abc: 3,
      '2.5': 1,
    },
  });
  assert.deepEqual(parsed.stars, { '1': 3, [String(LADDER_LENGTH)]: 2 });
  assert.deepEqual(parsePlayerRecord({ stars: [3, 3] }).stars, {});
  assert.deepEqual(parsePlayerRecord({ stars: 'lots' }).stars, {});
});

// --- daily streak + trophies ------------------------------------------------------

test('the first Daily clear starts a 1-day streak and pays one trophy', () => {
  const storage = fakeStorage();
  const record = new RecordStore(storage);
  assert.deepEqual(record.recordDailyWin('2026-09-01'), { credited: true, streak: 1, trophies: 1 });
  assert.deepEqual(new RecordStore(storage).value, {
    ...EMPTY_RECORD,
    dailyStreak: 1,
    lastDaily: '2026-09-01',
    trophies: 1,
  });
});

test('consecutive days extend the streak; a replay of the same date pays nothing', () => {
  const record = new RecordStore(fakeStorage());
  record.recordDailyWin('2026-09-01');
  assert.deepEqual(record.recordDailyWin('2026-09-01'), { credited: false, streak: 1, trophies: 0 });
  assert.deepEqual(record.recordDailyWin('2026-09-02'), { credited: true, streak: 2, trophies: 1 });
  assert.equal(record.value.trophies, 2);
  assert.equal(record.value.lastDaily, '2026-09-02');
});

test('a missed day restarts the streak at 1', () => {
  const record = new RecordStore(fakeStorage());
  record.recordDailyWin('2026-09-01');
  record.recordDailyWin('2026-09-02');
  assert.deepEqual(record.recordDailyWin('2026-09-04'), { credited: true, streak: 1, trophies: 1 });
  assert.equal(record.value.trophies, 3);
});

test('a past date is never credited out of order', () => {
  const record = new RecordStore(fakeStorage());
  record.recordDailyWin('2026-09-05');
  // Yesterday's board finished after today's: the streak is what it is.
  assert.deepEqual(record.recordDailyWin('2026-09-04'), { credited: false, streak: 1, trophies: 0 });
  assert.equal(record.value.lastDaily, '2026-09-05');
});

test('the streak crosses month, year and DST boundaries', () => {
  const record = new RecordStore(fakeStorage());
  // Oct 30 → Nov 3 2026 spans the US fall-back on Nov 1.
  for (const key of ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03']) {
    record.recordDailyWin(key);
  }
  assert.equal(record.value.dailyStreak, 5);
  record.recordDailyWin('2026-12-31');
  assert.deepEqual(record.recordDailyWin('2027-01-01'), { credited: true, streak: 2, trophies: 1 });
});

test('trophies escalate at the 7- and 30-day tiers', () => {
  const record = new RecordStore(fakeStorage());
  let paid = 0;
  for (let i = 0; i < 30; i++) {
    const d = new Date(Date.UTC(2026, 8, 1 + i));
    const key = d.toISOString().slice(0, 10);
    const credit = record.recordDailyWin(key);
    paid += credit.trophies;
    assert.equal(credit.streak, i + 1);
    assert.equal(credit.trophies, i + 1 >= 30 ? 3 : i + 1 >= 7 ? 2 : 1, key);
  }
  // 6 days × 1 + 23 days × 2 + 1 day × 3.
  assert.equal(paid, 6 + 46 + 3);
  assert.equal(record.value.trophies, paid);
});

test('liveStreak: alive if the last clear was today or yesterday, else 0', () => {
  const alive = { ...EMPTY_RECORD, dailyStreak: 4, lastDaily: '2026-09-01' };
  assert.equal(liveStreak(alive, '2026-09-01'), 4);
  assert.equal(liveStreak(alive, '2026-09-02'), 4);
  assert.equal(liveStreak(alive, '2026-09-03'), 0);
  assert.equal(liveStreak(EMPTY_RECORD, '2026-09-01'), 0);
});

test('parsePlayerRecord drops a streak whose date it cannot vouch for', () => {
  assert.deepEqual(parsePlayerRecord({ dailyStreak: 9, lastDaily: 'yesterday' }), EMPTY_RECORD);
  assert.deepEqual(parsePlayerRecord({ dailyStreak: 9 }), EMPTY_RECORD);
  assert.deepEqual(parsePlayerRecord({ dailyStreak: 9, lastDaily: '2026-02-30' }), EMPTY_RECORD);
  const ok = parsePlayerRecord({ dailyStreak: 9, lastDaily: '2026-09-01' });
  assert.equal(ok.dailyStreak, 9);
  assert.equal(ok.lastDaily, '2026-09-01');
});

test('a throwing storage still yields a working in-memory record', () => {
  const broken: KeyValueStorage = {
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
  const record = new RecordStore(broken);
  assert.equal(record.recordDailyWin('2026-09-01').credited, true);
  assert.equal(record.recordWin(10, { level: 1, stars: 3 }).stars['1'], 3);
  assert.equal(storageKeyIsStable(), true);
});

function storageKeyIsStable(): boolean {
  return RECORD_STORAGE_KEY === 'mahjong.record.v1';
}
