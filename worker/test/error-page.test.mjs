// Issue #210: a browser that lands on a path that is neither the game nor an
// API route gets a page, not `{"error":"not_found"}`. API callers keep JSON.

import assert from 'node:assert/strict';
import test from 'node:test';

import { errorPage, isNavigation } from '../error-page.mjs';
import { handleRequest } from '../index.mjs';

const env = {};

function nav(path, headers = { 'Sec-Fetch-Mode': 'navigate', Accept: 'text/html,*/*;q=0.8' }) {
  return new Request(`https://x.example${path}`, { headers });
}

test('a browser navigation to an unknown path gets an HTML 404 with a way back', async () => {
  const res = await handleRequest(nav('/play'), env);
  assert.equal(res.status, 404);
  assert.match(res.headers.get('content-type'), /^text\/html/);
  const html = await res.text();
  assert.match(html, /<title>.*Lantern Tiles.*<\/title>/);
  assert.match(html, /No matching pair here/);
  assert.match(html, /href="\/"/, 'the page links back to the game');
  // The deal reads 4 · 0 · 4 in tile art, described for a screen reader.
  assert.match(html, /aria-label="Three tiles reading four, zero, four"/);
});

test('the page is self-contained: no script, no external stylesheet, no external asset', async () => {
  for (const status of [404, 503]) {
    const html = await errorPage(status).text();
    assert.doesNotMatch(html, /<script/i);
    assert.doesNotMatch(html, /<link/i);
    assert.doesNotMatch(html, /\b(src|href)="(https?:)?\/\/[^"]*"/i, 'nothing fetched from anywhere');
    assert.doesNotMatch(html, /url\(/i, 'no background image');
    assert.match(html, /<html lang="en">/);
    assert.match(html, /prefers-reduced-motion/, 'the lantern glow stands still when asked');
  }
});

test('a 503 page deals the tiles face down and says the game is resting rather than missing', async () => {
  const res = errorPage(503);
  assert.equal(res.status, 503);
  const html = await res.text();
  assert.match(html, /short break/);
  assert.match(html, /aria-label="Three tiles face down"/);
});

test('an unknown path fetched by a program still gets JSON', async () => {
  const res = await handleRequest(new Request('https://x.example/play'), env);
  assert.equal(res.status, 404);
  assert.equal(res.headers.get('content-type'), 'application/json');
  assert.deepEqual(await res.json(), { error: 'not_found' });
});

test('an API path answers JSON even to a browser navigation', async () => {
  const res = await handleRequest(nav('/api/nope'), env);
  assert.equal(res.status, 404);
  assert.equal(res.headers.get('content-type'), 'application/json');
});

test('a navigation is recognised by Sec-Fetch-Mode, or by an Accept that asks for HTML', () => {
  assert.equal(isNavigation(nav('/x')), true);
  assert.equal(isNavigation(nav('/x', { Accept: 'text/html' })), true);
  assert.equal(isNavigation(nav('/x', { Accept: 'application/json' })), false);
  assert.equal(isNavigation(nav('/x', { 'Sec-Fetch-Mode': 'cors', Accept: 'text/html' })), false);
  assert.equal(isNavigation(nav('/x', {})), false);
});
