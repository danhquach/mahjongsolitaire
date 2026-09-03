// The save format's v6 fields (issue #19): the assist counts (hints/undos,
// unused since the star rating they fed was removed by issue #119) and the
// Daily Challenge date ride with the deal, and are validated like every other
// field.
//
// The version itself is v7 since issue #176. The record's *shape* did not
// change — these fields are all still here — but every pair is now scored at
// the level's band multiplier, so a v6 snapshot holds a score accumulated at
// the old flat rate. Resuming one would keep those points and then pay a
// different rate for every match after the reload: one deal scored two ways,
// with the seam invisible. So an older record reads as absent, the same clean
// break every previous bump made.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  CONCEAL_RATIO,
  dailyLayoutId,
  dailySeed,
  generateValidatedLevel,
  parseLayout,
} from '@mahjongsolitaire/core';
import type { LayoutFile } from '@mahjongsolitaire/core';
import { Game } from '../src/game.js';
import { SAVE_VERSION, captureSave, parseSave, reopen } from '../src/save.js';

const LAYOUT_DIR = new URL('../../../data/layouts/', import.meta.url);

function loadLayout(id: string) {
  return parseLayout(JSON.parse(readFileSync(new URL(`${id}.json`, LAYOUT_DIR), 'utf8')) as LayoutFile);
}

const KEY = '2026-09-01';
const layout = loadLayout(dailyLayoutId(KEY));

function dailyGame(): Game {
  return new Game(generateValidatedLevel(layout, dailySeed(KEY)), undefined, []);
}

test('v6 carries hints, undos and the daily date, and round-trips them', () => {
  const save = captureSave(dailyGame(), {
    shuffles: 1,
    hints: 2,
    undos: 3,
    elapsedMs: 4000,
    daily: KEY,
  });
  assert.equal(SAVE_VERSION, 7);
  assert.equal(save.hints, 2);
  assert.equal(save.undos, 3);
  assert.equal(save.daily, KEY);
  const parsed = parseSave(JSON.parse(JSON.stringify(save)));
  assert.ok(parsed);
  assert.equal(parsed.hints, 2);
  assert.equal(parsed.undos, 3);
  assert.equal(parsed.daily, KEY);
  // …and the Daily deal reopens on its own layout.
  assert.ok(reopen(layout, parsed, CONCEAL_RATIO.medium));
});

test('a ladder deal says daily: null outright', () => {
  const save = captureSave(dailyGame(), { shuffles: 0, hints: 0, undos: 0, elapsedMs: 0, daily: null });
  assert.equal(parseSave(JSON.parse(JSON.stringify(save)))?.daily, null);
});

test('bad assist counts or a bad date reject the record', () => {
  const good = JSON.parse(
    JSON.stringify(captureSave(dailyGame(), { shuffles: 0, hints: 0, undos: 0, elapsedMs: 0, daily: KEY })),
  ) as Record<string, unknown>;
  assert.ok(parseSave(good));
  const cases: Record<string, unknown> = {
    'negative hints': { ...good, hints: -1 },
    'fractional undos': { ...good, undos: 0.5 },
    'missing hints': (() => {
      const { hints: _h, ...rest } = good;
      return rest;
    })(),
    'missing daily': (() => {
      const { daily: _d, ...rest } = good;
      return rest;
    })(),
    'daily not a date': { ...good, daily: 'today' },
    'daily impossible date': { ...good, daily: '2026-02-30' },
    'daily a number': { ...good, daily: 20260901 },
  };
  for (const [name, record] of Object.entries(cases)) {
    assert.equal(parseSave(record), null, name);
  }
});

test('an older record reads as absent — the in-flight deal restarts, progress keeps', () => {
  const current = JSON.parse(
    JSON.stringify(captureSave(dailyGame(), { shuffles: 0, hints: 0, undos: 0, elapsedMs: 0, daily: null })),
  ) as Record<string, unknown>;
  const v5: Record<string, unknown> = { ...current, version: 5 };
  delete v5['hints'];
  delete v5['undos'];
  delete v5['daily'];
  assert.equal(parseSave(v5), null);
  // v6 too (issue #176): its shape is fine, but its score was accumulated at
  // the old flat rate, so it must not be resumed at the new one.
  assert.equal(parseSave({ ...current, version: 6 }), null);
});
