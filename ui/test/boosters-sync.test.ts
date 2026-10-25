// Booster charges follow a synced profile (issue #272): the ledger, its merge,
// and the balance it derives.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BOOSTER_CAP,
  BoosterCharges,
  CHARGES_STORAGE_KEY,
  EMPTY_LEDGER,
  MAX_DEVICES,
  STARTING_GRANT,
  balanceOf,
  mergeLedgers,
  parseLedger,
} from '../src/boosters.js';
import type { BoosterLedger, ChargeStorage } from '../src/boosters.js';

function fakeStorage(seed?: string): ChargeStorage & { store: Map<string, string> } {
  const store = new Map<string, string>();
  if (seed !== undefined) store.set(CHARGES_STORAGE_KEY, seed);
  return {
    store,
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => void store.set(key, value),
  };
}

/** A device with a fixed id, so a test can name whose tally is whose. */
function device(id: string, storage?: ChargeStorage): BoosterCharges {
  return new BoosterCharges(storage, CHARGES_STORAGE_KEY, () => id);
}

/** One round trip through the server: each side ends holding the merge. */
function sync(a: BoosterCharges, server: { ledger: BoosterLedger }): void {
  server.ledger = mergeLedgers(server.ledger, a.synced);
  a.adopt(server.ledger);
}

test('a restored profile brings its charges to the new device', () => {
  const server = { ledger: EMPTY_LEDGER };
  const phone = device('phone');
  phone.grant('hint', 10);
  phone.spend('undo');
  sync(phone, server);

  // The tablet is fresh: its own starting grant, untouched.
  const tablet = device('tablet');
  sync(tablet, server);
  assert.equal(tablet.remaining('hint'), STARTING_GRANT + 10);
  assert.equal(tablet.remaining('undo'), STARTING_GRANT - 1);
  assert.equal(tablet.remaining('shuffle'), STARTING_GRANT);
});

test('a spend on one device reaches the other, and is never handed back by a merge', () => {
  const server = { ledger: EMPTY_LEDGER };
  const a = device('a');
  const b = device('b');
  sync(a, server);
  sync(b, server);
  b.spend('shuffle');
  b.spend('shuffle');
  sync(b, server);
  sync(a, server);
  assert.equal(a.remaining('shuffle'), STARTING_GRANT - 2);
  // Syncing again, from either side, in any order, changes nothing.
  sync(a, server);
  sync(b, server);
  sync(a, server);
  assert.equal(a.remaining('shuffle'), STARTING_GRANT - 2);
  assert.equal(b.remaining('shuffle'), STARTING_GRANT - 2);
});

test('earnings made on two devices between syncs add up rather than one winning', () => {
  const server = { ledger: EMPTY_LEDGER };
  const a = device('a');
  const b = device('b');
  a.grant('hint', 3);
  b.grant('hint', 2);
  sync(a, server);
  sync(b, server);
  sync(a, server);
  assert.equal(a.remaining('hint'), STARTING_GRANT + 5);
  assert.equal(b.remaining('hint'), STARTING_GRANT + 5);
});

test('the same charges spent on two devices offline leave a debt, not a negative badge', () => {
  const server = { ledger: EMPTY_LEDGER };
  const a = device('a');
  const b = device('b');
  for (let i = 0; i < STARTING_GRANT; i++) {
    a.spend('hint');
    b.spend('hint');
  }
  sync(a, server);
  sync(b, server);
  assert.equal(b.remaining('hint'), 0);
  assert.equal(b.has('hint'), false);
  // The debt is paid back before the badge moves.
  b.grant('hint', STARTING_GRANT + 1);
  assert.equal(b.remaining('hint'), 1);
});

test('the balance stays inside 0..cap however the devices add up', () => {
  const ledger = parseLedger({
    day: null,
    devices: {
      a: { earned: { hint: 90, undo: 0, shuffle: 0 }, spent: { hint: 0, undo: 0, shuffle: 0 } },
      b: { earned: { hint: 90, undo: 0, shuffle: 0 }, spent: { hint: 0, undo: 40, shuffle: 0 } },
    },
  });
  assert.equal(balanceOf(ledger, 'hint'), BOOSTER_CAP);
  assert.equal(balanceOf(ledger, 'undo'), 0);
  assert.equal(balanceOf(ledger, 'shuffle'), STARTING_GRANT);
});

