// Version label + changelog parsing (issue #81).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseChangelog, versionLabel } from '../src/changelog.js';

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
