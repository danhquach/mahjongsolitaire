# Shared Rate Limiter in D1 — Implementation Plan (issue #186)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the per-isolate in-memory rate limiter on every write and credential-checking API route with a fixed-window counter in D1, keyed by caller address and, after authentication, by player id.

**Architecture:** One `rate_limits` table, one atomic upsert per check (`rateLimitedShared` in `worker/http.mjs`). Routers keep their pre-auth address check; handlers add a post-auth player check. The in-memory limiter survives only for the anonymous weekly-board `GET`. A daily cron sweeps stale rows.

**Tech Stack:** Cloudflare Workers, D1 (SQLite), `node --test` with `node:sqlite` via `worker/test/d1.mjs`.

Spec: `docs/superpowers/specs/2026-09-04-shared-rate-limiter-design.md`.

## Global Constraints

- Repo rule: **no commit until the PM approves** after QA + review (CLAUDE.md). Tasks end by running the suite, not by committing. Stage nothing; the final approval covers the whole branch.
- Branch: `issue-186-shared-rate-limiter` (already created from `main` at `c0dfcee`).
- Worker suite: `node --test worker/test/*.test.mjs` (requires `npm --prefix core run build` once; `core/dist` is imported by the leaderboard tests).
- Limit numbers are unchanged: feedback 5/10 min; register 5/1 h; profile read 10/10 min; sync 60/10 min; name 20/10 min; submit 20/10 min; signed board read 10/10 min; withdraw 10/10 min; anonymous board read 60/10 min (in-memory).
- Error bodies unchanged: `429 {"error":"rate_limited"}`, `503 {"error":"not_configured"}`.
- Time is ms since epoch, integers, from `deps.now`.
- Match existing comment style: prose comments explaining *why*, referencing issue numbers.

---

### Task 1: Migration 0005 and the test database

**Files:**
- Create: `worker/schema-0005-rate-limits.sql`
- Modify: `worker/test/d1.mjs:15-20` (SCHEMA_FILES)
- Modify: `worker/test/check-schema.test.mjs:21-28`

**Interfaces:**
- Produces: table `rate_limits(key TEXT PRIMARY KEY, window_start INTEGER NOT NULL, count INTEGER NOT NULL)`, present in every `createDb()`.

- [ ] **Step 1: Extend the check-schema test so it fails until the table exists**

In `worker/test/check-schema.test.mjs`, inside `test('a database built from every schema file is missing nothing', ...)`, after the `players.week_start` assertion add:

```js
  // Issue #186: the shared rate limiter's table is part of the expectation,
  // so a deploy that reads it cannot go live before the migration.
  assert.ok(expectedColumns().has('rate_limits.count'));
```

- [ ] **Step 2: Run it, expect failure**

Run: `node --test worker/test/check-schema.test.mjs`
Expected: 1 failing — `expectedColumns().has('rate_limits.count')` is false.

- [ ] **Step 3: Write the migration**

`worker/schema-0005-rate-limits.sql`:

```sql
-- D1 schema, migration 0005: the shared rate limiter (issue #186).
--
-- Applied on the same database, before the Worker that reads it is deployed:
--
--   wrangler d1 execute lantern-tiles --remote --file worker/schema-0005-rate-limits.sql
--
-- (`--local` instead of `--remote` for `wrangler dev`.) `IF NOT EXISTS`, so
-- re-running the file is a no-op — the next schema change gets 0006, never an
-- edit to this one. The deploy gate (worker/scripts/check-schema.mjs) refuses
-- to ship a Worker while this table is missing from the live database.
--
-- One row per limiter key: `<route>:ip:<address>` or `<route>:player:<id>`.
-- The old limiter was a Map inside one Worker isolate, so its count reset
-- whenever Cloudflare recycled the isolate and was never shared between the
-- many isolates and colos serving the same caller. This table is the one
-- place every isolate agrees on. Rows are reused per key (an upsert), so the
-- table is bounded by the number of distinct keys; a daily cron in
-- worker/index.mjs deletes rows whose window ended more than a day ago.

CREATE TABLE IF NOT EXISTS rate_limits (
  key          TEXT    PRIMARY KEY,
  -- ms since epoch when the current fixed window opened.
  window_start INTEGER NOT NULL,
  -- Requests seen in that window, including the one that opened it.
  count        INTEGER NOT NULL
);
```

- [ ] **Step 4: Register it in the test database**

In `worker/test/d1.mjs`, `SCHEMA_FILES` becomes:

```js
const SCHEMA_FILES = [
  '../schema.sql',
  '../schema-0002-leaderboard.sql',
  '../schema-0003-weekly-leaderboard.sql',
  '../schema-0004-drop-daily-board.sql',
  '../schema-0005-rate-limits.sql',
];
```

- [ ] **Step 5: Run the suite**

Run: `node --test worker/test/*.test.mjs`
Expected: all pass (the gate test now sees `rate_limits.count`; nothing else changed).

---

### Task 2: `rateLimitedShared` in http.mjs

**Files:**
- Modify: `worker/http.mjs:33-71`
- Create: `worker/test/http.test.mjs`

**Interfaces:**
- Produces:
  - `async function rateLimitedShared(db, key, now, { max, windowMs }) → Promise<boolean>` — `true` when over the limit. `db` is a D1 binding (`prepare().bind().first()`).
  - `function callerKey(request, scope) → string` — now `` `${scope}:ip:${ip ?? 'unknown'}` ``.
  - `function playerKey(scope, playerId) → string` — `` `${scope}:player:${playerId}` ``.
  - `rateLimited` / `createRateLimitStore` unchanged in behaviour; docstring now says they serve only the anonymous board read.