test('the merge is commutative and idempotent', () => {
  const x = parseLedger({
    day: '2026-10-20',
    devices: {
      a: { earned: { hint: 3, undo: 1, shuffle: 0 }, spent: { hint: 1, undo: 0, shuffle: 2 } },
      b: { earned: { hint: 0, undo: 0, shuffle: 4 }, spent: { hint: 0, undo: 0, shuffle: 0 } },
    },
  });
  const y = parseLedger({
    day: '2026-10-22',
    devices: {
      a: { earned: { hint: 5, undo: 0, shuffle: 0 }, spent: { hint: 0, undo: 0, shuffle: 3 } },
      c: { earned: { hint: 1, undo: 1, shuffle: 1 }, spent: { hint: 1, undo: 1, shuffle: 1 } },
    },
  });
  const xy = mergeLedgers(x, y);
  assert.deepEqual(xy, mergeLedgers(y, x));
  assert.deepEqual(mergeLedgers(xy, y), xy);
  assert.deepEqual(mergeLedgers(xy, xy), xy);
  assert.equal(xy.day, '2026-10-22');
  assert.deepEqual(xy.devices['a'], {
    earned: { hint: 5, undo: 1, shuffle: 0 },
    spent: { hint: 1, undo: 0, shuffle: 3 },
  });
  assert.deepEqual(Object.keys(xy.devices), ['a', 'b', 'c']);
});

test('the daily grant is paid once per profile per day once the devices have synced', () => {
  const server = { ledger: EMPTY_LEDGER };
  const a = device('a');
  const b = device('b');
  assert.notEqual(a.grantDailyLogin('2026-10-24'), null);
  sync(a, server);
  sync(b, server);
  assert.equal(b.grantDailyLogin('2026-10-24'), null);
  assert.equal(b.remaining('hint'), STARTING_GRANT + 1);
  // The next day is due again, on either device.
  assert.notEqual(b.grantDailyLogin('2026-10-25'), null);
});

test('a junk ledger is parsed field by field, never trusted', () => {
  assert.deepEqual(parseLedger(null), EMPTY_LEDGER);
  assert.deepEqual(parseLedger([]), EMPTY_LEDGER);
  const parsed = parseLedger({
    day: 'yesterday',
    devices: {
      'Not An Id': { earned: { hint: 5 } },
      ok: { earned: { hint: -1, undo: 1.5, shuffle: 'x' }, spent: { hint: 2 } },
      gone: 'nope',
    },
  });
  assert.deepEqual(parsed, {
    day: null,
    devices: { ok: { earned: { hint: 0, undo: 0, shuffle: 0 }, spent: { hint: 2, undo: 0, shuffle: 0 } } },
  });
  // More devices than the cap keeps the lowest ids, the same cut on every side.
  const many = Object.fromEntries(
    Array.from({ length: MAX_DEVICES + 5 }, (_, i) => [`d${String(i).padStart(3, '0')}`, {}]),
  );
  const capped = Object.keys(parseLedger({ devices: many }).devices);
  assert.equal(capped.length, MAX_DEVICES);
  assert.equal(capped[0], 'd000');
});

test('a balance stored before the ledger reads the same after the upgrade, under one id', () => {
  const storage = fakeStorage(JSON.stringify({ hint: 12, undo: 2, shuffle: 5, lastLoginGrant: '2026-10-01' }));
  let ids = 0;
  const first = new BoosterCharges(storage, CHARGES_STORAGE_KEY, () => `id${++ids}`);
  assert.equal(first.remaining('hint'), 12);
  assert.equal(first.remaining('undo'), 2);
  assert.equal(first.remaining('shuffle'), 5);
  assert.equal(first.synced.day, '2026-10-01');
  // Written at once: a second launch must not migrate again under a new id,
  // or a tally that already synced would count twice.
  const second = new BoosterCharges(storage, CHARGES_STORAGE_KEY, () => `id${++ids}`);
  assert.deepEqual(second.synced, first.synced);
  assert.deepEqual(Object.keys(second.synced.devices), ['id1']);
});

test('the device id and its tally survive a restart', () => {
  const storage = fakeStorage();
  const first = device('abc', storage);
  first.spend('hint');
  const resumed = new BoosterCharges(storage);
  assert.deepEqual(Object.keys(resumed.synced.devices), ['abc']);
  resumed.spend('hint');
  assert.equal(resumed.synced.devices['abc']!.spent.hint, 2);
});
