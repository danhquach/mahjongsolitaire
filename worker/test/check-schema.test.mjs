// The deploy gate of issue #185: worker/scripts/check-schema.mjs compares the
// live D1 schema to what the schema files produce. The comparison is the part
// that can be wrong quietly — a gate that never fails is the same as no gate —
// so it is exercised against a database that really is behind.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { QUERY, expectedColumns, liveColumns, missingColumns } from '../scripts/check-schema.mjs';
import { createDb } from './d1.mjs';

/** What `wrangler d1 execute --json` prints for `QUERY` against `db`. */
function wranglerJson(db) {
  return JSON.stringify([{ results: db.raw.prepare(QUERY).all(), success: true, meta: {} }]);
}

test('a database built from every schema file is missing nothing', () => {
  const live = liveColumns(wranglerJson(createDb()));
  assert.deepEqual(missingColumns(expectedColumns(), live), []);
  // The weekly tables are in the expectation at all — otherwise the live
  // failure this gate exists for would pass it.
  assert.ok(expectedColumns().has('weekly_scores.score'));
  assert.ok(expectedColumns().has('players.week_start'));
});

test('the live state of 2026-09-04 — weekly tables never created — fails the gate by name', () => {
  const db = createDb();
  db.raw.exec('DROP TABLE weekly_submissions; DROP TABLE weekly_scores');
  const missing = missingColumns(expectedColumns(), liveColumns(wranglerJson(db)));
  assert.ok(missing.includes('weekly_scores.score'));
  assert.ok(missing.includes('weekly_submissions.history'));
  assert.ok(missing.every((c) => c.startsWith('weekly_')));
});

test('a single missing column is enough', () => {
  const db = createDb();
  db.raw.exec('ALTER TABLE players DROP COLUMN week_start');
  assert.deepEqual(missingColumns(expectedColumns(), liveColumns(wranglerJson(db))), [
    'players.week_start',
  ]);
});

test('extra live tables and columns pass — a drop migration is applied after the deploy', () => {
  const db = createDb();
  db.raw.exec('ALTER TABLE players ADD COLUMN best_score INTEGER; CREATE TABLE daily_scores (x)');
  assert.deepEqual(missingColumns(expectedColumns(), liveColumns(wranglerJson(db))), []);
});

test('wrangler output is read past its banner, and a failed or empty result is unreadable', () => {
  const rows = wranglerJson(createDb());
  assert.equal(liveColumns(`\n ⛅️ wrangler 4.0.0\n---\n${rows}`).size, expectedColumns().size);
  assert.throws(() => liveColumns(''), /no JSON array/);
  assert.throws(() => liveColumns('[]'), /empty/);
  assert.throws(() => liveColumns('[{"success":false,"results":[]}]'), /failed statement/);
});

test('the query CI runs against the live database is the one the script expects', () => {
  // ci.yml carries the SQL literally (nothing interpolated reaches its shell);
  // this is what keeps that copy and QUERY the same statement.
  const ci = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const step = ci.match(/d1 execute lantern-tiles --remote --json --command "([^"]+)"/);
  assert.ok(step, 'ci.yml has the live-schema step');
  assert.equal(step[1], QUERY);
  // And the gate reads the output the action actually publishes: wrangler-action
  // names it `command-output` (action.yml), and a wrong name here would hand
  // the script an empty string and fail every deploy, not just a behind one.
  assert.match(ci, /LIVE_SCHEMA: \$\{\{ steps\.live-schema\.outputs\.command-output \}\}/);
});
