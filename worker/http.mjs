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

/** Per-isolate best-effort rate limiter — not shared across isolates or
 *  deploys, which is fine for "slow down obvious abuse", not a hard cap. */
export function createRateLimitStore() {
  return new Map();
}

/**
 * Best-effort fixed-window limiter keyed by caller (usually
 * `CF-Connecting-IP`). `store` and `now` are passed in so tests get a fresh,
 * deterministic clock and map.
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

/** The address a limiter keys on, namespaced by `scope` so routes sharing one
 *  store get independent buckets. Unknown callers share one bucket per scope,
 *  which is the conservative choice: better to throttle an unidentifiable
 *  caller than to hand every one of them its own allowance. */
export function callerKey(request, scope) {
  return `${scope}:${request.headers.get('CF-Connecting-IP') ?? 'unknown'}`;
}
