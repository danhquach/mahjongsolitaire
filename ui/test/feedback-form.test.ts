// Feedback form pure-helper tests (issue #118).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ATTACHMENT_ACCEPT,
  FEEDBACK_INBOX,
  MAX_ATTACHMENTS,
  MAX_IMAGE_BYTES,
  MAX_TOTAL_ATTACHMENT_BYTES,
  MAX_VIDEO_BYTES,
  attachmentKind,
  base64FromBytes,
  buildFeedbackPayload,
  canSend,
  checkAttachment,
  encodeAttachments,
  feedbackSubject,
  feedbackText,
  mailtoUrl,
  reencodedName,
  refusalMessage,
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

// --- attachments (issue #130) --------------------------------------------------

const MB = 1024 * 1024;

test('buildFeedbackPayload defaults to no attachments and passes a list through', () => {
  assert.deepEqual(buildFeedbackPayload(INPUT).attachments, []);
  const one = [{ name: 'shot.png', type: 'image/png', content: 'AAAA' }];
  assert.deepEqual(buildFeedbackPayload({ ...INPUT, attachments: one }).attachments, one);
});

test('feedbackText (the mailto body) never carries attachments', () => {
  const payload = buildFeedbackPayload({
    ...INPUT,
    attachments: [{ name: 'shot.png', type: 'image/png', content: 'AAAA' }],
  });
  assert.doesNotMatch(feedbackText(payload), /shot\.png|AAAA/);
});

test('attachmentKind: by MIME type, then by extension only when the type is empty', () => {
  assert.equal(attachmentKind('a.png', 'image/png'), 'image');
  assert.equal(attachmentKind('a.HEIC', 'image/heic'), 'image');
  assert.equal(attachmentKind('a.mov', 'video/quicktime'), 'video');
  assert.equal(attachmentKind('IMG_0001.HEIC', ''), 'image');
  assert.equal(attachmentKind('clip.MOV', ''), 'video');
  assert.equal(attachmentKind('notes.txt', 'text/plain'), null);
  assert.equal(attachmentKind('notes.txt', ''), null);
  // A wrong type wins over a right-looking extension: type is authoritative.
  assert.equal(attachmentKind('shot.png', 'text/plain'), null);
  assert.equal(attachmentKind('a.svg', 'image/svg+xml'), null);
});

test('ATTACHMENT_ACCEPT lists every image and video type the picker should offer', () => {
  for (const t of ['image/png', 'image/jpeg', 'image/webp', 'image/heic', 'video/mp4', 'video/quicktime', 'video/webm']) {
    assert.ok(ATTACHMENT_ACCEPT.split(',').includes(t), t);
  }
});

test('checkAttachment: accepts a small image and a small video', () => {
  assert.deepEqual(checkAttachment([], { name: 'a.png', type: 'image/png', size: 1000 }), { ok: true, kind: 'image' });
  assert.deepEqual(checkAttachment([], { name: 'a.mp4', type: 'video/mp4', size: 20 * MB }), { ok: true, kind: 'video' });
});

test('checkAttachment: fourth file is too_many, regardless of what it is', () => {
  const three = [{ size: 1 }, { size: 1 }, { size: 1 }];
  assert.equal(three.length, MAX_ATTACHMENTS);
  assert.deepEqual(checkAttachment(three, { name: 'a.png', type: 'image/png', size: 1 }), { ok: false, reason: 'too_many' });
});

test('checkAttachment: unsupported type', () => {
  assert.deepEqual(checkAttachment([], { name: 'a.txt', type: 'text/plain', size: 1 }), { ok: false, reason: 'unsupported' });
});

test('checkAttachment: per-kind caps — 10 MB images, 25 MB video, boundary inclusive', () => {
  assert.equal(checkAttachment([], { name: 'a.png', type: 'image/png', size: MAX_IMAGE_BYTES }).ok, true);
  assert.deepEqual(checkAttachment([], { name: 'a.png', type: 'image/png', size: MAX_IMAGE_BYTES + 1 }), { ok: false, reason: 'too_large' });
  assert.equal(checkAttachment([], { name: 'a.mp4', type: 'video/mp4', size: MAX_VIDEO_BYTES }).ok, true);
  assert.deepEqual(checkAttachment([], { name: 'a.mp4', type: 'video/mp4', size: MAX_VIDEO_BYTES + 1 }), { ok: false, reason: 'too_large' });
});

test('checkAttachment: combined cap across the report', () => {
  const existing = [{ size: 9 * MB }, { size: 9 * MB }];
  assert.equal(checkAttachment(existing, { name: 'a.png', type: 'image/png', size: 7 * MB }).ok, true);
  assert.deepEqual(checkAttachment(existing, { name: 'a.png', type: 'image/png', size: 8 * MB }), {
    ok: false,
    reason: 'total_too_large',
  });
  assert.equal(MAX_TOTAL_ATTACHMENT_BYTES, 25 * MB);
});

test('refusalMessage: one short line per reason', () => {
  for (const reason of ['too_many', 'unsupported', 'too_large', 'total_too_large'] as const) {
    const msg = refusalMessage(reason);
    assert.ok(msg.length > 0 && msg.length < 80 && !msg.includes('\n'), msg);
  }
  assert.match(refusalMessage('too_large'), /10 MB.*25 MB/);
});

test('reencodedName swaps the extension for the output type', () => {
  assert.equal(reencodedName('IMG_0001.HEIC', 'image/jpeg'), 'IMG_0001.jpg');
  assert.equal(reencodedName('shot.png', 'image/png'), 'shot.png');
  assert.equal(reencodedName('photo.webp', 'image/jpeg'), 'photo.jpg');
  assert.equal(reencodedName('noext', 'image/jpeg'), 'noext.jpg');
  assert.equal(reencodedName('.png', 'image/png'), 'image.png');
});

test('base64FromBytes matches the standard encoding, including across the chunk boundary', () => {
  const bytes = new Uint8Array(0x8000 * 2 + 5);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) & 255;
  assert.equal(base64FromBytes(bytes), Buffer.from(bytes).toString('base64'));
  assert.equal(base64FromBytes(new Uint8Array(0)), '');
});

test('encodeAttachments produces the payload shape with base64 content', async () => {
  const blob = new Blob([new Uint8Array([1, 2, 3, 4, 5])], { type: 'image/png' });
  const out = await encodeAttachments([{ name: 'shot.png', type: 'image/png', blob }]);
  assert.deepEqual(out, [{ name: 'shot.png', type: 'image/png', content: 'AQIDBAU=' }]);
});

test('sendFeedback: 413 (attachment refused server-side) -> failed, not unavailable', async () => {
  const payload = buildFeedbackPayload(INPUT);
  const result = await sendFeedback(payload, (async () => new Response('{}', { status: 413 })) as typeof fetch);
  assert.equal(result, 'failed');
});
