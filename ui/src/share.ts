// Daily share card (issue #228): a short plain-text summary of today's three
// challenges, the live streak, and the game URL — no name, no score, no
// level, so it stays inside spec §7's no-pressure stance (see decision 0028:
// the Daily is three challenges on the ladder, not a board or a leaderboard
// of its own).
//
// Pure functions only, like the rest of the Daily surface: no DOM, no clock.
// main.ts gathers today's standing, the live streak, the date key and the
// page's own URL and hands them in.

import type { ClipboardWriter } from './feedback-form.js';
import { copyText } from './feedback-form.js';

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/** "2026-09-05" -> "Sep 5", "2026-12-25" -> "Dec 25". Built from the key's
 *  own digits, never from `Date` local parsing, so the device's time zone
 *  cannot shift the date a share card claims. */
function shortDate(dateKey: string): string {
  const [, month, day] = dateKey.split('-');
  const name = MONTHS[Number(month) - 1] ?? month;
  return `${name} ${Number(day)}`;
}

/** The plain-text card (issue #228): one ✅/⬜ per slot in slot order, then
 *  the live streak — omitted entirely at 0, since a fresh streak is nothing
 *  to lead with — then the game URL on its own line. No trailing newline. */
export function dailyShareCard(input: {
  readonly done: readonly boolean[];
  readonly streak: number;
  readonly dateKey: string;
  readonly url: string;
}): string {
  const boxes = input.done.map((d) => (d ? '✅' : '⬜')).join(' ');
  const streakClause = input.streak > 0 ? `  🔥 ${input.streak}-day streak` : '';
  return [`Lantern Tiles · ${shortDate(input.dateKey)}`, `${boxes}${streakClause}`, input.url].join('\n');
}

function isAbortError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'name' in err && (err as { name: unknown }).name === 'AbortError';
}

/** Share the card (issue #228). `share` is passed only when the caller has
 *  already confirmed `typeof navigator.share === 'function'`; when given, it
 *  is preferred over the clipboard. A user-dismissed share sheet
 *  (`AbortError`) is not a failure worth reporting — it resolves 'failed'
 *  silently, without touching the clipboard. Any other share rejection falls
 *  back to copying the text; 'copied' on success, 'failed' otherwise. */
export async function shareDailyCard(
  text: string,
  options: {
    readonly share?: (data: { text: string }) => Promise<void>;
    readonly clipboard?: ClipboardWriter;
  },
): Promise<'shared' | 'copied' | 'failed'> {
  if (options.share !== undefined) {
    try {
      await options.share({ text });
      return 'shared';
    } catch (err) {
      if (isAbortError(err)) return 'failed';
      // any other share error falls through to the clipboard fallback
    }
  }
  const copied = await copyText(text, options.clipboard);
  return copied ? 'copied' : 'failed';
}
