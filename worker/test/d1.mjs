// A D1-shaped database for the Worker tests, backed by real SQLite
// (`node:sqlite`) and the real schema files.
//
// A hand-written fake that returned canned rows would pass while the SQL was
// wrong — a column typo, a bind-arity mismatch, an ORDER BY that does not
// order — and wrong SQL is most of what can break in worker/profile.mjs and
// worker/leaderboard.mjs. So the tests run a real engine over
// worker/schema.sql and every migration beside it.

import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

/** Applied in order, exactly as they are applied to the live database. */
const SCHEMA_FILES = [
  '../schema.sql',
  '../schema-0002-leaderboard.sql',
  '../schema-0003-weekly-leaderboard.sql',
  '../schema-0004-drop-daily-board.sql',
];

/**
 * The slice of the D1 binding the routes use: `prepare().bind()` returning
 * `first()`, `run()` and `all()`, all promise-returning. `raw` is the
 * underlying database, for a test that wants to assert on stored rows
 * directly rather than through a route.
 */
export function createDb() {
  const db = new DatabaseSync(':memory:');
  // Without this a `REFERENCES` clause is decoration; the leaderboard's
  // foreign key to `players` should behave in tests the way it does in D1.
  db.exec('PRAGMA foreign_keys = ON');
  for (const file of SCHEMA_FILES) {
    db.exec(readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8'));
  }
  return {
    prepare(sql) {
      const stmt = db.prepare(sql);
      return {
        bind(...args) {
          return {
            async first() {
              return stmt.get(...args) ?? null;
            },
            async run() {
              stmt.run(...args);
              return { success: true };
            },
            async all() {
              return { results: stmt.all(...args) };
            },
          };
        },
      };
    },
    raw: db,
  };
}
