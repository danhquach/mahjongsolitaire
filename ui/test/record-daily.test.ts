// Progression persistence (issue #19, spec §6; stars removed by issue #119):
// which ladder levels are cleared, total score, and the Daily Challenge
// streak + trophies — all on the player record.

import assert from 'node:assert/strict';
import { test } from 'node:test';

/** A fixed Thursday, so a run that straddles a Sunday cannot flake. */
const NOW = Date.parse('2026-09-03T12:00:00Z');
import { LADDER_LENGTH } from '@mahjongsolitaire/core';
import {
  EMPTY_RECORD,
  RECORD_STORAGE_KEY,
  RecordStore,
  dailyLockedFor,
  hasCleared,
  liveStreak,
  parsePlayerRecord,
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

// --- cleared levels ---------------------------------------------------------------

test('recordWin marks a ladder level cleared, once', () => {
  const storage = fakeStorage();
  const record = new RecordStore(storage);
  record.recordWin(500, { level: 3 }, NOW);
  assert.deepEqual(record.value.cleared, [3]);
  record.recordWin(500, { level: 3 }, NOW); // a replay does not duplicate the entry
  assert.deepEqual(record.value.cleared, [3]);
  record.recordWin(500, { level: 10 }, NOW);
  assert.deepEqual(record.value.cleared, [3, 10]);
  // Persisted, and read back through the parser.
  assert.deepEqual(new RecordStore(storage).value.cleared, [3, 10]);
});

test('a Daily clear pays trophies and the streak and nothing else', () => {
  // Issue #176: score belongs to the ladder and to the weekly board the ladder
  // feeds. A Daily contributes to neither, and is not a level cleared.
  const record = new RecordStore(fakeStorage());
  const credit = record.recordDailyWin('2026-09-03');
  assert.equal(credit.credited, true);
  assert.ok(credit.trophies > 0);
  assert.equal(credit.streak, 1);
  assert.deepEqual(record.value.cleared, []);
  assert.equal(record.value.levelsCleared, 0, 'a Daily is not a level cleared');
  assert.equal(record.value.weekScore, 0, 'a Daily banks no score');
  assert.equal(record.value.weekStart, null);
});

test('parsePlayerRecord keeps only well-formed cleared levels', () => {
  const parsed = parsePlayerRecord({
    cleared: [1, LADDER_LENGTH, LADDER_LENGTH + 1, 0, 2.5, '3', NaN, Infinity, -1, 1],
  });
  assert.deepEqual(parsed.cleared, [1, LADDER_LENGTH]);
  assert.deepEqual(parsePlayerRecord({ cleared: 'lots' }).cleared, []);
  assert.deepEqual(parsePlayerRecord({ cleared: { '1': true } }).cleared, []);
});

test('an old-shape record (stars map, issue #119) migrates: every keyed level counts as cleared, no rating, no re-paid first-clear grant', () => {
  const parsed = parsePlayerRecord({ stars: { '3': 2, '10': 1 } });
  assert.deepEqual(parsed.cleared, [3, 10]);
  assert.equal(hasCleared(parsed, 3), true);
  assert.equal(hasCleared(parsed, 10), true);
  assert.equal(hasCleared(parsed, 5), false);
  assert.equal((parsed as unknown as { stars?: unknown }).stars, undefined);
});

test('a record carrying both a cleared list and an old stars map merges them (issue #119)', () => {
  assert.deepEqual(parsePlayerRecord({ cleared: [3], stars: { '10': 1, '3': 3 } }).cleared, [3, 10]);
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
  assert.deepEqual(record.recordWin(10, { level: 1 }, NOW).cleared, [1]);
  assert.equal(storageKeyIsStable(), true);
});

function storageKeyIsStable(): boolean {
  return RECORD_STORAGE_KEY === 'mahjong.record.v1';
}

// --- dailyLockedFor (issue #166) ---------------------------------------------------

test('dailyLockedFor: locked only once today itself is the last credited date', () => {
  assert.equal(dailyLockedFor(EMPTY_RECORD, '2026-09-02'), false); // never cleared
  const clearedToday = { ...EMPTY_RECORD, lastDaily: '2026-09-02' };
  assert.equal(dailyLockedFor(clearedToday, '2026-09-02'), true);
  const clearedYesterday = { ...EMPTY_RECORD, lastDaily: '2026-09-01' };
  assert.equal(dailyLockedFor(clearedYesterday, '2026-09-02'), false); // rolled over
});

test('dailyLockedFor: a loss never sets lastDaily, so it never locks', () => {
  const storage = fakeStorage();
  const record = new RecordStore(storage);
  // A loss (holder full) records no Daily credit at all — recordDailyWin is
  // simply never called on that path — so the record stays exactly as a
  // fresh install left it: unlocked.
  assert.equal(dailyLockedFor(record.value, '2026-09-02'), false);
});

test('dailyLockedFor: credited today locks; the same credit stops locking once the date moves on', () => {
  const storage = fakeStorage();
  const record = new RecordStore(storage);
  record.recordDailyWin('2026-09-02');
  assert.equal(dailyLockedFor(record.value, '2026-09-02'), true);
  assert.equal(dailyLockedFor(record.value, '2026-09-03'), false);
});
