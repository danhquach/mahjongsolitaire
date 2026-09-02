// Feedback form pure-helper tests (issue #118).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  FEEDBACK_INBOX,
  buildFeedbackPayload,
  canSend,
  feedbackSubject,
  feedbackText,
  mailtoUrl,
  sendFeedback,
} from '../src/feedback-form.js';

const INPUT = {
  summary: '  Tiles overlap  ',
  body: '  The bamboo tile clips the dot tile.  ',
  version: 'v0.1.0+ab12cd3',
  level: 'Level 12',
  ua: 'test-agent',
  date: '2026-09-02T00:00:00.000Z',
};

test('buildFeedbackPayload trims summary and body', () => {
  const payload = buildFeedbackPayload(INPUT);
  assert.equal(payload.summary, 'Tiles overlap');
  assert.equal(payload.body, 'The bamboo tile clips the dot tile.');
  assert.deepEqual(payload.context, {
    version: INPUT.version,
    level: INPUT.level,
    ua: INPUT.ua,
    date: INPUT.date,
  });
});

test('feedbackSubject wraps the summary', () => {
  assert.equal(feedbackSubject('Tiles overlap'), '[Lantern Tiles feedback] Tiles overlap');
});

test('feedbackText contains the body and every context line, no profile name', () => {
  const payload = buildFeedbackPayload(INPUT);
  const text = feedbackText(payload);
  assert.match(text, /The bamboo tile clips the dot tile\./);
  assert.match(text, /Summary: Tiles overlap/);
  assert.match(text, /Version: v0\.1\.0\+ab12cd3/);
  assert.match(text, /Level: Level 12/);
  assert.match(text, /Platform: test-agent/);
  assert.match(text, /Date: 2026-09-02T00:00:00\.000Z/);
});

test('canSend requires non-blank summary and body', () => {
  assert.equal(canSend('', ''), false);
  assert.equal(canSend('  ', 'hi'), false);
  assert.equal(canSend('hi', '  '), false);
  assert.equal(canSend('hi', 'there'), true);
});

test('mailtoUrl encodes recipient, subject and body', () => {
  const url = mailtoUrl(FEEDBACK_INBOX, 'Subject line', 'Body text');
  assert.ok(url.startsWith(`mailto:${encodeURIComponent(FEEDBACK_INBOX)}?subject=`));
  assert.match(url, /subject=Subject%20line/);
  assert.match(url, /body=Body%20text/);
});

test('mailtoUrl truncates a very long body to stay under the length cap', () => {
  const longBody = 'x'.repeat(5000);
  const url = mailtoUrl(FEEDBACK_INBOX, 'Subject', longBody);
  assert.ok(url.length <= 2000);
});

test('sendFeedback: 202 -> sent', async () => {
  const payload = buildFeedbackPayload(INPUT);
  const result = await sendFeedback(payload, (async () => new Response('{}', { status: 202 })) as typeof fetch);
  assert.equal(result, 'sent');
});

test('sendFeedback: 503 -> unavailable', async () => {
  const payload = buildFeedbackPayload(INPUT);
  const result = await sendFeedback(payload, (async () => new Response('{}', { status: 503 })) as typeof fetch);
  assert.equal(result, 'unavailable');
});

test('sendFeedback: network error -> unavailable', async () => {
  const payload = buildFeedbackPayload(INPUT);
  const result = await sendFeedback(payload, (async () => {
    throw new Error('network down');
  }) as typeof fetch);
  assert.equal(result, 'unavailable');
});

test('sendFeedback: other non-2xx -> failed', async () => {
  const payload = buildFeedbackPayload(INPUT);
  const result = await sendFeedback(payload, (async () => new Response('{}', { status: 500 })) as typeof fetch);
  assert.equal(result, 'failed');
});
