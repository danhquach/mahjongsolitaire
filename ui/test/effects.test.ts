// The deadlock grey-out's lifetime (issue #159): finishing the fade leaves the
// board grey; only a cancel mid-fade takes the filter down. Driven through a
// hand-rolled ticker so no renderer is involved — `setDesaturation` is the
// whole observable surface.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Ticker } from 'pixi.js';
import { STUCK_WASH_MS } from '../src/anim.js';
import { Animator } from '../src/effects.js';

function harness() {
  let onTick: ((t: Ticker) => void) | null = null;
  const ticker = {
    add: (fn: (t: Ticker) => void) => {
      onTick = fn;
    },
    remove: () => {
      onTick = null;
    },
  } as unknown as Ticker;
  const amounts: number[] = [];
  const animator = new Animator(ticker, {
    reduced: () => false,
    tileNode: () => undefined,
    setDesaturation: (amount) => amounts.push(amount),
    tileRect: () => undefined,
  });
  const tick = (deltaMS: number) => onTick!({ deltaMS } as Ticker);
  const last = () => amounts[amounts.length - 1];
  return { animator, tick, amounts, last };
}

test('a finished grey-out leaves the board grey and stops being busy', () => {
  const h = harness();
  h.animator.greyOut(false);
  assert.equal(h.last(), 0, 'starts at full colour');
  h.tick(STUCK_WASH_MS / 2);
  assert.ok(h.last()! > 0 && h.last()! < 1, 'mid-fade is partial');
  h.tick(STUCK_WASH_MS);
  assert.equal(h.last(), 1, 'fully grey at the end of the wash');
  assert.equal(h.animator.busy, false, 'the finished effect is gone');
  h.tick(16);
  assert.equal(h.last(), 1, 'nothing resets it after it finished');
});

test('an instant grey-out is full at once and survives its first tick', () => {
  const h = harness();
  h.animator.greyOut(true);
  assert.equal(h.last(), 1);
  h.tick(16);
  assert.equal(h.last(), 1, 'the first tick finishes it without dropping to 0');
  assert.equal(h.animator.busy, false);
});

test('clear() after the fade finished does not reset the grey', () => {
  const h = harness();
  h.animator.greyOut(true);
  h.tick(16);
  const before = h.amounts.length;
  h.animator.clear();
  assert.equal(h.amounts.length, before, 'no setDesaturation call from a finished effect');
});

test('clear() mid-fade resets to full colour', () => {
  const h = harness();
  h.animator.greyOut(false);
  h.tick(STUCK_WASH_MS / 3);
  assert.ok(h.last()! > 0);
  h.animator.clear();
  assert.equal(h.last(), 0, 'a cancelled fade takes its filter down');
  assert.equal(h.animator.busy, false);
});
