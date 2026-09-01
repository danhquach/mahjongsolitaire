// Daily Challenge determinism (issue #19, spec §6, §11.2): the board for a
// calendar date is a pure function of the date key, and the key itself is
// derived the way the player's own calendar would across devices, time zones
// and DST boundaries. Also the streak arithmetic and trophy schedule.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';

import { Board } from '../src/board.js';
import {
  DAILY_LAYOUTS,
  STREAK_TIERS,
  dailyDateKey,
  dailyLayoutId,
  dailySeed,
  dailyTrophies,
  daysBetween,
  isDateKey,
} from '../src/daily.js';
import { facesMatch } from '../src/faces.js';
import { generateValidatedLevel } from '../src/generator.js';
import { LADDER_POOLS } from '../src/ladder.js';
import { parseLayout } from '../src/layouts.js';
import type { LayoutFile } from '../src/layouts.js';

const LAYOUT_DIR = new URL('../../../data/layouts/', import.meta.url);

/** Pinned on 2026-09-01 (FNV-1a of "daily:2026-09-01" / "daily-layout:…"):
 *  a refactor that changes either silently re-deals every past date. */
const PINNED_SEED_2026_09_01 = 476086030;
const PINNED_LAYOUT_2026_09_01 = 'pyramid';

// --- date keys ----------------------------------------------------------------

test('isDateKey accepts real YYYY-MM-DD dates only', () => {
  for (const ok of ['2026-09-01', '2024-02-29', '0001-01-01', '9999-12-31']) assert.ok(isDateKey(ok), ok);
  for (const bad of [
    '2026-9-1',
    '2026-13-01',
    '2026-02-30',
    '2025-02-29',
    '2026/09/01',
    '20260901',
    '2026-09-01T00:00',
    '',
    null,
    20260901,
  ]) {
    assert.equal(isDateKey(bad), false, String(bad));
  }
});

test('the same instant reads as the local calendar date of each zone', () => {
  // 2026-09-01 03:30Z: already Sept 1 in Auckland (15:30 NZST) and London
  // (04:30 BST), still Aug 31 in Los Angeles (20:30 PDT) and Honolulu.
  const at = new Date('2026-09-01T03:30:00Z');
  assert.equal(dailyDateKey(at, 'UTC'), '2026-09-01');
  assert.equal(dailyDateKey(at, 'Pacific/Auckland'), '2026-09-01');
  assert.equal(dailyDateKey(at, 'Europe/London'), '2026-09-01');
  assert.equal(dailyDateKey(at, 'America/Los_Angeles'), '2026-08-31');
  assert.equal(dailyDateKey(at, 'Pacific/Honolulu'), '2026-08-31');
});

test('the device zone key agrees with Intl for the same instant', () => {
  const at = new Date('2026-09-01T03:30:00Z');
  const local = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
  assert.equal(dailyDateKey(at), local);
});

/** DST fixtures: the instant just before and just after each transition, and
 *  the local wall-clock date both must read as. Spring-forward skips an hour,
 *  fall-back repeats one; the calendar date must not flicker either way. */
const DST_FIXTURES: ReadonlyArray<{
  readonly zone: string;
  readonly beforeIso: string;
  readonly afterIso: string;
  readonly date: string;
}> = [
  // US spring forward 2026-03-08 02:00 EST → 03:00 EDT (07:00Z).
  { zone: 'America/New_York', beforeIso: '2026-03-08T06:59:59Z', afterIso: '2026-03-08T07:00:00Z', date: '2026-03-08' },
  // US fall back 2026-11-01 02:00 EDT → 01:00 EST (06:00Z).
  { zone: 'America/New_York', beforeIso: '2026-11-01T05:59:59Z', afterIso: '2026-11-01T06:00:00Z', date: '2026-11-01' },
  // EU spring forward 2026-03-29 01:00Z (02:00 CET → 03:00 CEST).
  { zone: 'Europe/Berlin', beforeIso: '2026-03-29T00:59:59Z', afterIso: '2026-03-29T01:00:00Z', date: '2026-03-29' },
  // EU fall back 2026-10-25 01:00Z (03:00 CEST → 02:00 CET).
  { zone: 'Europe/Berlin', beforeIso: '2026-10-25T00:59:59Z', afterIso: '2026-10-25T01:00:00Z', date: '2026-10-25' },
  // Southern hemisphere: NZ fall back 2026-04-05 03:00 NZDT → 02:00 NZST (14:00Z Apr 4).
  { zone: 'Pacific/Auckland', beforeIso: '2026-04-04T13:59:59Z', afterIso: '2026-04-04T14:00:00Z', date: '2026-04-05' },
  // NZ spring forward 2026-09-27 02:00 NZST → 03:00 NZDT (14:00Z Sep 26).
  { zone: 'Pacific/Auckland', beforeIso: '2026-09-26T13:59:59Z', afterIso: '2026-09-26T14:00:00Z', date: '2026-09-27' },
];

test('DST transitions do not move the calendar date', () => {
  for (const f of DST_FIXTURES) {
    assert.equal(dailyDateKey(new Date(f.beforeIso), f.zone), f.date, `${f.zone} before`);
    assert.equal(dailyDateKey(new Date(f.afterIso), f.zone), f.date, `${f.zone} after`);
  }
});