- [ ] **Step 1: Write the failing unit tests**

`worker/test/http.test.mjs`:

```js
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
  assert.deepEqual(row, { window_start: 1_000 + LIMIT.windowMs, count: 1 });
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
```

- [ ] **Step 2: Run it, expect failure**

Run: `node --test worker/test/http.test.mjs`
Expected: fails to import `playerKey` / `rateLimitedShared` (SyntaxError: does not provide an export).

- [ ] **Step 3: Implement**

In `worker/http.mjs`, replace everything from the `createRateLimitStore` docstring to the end of the file with:

```js
/** Per-isolate best-effort limiter. Since issue #186 it serves exactly one
 *  route — the anonymous weekly-board GET — where the data is public, no
 *  credential is checked, and a database write per read would double the
 *  cost of the cheapest route. Every other route uses `rateLimitedShared`.
 *  Not shared across isolates or deploys: it slows an obvious flood, it is
 *  not a cap. */
export function createRateLimitStore() {
  return new Map();
}

/**
 * Best-effort fixed-window limiter over an in-memory `store` (see
 * `createRateLimitStore`). `store` and `now` are passed in so tests get a
 * fresh, deterministic clock and map.
 */
export function rateLimited(key, store, now, { max, windowMs }) {
  // Opportunistic eviction: a long-lived isolate must not keep one entry per
  // address it ever saw. Expired windows go on every call — the map only ever
  // holds addresses seen within the current window.
  //
  // Each entry is evicted against *its own* window, not the calling route's.
  // One store serves routes with different window lengths, and evicting a
  // 1-hour bucket after 10 minutes because a 10-minute route happened to run
  // would silently hand back the longer route's allowance.
  for (const [k, e] of store) {
    if (now - e.windowStart >= e.windowMs) store.delete(k);
  }
  const entry = store.get(key);
  if (entry === undefined || now - entry.windowStart >= windowMs) {
    store.set(key, { windowStart: now, windowMs, count: 1 });
    return false;
  }
  entry.count += 1;
  return entry.count > max;
}

/**
 * The shared limiter (issue #186): a fixed window per key in the `rate_limits`
 * table (schema-0005), so every isolate and colo meters the same count.
 *
 * One statement does the whole check. The upsert either opens a window for a
 * new key, resets an expired one, or increments the live one, and hands back
 * the count it settled on — so two isolates hitting the same key at the same
 * instant cannot both read "4" and both write "5". Fixed windows keep the
 * semantics (and the numbers) of the in-memory limiter this replaced.
 *
 * Throws whatever D1 throws. The routers let that reach `handleRequest`,
 * which answers 503 (issue #185): a limiter that cannot count fails closed.
 */
export async function rateLimitedShared(db, key, now, { max, windowMs }) {
  const row = await db
    .prepare(
      'INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 1) ' +
        'ON CONFLICT(key) DO UPDATE SET ' +
        'count = CASE WHEN ?2 - window_start >= ?3 THEN 1 ELSE count + 1 END, ' +
        'window_start = CASE WHEN ?2 - window_start >= ?3 THEN ?2 ELSE window_start END ' +
        'RETURNING count',
    )
    .bind(key, now, windowMs)
    .first();
  return row.count > max;
}

/** The address a limiter keys on, namespaced by `scope` (the route) so routes
 *  get independent buckets, and by `ip` so an address bucket can never collide
 *  with a player bucket. Unknown callers share one bucket per scope, which is
 *  the conservative choice: better to throttle an unidentifiable caller than
 *  to hand every one of them its own allowance. */
export function callerKey(request, scope) {
  return `${scope}:ip:${request.headers.get('CF-Connecting-IP') ?? 'unknown'}`;
}

/** The player a limiter keys on once a request has authenticated (issue
 *  #186): the same allowance as the address bucket, so a player cannot exceed
 *  it by changing address. */
export function playerKey(scope, playerId) {
  return `${scope}:player:${playerId}`;
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test worker/test/http.test.mjs`
Expected: 6 pass.

