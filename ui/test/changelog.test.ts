// Version label + changelog parsing (issue #81).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { briefChangelog, briefItem, parseChangelog, versionLabel } from '../src/changelog.js';

test('versionLabel is semver + commit + build day', () => {
  assert.equal(versionLabel('0.1.0', 'ab12cd3', '2026-09-01T04:30:00.000Z'), 'v0.1.0+ab12cd3 · 2026-09-01');
});

test('versionLabel tolerates a missing build time', () => {
  assert.equal(versionLabel('0.1.0', 'dev', ''), 'v0.1.0+dev');
});

test('parseChangelog: headings, items with continuations, prose', () => {
  const md = [
    '# Changelog',
    '',
    'Deploys from main.',
    'Two lines of it.',
    '',
    '## 2026-09-01',
    '',
    '- One-line entry (#1).',
    '- A wrapped entry that continues',
    '  on a second line (#2).',
    '- Last entry (#3).',
  ].join('\n');
  assert.deepEqual(parseChangelog(md), [
    { kind: 'text', text: 'Deploys from main. Two lines of it.' },
    { kind: 'heading', text: '2026-09-01' },
    { kind: 'item', text: 'One-line entry (#1).' },
    { kind: 'item', text: 'A wrapped entry that continues on a second line (#2).' },
    { kind: 'item', text: 'Last entry (#3).' },
  ]);
});

test('the shipped CHANGELOG.md parses into at least one release with entries', () => {
  // Three levels up from the compiled test (ui/dist/test/) to the repo root.
  const md = readFileSync(new URL('../../../CHANGELOG.md', import.meta.url), 'utf8');
  const blocks = parseChangelog(md);
  const headings = blocks.filter((b) => b.kind === 'heading');
  const items = blocks.filter((b) => b.kind === 'item');
  assert.ok(headings.length >= 1, 'a release heading exists');
  assert.ok(items.length >= 1, 'a release entry exists');
  // Release headings are deploy days, newest first.
  assert.match(headings[0]!.text, /^\d{4}-\d{2}-\d{2}$/);
});

// --- the in-game view: one short line per entry (issue #181) -----------------

test('briefItem keeps the lead sentence and drops emphasis and issue refs', () => {
  assert.equal(
    briefItem('**Score now scales with difficulty.** A pair is worth more on a harder level (#176).'),
    'Score now scales with difficulty.',
  );
  assert.equal(
    briefItem('The board opens *behind* the win dialog (#166, #168).'),
    'The board opens behind the win dialog.',
  );
});

test('briefItem does not mistake a decimal for a sentence end', () => {
  assert.equal(briefItem('A pair pays ×1.5 on medium.'), 'A pair pays ×1.5 on medium.');
});

test('briefItem cuts a long lead sentence at the clause its detail starts in', () => {
  assert.equal(
    briefItem(
      'A deadlock now reads as a pause, not a loss: a slate wash sweeps in left to right over ' +
        'the board while the tile pictures desaturate, and only then does the dialog appear.',
    ),
    'A deadlock now reads as a pause, not a loss.',
  );
  assert.equal(
    briefItem(
      'Tile size in Settings is now a one-row slider with three stops — Medium, Large, Extra ' +
        'large — instead of a four-option list, so the popup is shorter on a phone.',
    ),
    'Tile size in Settings is now a one-row slider with three stops.',
  );
});

test('briefItem falls back to a word-boundary cut when there is no clause break', () => {
  const brief = briefItem(`Tiles ${'and tiles '.repeat(20)}forever.`);
  assert.ok(brief.length <= 151, `cut to ${brief.length} chars`);
  assert.ok(brief.endsWith('…'), brief);
  assert.ok(!brief.includes(' …'), 'cuts on a word boundary');
});

test('briefChangelog keeps every release, drops the file\'s own prose header', () => {
  const md = [
    '# Changelog',
    '',
    'Deploys from main.',
    '',
    '## 2026-09-03',
    '',
    '- **A short one.** With detail after it (#181).',
    '',
    '## 2026-09-02',
    '',
    '- An older one (#1).',
  ].join('\n');
  assert.deepEqual(briefChangelog(md), [
    { kind: 'heading', text: '2026-09-03' },
    { kind: 'item', text: 'A short one.' },
    { kind: 'heading', text: '2026-09-02' },
    { kind: 'item', text: 'An older one.' },
  ]);
});

test('every entry of the shipped CHANGELOG.md renders short in game', () => {
  const md = readFileSync(new URL('../../../CHANGELOG.md', import.meta.url), 'utf8');
  const items = briefChangelog(md).filter((b) => b.kind === 'item');
  assert.ok(items.length >= 1, 'a release entry exists');
  for (const item of items) {
    assert.ok(item.text.length <= 151, `too long (${item.text.length}): ${item.text}`);
    assert.ok(!item.text.includes('*'), `emphasis left in: ${item.text}`);
    assert.ok(!/\(#\d/.test(item.text), `issue ref left in: ${item.text}`);
  }
});
