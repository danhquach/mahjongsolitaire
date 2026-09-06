// Felt textures (issue #229, decision 0040 §5): the URL a felt's texture
// loads from, and a check that every textured felt ships its PNG under
// data/felts/ at the size the CSS tiles it at.

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { DEFAULT_FELT, FELTS, feltTextureUrl } from '../src/depth.js';

test('the default felt has no texture; every other felt has one at felts/<id>.png', () => {
  assert.equal(feltTextureUrl(FELTS[DEFAULT_FELT]!), null);
  for (const felt of Object.values(FELTS)) {
    if (felt.id === DEFAULT_FELT) continue;
    assert.equal(feltTextureUrl(felt), `felts/${felt.id}.png`);
    assert.ok(felt.texture && felt.light !== undefined, `${felt.id} carries its texture size and brightest pixel`);
  }
});

test('every textured felt ships a PNG of exactly one CSS repeat', () => {
  const data = fileURLToPath(new URL('../../../data/', import.meta.url));
  for (const felt of Object.values(FELTS)) {
    const url = feltTextureUrl(felt);
    if (url === null) continue;
    const path = `${data}${url}`;
    assert.ok(existsSync(path), `${felt.id} is missing its texture`);
    // PNG IHDR: width and height are the big-endian u32s at bytes 16 and 20.
    const png = readFileSync(path);
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], felt.texture, `${felt.id} size`);
  }
});
