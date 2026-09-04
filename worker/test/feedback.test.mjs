// Feedback endpoint tests (issue #118). Node 22's global Request/Response/fetch
// stand in for the Workers runtime; the handler takes its own `fetch`/`now` as
// injectable deps so nothing here touches the network or a shared clock, and
// the rate limiter's counts live in the SQLite-backed D1 fake (issue #186).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleFeedback, sweep, sweepRateLimits } from '../index.mjs';
import { createDb } from './d1.mjs';

const VALID_CONTEXT = { version: 'v0.1.0+ab12cd3', level: 'Level 12', ua: 'test-agent', date: '2026-09-02T00:00:00.000Z' };
/** A fresh database per call: the limiter lives in it (issue #186), and one
 *  shared database would let one call's post spend the next one's allowance. */
function validEnv() {
  return { RESEND_API_KEY: 'test-key', FEEDBACK_TO: 'qa@example.com', FEEDBACK_FROM: 'Lantern Tiles <onboarding@resend.dev>', DB: createDb() };
}

function req(body, init = {}) {
  return new Request('https://lantern-tiles.example.workers.dev/api/feedback', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...init.headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    ...init,
  });
}

function okFetch() {
  return async () => new Response('{}', { status: 200 });
}

test('method not allowed', async () => {
  const request = new Request('https://x.example/api/feedback', { method: 'GET' });
  const res = await handleFeedback(request, validEnv(), {});
  assert.equal(res.status, 405);
});

test('bad JSON body', async () => {
  const request = req('not json');
  const res = await handleFeedback(request, validEnv(), {});
  assert.equal(res.status, 400);
});

test('over-length summary is rejected', async () => {
  const request = req({ summary: 'x'.repeat(101), body: 'hello', context: VALID_CONTEXT });
  const res = await handleFeedback(request, validEnv(), {});
  assert.equal(res.status, 400);
});

test('over-length body is rejected', async () => {
  const request = req({ summary: 'hi', body: 'x'.repeat(2001), context: VALID_CONTEXT });
  const res = await handleFeedback(request, validEnv(), {});
  assert.equal(res.status, 400);
});

test('missing key -> 503', async () => {
  const request = req({ summary: 'hi', body: 'hello', context: VALID_CONTEXT });
  const res = await handleFeedback(request, { ...validEnv(), RESEND_API_KEY: undefined }, {});
  assert.equal(res.status, 503);
});

test('provider failure -> 502', async () => {
  const request = req({ summary: 'hi', body: 'hello', context: VALID_CONTEXT });
  const res = await handleFeedback(request, validEnv(), {
    fetch: async () => new Response('nope', { status: 500 }),
  });
  assert.equal(res.status, 502);
});

test('success -> 202 with exact subject and a text body containing summary/body/context lines', async () => {
  let captured;
  const request = req({ summary: 'Tiles overlap', body: 'The bamboo tile clips the dot tile.', context: VALID_CONTEXT });
  const env = validEnv();
  const res = await handleFeedback(request, env, {
    fetch: async (url, init) => {
      captured = { url, init };
      return new Response('{}', { status: 200 });
    },
  });
  assert.equal(res.status, 202);
  assert.equal(captured.url, 'https://api.resend.com/emails');
  const sent = JSON.parse(captured.init.body);
  assert.equal(sent.subject, '[Lantern Tiles feedback] Tiles overlap');
  assert.match(sent.text, /The bamboo tile clips the dot tile\./);
  assert.match(sent.text, /Tiles overlap/);
  assert.match(sent.text, /v0\.1\.0\+ab12cd3/);
  assert.match(sent.text, /Level 12/);
  assert.match(sent.text, /test-agent/);
  assert.match(sent.text, /2026-09-02T00:00:00\.000Z/);
  assert.equal(sent.to, env.FEEDBACK_TO);
  assert.equal(sent.from, env.FEEDBACK_FROM);
  assert.equal(captured.init.headers.Authorization, `Bearer ${env.RESEND_API_KEY}`);
});

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

test('rate limit: two addresses have independent allowances', async () => {
  const env = validEnv();
  const deps = { fetch: okFetch(), now: () => 1_000 };
  for (let i = 0; i < 5; i++) {
    await handleFeedback(
      req({ summary: 'hi', body: 'hello', context: VALID_CONTEXT }, { headers: { 'CF-Connecting-IP': '203.0.113.9' } }),
      env,
      deps,
    );
  }
  const other = await handleFeedback(
    req({ summary: 'hi', body: 'hello', context: VALID_CONTEXT }, { headers: { 'CF-Connecting-IP': '203.0.113.10' } }),
    env,
    deps,
  );
  assert.equal(other.status, 202);
});

test('no database -> 503 not_configured: the limiter fails closed', async () => {
  const { DB, ...env } = validEnv();
  void DB;
  const res = await handleFeedback(
    req({ summary: 'hi', body: 'hello', context: VALID_CONTEXT }),
    env,
    { fetch: okFetch() },
  );
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: 'not_configured' });
});

