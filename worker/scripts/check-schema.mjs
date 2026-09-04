// Deploy gate (issue #185): refuse to ship a Worker that expects a table or
// column the live database has not got.
//
// On 2026-09-04 the Worker built for the weekly leaderboard went live before
// the migrations creating its tables were run, and every board read answered a
// Cloudflare 500 until someone noticed. Migrations are applied by hand
// (`wrangler d1 execute --remote --file ...`) while deploys are automatic, so
// nothing tied the two together. This does: CI asks the live database what it
// has, this script compares that to what the schema files in this directory
// would produce, and a missing table or column fails the deploy job before
// `wrangler deploy` runs. The old Worker stays live, still matching the old
// schema, until the migration is applied and the job re-run.
//
// Extra live tables or columns are allowed. A migration that *drops* something
// (schema-0004) is meant to be applied after the deploy that stops reading it,
// so between those two steps the live database legitimately has more than the
// code expects.
//
// Usage (CI sets LIVE_SCHEMA from wrangler's `--json` output):
//
//   wrangler d1 execute lantern-tiles --remote --json --command "$(node worker/scripts/check-schema.mjs --query)"
//   LIVE_SCHEMA='<that output>' node worker/scripts/check-schema.mjs
//
// Exit 0 when nothing is missing, 1 with a list when something is, 2 when the
// live schema could not be read at all (a gate that cannot see must fail closed).

import { createDb } from '../test/d1.mjs';

/** One row per column of every user table. `pragma_table_info` as a
 *  table-valued function is plain SQLite (3.16+), which is what D1 runs. */
export const QUERY =
  "SELECT m.name AS tbl, p.name AS col FROM sqlite_master m JOIN pragma_table_info(m.name) p " +
  "WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%' AND m.name NOT LIKE '_cf_%' " +
  'ORDER BY m.name, p.cid';

/** `table.column` for every row. */
function columnSet(rows) {
  return new Set(rows.map((r) => `${r.tbl}.${r.col}`));
}

/** What the schema files, applied in order, produce. The same in-memory build
 *  the Worker tests run against, so the gate and the tests cannot disagree. */
export function expectedColumns() {
  return columnSet(createDb().raw.prepare(QUERY).all());
}

/** The rows out of `wrangler d1 execute --json`: an array of result sets, one
 *  per statement, each `{results, success}`. Anything else is unreadable. */
export function liveColumns(json) {
  const start = json.indexOf('[');
  if (start < 0) throw new Error('no JSON array in wrangler output');
  const parsed = JSON.parse(json.slice(start));
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('empty wrangler result');
  const rows = parsed.flatMap((set) => {
    if (!set || set.success === false || !Array.isArray(set.results)) {
      throw new Error('wrangler reported a failed statement');
    }
    return set.results;
  });
  return columnSet(rows);
}

/** Everything expected that the live database lacks, sorted. */
export function missingColumns(expected, live) {
  return [...expected].filter((c) => !live.has(c)).sort();
}

function main() {
  if (process.argv.includes('--query')) {
    process.stdout.write(QUERY);
    return 0;
  }
  let live;
  try {
    live = liveColumns(process.env.LIVE_SCHEMA ?? '');
  } catch (error) {
    console.error(`check-schema: could not read the live schema: ${error.message}`);
    return 2;
  }
  const missing = missingColumns(expectedColumns(), live);
  if (missing.length === 0) {
    console.log(`check-schema: live database has every column the code expects (${live.size} checked)`);
    return 0;
  }
  console.error('check-schema: the live database is missing what this build expects — apply the pending migration(s) in worker/, then re-run the deploy:');
  for (const c of missing) console.error(`  ${c}`);
  return 1;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exit(main());
}