test('local midnight is the day boundary in every zone, DST or not', () => {
  // The last second of Nov 1 and the first of Nov 2 in New York, the day the
  // clocks fell back (so the day was 25 hours long).
  assert.equal(dailyDateKey(new Date('2026-11-02T04:59:59Z'), 'America/New_York'), '2026-11-01');
  assert.equal(dailyDateKey(new Date('2026-11-02T05:00:00Z'), 'America/New_York'), '2026-11-02');
  // Zones with a half-hour offset and a date-line offset.
  assert.equal(dailyDateKey(new Date('2026-09-01T18:29:59Z'), 'Asia/Kolkata'), '2026-09-01');
  assert.equal(dailyDateKey(new Date('2026-09-01T18:30:00Z'), 'Asia/Kolkata'), '2026-09-02');
  assert.equal(dailyDateKey(new Date('2026-09-01T09:59:59Z'), 'Pacific/Kiritimati'), '2026-09-01');
  assert.equal(dailyDateKey(new Date('2026-09-01T10:00:00Z'), 'Pacific/Kiritimati'), '2026-09-02');
});

// --- seed + layout ------------------------------------------------------------

test('seed and layout are pure functions of the key: pinned values', () => {
  // Pinned so a refactor of the hash cannot silently re-deal every past date.
  assert.equal(dailySeed('2026-09-01'), PINNED_SEED_2026_09_01);
  assert.equal(dailyLayoutId('2026-09-01'), PINNED_LAYOUT_2026_09_01);
  assert.notEqual(dailySeed('2026-09-01'), dailySeed('2026-09-02'));
  assert.notEqual(dailySeed('2026-09-01'), dailySeed('2027-09-01'));
  assert.ok(Number.isInteger(dailySeed('2026-09-01')));
  assert.ok(dailySeed('2026-09-01') >= 0 && dailySeed('2026-09-01') <= 0xffffffff);
  assert.ok(DAILY_LAYOUTS.includes(dailyLayoutId('2026-09-01')));
  assert.equal(dailyLayoutId('2026-09-01'), dailyLayoutId('2026-09-01'));
});

test('seed and layout reject anything that is not a date key', () => {
  for (const bad of ['2026-9-1', 'today', '']) {
    assert.throws(() => dailySeed(bad), RangeError, bad);
    assert.throws(() => dailyLayoutId(bad), RangeError, bad);
  }
});

test('a year of dates uses every layout and never repeats a seed', () => {
  const seeds = new Set<number>();
  const layouts = new Set<string>();
  for (let i = 0; i < 366; i++) {
    const d = new Date(Date.UTC(2026, 0, 1 + i));
    const key = dailyDateKey(d, 'UTC');
    seeds.add(dailySeed(key));
    layouts.add(dailyLayoutId(key));
  }
  assert.equal(seeds.size, 366);
  assert.equal(layouts.size, DAILY_LAYOUTS.length);
});

test('DAILY_LAYOUTS is exactly the shipped set — every ladder pool layout, and every layout file', () => {
  const pooled = [...new Set(Object.values(LADDER_POOLS).flat())].sort();
  assert.deepEqual([...DAILY_LAYOUTS], pooled);
  const files = readdirSync(LAYOUT_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -'.json'.length))
    .sort();
  assert.deepEqual([...DAILY_LAYOUTS], files);
});

test('the board for a date is identical across runs and clears by its own witness', () => {
  for (const key of ['2026-09-01', '2026-03-08', '2026-11-01', '2026-12-31', '2027-01-01']) {
    const layoutId = dailyLayoutId(key);
    const layout = parseLayout(
      JSON.parse(readFileSync(new URL(`${layoutId}.json`, LAYOUT_DIR), 'utf8')) as LayoutFile,
    );
    const a = generateValidatedLevel(layout, dailySeed(key));
    const b = generateValidatedLevel(layout, dailySeed(key));
    assert.deepEqual(
      a.tiles.map((t) => t.face),
      b.tiles.map((t) => t.face),
      key,
    );
    assert.equal(a.seed, b.seed, key);
    // Replay the witness: the shared board is a winnable one.
    const board = new Board(a.tiles);
    for (const [x, y] of a.solution) {
      assert.ok(board.isFree(x) && board.isFree(y), `${key}: pair not free`);
      assert.ok(facesMatch(board.get(x).face, board.get(y).face), `${key}: faces differ`);
      board.remove(x);
      board.remove(y);
    }
    assert.equal(board.presentTiles().length, 0, key);
  }
});

// --- streaks + trophies -------------------------------------------------------

test('daysBetween counts calendar days, across month, year and DST boundaries', () => {
  assert.equal(daysBetween('2026-09-01', '2026-09-02'), 1);
  assert.equal(daysBetween('2026-09-02', '2026-09-01'), -1);
  assert.equal(daysBetween('2026-09-01', '2026-09-01'), 0);
  assert.equal(daysBetween('2026-08-31', '2026-09-01'), 1);
  assert.equal(daysBetween('2026-12-31', '2027-01-01'), 1);
  assert.equal(daysBetween('2024-02-28', '2024-03-01'), 2);
  // The DST dates: a 23- and a 25-hour local day are still one day each.
  assert.equal(daysBetween('2026-03-07', '2026-03-08'), 1);
  assert.equal(daysBetween('2026-03-08', '2026-03-09'), 1);
  assert.equal(daysBetween('2026-10-31', '2026-11-01'), 1);
  assert.equal(daysBetween('2026-11-01', '2026-11-02'), 1);
  assert.equal(daysBetween('2026-01-01', '2026-12-31'), 364);
  assert.throws(() => daysBetween('bad', '2026-01-01'), RangeError);
});

test('dailyTrophies: one per clear, escalating at the streak tiers', () => {
  assert.deepEqual(STREAK_TIERS, [7, 30]);
  assert.equal(dailyTrophies(1), 1);
  assert.equal(dailyTrophies(6), 1);
  assert.equal(dailyTrophies(7), 2);
  assert.equal(dailyTrophies(29), 2);
  assert.equal(dailyTrophies(30), 3);
  assert.equal(dailyTrophies(365), 3);
  assert.throws(() => dailyTrophies(0), RangeError);
  assert.throws(() => dailyTrophies(1.5), RangeError);
});
