// Daily share card tests (issue #228).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dailyShareCard, shareDailyCard } from '../src/share.js';

const URL = 'https://lantern-tiles.example/play';

test('dailyShareCard: zero completions shows three empty boxes, no streak clause', () => {
  const text = dailyShareCard({ done: [false, false, false], streak: 0, dateKey: '2026-09-05', url: URL });
  assert.equal(text, `Lantern Tiles · Sep 5\n⬜ ⬜ ⬜\n${URL}`);
});

test('dailyShareCard: one completion, slot order preserved', () => {
  const text = dailyShareCard({ done: [false, true, false], streak: 0, dateKey: '2026-09-05', url: URL });
  assert.equal(text, `Lantern Tiles · Sep 5\n⬜ ✅ ⬜\n${URL}`);
});

test('dailyShareCard: three completions plus streak clause', () => {
  const text = dailyShareCard({ done: [true, true, true], streak: 12, dateKey: '2026-09-05', url: URL });
  assert.equal(text, `Lantern Tiles · Sep 5\n✅ ✅ ✅  🔥 12-day streak\n${URL}`);
});

test('dailyShareCard: singular 1-day streak', () => {
  const text = dailyShareCard({ done: [true, false, false], streak: 1, dateKey: '2026-09-05', url: URL });
  assert.match(text, /🔥 1-day streak/);
});

test('dailyShareCard: date formatting, no leading zero', () => {
  assert.match(dailyShareCard({ done: [], streak: 0, dateKey: '2026-09-05', url: URL }), /Lantern Tiles · Sep 5\n/);
  assert.match(dailyShareCard({ done: [], streak: 0, dateKey: '2026-12-25', url: URL }), /Lantern Tiles · Dec 25\n/);
});

test('dailyShareCard: URL is the last line, no trailing newline', () => {
  const text = dailyShareCard({ done: [true], streak: 0, dateKey: '2026-09-05', url: URL });
  const lines = text.split('\n');
  assert.equal(lines[lines.length - 1], URL);
  assert.equal(text.endsWith('\n'), false);
});

// --- shareDailyCard -----------------------------------------------------------

test('shareDailyCard: share preferred when provided', async () => {
  let called: unknown = null;
  const result = await shareDailyCard('text', {
    share: async (data) => {
      called = data;
    },
    clipboard: { writeText: async () => {} },
  });
  assert.equal(result, 'shared');
  assert.deepEqual(called, { text: 'text' });
});

test('shareDailyCard: AbortError resolves dismissed without touching the clipboard', async () => {
  let clipboardCalled = false;
  const abort = Object.assign(new Error('dismissed'), { name: 'AbortError' });
  const result = await shareDailyCard('text', {
    share: async () => {
      throw abort;
    },
    clipboard: {
      writeText: async () => {
        clipboardCalled = true;
      },
    },
  });
  assert.equal(result, 'dismissed');
  assert.equal(clipboardCalled, false);
});

test('shareDailyCard: other share error falls back to the clipboard', async () => {
  const result = await shareDailyCard('text', {
    share: async () => {
      throw new Error('boom');
    },
    clipboard: { writeText: async () => {} },
  });
  assert.equal(result, 'copied');
});

test('shareDailyCard: no share, clipboard succeeds', async () => {
  const result = await shareDailyCard('text', { clipboard: { writeText: async () => {} } });
  assert.equal(result, 'copied');
});

test('shareDailyCard: neither share nor clipboard fails', async () => {
  const result = await shareDailyCard('text', {});
  assert.equal(result, 'failed');
});

test('shareDailyCard: clipboard write rejects fails', async () => {
  const result = await shareDailyCard('text', {
    clipboard: {
      writeText: async () => {
        throw new Error('denied');
      },
    },
  });
  assert.equal(result, 'failed');
});
