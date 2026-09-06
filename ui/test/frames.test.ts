// Avatar frames (issue #229, decision 0041): the table is the only path from
// a frame id to the page, the default draws nothing, every sold frame ships
// its PNG, and a hostile id — the leaderboard shows other players' — reaches
// neither a URL nor the DOM.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { DEFAULT_FRAME, FRAMES, applyFrame, frameFor, frameUrl } from '../src/frames.js';

test('the default frame draws nothing; every other frame maps to frames/<id>.png', () => {
  assert.equal(frameUrl(FRAMES[DEFAULT_FRAME]!), null);
  for (const frame of Object.values(FRAMES)) {
    if (frame.id === DEFAULT_FRAME) continue;
    assert.equal(frameUrl(frame), `frames/${frame.id}.png`);
    assert.match(frame.id, /^[a-z][a-z0-9-]{0,31}$/);
    assert.ok(frame.label.length > 0);
  }
  assert.equal(Object.keys(FRAMES).length, 8);
});

test('every frame the shop sells ships a PNG; the default ships none', () => {
  const data = fileURLToPath(new URL('../../../data/', import.meta.url));
  for (const frame of Object.values(FRAMES)) {
    const url = frameUrl(frame);
    if (url === null) continue;
    assert.ok(existsSync(`${data}${url}`), `${frame.id} is missing its PNG`);
  }
  assert.equal(existsSync(`${data}frames/${DEFAULT_FRAME}.png`), false);
});

test('an unknown or hostile id resolves to no frame and touches nothing', () => {
  for (const id of ['frame-from-the-future', 'javascript:alert(1)', '../../x', 'url("evil")', '', 'FRAME-PLUM']) {
    assert.equal(frameFor(id).id, DEFAULT_FRAME, id);
  }
  // A minimal element stand-in: applyFrame must only ever write a URL built
  // from the table, never from the id it was given.
  const classes = new Set<string>();
  const badge = {
    classList: { toggle: (c: string, on: boolean) => (on ? classes.add(c) : classes.delete(c)) },
    style: { backgroundImage: 'url("stale")' },
  } as unknown as HTMLElement;
  applyFrame(badge, 'frame-plum');
  assert.equal(badge.style.backgroundImage, 'url("frames/frame-plum.png")');
  assert.ok(classes.has('framed'));
  applyFrame(badge, 'url("evil")');
  assert.equal(badge.style.backgroundImage, '');
  assert.equal(classes.has('framed'), false);
});
