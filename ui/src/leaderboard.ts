// The weekly leaderboard, device side (issue #176, superseding #70's Daily
// board — see docs/decisions/0027-one-weekly-score.md).
//
// One board, and it ranks the ladder: every ladder clear adds its final score
// to the player's standing for the current week. The Daily Challenge pays
// trophies and a streak and contributes nothing here.
//
// The week is the server's — Sunday 00:00 UTC — and the server decides which
// week a submitted run lands in, so nothing here sends one. `resetsAt` comes
// back with every board and is what the panel counts down to, rather than the
// device's own idea of when the week ends.
//
// Two consents, not one. Sync (issue #138) gives the profile a server-side
// home; appearing on a public board is a *further* step, because it puts a
// display name in front of strangers. So this module has its own opt-in flag,
// off by default, and turning it off withdraws every entry the player has
// posted rather than merely hiding them.
//
// No DOM here (main.ts owns the panel), and `fetch` arrives as an argument,
// so the failure paths are unit-testable. Failures are the same taxonomy sync
// uses — a leaderboard that is unreachable must read to the player exactly
// like a profile that is unreachable.

import { apiRequest, defaultFetch } from './sync.js';
import type { SyncCredentials, SyncDeps, SyncResult } from './sync.js';
import { readRecord, writeRecord } from './storage.js';
import type { KeyValueStorage } from './storage.js';

export const LEADERBOARD_STORAGE_KEY = 'mahjong.leaderboard.v1';

const BASE = '/api/leaderboard/weekly';

/** One row on the board. `rank` is the server's, never recomputed here: two
 *  players on the same score are separated by who got there first, which the
 *  client has no way to know. */
export interface BoardEntry {
  readonly rank: number;
  readonly playerId: string;
  readonly name: string;
  readonly avatar: string;
  /** Score accumulated across the week, not a single run's. */
  readonly score: number;
  /** How many clears went into it. */
  readonly runs: number;
}

export interface WeeklyBoard {
  /** The Sunday that opened this week, `YYYY-MM-DD` UTC. */
  readonly weekStart: string;
  /** When the week ends and the board empties, in epoch ms on the server's
   *  clock. The panel counts down to this rather than to a locally computed
   *  boundary, so every player watches the same instant. */
  readonly resetsAt: number;
  /** The leading entries, best first. */
  readonly top: readonly BoardEntry[];
  /** This player's own standing, or null when they have not scored this week. */
  readonly you: BoardEntry | null;
  /** The entries around this player, including their own — empty when they
   *  are already visible in `top`, or have no standing. */
  readonly around: readonly BoardEntry[];
}

// --- the opt-in ----------------------------------------------------------------

/** Whether the player has agreed to appear on the board. Off unless the
 *  stored record says otherwise: anything unreadable means "not asked". */
export function readOptIn(storage: KeyValueStorage | undefined): boolean {
  const record = readRecord(storage, LEADERBOARD_STORAGE_KEY);
  return typeof record === 'object' && record !== null
    ? (record as Record<string, unknown>)['optIn'] === true
    : false;
}

export function writeOptIn(storage: KeyValueStorage | undefined, optIn: boolean): void {
  writeRecord(storage, LEADERBOARD_STORAGE_KEY, { optIn });
}

// --- the endpoint ----------------------------------------------------------------

function isEntry(value: unknown): value is BoardEntry {
  if (typeof value !== 'object' || value === null) return false;
  const raw = value as Record<string, unknown>;
  return (
    typeof raw['rank'] === 'number' &&
    typeof raw['playerId'] === 'string' &&
    typeof raw['name'] === 'string' &&
    typeof raw['avatar'] === 'string' &&
    typeof raw['score'] === 'number' &&
    typeof raw['runs'] === 'number'
  );
}

function entries(value: unknown): readonly BoardEntry[] | null {
  if (!Array.isArray(value)) return null;
  return value.every(isEntry) ? (value as BoardEntry[]) : null;
}

/** A board out of a response body, field by field — a server that answers
 *  something unexpected must not reach the renderer. */
function toBoard(value: unknown): WeeklyBoard | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw['weekStart'] !== 'string') return null;
  // A countdown is the one thing on this panel that keeps moving, so a missing
  // or nonsense reset instant has to fail the whole board rather than render as
  // NaN or as a week that has already ended.
  if (typeof raw['resetsAt'] !== 'number' || !Number.isFinite(raw['resetsAt'])) return null;
  const top = entries(raw['top']);
  const around = entries(raw['around']);
  if (top === null || around === null) return null;
  const you = raw['you'];
  if (you !== null && you !== undefined && !isEntry(you)) return null;
  return {
    weekStart: raw['weekStart'],
    resetsAt: raw['resetsAt'],
    top,
    you: isEntry(you) ? you : null,
    around,
  };
}

function boardResult(result: SyncResult<unknown>): SyncResult<WeeklyBoard> {
  if (!result.ok) return result;
  const board = toBoard(result.value);
  return board === null ? { ok: false, reason: 'unavailable' } : { ok: true, value: board };
}

