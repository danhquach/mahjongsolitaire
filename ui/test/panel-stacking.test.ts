// Modal stacking order (issue #174).
//
// The panels all live in the same stacking context (siblings inside #board),
// so paint order is decided by z-index, not by which one opened last. The
// leaderboard is the one panel that opens *over* another dialog — the Daily
// win screen offers a Leaderboard button — and the JS already assumes it
// wins: opening it marks #overlay inert, and Escape closes it before anything
// underneath. If it does not also paint above #overlay, the player is left
// staring at an inert win dialog with the leaderboard hidden behind it, which
// reads as a frozen game.
//
// Asserted against the stylesheet itself rather than a rendered page: the CSS
// is inline in index.html, and this invariant is the whole bug.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// Comments stripped first: a selector is whatever sits between one rule's
// closing brace and the next opening one, and a comment there would otherwise
// be read as part of it.
const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);

/** The z-index declared for a selector on its own (`#foo { … }`), or null. */
function zIndexOf(selector: string): number | null {
  const rules = [...html.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  let found: number | null = null;
  for (const rule of rules) {
    const targets = (rule[1] ?? '').split(',').map((s) => s.trim());
    if (!targets.includes(selector)) continue;
    const z = /(?:^|[;\s])z-index:\s*(-?\d+)/.exec(rule[2] ?? '');
    // Last declaration wins, as in the cascade.
    if (z !== null) found = Number(z[1]);
  }
  return found;
}

test('the leaderboard paints above the end-of-level dialog', () => {
  const overlay = zIndexOf('#overlay');
  const leaderboard = zIndexOf('#leaderboard');
  assert.notEqual(overlay, null, 'no z-index found for #overlay');
  assert.notEqual(leaderboard, null, 'no z-index found for #leaderboard');
  assert.ok(
    (leaderboard as number) > (overlay as number),
    `#leaderboard (${leaderboard}) must stack above #overlay (${overlay})`,
  );
});
