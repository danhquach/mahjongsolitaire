// Pieces every Worker route needs (issue #138 split them out of index.mjs).
//
// The feedback endpoint (issue #118) was the only route, so its JSON helper,
// its same-origin check and its rate limiter lived inline. The profile routes
// need all three with identical semantics, and two copies of a security check
// is how the copies drift — so they live here and both routers import them.

export function json(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Same-origin check (issue #118 design): reject a request that names itself
 *  cross-site, allow everything else — a direct API client sends neither
 *  header, and these endpoints have no cookie/session to protect from CSRF
 *  (the profile routes authenticate with a bearer code a browser never
 *  attaches on its own), so the check only needs to stop a *browser* on
 *  another origin. */
export function isCrossSite(request) {
  const secFetchSite = request.headers.get('Sec-Fetch-Site');
  if (secFetchSite !== null) return secFetchSite === 'cross-site';
  const origin = request.headers.get('Origin');
  if (origin === null) return false;
  try {
    return new URL(origin).origin !== new URL(request.url).origin;
  } catch {
    return true;
  }
}

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
