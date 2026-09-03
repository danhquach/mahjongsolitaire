// What a date asks for (issue #183): three challenges, a pure function of the
// date key, the same three for every player on that date.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CHALLENGE_KINDS,
  CHALLENGE_SUITS,
  DAILY_CHALLENGE_COUNT,
  dailyChallenges,
} from '../src/challenges.js';

/** Every date key in a year, so a property holds across the calendar rather
 *  than across the three dates someone happened to pick. */
function keysAcrossAYear(): string[] {
  const keys: string[] = [];
  for (let day = 0; day < 366; day++) {
    keys.push(new Date(Date.UTC(2026, 0, 1 + day)).toISOString().slice(0, 10));
  }
  return keys;
}

test('a date always yields the same three challenges', () => {
  const first = dailyChallenges('2026-09-03');
  assert.equal(first.length, DAILY_CHALLENGE_COUNT);
  assert.deepEqual(dailyChallenges('2026-09-03'), first);
});

test('different dates differ, and every kind is used across a year', () => {
  const seen = new Set<string>();
  const kinds = new Set<string>();
  for (const key of keysAcrossAYear()) {
    const day = dailyChallenges(key);
    seen.add(day.map((c) => `${c.kind}:${c.target}:${c.suit ?? ''}`).join('|'));
    for (const c of day) kinds.add(c.kind);
  }
  assert.ok(seen.size > 10, `expected varied days, got ${seen.size} distinct`);
  assert.deepEqual([...kinds].sort(), [...CHALLENGE_KINDS].sort());
});

test('a day never repeats a kind, and only a suit challenge names a suit', () => {
  for (const key of keysAcrossAYear()) {
    const day = dailyChallenges(key);
    const kinds = day.map((c) => c.kind);
    assert.equal(new Set(kinds).size, DAILY_CHALLENGE_COUNT, `${key} repeated a kind: ${kinds}`);
    for (const c of day) {
      assert.ok(Number.isInteger(c.target) && c.target >= 1, `${key} bad target: ${c.target}`);
      if (c.kind === 'suit') {
        assert.ok(CHALLENGE_SUITS.includes(c.suit!), `${key} suit out of range: ${c.suit}`);
      } else {
        assert.equal(c.suit, undefined, `${key} ${c.kind} carries a suit`);
      }
    }
  }
});

test('the boards challenge never asks for more than two', () => {
  // PM, 2026-09-03: a finished board is the longest unit of play there is.
  for (const key of keysAcrossAYear()) {
    for (const c of dailyChallenges(key)) {
      if (c.kind === 'boards') assert.ok(c.target <= 2, `${key} asked for ${c.target} boards`);
    }
  }
});

test('every target fits inside a day of play', () => {
  // A full board is 72 pairs, 18 of any of the three big suits.
  for (const key of keysAcrossAYear()) {
    for (const c of dailyChallenges(key)) {
      if (c.kind === 'pairs') assert.ok(c.target <= 72);
      if (c.kind === 'suit') assert.ok(c.target <= 18);
      if (c.kind === 'clean-run') assert.ok(c.target <= 20);
    }
  }
});

test('a malformed date key throws', () => {
  assert.throws(() => dailyChallenges('2026-9-3'), RangeError);
  assert.throws(() => dailyChallenges('2026-02-30'), RangeError);
  assert.throws(() => dailyChallenges(''), RangeError);
});
