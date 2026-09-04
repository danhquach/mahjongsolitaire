// The shared limiter (issue #186): one atomic upsert per check against the
// D1 table, so every isolate and colo meters the same count. The window
// arithmetic is the part that can be wrong quietly, so it is pinned here.

import assert from 'node:assert/strict';
import test from 'node:test';

import { callerKey, playerKey, rateLimitedShared } from '../http.mjs';
import { createDb } from './d1.mjs';

const LIMIT = { max: 3, windowMs: 10_000 };

test('max calls pass and the next is refused', async () => {
  const db = createDb();
  const seen = [];
  for (let i = 0; i < 4; i += 1) seen.push(await rateLimitedShared(db, 'k', 1_000, LIMIT));
  assert.deepEqual(seen, [false, false, false, true]);
});

test('the window rolls over at exactly windowMs, not before', async () => {
  const db = createDb();
  for (let i = 0; i < 3; i += 1) await rateLimitedShared(db, 'k', 1_000, LIMIT);
  assert.equal(await rateLimitedShared(db, 'k', 1_000 + LIMIT.windowMs - 1, LIMIT), true);
  assert.equal(await rateLimitedShared(db, 'k', 1_000 + LIMIT.windowMs, LIMIT), false);
  // The new window started at the rollover call, and counts from 1.
  const row = db.raw.prepare('SELECT window_start, count FROM rate_limits WHERE key = ?').get('k');
  assert.equal(row.window_start, 1_000 + LIMIT.windowMs);
  assert.equal(row.count, 1);
});

test('keys are independent', async () => {
  const db = createDb();
  for (let i = 0; i < 3; i += 1) await rateLimitedShared(db, 'a', 1_000, LIMIT);
  assert.equal(await rateLimitedShared(db, 'b', 1_000, LIMIT), false);
});

test('a second handle over the same database sees the same count', async () => {
  // The "two isolates" case: nothing in memory is consulted, so a fresh
  // caller of the same key is metered by what the database already holds.
  const db = createDb();
  const other = { prepare: (sql) => db.prepare(sql) };
  for (let i = 0; i < 3; i += 1) await rateLimitedShared(db, 'k', 1_000, LIMIT);
  assert.equal(await rateLimitedShared(other, 'k', 1_000, LIMIT), true);
});

test('one row per key, however many calls', async () => {
  const db = createDb();
  for (let i = 0; i < 10; i += 1) await rateLimitedShared(db, 'k', 1_000 + i, LIMIT);
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM rate_limits').get().n, 1);
});

test('keys name the route, the kind of caller and the caller', () => {
  const request = new Request('https://x.example/api/x', { headers: { 'CF-Connecting-IP': '203.0.113.9' } });
  assert.equal(callerKey(request, 'sync'), 'sync:ip:203.0.113.9');
  assert.equal(callerKey(new Request('https://x.example/api/x'), 'sync'), 'sync:ip:unknown');
  assert.equal(playerKey('sync', 'p1'), 'sync:player:p1');
});
