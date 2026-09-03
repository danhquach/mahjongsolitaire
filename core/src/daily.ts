// The Daily's calendar (spec §6, issue #19; reshaped by #183).
//
// The date no longer keys a board — it keys the day itself: which three
// challenges are served (core/challenges.ts) and which day a streak and its
// trophies belong to. What survived the board's removal is the calendar
// arithmetic, and that is what this module is.
//
// The whole contract is a pure function of the *calendar date* — the
// "YYYY-MM-DD" a player's clock shows — not of an instant. Two players in
// Auckland and Los Angeles are on different calendar dates for part of every
// day and simply reach each other's challenges a few hours apart; what must
// never happen is the same calendar date producing two sets, or a timezone or
// DST shift producing a date the player's own calendar disagrees with. So:
//
//   * `dailyDateKey` derives the key with Intl's own calendar arithmetic in
//     the given (or device) time zone, so DST gaps and overlaps resolve the
//     way the OS clock does;
//   * `daysBetween` does streak arithmetic on the keys in UTC, where a day is
//     always 86,400 s, so a streak spanning a DST change still reads as
//     consecutive days.
//
// The spec's "trophy + streak with escalating rewards" is `dailyTrophies` —
// the schedule is decision 0016's.

const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Is `key` a well-formed "YYYY-MM-DD" naming a real calendar date? */
export function isDateKey(key: unknown): key is string {
  if (typeof key !== 'string') return false;
  const m = DATE_KEY.exec(key);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  // setUTCFullYear, not Date.UTC: the latter reads years 0–99 as 1900–1999.
  const date = new Date(0);
  date.setUTCFullYear(y, mo - 1, d);
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

/**
 * The calendar date of `at` in `timeZone` (the device zone when omitted) as
 * "YYYY-MM-DD". Intl does the zone and DST resolution; the parts are read
 * back as numbers so no locale's digit shapes or ordering leak in.
 */
export function dailyDateKey(at: Date = new Date(), timeZone?: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    ...(timeZone === undefined ? {} : { timeZone }),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  // en-US 'numeric' can yield 5+ digit years far in the future; pad, never trim.
  const key = `${get('year').padStart(4, '0')}-${get('month')}-${get('day')}`;
  if (!isDateKey(key)) throw new RangeError(`could not derive a date key: ${key}`);
  return key;
}

function requireKey(key: string): void {
  if (!isDateKey(key)) throw new RangeError(`not a date key: ${key}`);
}

/** Whole calendar days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  requireKey(from);
  requireKey(to);
  const ms = (k: string): number => {
    const [y, m, d] = k.split('-').map(Number) as [number, number, number];
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((ms(to) - ms(from)) / 86_400_000);
}

/** Streak lengths at which the day's first completion starts paying an extra
 *  trophy. */
export const STREAK_TIERS: readonly number[] = [7, 30];

/** Trophies the day's first completed challenge grants at `streak`
 *  consecutive days (≥ 1): one, plus one per tier reached — the "escalating
 *  rewards" of spec §6. */
export function dailyTrophies(streak: number): number {
  if (!Number.isInteger(streak) || streak < 1) throw new RangeError(`streak must be ≥ 1: ${streak}`);
  return 1 + STREAK_TIERS.filter((tier) => streak >= tier).length;
}
