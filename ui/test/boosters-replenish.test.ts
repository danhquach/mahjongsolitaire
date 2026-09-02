// Booster replenishment (issue #51, spec §5; rules revised in issue #117):
// ads-independent grant channels — every third distinct clear (random type),
// milestone level (one of each), daily login — under a 99 cap, persisted with the balances. The acceptance criteria are tested one by
// one below.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bandForLevel, dailyDateKey } from '@mahjongsolitaire/core';
import {
  BOOSTER_CAP,
  BOOSTER_KINDS,
  BoosterCharges,
  CHARGES_STORAGE_KEY,
  DAILY_LOGIN_GRANT,
  MILESTONE_LEVEL_GRANT,
  STARTING_GRANT,
  THIRD_CLEAR_EVERY,
  THIRD_CLEAR_GRANT,
  thirdClearDue,
} from '../src/boosters.js';
import type { BoosterKind, ChargeStorage } from '../src/boosters.js';
import { RecordStore, clearedLevelCount, hasCleared } from '../src/profile.js';
import type { KeyValueStorage } from '../src/storage.js';

function fakeStorage(seed?: string): ChargeStorage & KeyValueStorage & { store: Map<string, string> } {
  const store = new Map<string, string>();
  if (seed !== undefined) store.set(CHARGES_STORAGE_KEY, seed);
  return {
    store,
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => void store.set(key, value),
    removeItem: (key) => void store.delete(key),
  };
}

function balances(c: BoosterCharges): Record<BoosterKind, number> {
  return { hint: c.remaining('hint'), undo: c.remaining('undo'), shuffle: c.remaining('shuffle') };
}

test('PM numbers (#117): cap 99, +1 random every 3 new levels, milestone level +1 each, daily +1 each', () => {
  assert.equal(BOOSTER_CAP, 99);
  assert.equal(THIRD_CLEAR_GRANT, 1);
  assert.equal(THIRD_CLEAR_EVERY, 3);
  assert.equal(MILESTONE_LEVEL_GRANT, 1);
  assert.equal(DAILY_LOGIN_GRANT, 1);
});

// --- cap ------------------------------------------------------------------------

test('grant adds and reports what landed; the cap clamps rather than rejects', () => {
  const charges = new BoosterCharges();
  assert.equal(charges.grant('hint', 2), 2);
  assert.equal(charges.remaining('hint'), STARTING_GRANT + 2);
  assert.equal(charges.grant('hint', 1000), BOOSTER_CAP - STARTING_GRANT - 2);
  assert.equal(charges.remaining('hint'), BOOSTER_CAP);
  assert.equal(charges.grant('hint', 1), 0);
  assert.equal(charges.remaining('hint'), BOOSTER_CAP);
  assert.throws(() => charges.grant('undo', -1), RangeError);
  assert.throws(() => charges.grant('undo', 1.5), RangeError);
});

test('no combination of channels exceeds the cap; a stored count above it is clamped on read', () => {
  const charges = new BoosterCharges(fakeStorage(JSON.stringify({ hint: 98, undo: 150, shuffle: 99 })));
  assert.deepEqual(balances(charges), { hint: 98, undo: 99, shuffle: 99 });
  charges.grantSplit(THIRD_CLEAR_GRANT, () => 0); // onto hint
  charges.grantEach(MILESTONE_LEVEL_GRANT);
  charges.grantDailyLogin('2026-09-01');
  charges.grant('shuffle', 5);
  assert.deepEqual(balances(charges), { hint: 99, undo: 99, shuffle: 99 });
});

// --- random grants ---------------------------------------------------------------

test('the random grant is driven by the injected source and lands exactly one charge', () => {
  for (const [roll, kind] of [[0.1, 'hint'], [0.5, 'undo'], [0.9, 'shuffle']] as const) {
    const charges = new BoosterCharges();
    const got = charges.grantSplit(THIRD_CLEAR_GRANT, () => roll);
    assert.equal(got.hint + got.undo + got.shuffle, 1);
    assert.equal(got[kind], 1);
    assert.equal(charges.remaining(kind), STARTING_GRANT + 1);
  }
  // A random source that returns exactly 1 (out of contract) still lands on a real type.
  assert.deepEqual(new BoosterCharges().grantSplit(1, () => 1), { hint: 0, undo: 0, shuffle: 1 });
});

