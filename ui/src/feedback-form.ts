// In-game feedback form (issue #118): "Send feedback" in Settings, delivered
// to the QA inbox by a Cloudflare Worker endpoint (worker/index.mjs), with a
// `mailto:` fallback so a submission is never lost if the endpoint is down.
//
// Pure helpers only — no DOM here, so the payload shape, the email text, and
// the mailto fallback are all unit-testable without a browser (main.ts owns
// the dialog wiring). Not to be confused with feedback.ts, which is the
// audio/haptics cue player.
//
// Issue #130 adds optional attachments: up to three screenshots or a short
// recording, base64-encoded into the same JSON payload (the Worker forwards
// them to the mail provider as-is, see worker/index.mjs). The size/type rules
// here are the player-facing check; the Worker enforces the same caps again.

/** The one place the QA inbox address lives in the UI bundle. It ships in the
 *  `mailto:` fallback by design (issue #118 accepts this) — the Worker
 *  endpoint is the normal path and never puts the address or an API key in
 *  the bundle (see worker/index.mjs). */
export const FEEDBACK_INBOX = 'dqtgametesting@gmail.com';

/** `mailto:` bodies get unwieldy fast in some clients; keep the generated URL
 *  comfortably under the ~2000-char limit several still enforce. */
const MAILTO_MAX_LENGTH = 2000;

export interface FeedbackContext {
  readonly version: string;
  readonly level: string;
  readonly ua: string;
  readonly date: string;
}

/** One attachment as it travels in the payload: base64 `content`. */
export interface FeedbackAttachment {
  readonly name: string;
  readonly type: string;
  readonly content: string;
}

export interface FeedbackPayload {
  readonly summary: string;
  readonly body: string;
  readonly context: FeedbackContext;
  readonly attachments: readonly FeedbackAttachment[];
}

/** Build the payload the Worker endpoint (and the mailto fallback) both send.
 *  Summary/body are trimmed here so a field of only whitespace behaves like
 *  an empty one everywhere downstream. Attachments are optional (issue #130)
 *  and never part of the mailto path. */
export function buildFeedbackPayload(input: {
  summary: string;
  body: string;
  version: string;
  level: string;
  ua: string;
  date: string;
  attachments?: readonly FeedbackAttachment[];
}): FeedbackPayload {
  return {
    summary: input.summary.trim(),
    body: input.body.trim(),
    context: { version: input.version, level: input.level, ua: input.ua, date: input.date },
    attachments: input.attachments ?? [],
  };
}

// --- attachments (issue #130) --------------------------------------------------

export const MAX_ATTACHMENTS = 3;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** The mail provider caps a whole email at 40 MB after base64 (×4/3), which
 *  is what pulls the video cap down from the issue's "~50 MB"; the combined
 *  cap keeps three near-limit images inside the same envelope. */
export const MAX_VIDEO_BYTES = 25 * 1024 * 1024;
export const MAX_TOTAL_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export type AttachmentKind = 'image' | 'video';

/** MIME types the picker offers, and the kind each maps to. HEIC/HEIF are
 *  accepted at the picker because the client re-encodes every image before
 *  sending (metadata strip), so they leave the device as JPEG. */
const KIND_BY_TYPE: Readonly<Record<string, AttachmentKind>> = {
  'image/png': 'image',
  'image/jpeg': 'image',
  'image/webp': 'image',
  'image/heic': 'image',
  'image/heif': 'image',
  'video/mp4': 'video',
  'video/quicktime': 'video',
  'video/webm': 'video',
};

/** Some platforms hand over a File with an empty `type` (HEIC on desktop
 *  browsers, MOV from some pickers) — fall back to the extension. */
const KIND_BY_EXTENSION: Readonly<Record<string, AttachmentKind>> = {
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  webp: 'image',
  heic: 'image',
  heif: 'image',
  mp4: 'video',
  m4v: 'video',
  mov: 'video',
  webm: 'video',
};

/** The `accept` attribute for the file input. */
export const ATTACHMENT_ACCEPT = Object.keys(KIND_BY_TYPE).join(',');

export function attachmentKind(name: string, type: string): AttachmentKind | null {
  const byType = KIND_BY_TYPE[type.toLowerCase()];
  if (byType !== undefined) return byType;
  if (type !== '') return null;
  const ext = name.toLowerCase().split('.').pop() ?? '';
  return KIND_BY_EXTENSION[ext] ?? null;
}

export type AttachmentRefusal = 'too_many' | 'unsupported' | 'too_large' | 'total_too_large';

export type AttachmentCheck =
  | { readonly ok: true; readonly kind: AttachmentKind }
  | { readonly ok: false; readonly reason: AttachmentRefusal };

