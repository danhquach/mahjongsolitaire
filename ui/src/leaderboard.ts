// Daily Challenge leaderboard, device side (issue #70).
//
// The Daily is the same layout and seed for everyone on a given date, which
// is the only reason comparing scores is fair — see
// docs/decisions/0022-daily-leaderboard-first.md for why the ladder and an
// all-time board are not here.
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

const BASE = '/api/leaderboard/daily';

/** One row on the board. `rank` is the server's, never recomputed here: two
 *  players on the same score are separated by who got there first, which the
 *  client has no way to know. */
export interface BoardEntry {
  readonly rank: number;
  readonly playerId: string;
  readonly name: string;
  readonly avatar: string;
  readonly score: number;
  readonly elapsedMs: number;
}

export interface DailyBoard {
  readonly date: string;
  /** The leading entries, best first. */
  readonly top: readonly BoardEntry[];
  /** This player's own entry, or null when they have not posted for the date. */
  readonly you: BoardEntry | null;
  /** The entries around this player, including their own — empty when they
   *  are already visible in `top`, or have no entry. */
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
    typeof raw['elapsedMs'] === 'number'
  );
}

function entries(value: unknown): readonly BoardEntry[] | null {
  if (!Array.isArray(value)) return null;
  return value.every(isEntry) ? (value as BoardEntry[]) : null;
}

/** A board out of a response body, field by field — a server that answers
 *  something unexpected must not reach the renderer. */
function toBoard(value: unknown): DailyBoard | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw['date'] !== 'string') return null;
  const top = entries(raw['top']);
  const around = entries(raw['around']);
  if (top === null || around === null) return null;
  const you = raw['you'];
  if (you !== null && you !== undefined && !isEntry(you)) return null;
  return { date: raw['date'], top, you: isEntry(you) ? you : null, around };
}

function boardResult(result: SyncResult<unknown>): SyncResult<DailyBoard> {
  if (!result.ok) return result;
  const board = toBoard(result.value);
  return board === null ? { ok: false, reason: 'unavailable' } : { ok: true, value: board };
}

/**
 * The move history, trimmed to what a replay actually needs.
 *
 * A `MoveRecord` also carries `prevSelection` and `prevScores` — undo
 * bookkeeping that nothing replays (see core's moves.ts). Sending them makes
 * a finished Daily's history about 23 KB; without them it is a fraction of
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

/** What a finished Daily has to say about itself. */
export interface DailyResult {
  readonly date: string;
  readonly score: number;
  readonly elapsedMs: number;
  /** The move history, sent so a later build can verify the score by
   *  replaying it (the server stores it and does not read it today). */
  readonly history?: unknown;
}

/** Post a Daily result and take back the board it landed on. */
export async function submitDailyScore(
  credentials: SyncCredentials,
  result: DailyResult,
  deps: SyncDeps = {},
): Promise<SyncResult<DailyBoard>> {
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

/** Read a date's board. Credentials are optional — without them the board
 *  comes back without a "you" row, which is what a player who has not turned
 *  sync on should see. */
export async function fetchDailyBoard(
  date: string,
  credentials: SyncCredentials | null,
  deps: SyncDeps = {},
): Promise<SyncResult<DailyBoard>> {
  return boardResult(
    await apiRequest({
      fetchImpl: deps.fetchImpl ?? defaultFetch,
      path: `${BASE}?date=${encodeURIComponent(date)}`,
      method: 'GET',
      ...(credentials === null ? {} : { code: credentials.code }),
    }),
  );
}

/** Take the player off the board — every date, not just today's. */
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

/** `4:07` — the same shape as the in-game clock, for the board's time column. */
export function formatBoardTime(elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * The rows to draw, in order: the leading entries, then — when the player is
 * further down — their neighbourhood, with a marker saying the two are not
 * adjacent. Returning one list keeps the gap out of the DOM code, which
 * otherwise has to know when the two halves touch.
 */
export type BoardRow = { readonly kind: 'entry'; readonly entry: BoardEntry } | { readonly kind: 'gap' };

export function boardRows(board: DailyBoard): readonly BoardRow[] {
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