test('the daily sweep drops rows whose window opened more than a day ago, and nothing else', async () => {
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

test('cross-site request -> 403', async () => {
  const request = req(
    { summary: 'hi', body: 'hello', context: VALID_CONTEXT },
    { headers: { 'Sec-Fetch-Site': 'cross-site' } },
  );
  const res = await handleFeedback(request, validEnv(), {});
  assert.equal(res.status, 403);
});

test('no Origin and no Sec-Fetch-Site (a non-browser or same-origin client) is allowed through', async () => {
  const seen = [];
  const fetchImpl = async (_url, init) => {
    seen.push(JSON.parse(init.body));
    return new Response('{}', { status: 200 });
  };
  const res = await handleFeedback(
    req({ summary: 'hi', body: 'there', context: VALID_CONTEXT }),
    validEnv(),
    { fetch: fetchImpl },
  );
  assert.equal(res.status, 202);
  assert.equal(seen.length, 1);
});

test('an oversized body with no Content-Length is still rejected with 413', async () => {
  const big = { summary: 'x', body: 'y'.repeat(1000), context: { ...VALID_CONTEXT, ua: 'z'.repeat(250) } };
  // Pad past 8 KB with an ignored field; strip Content-Length so only the
  // post-read measurement can catch it.
  const raw = JSON.stringify({ ...big, pad: 'p'.repeat(9000) });
  const request = new Request('https://lantern-tiles.example.workers.dev/api/feedback', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(raw));
        controller.close();
      },
    }),
    duplex: 'half',
  });
  assert.equal(request.headers.get('Content-Length'), null);
  const res = await handleFeedback(request, validEnv(), { fetch: okFetch() });
  assert.equal(res.status, 413);
});

test('line breaks in the summary never reach the subject line', async () => {
  let sent;
  const fetchImpl = async (_url, init) => {
    sent = JSON.parse(init.body);
    return new Response('{}', { status: 200 });
  };
  const res = await handleFeedback(
    req({ summary: 'line one\r\nBcc: x', body: 'b', context: VALID_CONTEXT }),
    validEnv(),
    { fetch: fetchImpl },
  );
  assert.equal(res.status, 202);
  assert.equal(sent.subject, '[Lantern Tiles feedback] line one Bcc: x');
});

// --- attachments (issue #130) --------------------------------------------------

/** A base64 string that decodes to exactly `bytes` bytes (all 'A's, i.e. zero
 *  bytes — the handler never decodes, it only measures). */
function base64OfSize(bytes) {
  const full = Math.floor(bytes / 3);
  const rest = bytes % 3;
  return 'A'.repeat(full * 4) + (rest === 1 ? 'AA==' : rest === 2 ? 'AAA=' : '');
}

const PNG = { name: 'shot.png', type: 'image/png', content: base64OfSize(300) };
const MP4 = { name: 'clip.mp4', type: 'video/mp4', content: base64OfSize(500) };

function reqWithAttachments(attachments, init) {
  return req({ summary: 'Tiles overlap', body: 'See attached.', context: VALID_CONTEXT, attachments }, init);
}

async function sendAndCapture(request) {
  let sent;
  const res = await handleFeedback(request, validEnv(), {
    fetch: async (_url, init) => {
      sent = JSON.parse(init.body);
      return new Response('{}', { status: 200 });
    },
  });
  return { res, sent };
}

test('attachments are forwarded to Resend as filename + base64 content, and listed in the text', async () => {
  const { res, sent } = await sendAndCapture(reqWithAttachments([PNG, MP4]));
  assert.equal(res.status, 202);
  assert.deepEqual(sent.attachments, [
    { filename: 'shot.png', content: PNG.content },
    { filename: 'clip.mp4', content: MP4.content },
  ]);
  assert.match(sent.text, /Attachments: 2 — shot\.png \(1 KB\), clip\.mp4 \(1 KB\)/);
});

test('no attachments field -> no attachments key sent and no Attachments line', async () => {
  const { res, sent } = await sendAndCapture(req({ summary: 'hi', body: 'hello', context: VALID_CONTEXT }));
  assert.equal(res.status, 202);
  assert.equal('attachments' in sent, false);
  assert.doesNotMatch(sent.text, /Attachments:/);
});

test('an empty attachments array is fine and sends nothing extra', async () => {
  const { res, sent } = await sendAndCapture(reqWithAttachments([]));
  assert.equal(res.status, 202);
  assert.equal('attachments' in sent, false);
});

test('a fourth attachment is rejected as an invalid payload', async () => {
  const res = await handleFeedback(reqWithAttachments([PNG, PNG, PNG, PNG]), validEnv(), {});
  assert.equal(res.status, 400);
});

test('an attachment type outside the allow-list (HEIC, text, svg) is rejected', async () => {
  for (const type of ['image/heic', 'text/plain', 'image/svg+xml', 'application/octet-stream', undefined]) {
    const res = await handleFeedback(reqWithAttachments([{ ...PNG, type }]), validEnv(), {});
    assert.equal(res.status, 400, `type ${type}`);
  }
});

