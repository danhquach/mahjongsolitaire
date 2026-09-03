// Modal stacking order (issue #174).
//
// The panels all live in the same stacking context (siblings inside #board),
// so paint order is decided by z-index, not by which one opened last. The
// leaderboard used to be the one panel that opened *over* another dialog: the
// Daily win screen offered a Leaderboard button, and because opening the board
// also marked #overlay inert, a board painted underneath left the player
// staring at an inert win dialog with nothing on screen able to respond — a
// frozen game (issue #174).
//
// Issue #176 removed that route. The Daily pays nothing into the board and its
// own board is gone, so the header button is the only way in and no dialog can
// be up behind the leaderboard today. The rule is kept anyway: it is one line
// of CSS, it is still correct, and it means a future route over a dialog
// starts right instead of reintroducing #174. Nothing else in the page stacks
// above #overlay, so this is the invariant that would silently break.
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
