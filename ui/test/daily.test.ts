// Today's progress against today's three challenges (issue #183). Progress is
// per local calendar date and counts every match played on the ladder — a
// loss, a restart and an abandoned board all keep what they earned.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { dailyChallenges } from '@mahjongsolitaire/core';
import { DAILY_STORAGE_KEY, DailyStore, describeChallenge } from '../src/daily.js';
import type { KeyValueStorage } from '../src/storage.js';

const TODAY = '2026-09-03';
const YESTERDAY = '2026-09-02';

function fakeStorage(
  seed: Record<string, string> = {},
): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(seed));
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

/** The slot a kind sits in on a date, or -1 — the day's kinds are dealt by the
 *  date, so a test looks the slot up rather than assuming one. */
function slotOf(kind: string, day = TODAY): number {
  return dailyChallenges(day).findIndex((c) => c.kind === kind);
}

/** A date that actually serves `kind`, searching forward from TODAY. A test
 *  that skipped itself when the day's deal lacked its kind would pass while
 *  covering nothing, which is how three of these tests first shipped green. */
function dayWith(kind: string): string {
  for (let i = 0; i < 366; i++) {
    const key = new Date(Date.parse(`${TODAY}T00:00:00Z`) + i * 86_400_000)
      .toISOString()
      .slice(0, 10);
    if (slotOf(kind, key) !== -1) return key;
  }
  throw new Error(`no date serves ${kind}`);
}

test('a match ticks every counter it feeds', () => {
  const day = dayWith('clean-run');
  const pairs = slotOf('pairs', day);
  const clean = slotOf('clean-run', day);
  const boards = slotOf('boards', day);
  assert.notEqual(pairs, -1);
  const store = new DailyStore(fakeStorage());
  store.onMatch(day, 'dots');
  const standing = store.standing(day);
  assert.equal(standing[pairs]!.count, 1);
  assert.equal(standing[clean]!.count, 1);
  if (boards !== -1) assert.equal(standing[boards]!.count, 0, 'a match is not a finished board');
});

test('a suit challenge counts only its own suit', () => {
  const day = dayWith('suit');
  const suitSlot = slotOf('suit', day);
  const store = new DailyStore(fakeStorage());
  const wanted = dailyChallenges(day)[suitSlot]!.suit!;
  const other = wanted === 'dots' ? 'bamboo' : 'dots';
  store.onMatch(day, other);
  assert.equal(store.standing(day)[suitSlot]!.count, 0);
  store.onMatch(day, wanted);
  assert.equal(store.standing(day)[suitSlot]!.count, 1);
});

test('progress persists and accumulates across boards', () => {
  const storage = fakeStorage();
  const store = new DailyStore(storage);
  const pairs = slotOf('pairs');
  assert.notEqual(pairs, -1);
  store.onMatch(TODAY, 'dots');
  store.onMatch(TODAY, 'dots');
  // A new store is a new board, a reload, a loss — the counters are the day's.
  assert.equal(new DailyStore(storage).standing(TODAY)[pairs]!.count, 2);
});

test('yesterday reads as zero without any timer firing', () => {
  const store = new DailyStore(fakeStorage());
  store.onMatch(YESTERDAY, 'dots');
  assert.ok(store.standing(YESTERDAY).some((s) => s.count > 0));
  for (const slot of store.standing(TODAY)) assert.equal(slot.count, 0);
  assert.equal(store.completedCount(TODAY), 0);
});

test('a hint or shuffle resets the clean run, and nothing else', () => {
  const day = dayWith('clean-run');
  const clean = slotOf('clean-run', day);
  const pairs = slotOf('pairs', day);
  assert.notEqual(pairs, -1, 'pick a day that also counts pairs, to prove the reset is targeted');
  const store = new DailyStore(fakeStorage());
  store.onMatch(day, 'dots');
  store.onMatch(day, 'dots');
  store.onAssist(day);
  assert.equal(store.standing(day)[clean]!.count, 0);
  assert.equal(store.standing(day)[pairs]!.count, 2, 'other counters survive');
});

test('completing a challenge reports its slot once and freezes it', () => {
  const day = dayWith('boards');
  const boards = slotOf('boards', day);
  const store = new DailyStore(fakeStorage());
  const target = dailyChallenges(day)[boards]!.target;
  let completed: readonly number[] = [];
  for (let i = 0; i < target; i++) completed = store.onBoardCleared(day);
  assert.deepEqual([...completed], [boards]);
  assert.equal(store.standing(day)[boards]!.done, true);
  // A later clear neither re-reports nor pushes the count past the target.
  assert.deepEqual([...store.onBoardCleared(day)], []);
  assert.equal(store.standing(day)[boards]!.count, target);
});

test('a completed clean run stays complete when an assist follows it', () => {
  const day = dayWith('clean-run');
  const clean = slotOf('clean-run', day);
  const store = new DailyStore(fakeStorage());
  const target = dailyChallenges(day)[clean]!.target;
  for (let i = 0; i < target; i++) store.onMatch(day, 'dots');
  assert.equal(store.standing(day)[clean]!.done, true);
  store.onAssist(day);
  assert.equal(store.standing(day)[clean]!.done, true);
  assert.equal(store.standing(day)[clean]!.count, target);
});

test('malformed storage reads as a fresh day rather than throwing', () => {
  for (const junk of ['not json', '{}', '{"date":"nope","counts":"x","done":3}', '[]']) {
    const store = new DailyStore(fakeStorage({ [DAILY_STORAGE_KEY]: junk }));
    assert.equal(store.completedCount(TODAY), 0);
    assert.equal(store.standing(TODAY).length, 3);
  }
});

test('a stored count beyond the target still reads as the target', () => {
  // A hand-edited record, or a build with a lower target than the one that
  // wrote it: the panel must never render 99 / 20.
  const store = new DailyStore(
    fakeStorage({
      [DAILY_STORAGE_KEY]: JSON.stringify({
        date: TODAY,
        counts: [999, 999, 999],
        done: [false, false, false],
      }),
    }),
  );
  for (const slot of store.standing(TODAY)) assert.equal(slot.count, slot.challenge.target);
});

test('completedCount counts only completed slots', () => {
  const day = dayWith('boards');
  const boards = slotOf('boards', day);
  const store = new DailyStore(fakeStorage());
  assert.equal(store.completedCount(day), 0);
  for (let i = 0; i < dailyChallenges(day)[boards]!.target; i++) store.onBoardCleared(day);
  assert.equal(store.completedCount(day), 1);
});

test('a challenge describes itself in sentence case, with the suit named', () => {
  assert.equal(describeChallenge({ kind: 'boards', target: 1 }), 'Finish 1 board');
  assert.equal(describeChallenge({ kind: 'boards', target: 2 }), 'Finish 2 boards');
  assert.equal(describeChallenge({ kind: 'pairs', target: 40 }), 'Match 40 pairs');
  assert.equal(describeChallenge({ kind: 'suit', target: 10, suit: 'dots' }), 'Match 10 Dots pairs');
  assert.equal(
    describeChallenge({ kind: 'suit', target: 6, suit: 'char' }),
    'Match 6 Characters pairs',
  );
  assert.equal(
    describeChallenge({ kind: 'clean-run', target: 12 }),
    'Match 12 pairs in a row without a hint or shuffle',
  );
});