/** Can `candidate` join `existing`? Checked twice per file in practice: once
 *  on the picked file (so a huge file is refused before it is decoded) and
 *  again on the re-encoded result (whose size differs). */
export function checkAttachment(
  existing: readonly { readonly size: number }[],
  candidate: { readonly name: string; readonly type: string; readonly size: number },
): AttachmentCheck {
  if (existing.length >= MAX_ATTACHMENTS) return { ok: false, reason: 'too_many' };
  const kind = attachmentKind(candidate.name, candidate.type);
  if (kind === null) return { ok: false, reason: 'unsupported' };
  if (candidate.size > (kind === 'image' ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES)) {
    return { ok: false, reason: 'too_large' };
  }
  const total = existing.reduce((sum, a) => sum + a.size, candidate.size);
  if (total > MAX_TOTAL_ATTACHMENT_BYTES) return { ok: false, reason: 'total_too_large' };
  return { ok: true, kind };
}

/** The short message the form shows for a refused file (issue #130: refuse
 *  with a short message, leave the rest of the form untouched). */
export function refusalMessage(reason: AttachmentRefusal): string {
  switch (reason) {
    case 'too_many':
      return `Up to ${MAX_ATTACHMENTS} attachments per report`;
    case 'unsupported':
      return 'Only images (PNG, JPG, WebP, HEIC) or video (MP4, MOV, WebM)';
    case 'too_large':
      return 'Too big: images up to 10 MB, video up to 25 MB';
    case 'total_too_large':
      return 'Attachments add up to more than 25 MB';
  }
}

/** Filename for a re-encoded image: same stem, extension matching the new
 *  type, so a HEIC that left the canvas as JPEG is not called `.heic`. */
export function reencodedName(name: string, type: string): string {
  const stem = name.replace(/\.[^.]*$/, '') || 'image';
  return `${stem}.${type === 'image/png' ? 'png' : 'jpg'}`;
}

/** Standard base64 of raw bytes, chunked so `String.fromCharCode` never sees
 *  an argument list longer than engines allow. */
export function base64FromBytes(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
  }
  return btoa(binary);
}

/** Encode the pending files into the payload shape. */
export async function encodeAttachments(
  items: readonly { readonly name: string; readonly type: string; readonly blob: Blob }[],
): Promise<FeedbackAttachment[]> {
  const out: FeedbackAttachment[] = [];
  for (const item of items) {
    const bytes = new Uint8Array(await item.blob.arrayBuffer());
    out.push({ name: item.name, type: item.type, content: base64FromBytes(bytes) });
  }
  return out;
}

export function feedbackSubject(summary: string): string {
  return `[Lantern Tiles feedback] ${summary}`;
}

/** The player's text plus the auto-appended context block (issue #118): no
 *  player-identifying data beyond what they typed — the profile name is
 *  deliberately not part of `context`. */
export function feedbackText(payload: FeedbackPayload): string {
  const { summary, body, context } = payload;
  return [
    body,
    '',
    '---',
    `Summary: ${summary}`,
    `Version: ${context.version}`,
    `Level: ${context.level}`,
    `Platform: ${context.ua}`,
    `Date: ${context.date}`,
  ].join('\n');
}

/** A pre-filled `mailto:` link, truncating the body (never the subject) so
 *  the whole URL stays under MAILTO_MAX_LENGTH. */
export function mailtoUrl(to: string, subject: string, text: string): string {
  const base = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=`;
  let body = text;
  while (base.length + encodeURIComponent(body).length > MAILTO_MAX_LENGTH && body.length > 0) {
    body = body.slice(0, Math.max(0, body.length - 200));
  }
  return base + encodeURIComponent(body);
}

/** Send is enabled once both fields have real (non-whitespace) content. */
export function canSend(summary: string, body: string): boolean {
  return summary.trim().length > 0 && body.trim().length > 0;
}

export type SendResult = 'sent' | 'unavailable' | 'failed';

/** POST to the Worker endpoint. `fetchImpl` is injected so tests never touch
 *  the network. 202 -> 'sent'; a network error or 503 (key not configured,
 *  see worker/index.mjs) -> 'unavailable', so the caller offers the mailto
 *  fallback; any other non-2xx -> 'failed'. */
export async function sendFeedback(
  payload: FeedbackPayload,
  fetchImpl: typeof fetch,
): Promise<SendResult> {
  let response: Response;
  try {
    response = await fetchImpl('/api/feedback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    return 'unavailable';
  }
  if (response.status === 202) return 'sent';
  if (response.status === 503) return 'unavailable';
  return 'failed';
}