test('thirdClearDue fires on every third distinct clear and never on zero', () => {
  assert.equal(thirdClearDue(0), false);
  assert.equal(thirdClearDue(1), false);
  assert.equal(thirdClearDue(2), false);
  assert.equal(thirdClearDue(3), true);
  assert.equal(thirdClearDue(4), false);
  assert.equal(thirdClearDue(6), true);
  assert.equal(thirdClearDue(150), true);
});

// --- milestone level: one of each ------------------------------------------------

test('grantEach adds n of every booster, clamped per type, and reports what landed', () => {
  const charges = new BoosterCharges(fakeStorage(JSON.stringify({ hint: 0, undo: 5, shuffle: 99 })));
  assert.deepEqual(charges.grantEach(MILESTONE_LEVEL_GRANT), { hint: 1, undo: 1, shuffle: 0 });
  assert.deepEqual(balances(charges), { hint: 1, undo: 6, shuffle: 99 });
  assert.throws(() => charges.grantEach(-1), RangeError);
});

test('the grants applied per main.ts: a plain first clear pays nothing; every third pays one; a milestone pays one of each', () => {
  const record = new RecordStore(fakeStorage());
  const charges = new BoosterCharges();
  // Mirror of the win branch in main.ts: every third distinct clear pays a
  // random charge; a decade level pays one of each; nothing else pays.
  const winLevel = (level: number, roll: number): Record<BoosterKind, number> => {
    const firstClear = !hasCleared(record.value, level);
    record.recordWin(100, { level, stars: 3 });
    const got: Record<BoosterKind, number> = { hint: 0, undo: 0, shuffle: 0 };
    if (!firstClear) return got;
    const add = (part: Record<BoosterKind, number>): void => {
      for (const k of BOOSTER_KINDS) got[k] += part[k];
    };
    if (thirdClearDue(clearedLevelCount(record.value))) add(charges.grantSplit(THIRD_CLEAR_GRANT, () => roll));
    if (bandForLevel(level).spike) add(charges.grantEach(MILESTONE_LEVEL_GRANT));
    return got;
  };
  assert.deepEqual(winLevel(8, 0.1), { hint: 0, undo: 0, shuffle: 0 }); // 1st distinct clear: nothing
  assert.deepEqual(winLevel(9, 0.1), { hint: 0, undo: 0, shuffle: 0 }); // 2nd: nothing
  // Level 10: the 3rd distinct clear *and* a milestone level — both stack:
  // third-clear +1 shuffle, then one of each.
  assert.deepEqual(winLevel(10, 0.9), { hint: 1, undo: 1, shuffle: 2 });
  assert.deepEqual(balances(charges), { hint: STARTING_GRANT + 1, undo: STARTING_GRANT + 1, shuffle: STARTING_GRANT + 2 });
  // Replaying the milestone pays nothing at all.
  assert.deepEqual(winLevel(10, 0.9), { hint: 0, undo: 0, shuffle: 0 });
  assert.deepEqual(balances(charges), { hint: STARTING_GRANT + 1, undo: STARTING_GRANT + 1, shuffle: STARTING_GRANT + 2 });
  // Level 20: the 4th distinct clear — milestone set only.
  assert.deepEqual(winLevel(20, 0.1), { hint: 1, undo: 1, shuffle: 1 });
});

// --- first clear vs replay (the record decides) -----------------------------------