/**
 * The move history, trimmed to what a replay actually needs.
 *
 * A `MoveRecord` also carries `prevSelection` and `prevScores` — undo
 * bookkeeping that nothing replays (see core's moves.ts). Sending them makes
 * a finished run's history about 23 KB; without them it is a fraction of
 * that, and it is stored on every row of every board, so the difference is
 * the storage bill rather than a nicety.
 */
export function compactHistory(moves: readonly Record<string, unknown>[]): unknown[] {
  return moves.map((move) => {
    const { prevSelection, prevScores, ...rest } = move;
    void prevSelection;
    void prevScores;
    return rest;
  });
}

/** What a finished ladder level has to say about itself. No week: the server
 *  decides which one the run lands in, from the moment it arrives. */
export interface RunResult {
  readonly score: number;
  readonly elapsedMs: number;
  /** The move history, sent so a later build can verify the score by
   *  replaying it (the server stores it and does not read it today). */
  readonly history?: unknown;
}

/** Post a finished ladder level and take back the standing it added to. */
export async function submitRunScore(
  credentials: SyncCredentials,
  result: RunResult,
  deps: SyncDeps = {},
): Promise<SyncResult<WeeklyBoard>> {
  return boardResult(
    await apiRequest({
      fetchImpl: deps.fetchImpl ?? defaultFetch,
      path: BASE,
      method: 'POST',
      code: credentials.code,
      body: result,
    }),
  );
}

/** Read the live week's board. There is no parameter and no archive: only the
 *  current week exists to ask for. Credentials are optional — without them the
 *  board comes back without a "you" row, which is what a player who has not
 *  turned sync on should see. */
export async function fetchWeeklyBoard(
  credentials: SyncCredentials | null,
  deps: SyncDeps = {},
): Promise<SyncResult<WeeklyBoard>> {
  return boardResult(
    await apiRequest({
      fetchImpl: deps.fetchImpl ?? defaultFetch,
      path: BASE,
      method: 'GET',
      ...(credentials === null ? {} : { code: credentials.code }),
    }),
  );
}

/** Take the player off the board — every week and every stored run. */
export async function withdrawFromBoard(
  credentials: SyncCredentials,
  deps: SyncDeps = {},
): Promise<SyncResult<null>> {
  const result = await apiRequest({
    fetchImpl: deps.fetchImpl ?? defaultFetch,
    path: BASE,
    method: 'DELETE',
    code: credentials.code,
  });
  return result.ok ? { ok: true, value: null } : result;
}

// --- rendering helpers ----------------------------------------------------------

/**
 * "Resets in 2d 14h", tightening as the boundary approaches (issue #176).
 *
 * Two units at most, and never a unit that is always zero next to a bigger
 * one: days and hours far out, hours and minutes inside a day, minutes and
 * seconds in the last hour, seconds alone at the end. A countdown that reads
 * "2d 14h 03m 11s" invites watching the seconds tick on something a week away.
 */
export function formatResetCountdown(msLeft: number): string {
  const total = Math.max(0, Math.floor(msLeft / 1000));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/** The same countdown said in full, for a screen reader: "2 days, 14 hours". */
export function speakResetCountdown(msLeft: number): string {
  const total = Math.max(0, Math.floor(msLeft / 1000));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const unit = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
  if (days > 0) return `${unit(days, 'day')}, ${unit(hours, 'hour')}`;
  if (hours > 0) return `${unit(hours, 'hour')}, ${unit(minutes, 'minute')}`;
  if (minutes > 0) return `${unit(minutes, 'minute')}, ${unit(seconds, 'second')}`;
  return unit(seconds, 'second');
}

/**
 * The rows to draw, in order: the leading entries, then — when the player is
 * further down — their neighbourhood, with a marker saying the two are not
 * adjacent. Returning one list keeps the gap out of the DOM code, which
 * otherwise has to know when the two halves touch.
 */
export type BoardRow = { readonly kind: 'entry'; readonly entry: BoardEntry } | { readonly kind: 'gap' };

export function boardRows(board: WeeklyBoard): readonly BoardRow[] {
  const rows: BoardRow[] = board.top.map((entry) => ({ kind: 'entry', entry }) as const);
  if (board.around.length === 0) return rows;
  const lastTopRank = board.top.length === 0 ? 0 : board.top[board.top.length - 1]!.rank;
  // Only a real break gets a marker: an eleventh-placed player's
  // neighbourhood starts at rank 8, which overlaps the top ten rather than
  // sitting below it.
  const fresh = board.around.filter((entry) => entry.rank > lastTopRank);
  if (fresh.length === 0) return rows;
  if (fresh[0]!.rank > lastTopRank + 1) rows.push({ kind: 'gap' });
  rows.push(...fresh.map((entry) => ({ kind: 'entry', entry }) as const));
  return rows;
}
