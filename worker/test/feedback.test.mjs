// Feedback endpoint tests (issue #118). Node 22's global Request/Response/fetch
// stand in for the Workers runtime; the handler takes its own `fetch`/`now`/
// rate-limit store as injectable deps so nothing here touches the network or
// a shared clock.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleFeedback } from '../index.mjs';

const VALID_CONTEXT = { version: 'v0.1.0+ab12cd3', level: 'Level 12', ua: 'test-agent', date: '2026-09-02T00:00:00.000Z' };
const VALID_ENV = { RESEND_API_KEY: 'test-key', FEEDBACK_TO: 'qa@example.com', FEEDBACK_FROM: 'Lantern Tiles <onboarding@resend.dev>' };

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
  const res = await handleFeedback(request, VALID_ENV, { rateLimitStore: new Map() });
  assert.equal(res.status, 405);
});

test('bad JSON body', async () => {
  const request = req('not json');
  const res = await handleFeedback(request, VALID_ENV, { rateLimitStore: new Map() });
  assert.equal(res.status, 400);
});

test('over-length summary is rejected', async () => {
  const request = req({ summary: 'x'.repeat(101), body: 'hello', context: VALID_CONTEXT });
  const res = await handleFeedback(request, VALID_ENV, { rateLimitStore: new Map() });
  assert.equal(res.status, 400);
});

test('over-length body is rejected', async () => {
  const request = req({ summary: 'hi', body: 'x'.repeat(2001), context: VALID_CONTEXT });
  const res = await handleFeedback(request, VALID_ENV, { rateLimitStore: new Map() });
  assert.equal(res.status, 400);
});

test('missing key -> 503', async () => {
  const request = req({ summary: 'hi', body: 'hello', context: VALID_CONTEXT });
  const res = await handleFeedback(request, { ...VALID_ENV, RESEND_API_KEY: undefined }, { rateLimitStore: new Map() });
  assert.equal(res.status, 503);
});

test('provider failure -> 502', async () => {
  const request = req({ summary: 'hi', body: 'hello', context: VALID_CONTEXT });
  const res = await handleFeedback(request, VALID_ENV, {
    rateLimitStore: new Map(),
    fetch: async () => new Response('nope', { status: 500 }),
  });
  assert.equal(res.status, 502);
});

test('success -> 202 with exact subject and a text body containing summary/body/context lines', async () => {
  let captured;
  const request = req({ summary: 'Tiles overlap', body: 'The bamboo tile clips the dot tile.', context: VALID_CONTEXT });
  const res = await handleFeedback(request, VALID_ENV, {
    rateLimitStore: new Map(),
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
  assert.equal(sent.to, VALID_ENV.FEEDBACK_TO);
  assert.equal(sent.from, VALID_ENV.FEEDBACK_FROM);
  assert.equal(captured.init.headers.Authorization, `Bearer ${VALID_ENV.RESEND_API_KEY}`);
});

test('rate limit: 6th call in the window is 429', async () => {
  const store = new Map();
  const deps = { rateLimitStore: store, fetch: okFetch(), now: () => 1_000 };
  const headers = { 'CF-Connecting-IP': '203.0.113.9' };
  let last;
  for (let i = 0; i < 6; i++) {
    last = await handleFeedback(
      req({ summary: 'hi', body: 'hello', context: VALID_CONTEXT }, { headers }),
      VALID_ENV,
      deps,
    );
  }
  assert.equal(last.status, 429);
});

test('cross-site request -> 403', async () => {
  const request = req(
    { summary: 'hi', body: 'hello', context: VALID_CONTEXT },
    { headers: { 'Sec-Fetch-Site': 'cross-site' } },
  );
  const res = await handleFeedback(request, VALID_ENV, { rateLimitStore: new Map() });
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
    VALID_ENV,
    { fetch: fetchImpl, rateLimitStore: new Map() },
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
  const res = await handleFeedback(request, VALID_ENV, { fetch: okFetch(), rateLimitStore: new Map() });
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
    VALID_ENV,
    { fetch: fetchImpl, rateLimitStore: new Map() },
  );
  assert.equal(res.status, 202);
  assert.equal(sent.subject, '[Lantern Tiles feedback] line one Bcc: x');
});
