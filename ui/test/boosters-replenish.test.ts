// Booster replenishment (issue #51, spec §5): three ads-independent grant
// channels — first clear, milestone, daily login — under a 99 cap, persisted
// with the balances. The acceptance criteria are tested one by one below.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dailyDateKey } from '@mahjongsolitaire/core';
import {
  BOOSTER_CAP,
  BOOSTER_KINDS,
  BoosterCharges,
  CHARGES_STORAGE_KEY,
  DAILY_LOGIN_GRANT,
  FIRST_CLEAR_GRANT,
  MILESTONE_EVERY,
  MILESTONE_GRANT,
  STARTING_GRANT,
  milestoneDue,
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

test('PM numbers: cap 99, first clear +1, milestone +3 every 3, daily +1 each', () => {
  assert.equal(BOOSTER_CAP, 99);
  assert.equal(FIRST_CLEAR_GRANT, 1);
  assert.equal(MILESTONE_GRANT, 3);
  assert.equal(MILESTONE_EVERY, 3);
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
  charges.grantSplit(MILESTONE_GRANT, () => 0); // all three onto hint
  charges.grantDailyLogin('2026-09-01');
  charges.grant('shuffle', 5);
  assert.deepEqual(balances(charges), { hint: 99, undo: 99, shuffle: 99 });
});

// --- milestone split -------------------------------------------------------------

test('the milestone split is driven by the injected source and totals exactly 3', () => {
  const rolls = [0.1, 0.5, 0.9]; // → hint, undo, shuffle
  const charges = new BoosterCharges();
  const got = charges.grantSplit(MILESTONE_GRANT, () => rolls.shift()!);
  assert.deepEqual(got, { hint: 1, undo: 1, shuffle: 1 });
  assert.equal(got.hint + got.undo + got.shuffle, 3);
  const skewed = new BoosterCharges();
  assert.deepEqual(skewed.grantSplit(MILESTONE_GRANT, () => 0.999), { hint: 0, undo: 0, shuffle: 3 });
  // A random source that returns exactly 1 (out of contract) still lands on a real type.
  assert.deepEqual(new BoosterCharges().grantSplit(1, () => 1), { hint: 0, undo: 0, shuffle: 1 });
});

test('milestoneDue fires on every third distinct clear and never on zero', () => {
  assert.equal(milestoneDue(0), false);
  assert.equal(milestoneDue(1), false);
  assert.equal(milestoneDue(2), false);
  assert.equal(milestoneDue(3), true);
  assert.equal(milestoneDue(4), false);
  assert.equal(milestoneDue(6), true);
  assert.equal(milestoneDue(150), true);
});

// --- first clear vs replay (the record decides) -----------------------------------

test('replaying a level is never a first clear, and the milestone counter does not move', () => {
  const record = new RecordStore(fakeStorage());
  assert.equal(hasCleared(record.value, 5), false);
  record.recordWin(100, { level: 5, stars: 2 });
  assert.equal(hasCleared(record.value, 5), true);
  assert.equal(clearedLevelCount(record.value), 1);
  // Three more clears of the same level: still one distinct level, no milestone.
  for (let i = 0; i < 3; i++) record.recordWin(100, { level: 5, stars: 3 });
  assert.equal(clearedLevelCount(record.value), 1);
  assert.equal(milestoneDue(clearedLevelCount(record.value)), false);
  // Two *different* levels bring the distinct count to three.
  record.recordWin(100, { level: 6, stars: 1 });
  record.recordWin(100, { level: 7, stars: 1 });
  assert.equal(clearedLevelCount(record.value), 3);
  assert.equal(milestoneDue(clearedLevelCount(record.value)), true);
  // A Daily clear (no level) is not a ladder clear.
  record.recordWin(100);
  assert.equal(clearedLevelCount(record.value), 3);
});

test('the first-clear grant applied per main.ts: a replay leaves the balance alone', () => {
  const record = new RecordStore(fakeStorage());
  const charges = new BoosterCharges();
  const winLevel = (level: number, pick: BoosterKind): void => {
    const firstClear = !hasCleared(record.value, level);
    record.recordWin(100, { level, stars: 3 });
    if (firstClear) charges.grant(pick, FIRST_CLEAR_GRANT);
  };
  winLevel(1, 'undo');
  assert.equal(charges.remaining('undo'), STARTING_GRANT + 1);
  winLevel(1, 'undo');
  winLevel(1, 'undo');
  assert.equal(charges.remaining('undo'), STARTING_GRANT + 1);
});

test('scarcest picks the lowest balance, ties in rail order', () => {
  const charges = new BoosterCharges(fakeStorage(JSON.stringify({ hint: 3, undo: 1, shuffle: 1 })));
  assert.equal(charges.scarcest(), 'undo');
  assert.equal(new BoosterCharges().scarcest(), 'hint');
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
