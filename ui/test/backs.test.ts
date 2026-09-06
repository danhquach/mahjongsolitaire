// Tile backs (issue #229, decision 0040): the URL a back loads from, the
// loader's caching and failure handling, and a check that every back the shop
// sells has its PNG under data/backs/, so a missing file fails here rather
// than as a plain-keyline back on a bought board.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Texture } from 'pixi.js';
import { BackLoader, backUrl } from '../src/backs.js';
import { BACKS, DEFAULT_BACK } from '../src/depth.js';

test('a back loads from backs/<id>.png, relative to the app base', () => {
  assert.equal(backUrl('back-koi'), 'backs/back-koi.png');
});

test('every back the shop sells ships a PNG; the default ships none', () => {
  const data = fileURLToPath(new URL('../../../data/', import.meta.url));
  const shipped = Object.keys(BACKS).filter((id) => id !== DEFAULT_BACK);
  assert.equal(shipped.length, 7);
  for (const id of shipped) assert.ok(existsSync(`${data}${backUrl(id)}`), `${id} is missing its PNG`);
  assert.equal(existsSync(`${data}${backUrl(DEFAULT_BACK)}`), false);
});

test('a back loads once, shares concurrent loads, is cached, and a failure is not', async () => {
  const requested: string[] = [];
  let fail = true;
  const loader = new BackLoader(async (url) => {
    requested.push(url);
    if (fail) throw new Error('404');
    return Texture.EMPTY;
  });
  await assert.rejects(loader.get('back-koi'), /404/);
  assert.equal(loader.peek('back-koi'), undefined);
  fail = false;
  const [a, b] = await Promise.all([loader.get('back-koi'), loader.get('back-koi')]);
  assert.equal(a, b);
  assert.equal(requested.length, 2, 'the failed try and one shared retry');
  assert.equal(await loader.get('back-koi'), a);
  assert.equal(loader.peek('back-koi'), a);
  assert.equal(requested.length, 2);
});