test('replaying a level is never a first clear, and the milestone counter does not move', () => {
  const record = new RecordStore(fakeStorage());
  assert.equal(hasCleared(record.value, 5), false);
  record.recordWin(100, { level: 5, stars: 2 });
  assert.equal(hasCleared(record.value, 5), true);
  assert.equal(clearedLevelCount(record.value), 1);
  // Three more clears of the same level: still one distinct level, no third-clear bonus.
  for (let i = 0; i < 3; i++) record.recordWin(100, { level: 5, stars: 3 });
  assert.equal(clearedLevelCount(record.value), 1);
  assert.equal(thirdClearDue(clearedLevelCount(record.value)), false);
  // Two *different* levels bring the distinct count to three.
  record.recordWin(100, { level: 6, stars: 1 });
  record.recordWin(100, { level: 7, stars: 1 });
  assert.equal(clearedLevelCount(record.value), 3);
  assert.equal(thirdClearDue(clearedLevelCount(record.value)), true);
  // A Daily clear (no level) is not a ladder clear.
  record.recordWin(100);
  assert.equal(clearedLevelCount(record.value), 3);
});

test('the every-third grant applied per main.ts: a replay leaves the balance alone', () => {
  const record = new RecordStore(fakeStorage());
  const charges = new BoosterCharges();
  const winLevel = (level: number): void => {
    const firstClear = !hasCleared(record.value, level);
    record.recordWin(100, { level, stars: 3 });
    if (firstClear && thirdClearDue(clearedLevelCount(record.value))) charges.grantSplit(THIRD_CLEAR_GRANT, () => 0.5); // → undo
  };
  winLevel(1);
  winLevel(2);
  winLevel(3);
  assert.equal(charges.remaining('undo'), STARTING_GRANT + 1);
  winLevel(3);
  winLevel(3);
  assert.equal(charges.remaining('undo'), STARTING_GRANT + 1);
});

// --- daily login ------------------------------------------------------------------

test('daily login grants +1 of each once per calendar day', () => {
  const storage = fakeStorage();
  const charges = new BoosterCharges(storage);
  assert.deepEqual(charges.grantDailyLogin('2026-09-01'), { hint: 1, undo: 1, shuffle: 1 });
  assert.equal(charges.grantDailyLogin('2026-09-01'), null);
  assert.deepEqual(balances(charges), { hint: 6, undo: 6, shuffle: 6 });
  // Persisted with the balances, and honoured by the next launch.
  const relaunched = new BoosterCharges(storage);
  assert.equal(relaunched.grantDailyLogin('2026-09-01'), null);
  assert.deepEqual(relaunched.grantDailyLogin('2026-09-02'), { hint: 1, undo: 1, shuffle: 1 });
  assert.deepEqual(balances(relaunched), { hint: 7, undo: 7, shuffle: 7 });
});

test('winding the clock back, or forward to a day already paid, grants nothing', () => {
  const charges = new BoosterCharges();
  assert.ok(charges.grantDailyLogin('2026-09-02'));
  assert.equal(charges.grantDailyLogin('2026-09-01'), null); // back a day
  assert.equal(charges.grantDailyLogin('2026-08-01'), null); // back a month
  assert.equal(charges.grantDailyLogin('2026-09-02'), null); // forward again to the paid day
  assert.ok(charges.grantDailyLogin('2026-09-03'));
  assert.deepEqual(balances(charges), { hint: 7, undo: 7, shuffle: 7 });
});

