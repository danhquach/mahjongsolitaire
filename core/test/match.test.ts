// Match rules (issue #6, spec §3.3–3.4, §11.1): identical-face match for ALL
// tiles — Flowers/Seasons included (wildcards removed by PM decision 0005,
// 2026-08-30) — self-match rejection, non-free rejection, and the standard
// 144 tile set.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Board } from '../src/board.js';
import type { Slot } from '../src/board.js';
import { facesMatch, STANDARD_144 } from '../src/faces.js';
import { canMatch, matchPair } from '../src/match.js';

// --- facesMatch: exact suits -------------------------------------------------

test('same suit face matches itself exactly', () => {
  assert.equal(facesMatch('dots-3', 'dots-3'), true);
  assert.equal(facesMatch('bamboo-7', 'bamboo-7'), true);
  assert.equal(facesMatch('char-1', 'char-1'), true);
  assert.equal(facesMatch('wind-east', 'wind-east'), true);
  assert.equal(facesMatch('dragon-red', 'dragon-red'), true);
});

test('different ranks within a suit do not match', () => {
  assert.equal(facesMatch('dots-3', 'dots-4'), false);
  assert.equal(facesMatch('bamboo-1', 'bamboo-9'), false);
});

test('same rank across suits does not match', () => {
  assert.equal(facesMatch('dots-1', 'bamboo-1'), false);
  assert.equal(facesMatch('bamboo-5', 'char-5'), false);
});

test('winds and dragons require exact face', () => {
  assert.equal(facesMatch('wind-east', 'wind-west'), false);
  assert.equal(facesMatch('dragon-red', 'dragon-green'), false);
});

// --- facesMatch: Flowers/Seasons are exact-match too (no wildcards) -----------

test('Flowers and Seasons match only their identical face', () => {
  assert.equal(facesMatch('flower-1', 'flower-1'), true);
  assert.equal(facesMatch('season-2', 'season-2'), true);
  assert.equal(facesMatch('flower-1', 'flower-2'), false);
  assert.equal(facesMatch('season-1', 'season-2'), false);
  assert.equal(facesMatch('flower-1', 'season-1'), false);
});

// --- standard 144 tile set (spec §3.4) ----------------------------------------

test('standard set has 144 faces with spec §3.4 composition', () => {
  assert.equal(STANDARD_144.length, 144);
  const count = (prefix: string) => STANDARD_144.filter((f) => f.startsWith(prefix)).length;
  assert.equal(count('dots-'), 36);
  assert.equal(count('bamboo-'), 36);
  assert.equal(count('char-'), 36);
  assert.equal(count('wind-'), 16);
  assert.equal(count('dragon-'), 12);
  assert.equal(count('flower-'), 4);
  assert.equal(count('season-'), 4);
});

test('flowers and seasons come as identical duplicates (2×2 each)', () => {
  const count = (face: string) => STANDARD_144.filter((f) => f === face).length;
  assert.equal(count('flower-1'), 2);
  assert.equal(count('flower-2'), 2);
  assert.equal(count('season-1'), 2);
  assert.equal(count('season-2'), 2);
});

test('standard set has an even count per face (identical-only matching)', () => {
  const counts = new Map<string, number>();
  for (const f of STANDARD_144) {
    counts.set(f, (counts.get(f) ?? 0) + 1);
  }
  for (const [face, n] of counts) {
    assert.equal(n % 2, 0, `face ${face} has odd count ${n}`);
  }
});

// --- canMatch / matchPair on a board (spec §3.3) -------------------------------

// Row of three tiles: 0 and 2 free (ends), 1 both-blocked (middle).
// Fourth tile stacked on nothing at a distance, also free.
function fixture(faces: [string, string, string, string]): Board {
  const slots: Slot[] = [
    { x: 0, y: 0, z: 0 },
    { x: 2, y: 0, z: 0 },
    { x: 4, y: 0, z: 0 },
    { x: 10, y: 0, z: 0 },
  ];
  return new Board(slots.map((slot, i) => ({ id: i, slot, face: faces[i]! })));
}

test('two free tiles with matching faces can match', () => {
  const b = fixture(['dots-3', 'bamboo-1', 'dots-3', 'char-9']);
  assert.deepEqual(canMatch(b, 0, 2), { ok: true });
});

test('self-match is rejected', () => {
  const b = fixture(['dots-3', 'bamboo-1', 'dots-3', 'char-9']);
  assert.deepEqual(canMatch(b, 0, 0), { ok: false, reason: 'self' });
});

test('non-free tile is rejected even with matching face', () => {
  const b = fixture(['bamboo-1', 'dots-3', 'dots-3', 'char-9']);
  // tile 1 is both-blocked; tile 2 is free and matches its face
  assert.deepEqual(canMatch(b, 1, 2), { ok: false, reason: 'not-free' });
  assert.deepEqual(canMatch(b, 2, 1), { ok: false, reason: 'not-free' });
});

test('free tiles with mismatched faces are rejected', () => {
  const b = fixture(['dots-3', 'bamboo-1', 'char-9', 'char-9']);
  assert.deepEqual(canMatch(b, 0, 2), { ok: false, reason: 'face-mismatch' });
});

test('removed tile is rejected', () => {
  const b = fixture(['dots-3', 'bamboo-1', 'dots-3', 'dots-3']);
  b.remove(0);
  assert.deepEqual(canMatch(b, 0, 2), { ok: false, reason: 'not-free' });
});

test('identical Flower pair matches on the board; different Flowers do not', () => {
  const same = fixture(['flower-1', 'bamboo-1', 'flower-1', 'char-9']);
  assert.deepEqual(canMatch(same, 0, 2), { ok: true });
  const different = fixture(['flower-1', 'bamboo-1', 'flower-2', 'char-9']);
  assert.deepEqual(canMatch(different, 0, 2), { ok: false, reason: 'face-mismatch' });
});

test('matchPair removes both tiles', () => {
  const b = fixture(['dots-3', 'bamboo-1', 'dots-3', 'char-9']);
  matchPair(b, 0, 2);
  assert.equal(b.get(0).removed, true);
  assert.equal(b.get(2).removed, true);
  assert.equal(b.get(1).removed, false);
  // middle tile is now unblocked on both sides
  assert.equal(b.isFree(1), true);
});

test('matchPair throws on an invalid pair and removes nothing', () => {
  const b = fixture(['dots-3', 'bamboo-1', 'char-9', 'char-9']);
  assert.throws(() => matchPair(b, 0, 2), /face-mismatch/);
  assert.equal(b.get(0).removed, false);
  assert.equal(b.get(2).removed, false);
});
