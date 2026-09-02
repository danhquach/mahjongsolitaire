// In-game feedback form (issue #118): "Send feedback" in Settings, delivered
// to the QA inbox by a Cloudflare Worker endpoint (worker/index.mjs), with a
// `mailto:` fallback so a submission is never lost if the endpoint is down.
//
// Pure helpers only — no DOM here, so the payload shape, the email text, and
// the mailto fallback are all unit-testable without a browser (main.ts owns
// the dialog wiring). Not to be confused with feedback.ts, which is the
// audio/haptics cue player.

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

export interface FeedbackPayload {
  readonly summary: string;
  readonly body: string;
  readonly context: FeedbackContext;
}

/** Build the payload the Worker endpoint (and the mailto fallback) both send.
 *  Summary/body are trimmed here so a field of only whitespace behaves like
 *  an empty one everywhere downstream. */
export function buildFeedbackPayload(input: {
  summary: string;
  body: string;
  version: string;
  level: string;
  ua: string;
  date: string;
}): FeedbackPayload {
  return {
    summary: input.summary.trim(),
    body: input.body.trim(),
    context: { version: input.version, level: input.level, ua: input.ua, date: input.date },
  };
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