test('daily login keys off the local calendar date across zones and DST (spec §11.2)', () => {
  // Same instant, two zones, two different dates: the grant follows the local day.
  const at = new Date('2026-09-01T03:30:00Z');
  const la = new BoosterCharges();
  const nz = new BoosterCharges();
  assert.ok(la.grantDailyLogin(dailyDateKey(at, 'America/Los_Angeles'))); // 2026-08-31
  assert.ok(nz.grantDailyLogin(dailyDateKey(at, 'Pacific/Auckland'))); // 2026-09-01
  // Los Angeles crosses its own midnight seven hours on: a new day, one more grant.
  assert.ok(la.grantDailyLogin(dailyDateKey(new Date('2026-09-01T07:00:00Z'), 'America/Los_Angeles')));
  assert.equal(la.grantDailyLogin(dailyDateKey(new Date('2026-09-01T23:00:00Z'), 'America/Los_Angeles')), null);
  // DST fall-back in New York (2026-11-01): the 25-hour day is one day — the
  // instants either side of the repeated hour pay nothing extra; midnight does.
  const ny = new BoosterCharges();
  const zone = 'America/New_York';
  assert.ok(ny.grantDailyLogin(dailyDateKey(new Date('2026-11-01T05:59:59Z'), zone)));
  assert.equal(ny.grantDailyLogin(dailyDateKey(new Date('2026-11-01T06:00:00Z'), zone)), null);
  assert.equal(ny.grantDailyLogin(dailyDateKey(new Date('2026-11-02T04:59:59Z'), zone)), null);
  assert.ok(ny.grantDailyLogin(dailyDateKey(new Date('2026-11-02T05:00:00Z'), zone)));
  // Spring-forward (2026-03-08): the 23-hour day likewise.
  const spring = new BoosterCharges();
  assert.ok(spring.grantDailyLogin(dailyDateKey(new Date('2026-03-08T06:59:59Z'), zone)));
  assert.equal(spring.grantDailyLogin(dailyDateKey(new Date('2026-03-08T07:00:00Z'), zone)), null);
  // …and after the jump New York is UTC−4, so its midnight is 04:00Z.
  assert.equal(spring.grantDailyLogin(dailyDateKey(new Date('2026-03-09T03:59:59Z'), zone)), null);
  assert.ok(spring.grantDailyLogin(dailyDateKey(new Date('2026-03-09T04:00:00Z'), zone)));
  assert.throws(() => spring.grantDailyLogin('today'), RangeError);
});

test('a player at zero of everything gets back to a non-zero balance with no ads or purchase', () => {
  const charges = new BoosterCharges(fakeStorage(JSON.stringify({ hint: 0, undo: 0, shuffle: 0 })));
  for (const kind of BOOSTER_KINDS) assert.equal(charges.has(kind), false);
  charges.grantDailyLogin('2026-09-01');
  for (const kind of BOOSTER_KINDS) assert.equal(charges.remaining(kind), 1);
});

// --- persistence ------------------------------------------------------------------

test('grants persist through the same record as the balances', () => {
  const storage = fakeStorage();
  const charges = new BoosterCharges(storage);
  charges.grant('shuffle', 2);
  charges.grantDailyLogin('2026-09-01');
  assert.deepEqual(JSON.parse(storage.store.get(CHARGES_STORAGE_KEY)!), {
    hint: 6,
    undo: 6,
    shuffle: 8,
    lastLoginGrant: '2026-09-01',
  });
  assert.deepEqual(balances(new BoosterCharges(storage)), { hint: 6, undo: 6, shuffle: 8 });
});

test('a failed write does not double-grant on the next launch', () => {
  // Storage that reads fine but refuses every write: the grant lives in memory
  // only, and so does the date — both are lost together.
  const persisted = JSON.stringify({ hint: 2, undo: 2, shuffle: 2, lastLoginGrant: '2026-08-31' });
  const readOnly: ChargeStorage = {
    getItem: () => persisted,
    setItem: () => {
      throw new Error('quota');
    },
  };
  const first = new BoosterCharges(readOnly);
  assert.ok(first.grantDailyLogin('2026-09-01'));
  assert.deepEqual(balances(first), { hint: 3, undo: 3, shuffle: 3 });
  // Next launch: the persisted record still says Aug 31 at 2 each, so the
  // grant is due again — from 2, landing on 3, not on 4.
  const next = new BoosterCharges(readOnly);
  assert.deepEqual(balances(next), { hint: 2, undo: 2, shuffle: 2 });
  assert.ok(next.grantDailyLogin('2026-09-01'));
  assert.deepEqual(balances(next), { hint: 3, undo: 3, shuffle: 3 });
});

test('a malformed stored login date reads as never granted', () => {
  const charges = new BoosterCharges(fakeStorage(JSON.stringify({ hint: 5, undo: 5, shuffle: 5, lastLoginGrant: 'yesterday' })));
  assert.ok(charges.grantDailyLogin('2026-09-01'));
});
