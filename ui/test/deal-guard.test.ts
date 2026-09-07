// Issue #248: the gate in front of New game / Restart.
//
// The dialog itself is main.ts wiring the #201 panel; what is testable on its
// own — and what the bug actually is — is *when* it appears.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dealConfirmCopy, dealNeedsConfirm } from '../src/deal-guard.js';
import type { DealProgress } from '../src/deal-guard.js';

/** A dealt, untouched, in-play board: 144 tiles, nothing spent. */
const FRESH: DealProgress = {
  playing: true,
  tilesLeft: 144,
  dealtTiles: 144,
  undoDepth: 0,
  shuffles: 0,
};

test('an untouched deal re-deals on the first tap', () => {
  assert.equal(dealNeedsConfirm(FRESH), false);
});

test('a matched pair is progress worth confirming', () => {
  assert.equal(dealNeedsConfirm({ ...FRESH, tilesLeft: 142 }), true);
});

test('a parked tile is progress, though it is still in play', () => {
  // The holder keeps the tile in `tilesLeft`, so this is the case a
  // tiles-only rule would miss.
  assert.equal(dealNeedsConfirm({ ...FRESH, undoDepth: 1 }), true);
});

test('a spent shuffle is progress, though it removes nothing', () => {
  assert.equal(dealNeedsConfirm({ ...FRESH, shuffles: 1 }), true);
});

test('a finished board never asks — its own dialog is the decision', () => {
  for (const played of [
    { ...FRESH, playing: false, tilesLeft: 0 },
    { ...FRESH, playing: false, tilesLeft: 40, undoDepth: 4 },
    { ...FRESH, playing: false, tilesLeft: 40, shuffles: 2 },
  ])
    assert.equal(dealNeedsConfirm(played), false);
});

test('the copy names the board, the action, and that it cannot be undone', () => {
  const where = { level: 12, score: 340, tilesLeft: 96 };
  const reroll = dealConfirmCopy('reroll', where);
  const replay = dealConfirmCopy('replay', where);
  assert.equal(reroll.button, 'New game');
  assert.equal(replay.button, 'Restart');
  assert.notEqual(reroll.title, replay.title);
  for (const copy of [reroll, replay]) {
    assert.match(copy.text, /level 12/);
    assert.match(copy.text, /score 340/);
    assert.match(copy.text, /96 tiles left/);
    assert.match(copy.text, /cannot be undone/);
  }
});

test('the last tile is singular', () => {
  assert.match(dealConfirmCopy('replay', { level: 3, score: 10, tilesLeft: 1 }).text, /1 tile left/);
});
