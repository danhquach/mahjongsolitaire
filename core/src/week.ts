// The leaderboard week (issue #176).
//
// One weekly board, and every player is ranked over the same seven days. The
// week starts Sunday 00:00 UTC — the *server's* clock, not the player's local
// week (PM, 2026-09-03). A client-supplied week key would split the board into
// overlapping buckets across the ~27 hours of local boundaries, and would need
// the skew and age guards the Daily board carried. The accepted cost is a reset
// at an odd local hour: Saturday 16:00 Pacific.
//
// UTC throughout, so unlike the Daily's date key there is no timezone to get
// wrong — the same instant yields the same week key on every machine. That is
// also why the client may compute it: a player with no account still needs a
// week to score into, and their answer agrees with the server's by
// construction rather than by trust.

const DAY_MS = 24 * 60 * 60 * 1000;
export const WEEK_MS = 7 * DAY_MS;

/** The instant the week containing `nowMs` opened: Sunday 00:00:00.000 UTC. */
export function weekStartMs(nowMs: number): number {
  const at = new Date(nowMs);
  const midnight = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
  // getUTCDay: 0 is Sunday, so this is already "days since the week opened".
  return midnight - at.getUTCDay() * DAY_MS;
}

/** `YYYY-MM-DD` of the Sunday that opens the week containing `nowMs`. */
export function weekStartKey(nowMs: number): string {
  return new Date(weekStartMs(nowMs)).toISOString().slice(0, 10);
}

/** The instant the current week ends and the board resets. Exclusive: a run at
 *  exactly this millisecond belongs to the next week, not this one. */
export function weekResetAt(nowMs: number): number {
  return weekStartMs(nowMs) + WEEK_MS;
}

/** How long until the board resets. Never negative, so a clock that jumps
 *  forward shows "0s" rather than a countdown running backwards. */
export function msUntilWeekReset(nowMs: number): number {
  return Math.max(0, weekResetAt(nowMs) - nowMs);
}

const WEEK_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** A week key that is shaped like one. Anything else reads as "no week", which
 *  is what makes a record written before this feature start a fresh week
 *  instead of carrying a lifetime total onto the board. */
export function isWeekKey(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    WEEK_KEY.test(value) &&
    !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
  );
}