test('malformed attachment entries are rejected', async () => {
  const bad = [
    [null],
    [{ ...PNG, name: '' }],
    [{ ...PNG, name: 'x'.repeat(201) }],
    [{ ...PNG, content: '' }],
    [{ ...PNG, content: 'abc' }], // length not a multiple of 4
    [{ ...PNG, content: 42 }],
    'not-an-array',
  ];
  for (const attachments of bad) {
    const res = await handleFeedback(reqWithAttachments(attachments), validEnv(), {});
    assert.equal(res.status, 400, JSON.stringify(attachments).slice(0, 60));
  }
});

test('an image over 10 MB is 413 attachment_too_large; one at exactly 10 MB is accepted', async () => {
  const over = await handleFeedback(
    reqWithAttachments([{ ...PNG, content: base64OfSize(10 * 1024 * 1024 + 1) }]),
    validEnv(),
    { fetch: okFetch() },
  );
  assert.equal(over.status, 413);
  assert.deepEqual(await over.json(), { error: 'attachment_too_large' });
  const exact = await handleFeedback(
    reqWithAttachments([{ ...PNG, content: base64OfSize(10 * 1024 * 1024) }]),
    validEnv(),
    { fetch: okFetch() },
  );
  assert.equal(exact.status, 202);
});

test('a video over 25 MB is 413; one at 25 MB (over the image cap) is accepted because it is video', async () => {
  const over = await handleFeedback(
    reqWithAttachments([{ ...MP4, content: base64OfSize(25 * 1024 * 1024 + 3) }]),
    validEnv(),
    { fetch: okFetch() },
  );
  assert.equal(over.status, 413);
  const exact = await handleFeedback(
    reqWithAttachments([{ ...MP4, content: base64OfSize(25 * 1024 * 1024) }]),
    validEnv(),
    { fetch: okFetch() },
  );
  assert.equal(exact.status, 202);
});

test('three images that individually fit but total over 25 MB are 413', async () => {
  const nine = { ...PNG, content: base64OfSize(9 * 1024 * 1024) };
  const res = await handleFeedback(reqWithAttachments([nine, nine, nine]), validEnv(), {
    fetch: okFetch(),
  });
  assert.equal(res.status, 413);
});

test('a body over 36 MB is 413 before parsing, via Content-Length', async () => {
  const request = new Request('https://lantern-tiles.example.workers.dev/api/feedback', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Content-Length': String(37 * 1024 * 1024) },
    body: '{}',
  });
  const res = await handleFeedback(request, validEnv(), {});
  assert.equal(res.status, 413);
});

test('a text-only body over 8 KB is still 413 even though the attachment allowance is larger', async () => {
  const res = await handleFeedback(
    req({ summary: 'x', body: 'y', context: VALID_CONTEXT, attachments: [], pad: 'p'.repeat(9000) }),
    validEnv(),
    { fetch: okFetch() },
  );
  assert.equal(res.status, 413);
});

test('a body over 8 KB that carries an attachment is accepted', async () => {
  const res = await handleFeedback(
    reqWithAttachments([{ ...PNG, content: base64OfSize(12 * 1024) }]),
    validEnv(),
    { fetch: okFetch() },
  );
  assert.equal(res.status, 202);
});

test('path separators and control characters are scrubbed from the filename', async () => {
  const { res, sent } = await sendAndCapture(
    reqWithAttachments([{ ...PNG, name: '../..\\evil name\r\n.png' }]),
  );
  assert.equal(res.status, 202);
  assert.equal(sent.attachments[0].filename, '.._.._evil name__.png');
});

test('the nightly sweep is one entry point for all three tables', async () => {
  const { DB } = validEnv();
  const day = 24 * 60 * 60 * 1000;
  const now = Date.parse('2026-09-03T12:00:00Z');
  DB.raw.prepare('INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)').run('old', now - 2 * day);
  DB.raw
    .prepare(
      `INSERT INTO players (id, code_hash, name, avatar, created_at, updated_at)
       VALUES ('STALE', 'h1', 'Stale', 'lantern', ?, ?), ('GONE', 'h2', 'Gone', 'lantern', ?, ?)`,
    )
    .run(now - 400 * day, now - 400 * day, now - 400 * day, now - 400 * day);
  // A withdrawn-and-forgotten player: standing gone, but one run from long ago
  // survived — the sweep must clear that before the player can go.
  DB.raw
    .prepare(
      `INSERT INTO weekly_submissions (week_start, player_id, score, elapsed_ms, history, created_at)
       VALUES ('2026-01-04', 'GONE', 1, 1, '[]', ?)`,
    )
    .run(now - 240 * day);
  await sweep(DB, now);
  assert.equal(DB.raw.prepare('SELECT COUNT(*) AS n FROM rate_limits').get().n, 0);
  assert.equal(DB.raw.prepare('SELECT COUNT(*) AS n FROM weekly_submissions').get().n, 0);
  assert.equal(DB.raw.prepare('SELECT COUNT(*) AS n FROM players').get().n, 0);
});