Run: `node --test worker/test/*.test.mjs`
Expected: all pass (only `callerKey`'s string changed; nothing asserts on it).

---

### Task 3: Feedback route

**Files:**
- Modify: `worker/index.mjs:30`, `:54-58`, `:157-208`
- Modify: `worker/test/feedback.test.mjs`

**Interfaces:**
- Consumes: `rateLimitedShared`, `callerKey` from Task 2.
- Produces: `handleFeedback(request, env, deps)` no longer reads `deps.rateLimitStore`; requires `env.DB`; limiter runs before the body is read.

- [ ] **Step 1: Rewrite the feedback tests' environment and add the new cases**

In `worker/test/feedback.test.mjs`:

Replace the `VALID_ENV` constant and add the import:

```js
import { createDb } from './d1.mjs';

const VALID_CONTEXT = { version: 'v0.1.0+ab12cd3', level: 'Level 12', ua: 'test-agent', date: '2026-09-02T00:00:00.000Z' };
/** A fresh database per test: the limiter lives in it (issue #186), and one
 *  shared database would let one test's posts spend the next test's allowance. */
function validEnv() {
  return { RESEND_API_KEY: 'test-key', FEEDBACK_TO: 'qa@example.com', FEEDBACK_FROM: 'Lantern Tiles <onboarding@resend.dev>', DB: createDb() };
}
```

Then, throughout the file: every `VALID_ENV` becomes `validEnv()` — except the two places that read fields off it (`VALID_ENV.FEEDBACK_FROM`, `VALID_ENV.RESEND_API_KEY` in the "forwards to Resend" test): there, bind once `const env = validEnv();`, pass `env`, and read `env.FEEDBACK_FROM` / `env.RESEND_API_KEY`. The `{ ...VALID_ENV, RESEND_API_KEY: undefined }` case becomes `{ ...validEnv(), RESEND_API_KEY: undefined }`. Every `rateLimitStore: new Map()` / `rateLimitStore: store` in a deps object is deleted (leave `{}` or the remaining deps).

Replace the existing rate-limit test with these three:

```js
test('rate limit: 6th call in the window is 429, with nothing shared in memory between calls', async () => {
  // A fresh deps object per call: the count has to live in the database, or
  // a recycled isolate (issue #186) would start every caller at zero.
  const env = validEnv();
  const headers = { 'CF-Connecting-IP': '203.0.113.9' };
  let last;
  for (let i = 0; i < 6; i++) {
    last = await handleFeedback(
      req({ summary: 'hi', body: 'hello', context: VALID_CONTEXT }, { headers }),
      env,
      { fetch: okFetch(), now: () => 1_000 },
    );
  }
  assert.equal(last.status, 429);
  assert.deepEqual(await last.json(), { error: 'rate_limited' });
});

test('rate limit: the over-limit request is refused before its body is read', async () => {
  // Feedback is the most expensive unauthenticated write (up to 36 MB). The
  // sixth caller's body must not be parsed to find out it is refused.
  const env = validEnv();
  const headers = { 'CF-Connecting-IP': '203.0.113.9' };
  const deps = { fetch: okFetch(), now: () => 1_000 };
  for (let i = 0; i < 5; i++) {
    await handleFeedback(req({ summary: 'hi', body: 'hello', context: VALID_CONTEXT }, { headers }), env, deps);
  }
  const res = await handleFeedback(req('{ not json', { headers }), env, deps);
  assert.equal(res.status, 429, 'a 400 here would mean the body was parsed first');
});

test('no database -> 503 not_configured: the limiter fails closed', async () => {
  const { DB, ...env } = validEnv();
  const res = await handleFeedback(
    req({ summary: 'hi', body: 'hello', context: VALID_CONTEXT }),
    env,
    { fetch: okFetch() },
  );
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: 'not_configured' });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `node --test worker/test/feedback.test.mjs`
Expected: the three new tests fail (6th call is 202; malformed body is 400; missing DB is 202).

- [ ] **Step 3: Implement**

In `worker/index.mjs`:

Import line becomes:

```js
import { callerKey, isCrossSite, json, rateLimitedShared } from './http.mjs';
```

Delete `const defaultRateLimitStore = createRateLimitStore();` (line 58). Keep `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS`.

Replace the top of `handleFeedback` through the cross-site check:

```js
/**
 * Pure-ish request handler: everything reachable from the outside world
 * (fetch, the clock) comes in through `deps` so tests never touch the network
 * or real time. The database — which holds the rate limiter's counts (issue
 * #186) — arrives as `env.DB`, D1's binding, exactly as for the profile.
 */
export async function handleFeedback(request, env, deps = {}) {
  const fetchImpl = deps.fetch ?? fetch;
  const now = deps.now ?? (() => Date.now());

  const url = new URL(request.url);
  if (url.pathname !== '/api/feedback') return json(404, { error: 'not_found' });
  if (request.method !== 'POST') return json(405, { error: 'method_not_allowed' });
  if (isCrossSite(request)) return json(403, { error: 'cross_site' });
  // Without the database there is no limiter, and an unmetered 36 MB
  // unauthenticated write is not something to run "for now" — so the route
  // fails closed, like the profile does. The client falls back to mailto.
  if (!env.DB) return json(503, { error: 'not_configured' });

  // Before the body is read (issue #186). This is the most expensive
  // unauthenticated write surface, and the point of a limit on it is to not
  // pay for the over-limit bodies — parsing 36 MB to then say 429 would pay
  // for them. A malformed request therefore spends allowance too; a real
  // client does not send those.
  if (
    await rateLimitedShared(env.DB, callerKey(request, 'feedback'), now(), {
      max: RATE_LIMIT_MAX,
      windowMs: RATE_LIMIT_WINDOW_MS,
    })
  ) {
    return json(429, { error: 'rate_limited' });
  }

  const contentLength = request.headers.get('Content-Length');
```

and delete the old `rateLimited(...)` block that sat after the attachment checks (the `if (rateLimited(callerKey(request, 'feedback'), rateLimitStore, ...)) return json(429, ...)` statement).

- [ ] **Step 4: Run**

Run: `node --test worker/test/feedback.test.mjs`
Expected: all pass.

Run: `node --test worker/test/*.test.mjs`
Expected: all pass. (`handleRequest` tests in leaderboard.test.mjs call feedback? No — only `/api/leaderboard`. If any other test posts to `/api/feedback` through `handleRequest` without `DB`, it now gets 503; update that expectation.)

---

### Task 4: Profile routes — address before auth, player after

**Files:**
- Modify: `worker/profile.mjs:38`, `:73`, `:474-576`
- Modify: `worker/test/profile.test.mjs:12`, `:36-42`, `:470-491`, plus new tests

**Interfaces:**
- Consumes: `rateLimitedShared`, `callerKey`, `playerKey` (Task 2).
- Produces: `handleProfile(request, env, deps)` ignores `deps.rateLimitStore`; handlers take `(request, env, deps, now, limit)`.

- [ ] **Step 1: Update fixtures and add failing tests**

In `worker/test/profile.test.mjs`:

- Delete `import { createRateLimitStore } from '../http.mjs';` and the `rateLimitStore: createRateLimitStore(),` line in `makeDeps`.
- In the test `"a short-window route's traffic cannot expire the hour-long register window"`, delete `const store = createRateLimitStore();` and change `makeDeps({ rateLimitStore: store, now: () => clock })` to `makeDeps({ now: () => clock })`. Change its opening comment to:

```js
  // Every key has its own row and its own window (issue #186); a route with a
  // short window running in between must not hand back the register allowance.
```

Add, after `'registrations from one address are rate limited'`:

```js
function from(ip) {
  return { 'CF-Connecting-IP': ip };
}

test('one player syncing from two addresses is metered as one player', async () => {
  // Issue #186: the address bucket alone lets a player exceed the allowance by
  // changing address. The player bucket, checked after the code is verified,
  // does not.
  const env = { DB: createDb() };
  const deps = makeDeps();
  const { json: created } = await registerPlayer(env, deps);
  let last;
  for (let i = 0; i < 61; i += 1) {
    last = await handleProfile(
      request('POST', '/api/profile/sync', {
        headers: { ...bearer(created.code), ...from(i % 2 ? '203.0.113.1' : '203.0.113.2') },
        body: { record: EMPTY_RECORD },
      }),
      env,
      deps,
    );
  }
  assert.equal(last.status, 429);
  assert.deepEqual(await last.json(), { error: 'rate_limited' });
});

test('two players behind one address share the address bucket', async () => {
  const env = { DB: createDb() };
  const deps = makeDeps();
  const a = await registerPlayer(env, deps);
  const b = await registerPlayer(env, deps, { name: 'Bea' });
  const sync = (code) =>
    handleProfile(
      request('POST', '/api/profile/sync', { headers: bearer(code), body: { record: EMPTY_RECORD } }),
      env,
      deps,
    );
  for (let i = 0; i < 30; i += 1) await sync(a.json.code);
  for (let i = 0; i < 30; i += 1) await sync(b.json.code);
  assert.equal((await sync(a.json.code)).status, 429);
  // From another address, neither player has spent their own allowance.
  const elsewhere = await handleProfile(
    request('POST', '/api/profile/sync', {
      headers: { ...bearer(a.json.code), ...from('198.51.100.7') },
      body: { record: EMPTY_RECORD },
    }),
    env,
    deps,
  );
  assert.equal(elsewhere.status, 200);
});

test('registrations from two addresses are independent', async () => {
  const env = { DB: createDb() };
  const deps = makeDeps();
  for (let i = 0; i < 5; i += 1) {
    await handleProfile(
      request('POST', '/api/profile/register', {
        headers: from('203.0.113.1'),
        body: { name: 'Alex', avatar: 'lantern', record: EMPTY_RECORD },
      }),
      env,
      deps,
    );
  }
  const other = await handleProfile(
    request('POST', '/api/profile/register', {
      headers: from('203.0.113.2'),
      body: { name: 'Alex', avatar: 'lantern', record: EMPTY_RECORD },
    }),
    env,
    deps,
  );
  assert.equal(other.status, 201);
});

test('the count survives a fresh deps object — nothing is kept in memory', async () => {
  const env = { DB: createDb() };
  let last;
  for (let i = 0; i < 6; i += 1) last = await registerPlayer(env, makeDeps());
  assert.equal(last.response.status, 429);
});
```

- [ ] **Step 2: Run, expect failure**

Run: `node --test worker/test/profile.test.mjs`
Expected: "one player syncing from two addresses" fails (61st sync is 200); "the count survives a fresh deps object" fails (6th register is 201). The others may already pass.

- [ ] **Step 3: Implement**

In `worker/profile.mjs`:

Import line (line 38) becomes:

```js
import { callerKey, isCrossSite, json, playerKey, rateLimitedShared } from './http.mjs';
```

Delete `const defaultRateLimitStore = createRateLimitStore();` (line 73). Above `RATE_LIMITS`, extend the existing comment's last paragraph with:

```js
 *
 * Each number is enforced twice (issue #186): once per calling address before
 * the code is checked, and once per player after it is — the same allowance
 * from either side, so a player cannot exceed it by changing address and an
 * address cannot exceed it by rotating codes.
```

Add, after `authenticate`:

```js
/** The post-auth half of the limiter (issue #186): the player's own bucket for
 *  `scope`, with the same allowance as the address bucket the router already
 *  checked. `null` when within it; the 429 to return when not. */
async function playerLimited(db, scope, playerId, now, limit) {
  if (await rateLimitedShared(db, playerKey(scope, playerId), now, limit)) {
    return json(429, { error: 'rate_limited' });
  }
  return null;
}
```

`sync`:

```js
async function sync(request, env, deps, now, limit) {
  const auth = await authenticate(request, env.DB);
  if (auth.error) return auth.error;
  const limited = await playerLimited(env.DB, 'sync', auth.row.id, now, limit);
  if (limited) return limited;
  const body = await readBody(request);
```

`rename`:

```js
async function rename(request, env, deps, now, limit) {
  const auth = await authenticate(request, env.DB);
  if (auth.error) return auth.error;
  const limited = await playerLimited(env.DB, 'name', auth.row.id, now, limit);
  if (limited) return limited;
  const body = await readBody(request);
```

`read`:

```js
async function read(request, env, deps, now, limit) {
  const auth = await authenticate(request, env.DB);
  if (auth.error) return auth.error;
  const limited = await playerLimited(env.DB, 'read', auth.row.id, now, limit);
  if (limited) return limited;
  return json(200, { profile: rowToProfile(auth.row) });
}
```

`register` keeps its signature `(request, env, deps, now)`; the extra argument is ignored.

`handleProfile`:

```js
/**
 * The `/api/profile*` router. Everything reachable from the outside world
 * (the clock, randomness) arrives through `deps` so tests are deterministic;
 * the database — rows and the rate limiter's counts alike — arrives as
 * `env.DB`, D1's binding.
 */
export async function handleProfile(request, env, deps = {}) {
  const now = (deps.now ?? (() => Date.now()))();
  const resolved = { randomBytes: deps.randomBytes ?? defaultRandomBytes };

  if (isCrossSite(request)) return json(403, { error: 'cross_site' });
  if (!env.DB) return json(503, { error: 'not_configured' });

  const { pathname } = new URL(request.url);
  const post = request.method === 'POST';
  const route =
    pathname === '/api/profile/register'
      ? { name: 'register', handler: register, allowed: post }
      : pathname === '/api/profile/sync'
        ? { name: 'sync', handler: sync, allowed: post }
        : pathname === '/api/profile/name'
          ? { name: 'name', handler: rename, allowed: post }
          : pathname === '/api/profile'
            ? { name: 'read', handler: read, allowed: request.method === 'GET' }
            : null;
  if (route === null) return json(404, { error: 'not_found' });
  if (!route.allowed) return json(405, { error: 'method_not_allowed' });

  // The address bucket, before the handler — and so before any code is
  // checked or any row is read. The handler checks the player bucket once it
  // knows who the player is (issue #186).
  const limit = RATE_LIMITS[route.name];
  if (await rateLimitedShared(env.DB, callerKey(request, route.name), now, limit)) {
    return json(429, { error: 'rate_limited' });
  }
  return route.handler(request, env, resolved, now, limit);
}
```

- [ ] **Step 4: Run**

Run: `node --test worker/test/profile.test.mjs`
Expected: all pass.

Run: `node --test worker/test/*.test.mjs`
Expected: leaderboard tests may now fail — `addPlayer` registers every player from the same (unknown) address with a throwaway store that no longer bypasses anything, and a test registering more than 5 players trips the register limit. Task 5 fixes those; proceed.

---

### Task 5: Leaderboard routes — player bucket, anon read stays in memory

**Files:**
- Modify: `worker/leaderboard.mjs:41`, `:110-125`, `:334-337`, `:398-431`, `:435-470`
- Modify: `worker/test/leaderboard.test.mjs:21`, `:47-56`, `:70-82`, `:352-372`, plus new tests

**Interfaces:**
- Consumes: `rateLimitedShared`, `callerKey`, `playerKey`, `rateLimited`, `createRateLimitStore` (Task 2); `authenticate` via `deps`.
- Produces: `handleLeaderboard(request, env, deps)` — `deps.rateLimitStore` is still honoured, for the anonymous read only.

- [ ] **Step 1: Update fixtures and add failing tests**

In `worker/test/leaderboard.test.mjs`:

`addPlayer` gives each player its own address (they are different people) instead of a throwaway store:

```js
/** A registered player, so an entry has an owner and a display name. Each
 *  registration comes from its own address: these are meant to be different
 *  people, and the profile route caps registrations per address. */
let nextAddress = 0;
async function addPlayer(env, deps, name) {
  nextAddress += 1;
  const response = await handleProfile(
    request('POST', '/api/profile/register', {
      headers: { 'CF-Connecting-IP': `203.0.113.${nextAddress}` },
      body: { name, avatar: 'lantern', record: {} },
    }),
    env,
    deps,
  );
  const body = await response.json();
  assert.equal(response.status, 201, JSON.stringify(body));
  return { name, code: body.code, playerId: body.playerId };
}
```

(If `nextAddress` can exceed 254 in one file, use `` `203.0.${Math.floor(nextAddress / 256)}.${nextAddress % 256}` ``.)

In `'a player cannot bank more than the week’s run cap'`, replace the loop with one that spreads the posts a minute apart, so the 20/10 min submit limit is never what stops it:

```js
  for (let i = 0; i < MAX_RUNS_PER_WEEK + 5; i += 1) {
    // A minute apart: the submit limiter (20 / 10 min) rolls over as the run
    // goes, so the database's run cap — not the limiter — is what stops this.
    // That is the whole point: a caller who slips the limiter must still stop
    // at the database.
    last = await post(env, deps, alex, { score: 100, elapsedMs: 90_000 }, NOW + i * 60_000);
  }
```

Keep `makeDeps` as is (its `rateLimitStore` now serves only the anonymous read). Keep the `createRateLimitStore` import.

Add, after `'submissions from one address are rate limited'`:

```js
test('one player submitting from two addresses is metered as one player', async () => {
  // Issue #186: the address bucket alone lets a player exceed the allowance by
  // changing address. The player bucket, checked after the code is verified,
  // does not.
  const env = { DB: createDb() };
  const deps = makeDeps();
  const alex = await addPlayer(env, deps, 'Alex');
  let last;
  for (let i = 0; i < 21; i += 1) {
    const response = await handleLeaderboard(
      request('POST', '/api/leaderboard/weekly', {
        headers: { ...bearer(alex.code), 'CF-Connecting-IP': i % 2 ? '198.51.100.1' : '198.51.100.2' },
        body: { score: 100 + i, elapsedMs: 90_000 },
      }),
      env,
      deps,
    );
    last = { status: response.status, body: await response.json() };
  }
  assert.equal(last.status, 429);
  assert.deepEqual(last.body, { error: 'rate_limited' });
});

test('the submit count survives a fresh deps object — nothing is kept in memory', async () => {
  const env = { DB: createDb() };
  const alex = await addPlayer(env, makeDeps(), 'Alex');
  let last;
  for (let i = 0; i < 21; i += 1) {
    last = await post(env, makeDeps(), alex, { score: 100 + i, elapsedMs: 90_000 });
  }
  assert.equal(last.status, 429);
});

test('withdrawing is metered per player', async () => {
  const env = { DB: createDb() };
  const deps = makeDeps();
  const alex = await addPlayer(env, deps, 'Alex');
  let last;
  for (let i = 0; i < 11; i += 1) {
    last = await handleLeaderboard(
      request('DELETE', '/api/leaderboard/weekly', {
        headers: { ...bearer(alex.code), 'CF-Connecting-IP': `198.51.100.${i}` },
      }),
      env,
      deps,
    );
  }
  assert.equal(last.status, 429);
});

test('an anonymous read writes nothing to the limiter table', async () => {
  // Public data, no credential: the in-memory limiter stays for this one route
  // so a board read does not cost a database write.
  const env = { DB: createDb() };
  const deps = makeDeps();
  const alex = await addPlayer(env, deps, 'Alex');
  const before = env.DB.raw.prepare('SELECT COUNT(*) AS n FROM rate_limits').get().n;
  for (let i = 0; i < 5; i += 1) assert.equal((await board(env, deps, null)).status, 200);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM rate_limits').get().n, before);
  // ...but it is still limited, per isolate.
  for (let i = 0; i < 60; i += 1) await board(env, deps, null);
  assert.equal((await board(env, deps, null)).status, 429);
  void alex;
});
```

- [ ] **Step 2: Run, expect failure**

Run: `node --test worker/test/leaderboard.test.mjs`
Expected: "two addresses" (21st submit is 200), "fresh deps" (21st is 200), "withdrawing" (11th is 200) fail; "anonymous read writes nothing" fails (the router now — after Task 4? no, leaderboard still uses the Map — actually it passes until Step 3 changes the router; that is fine).

- [ ] **Step 3: Implement**

In `worker/leaderboard.mjs`:

Import (line 41):

```js
import { callerKey, createRateLimitStore, isCrossSite, json, playerKey, rateLimited, rateLimitedShared } from './http.mjs';
```

Replace the comment above `defaultRateLimitStore` (lines 121-125):

```js
/** For the anonymous board read only (issue #186): public data, no credential,
 *  and a database write per read would double the cost of the cheapest route.
 *  Every other route is metered in D1 by `rateLimitedShared`. Falls back to a
 *  per-isolate store, exactly like before: the entry point injects nothing,
 *  and a limiter that is only wired up in tests is not a limiter. */
const defaultRateLimitStore = createRateLimitStore();
```

Add after `defaultRateLimitStore`:

```js
/** The post-auth half of the limiter (issue #186): the player's own bucket for
 *  `scope`, with the same allowance as the address bucket the router already
 *  checked. `null` when within it; the 429 to return when not. */
async function playerLimited(db, scope, playerId, now, limit) {
  if (await rateLimitedShared(db, playerKey(scope, playerId), now, limit)) {
    return json(429, { error: 'rate_limited' });
  }
  return null;
}
```

`submit` (line 334):

```js
async function submit(request, env, deps, now) {
  const auth = await deps.authenticate(request, env.DB);
  if (auth.error) return auth.error;
  const limited = await playerLimited(env.DB, 'lb-submit', auth.row.id, now, RATE_LIMITS.submit);
  if (limited) return limited;
  const body = await readBody(request);
```

`read` — the signed branch:

```js
  if (
    await rateLimitedShared(env.DB, callerKey(request, 'lb-read-signed'), now, RATE_LIMITS['read-signed'])
  ) {
    return json(429, { error: 'rate_limited' });
  }
  const auth = await deps.authenticate(request, env.DB);
  if (!auth.error) {
    const limited = await playerLimited(env.DB, 'lb-read-signed', auth.row.id, now, RATE_LIMITS['read-signed']);
    if (limited) return limited;
  }
  const playerId = auth.error ? null : auth.row.id;
  return json(200, await boardFor(env.DB, week, playerId, now));
```

`withdraw` gains `now`:

```js
async function withdraw(request, env, deps, now) {
  const auth = await deps.authenticate(request, env.DB);
  if (auth.error) return auth.error;
  const limited = await playerLimited(env.DB, 'lb-withdraw', auth.row.id, now, RATE_LIMITS.withdraw);
  if (limited) return limited;
```

`handleLeaderboard` — replace the block from `// Before the handler, so a caller with no valid code is metered too.` to the end of the function:

```js
  // Before the handler, so a caller with no valid code is metered too. The
  // anonymous read is the one route still on the in-memory limiter (see
  // `defaultRateLimitStore`); everything else counts in D1, and the handler
  // adds the player's own bucket once the code has been checked (issue #186).
  const limit = RATE_LIMITS[route.name];
  const key = callerKey(request, `lb-${route.name}`);
  const limited =
    route.name === 'read' && request.headers.get('Authorization') === null
      ? rateLimited(key, resolved.rateLimitStore, now, limit)
      : await rateLimitedShared(env.DB, key, now, limit);
  if (limited) return json(429, { error: 'rate_limited' });
  return route.handler(request, env, resolved, now);
```

Note: a *signed* read now passes through the D1 `lb-read` bucket (60/10 min, address) in the router and then the `lb-read-signed` bucket (10/10 min, address, then player) in the handler. That is the pre-existing layering; only the store changed.

- [ ] **Step 4: Run**

Run: `node --test worker/test/leaderboard.test.mjs`
Expected: all pass, including `'signed reads are metered more tightly than public ones'` and `'an anonymous read never reaches the credential check'`.

Run: `node --test worker/test/*.test.mjs`
Expected: all pass.

---

### Task 6: Daily sweep of stale rows

**Files:**
- Modify: `wrangler.jsonc` (add `triggers`)
- Modify: `worker/index.mjs:279-281` (default export)
- Modify: `worker/test/feedback.test.mjs` (new test; it already imports from `../index.mjs`)

**Interfaces:**
- Produces: `export async function sweepRateLimits(db, now) → Promise<void>`; default export gains `scheduled`.

- [ ] **Step 1: Failing test**

Append to `worker/test/feedback.test.mjs` (and add `sweepRateLimits` to its import from `../index.mjs`):

```js
test('the daily sweep drops rows whose window ended more than a day ago, and nothing else', async () => {
  const { DB } = validEnv();
  const day = 24 * 60 * 60 * 1000;
  const now = 10 * day;
  DB.raw
    .prepare('INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1), (?, ?, 1), (?, ?, 1)')
    .run('old', now - day - 1, 'edge', now - day, 'live', now - 60_000);
  await sweepRateLimits(DB, now);
  const keys = DB.raw.prepare('SELECT key FROM rate_limits ORDER BY key').all().map((r) => r.key);
  assert.deepEqual(keys, ['edge', 'live']);
});
```

- [ ] **Step 2: Run, expect failure**

Run: `node --test worker/test/feedback.test.mjs`
Expected: import of `sweepRateLimits` fails.

- [ ] **Step 3: Implement**

In `worker/index.mjs`, before the default export:

```js
/** Longer than any limiter window (the longest is register's hour), so a row
 *  this old cannot still be counting. */
const RATE_LIMIT_ROW_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Issue #186: `rate_limits` rows are reused per key, so the table is bounded
 * by the number of distinct callers — but a caller seen once leaves a row
 * behind forever. This runs from the cron trigger in wrangler.jsonc, once a
 * day, and deletes rows whose window opened more than a day ago. Exported so
 * the test can run it against the SQLite fake.
 */
export async function sweepRateLimits(db, now) {
  await db.prepare('DELETE FROM rate_limits WHERE window_start < ?').bind(now - RATE_LIMIT_ROW_TTL_MS).run();
}

export default {
  fetch: (request, env) => handleRequest(request, env),
  // `scheduled` only ever runs when wrangler.jsonc has a cron, and only with
  // the database bound; without `DB` there is nothing to sweep.
  scheduled: (controller, env) => (env.DB ? sweepRateLimits(env.DB, Date.now()) : undefined),
};
```

In `wrangler.jsonc`, after the `"main"` line:

```jsonc
  // Issue #186 — once a day, delete rate-limit rows whose window ended more
  // than a day ago (worker/index.mjs `scheduled`). 04:17 UTC: off the hour,
  // and outside the evening peak in every playtest time zone.
  "triggers": {
    "crons": ["17 4 * * *"]
  },
```

and extend the D1 comment's list of applied migrations:

```jsonc
  //   wrangler d1 execute lantern-tiles --remote --file worker/schema-0005-rate-limits.sql
```

- [ ] **Step 4: Run**

Run: `node --test worker/test/*.test.mjs`
Expected: all pass.

Run: `npx --prefix ui wrangler --version >/dev/null 2>&1 && npx wrangler deploy --dry-run --outdir /tmp/wr 2>&1 | tail -5` (only if wrangler is installed locally; otherwise skip — CI's deploy job validates the config).
Expected: no config error about `triggers`.

---

### Task 7: Docs

**Files:**
- Create: `docs/decisions/0029-shared-rate-limiter-in-d1.md`
- Modify: `docs/decisions/0019-feedback-worker-endpoint.md:66-70`
- Modify: `docs/decisions/0021-profile-sync-own-backend.md:52`
- Modify: `worker/index.mjs:13-16` (header comment)

- [ ] **Step 1: Decision record**

`docs/decisions/0029-shared-rate-limiter-in-d1.md`:

```markdown
# 0029 — The rate limiter counts in D1, keyed by address and by player

**Date:** 2026-09-04 · **Status:** accepted · **Ticket:** issue #186
**Amends:** [0019](0019-feedback-worker-endpoint.md) (its per-isolate caveat) and
[0021](0021-profile-sync-own-backend.md) ("rate limits are applied before
authentication" — now also after, by player).

## Context

Every API route was metered by a `Map` inside one Worker isolate, keyed by
`CF-Connecting-IP`. Cloudflare recycles isolates and runs many per colo, so the
count reset on every eviction and was never shared between the isolates and
colos serving one caller. 0019 said so ("slow down obvious abuse, not a hard
cap"). The external review of 2026-09-04 asked for a real limit on the write
routes; feedback — unauthenticated, up to 36 MB a request — is the most
expensive of them.

## Decision

1. **The count lives in D1.** One `rate_limits` row per key
   (schema-0005), updated by a single upsert that opens, resets or increments
   the window and returns the count — atomic, so two isolates cannot both
   read four and both write five. Fixed windows, the same numbers as before:
   the store was the problem, not the ceilings.
2. **Two keys per authenticated route.** `<route>:ip:<address>` before the
   code is checked, so guesses are metered; `<route>:player:<id>` after, with
   the same allowance, so a player cannot exceed it by changing address.
   Feedback and register have no player and get the address key only.
3. **Feedback meters before it reads the body.** The point of a limit on a
   36 MB write is to not pay for the over-limit bodies. Malformed requests now
   spend allowance too; a real client does not send those.
4. **Feedback needs the database.** Without `DB` it answers `503
   not_configured`, as the profile does; the client already falls back to
   `mailto:`. A D1 error from the limiter reaches `handleRequest` and becomes
   the 503 of issue #185. Fail closed.
5. **The anonymous board read stays in memory.** Public data, no credential; a
   database write per read would double the cost of the cheapest route.
6. **A daily cron deletes rows older than a day.** Rows are reused per key, so
   the table is bounded by distinct callers, but nothing else would ever
   remove a caller seen once.

## Rejected

- **Cloudflare's Rate Limiting binding.** `period` is 10 or 60 seconds, so no
  existing window (10 min, 1 h) is expressible, and counts are per-colo — the
  property this ticket exists to remove.
- **A Durable Object counter.** The strongest guarantee, but a new binding
  class, a migration block and a new test double, for traffic this small. If
  the D1 write per request ever matters, this is the upgrade.
- **KV with TTL.** Eventually consistent, one write per second per key. Not a
  counter.

## Consequences

- Two D1 writes per authenticated write request; one per feedback or register.
  At playtest volume this is noise against the free tier's daily row budget.
- Migration 0005 must be applied before the deploy; the #185 gate enforces it.
- Issue #189 (per-player quotas over longer horizons) can reuse the table with
  a longer window and its own scope.
- The tests exercise the real SQL through `node:sqlite`; nothing about the
  limiter is faked.
```

- [ ] **Step 2: Pointers in 0019 and 0021**

In `docs/decisions/0019-feedback-worker-endpoint.md`, at the end of the bullet beginning "The rate limiter is per-isolate, in-memory state" (lines 66-70), append:

```markdown
  **Superseded by [0029](0029-shared-rate-limiter-in-d1.md) (issue #186):** the
  count now lives in D1 and is checked before the body is read.
```

In `docs/decisions/0021-profile-sync-own-backend.md`, after the paragraph beginning "**Rate limits are applied before authentication.**" (line 52), append a sentence:

```markdown
Since [0029](0029-shared-rate-limiter-in-d1.md) (issue #186) the count lives in
D1 rather than in one isolate's memory, and the same allowance is checked again
after authentication, keyed by player.
```

- [ ] **Step 3: index.mjs header**

Line 15-16 of `worker/index.mjs` — "and the shared JSON/cross-site/rate-limit helpers in http.mjs." — becomes:

```js
// `/api/leaderboard*` (issue #70) in leaderboard.mjs, and the shared
// JSON/cross-site/rate-limit helpers in http.mjs. Rate limits count in D1
// since issue #186 (decision 0029); `scheduled` below sweeps their table.
```

- [ ] **Step 4: Full QA per CLAUDE.md**

Run, from a clean install:

```bash
cd core && npm ci && npm test && npm run build && cd .. && cd ui && npm ci && npm test && cd .. && node --test bench/test/*.test.mjs && node --test worker/test/*.test.mjs
```

Expected: all green. Then senior-dev review of the working-tree diff, then present results and STOP for PM approval before any commit.

---

## Self-review

- Spec coverage: storage (T1), limiter + keys (T2), feedback incl. before-body and 503 (T3), profile ip+player (T4), leaderboard ip+player + anon in-memory (T5), cleanup cron (T6), docs incl. 0019/0021 pointers and wrangler comments (T6, T7). Tests listed in the spec each map to a task.
- Names used consistently: `rateLimitedShared(db, key, now, {max, windowMs})`, `callerKey(request, scope)`, `playerKey(scope, playerId)`, `playerLimited(db, scope, playerId, now, limit)` (module-local, defined identically in profile.mjs and leaderboard.mjs — two copies of a 6-line helper was preferred to exporting a 429-shaped helper from http.mjs; if a reviewer objects, move it to http.mjs), `sweepRateLimits(db, now)`.
- Scopes: profile `register|read|sync|name`; leaderboard `lb-submit|lb-read|lb-read-signed|lb-withdraw`; feedback `feedback`. The player key uses the same scope string as the address key of the same check.
```
