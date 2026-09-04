// The save format's v6 fields (issue #19): the assist counts (hints/undos,
// unused since the star rating they fed was removed by issue #119) ride with
// the deal and are validated like every other field. The `daily` date that
// rode with them is gone with the Daily board (issue #183) — a record still
// carrying one parses, ignoring it, so an in-flight board is not thrown away
// on upgrade.
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
import { CONCEAL_RATIO, generateValidatedLevel, parseLayout } from '@mahjongsolitaire/core';
import type { LayoutFile } from '@mahjongsolitaire/core';
import { Game } from '../src/game.js';
import { SAVE_VERSION, captureSave, parseSave, reopen } from '../src/save.js';

const LAYOUT_DIR = new URL('../../../data/layouts/', import.meta.url);

function loadLayout(id: string) {
  return parseLayout(JSON.parse(readFileSync(new URL(`${id}.json`, LAYOUT_DIR), 'utf8')) as LayoutFile);
}

/** A date key a stale record might still carry. */
const KEY = '2026-09-01';
const layout = loadLayout('pyramid');

function dealtGame(): Game {
  return new Game(generateValidatedLevel(layout, 476086030), undefined, []);
}

test('v6 carries hints and undos, and round-trips them', () => {
  const save = captureSave(dealtGame(), {
    shuffles: 1,
    hints: 2,
    undos: 3,
    elapsedMs: 4000,
  });
  assert.equal(SAVE_VERSION, 8);
  assert.equal(save.hints, 2);
  assert.equal(save.undos, 3);
  const parsed = parseSave(JSON.parse(JSON.stringify(save)));
  assert.ok(parsed);
  assert.equal(parsed.hints, 2);
  assert.equal(parsed.undos, 3);
  assert.ok(reopen(layout, parsed, CONCEAL_RATIO.medium));
});

test('a record written with a daily field resumes as an ordinary board', () => {
  // Issue #183 retired the Daily board. A board captured mid-Daily is still a
  // real deal, so the field is ignored rather than rejected — the deal resumes
  // as a ladder board instead of being thrown away on upgrade.
  const good = JSON.parse(
    JSON.stringify(captureSave(dealtGame(), { shuffles: 0, hints: 0, undos: 0, elapsedMs: 0 })),
  ) as Record<string, unknown>;
  for (const stale of [KEY, null, 'today', 20260901]) {
    const parsed = parseSave({ ...good, daily: stale });
    assert.ok(parsed, `daily: ${String(stale)} still parses`);
    assert.equal((parsed as unknown as Record<string, unknown>)['daily'], undefined);
    assert.ok(reopen(layout, parsed, CONCEAL_RATIO.medium));
  }
});

test('bad assist counts reject the record', () => {
  const good = JSON.parse(
    JSON.stringify(captureSave(dealtGame(), { shuffles: 0, hints: 0, undos: 0, elapsedMs: 0 })),
  ) as Record<string, unknown>;
  assert.ok(parseSave(good));
  const cases: Record<string, unknown> = {
    'negative hints': { ...good, hints: -1 },
    'fractional undos': { ...good, undos: 0.5 },
    'missing hints': (() => {
      const { hints: _h, ...rest } = good;
      return rest;
    })(),
  };
  for (const [name, record] of Object.entries(cases)) {
    assert.equal(parseSave(record), null, name);
  }
});

test('an older record reads as absent — the in-flight deal restarts, progress keeps', () => {
  const current = JSON.parse(
    JSON.stringify(captureSave(dealtGame(), { shuffles: 0, hints: 0, undos: 0, elapsedMs: 0 })),
  ) as Record<string, unknown>;
  const v5: Record<string, unknown> = { ...current, version: 5 };
  delete v5['hints'];
  delete v5['undos'];
  delete v5['daily'];
  assert.equal(parseSave(v5), null);
  // v6 too (issue #176): its shape is fine, but its score was accumulated at
  // the old flat rate, so it must not be resumed at the new one.
  assert.equal(parseSave({ ...current, version: 6 }), null);
  // And v7 (issue #187): its move list has no shuffle seeds and no undo
  // returns, so a deal resumed from it would end with a history the
  // leaderboard cannot replay.
  assert.equal(parseSave({ ...current, version: 7 }), null);
});
