// The leaderboard week (issue #176): Sunday 00:00 UTC, on the server's clock.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  WEEK_MS,
  isWeekKey,
  msUntilWeekReset,
  weekResetAt,
  weekStartKey,
  weekStartMs,
} from '../src/week.js';

const at = (iso: string): number => Date.parse(iso);

// 2026-09-06 is a Sunday; 2026-09-03 (the day this shipped) is the Thursday
// inside that week's predecessor, which opened Sunday 2026-08-30.
test('the week opens on Sunday 00:00 UTC', () => {
  assert.equal(weekStartKey(at('2026-09-03T12:00:00Z')), '2026-08-30');
  assert.equal(weekStartKey(at('2026-09-06T00:00:00Z')), '2026-09-06');
  assert.equal(weekStartKey(at('2026-09-12T23:59:59.999Z')), '2026-09-06');
});

test('the boundary is exclusive at the end and inclusive at the start', () => {
  // The last millisecond of a week and the first of the next must not land in
  // the same bucket, or a run at the rollover is counted into a week that has
  // already been ranked and shown as final.
  const lastMs = at('2026-09-05T23:59:59.999Z');
  const firstMs = at('2026-09-06T00:00:00.000Z');
  assert.equal(weekStartKey(lastMs), '2026-08-30');
  assert.equal(weekStartKey(firstMs), '2026-09-06');
  assert.equal(weekResetAt(lastMs), firstMs);
  assert.equal(weekStartMs(firstMs), firstMs);
});

test('every instant of a week agrees on its start, and a week is seven days', () => {
  const start = at('2026-09-06T00:00:00Z');
  for (let ms = 0; ms < WEEK_MS; ms += 37 * 60 * 1000) {
    assert.equal(weekStartMs(start + ms), start, `drift at +${ms}ms`);
    assert.equal(weekResetAt(start + ms), start + WEEK_MS);
  }
  assert.equal(weekStartMs(start + WEEK_MS), start + WEEK_MS, 'the next week is its own');
});

test('the countdown runs down to zero and never below', () => {
  const start = at('2026-09-06T00:00:00Z');
  assert.equal(msUntilWeekReset(start), WEEK_MS);
  assert.equal(msUntilWeekReset(start + WEEK_MS - 1), 1);
  // At the boundary the caller is already in the next week, so a full week
  // remains — the countdown never reports a negative or a stuck zero.
  assert.equal(msUntilWeekReset(start + WEEK_MS), WEEK_MS);
});

test('the reset lands on a Saturday afternoon in the Americas', () => {
  // The accepted cost of a server-clock boundary, asserted so nobody "fixes"
  // it into a local week later: 2026-09-06T00:00Z is 2026-09-05 17:00 PDT.
  const reset = new Date(weekResetAt(at('2026-09-03T12:00:00Z')));
  const pacific = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    weekday: 'long',
    hour: 'numeric',
  }).format(reset);
  assert.match(pacific, /Saturday/);
});

test('a week is never a year or a month boundary problem', () => {
  // Dec 27 2026 is a Sunday, so the week spanning new year opens in 2026 and
  // ends in 2027 — the key is the Sunday's own date, not a week number.
  assert.equal(weekStartKey(at('2027-01-01T09:00:00Z')), '2026-12-27');
  assert.equal(weekStartKey(at('2026-03-01T00:00:00Z')), '2026-03-01');
  // A leap day sits inside its week like any other date.
  assert.equal(weekStartKey(at('2028-02-29T18:00:00Z')), '2028-02-27');
});

test('only a well-formed date key reads as a week', () => {
  // Shape and parseability, not Sunday-ness: a Monday key is well-formed and
  // simply never equals weekStartKey(now), so it reads as "not this week" —
  // which is the only thing callers ask.
  assert.ok(isWeekKey('2026-09-06'));
  for (const bad of ['2026-9-6', '2026-09-06T00:00:00Z', '2026-13-01', '', 'yesterday', null, 7]) {
    assert.equal(isWeekKey(bad), false, `accepted ${String(bad)}`);
  }
});
