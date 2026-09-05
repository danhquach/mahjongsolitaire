// Glyph sets (issue #229): the face inventory a set must cover, the URL each
// face loads from, the loader's caching and failure handling — and a check
// that the shipped art under data/glyphs/ is complete for every set the shop
// sells, so a missing PNG fails here rather than as one Lantern tile on a
// bought board.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Texture } from 'pixi.js';
import { GLYPH_FACES, GlyphSetLoader, glyphUrl } from '../src/glyphs.js';
import { GLYPH_SETS } from '../src/shop.js';

test('the face inventory is the 38 distinct faces of the standard set', () => {
  assert.equal(GLYPH_FACES.length, 38);
  assert.equal(new Set(GLYPH_FACES).size, 38);
  for (const face of ['dots-1', 'bamboo-9', 'char-5', 'wind-east', 'dragon-white', 'season-fall']) {
    assert.ok(GLYPH_FACES.includes(face), face);
  }
});

test('a face loads from glyphs/<dir>/<face>.png, relative to the app base', () => {
  assert.equal(glyphUrl('fantasy', 'dots-7'), 'glyphs/fantasy/dots-7.png');
});

test('every set the shop sells ships a PNG for every face', () => {
  // dist/test/*.js at run time; data/ is the repo's static-asset root.
  const data = fileURLToPath(new URL('../../../data/', import.meta.url));
  const sets = Object.values(GLYPH_SETS).filter((s) => s.dir !== null);
  assert.ok(sets.length >= 2, 'the two drawn sets are wired');
  for (const set of sets) {
    for (const face of GLYPH_FACES) {
      assert.ok(existsSync(`${data}${glyphUrl(set.dir!, face)}`), `${set.id} is missing ${face}`);
    }
  }
});

test('a set loads every face once, shares concurrent loads, and is cached afterwards', async () => {
  const requested: string[] = [];
  const loader = new GlyphSetLoader(async (url) => {
    requested.push(url);
    return Texture.EMPTY;
  });
  assert.equal(loader.peek('fantasy'), undefined);
  const [a, b] = await Promise.all([loader.get('fantasy'), loader.get('fantasy')]);
  assert.equal(a, b, 'one load, one map');
  assert.equal(requested.length, 38);
  assert.equal(new Set(requested).size, 38);
  assert.ok(requested.includes('glyphs/fantasy/wind-north.png'));
  assert.equal(a.size, 38);
  assert.equal(await loader.get('fantasy'), a, 'served from cache');
  assert.equal(loader.peek('fantasy'), a);
  assert.equal(requested.length, 38, 'nothing re-fetched');
});

test('one missing face fails the whole set, and the failure is not cached', async () => {
  let fail = true;
  const loader = new GlyphSetLoader(async (url) => {
    if (fail && url.endsWith('char-4.png')) throw new Error('404');
    return Texture.EMPTY;
  });
  await assert.rejects(loader.get('calligraphy'), /404/);
  assert.equal(loader.peek('calligraphy'), undefined);
  fail = false;
  assert.equal((await loader.get('calligraphy')).size, 38, 'a retry succeeds');
});
