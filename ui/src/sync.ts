// Profile sync (issue #138): the device's half of the server-held profile.
//
// The local profile (profile.ts) stays the source of truth while you play —
// nothing here is on the path to starting, saving or finishing a level, and
// the game is exactly as playable with sync off, offline, or with the
// endpoint down. Turning sync on registers the *existing* local profile with
// the Worker (worker/profile.mjs), which mints a public player id and a
// one-time recovery code; from then on each sync pushes the local record up
// and merges the server's back down.
//
// No DOM here (main.ts owns the panel), and `fetch` and the clock arrive as
// arguments, so every path — including the failure paths, which are most of
// them — is unit-testable.
//
// What is stored on the device: the recovery code. It is the only credential,
// so treat it like a session token — it is never logged, and the only place
// it is shown is the player's own profile panel, deliberately, because it is
// the only way back into the profile after a reinstall.

import { readRecord, writeRecord, clearRecord } from './storage.js';
import type { KeyValueStorage } from './storage.js';
import type { PlayerRecord } from './profile.js';
import { parsePlayerRecord } from './profile.js';

export const SYNC_STORAGE_KEY = 'mahjong.sync.v1';

/** What the device keeps once sync is on. */
export interface SyncCredentials {
  /** The public tag shown beside a display name (`Alex #7K3MQ2R9WD`). */
  readonly playerId: string;
  /** The recovery code, formatted as the player sees it. */
  readonly code: string;
}

/** The server's view of the player, as every route returns it. */
export interface RemoteProfile {
  readonly playerId: string;
  readonly name: string;
  readonly avatar: string;
  readonly record: PlayerRecord;
}

/**
 * Why a call did not produce a profile. Every one of these leaves the local
 * profile untouched — the caller shows a message and the player keeps playing.
 *
 *   `offline`      the request never completed (no network, endpoint down)
 *   `unavailable`  the endpoint answered, but sync is not configured/working
 *   `unauthorized` the code is not (or is no longer) a profile
 *   `name_rejected` the display name cannot be shown publicly
 *   `rate_limited` too many attempts from here; try later
 */
export type SyncFailure =
  | 'offline'
  | 'unavailable'
  | 'unauthorized'
  | 'name_rejected'
  | 'rate_limited';

export type SyncResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: SyncFailure };

/** A registration hands back the credentials as well as the profile. */
export interface Registration {
  readonly credentials: SyncCredentials;
  readonly profile: RemoteProfile;
}

function isCredentials(value: unknown): value is SyncCredentials {
  if (typeof value !== 'object' || value === null) return false;
  const raw = value as Record<string, unknown>;
  return typeof raw['playerId'] === 'string' && typeof raw['code'] === 'string';
}

/** The stored credentials, or null when sync has never been turned on (or the
 *  record is unreadable, which is treated the same way — sync off). */
export function readCredentials(storage: KeyValueStorage | undefined): SyncCredentials | null {
  const record = readRecord(storage, SYNC_STORAGE_KEY);
  return isCredentials(record) ? { playerId: record.playerId, code: record.code } : null;
}

export function writeCredentials(
  storage: KeyValueStorage | undefined,
  credentials: SyncCredentials,
): void {
  writeRecord(storage, SYNC_STORAGE_KEY, credentials);
}

/** Turn sync off on this device. The server profile is untouched — the code
 *  can be entered again here or anywhere else — so the confirmation the UI
 *  shows must say so. */
export function forgetCredentials(storage: KeyValueStorage | undefined): void {
  clearRecord(storage, SYNC_STORAGE_KEY);
}

/** A player id as it reads next to a name. */
export function formatPlayerTag(playerId: string): string {
  return `#${playerId}`;
}

/**
 * A code the player typed, in the form the server compares: upper-cased,
 * separators dropped, and the Crockford substitutions applied (I/L → 1,
 * O → 0). Returns null when what is left is not a code — the panel can then
 * say so without a round trip.
 *
 * The server normalizes again on every request; this exists so the code the
 * panel *stores and shows* afterwards is the canonical one, rather than
 * however it happened to be typed.
 */
export function normalizeCode(raw: string): string | null {
  const cleaned = raw
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0');
  // 24 symbols of Crockford base32 — the alphabet and length the Worker mints
  // (worker/profile.mjs), with I, L, O and U absent by construction.
  return /^[0-9A-HJKMNP-TV-Z]{24}$/.test(cleaned) ? cleaned : null;
}

/** A code as the player sees it: groups of four. */
export function formatCode(code: string): string {
  return (code.match(/.{1,4}/g) ?? []).join('-');
}

// --- the endpoint --------------------------------------------------------------

/** Same-origin, like the feedback endpoint: the Worker serves the bundle. */
const BASE = '/api/profile';

/** `fetch` must keep its receiver: a browser throws "Illegal invocation" when
 *  the global is called through a bare reference, which is exactly what a
 *  `deps.fetchImpl ?? fetch` default does. Node does not care, so this only
 *  ever showed up in a real browser. */
const boundFetch: typeof fetch = (...args) => globalThis.fetch(...args);

/** Long enough for a cold Worker plus a D1 round trip, short enough that a
 *  dead endpoint does not leave the panel spinning. */
const TIMEOUT_MS = 8000;

/** The bound global, for callers outside this module (leaderboard.ts). */
export const defaultFetch = boundFetch;

/** Map an endpoint status onto the reason the UI explains. A 4xx we did not
 *  name is a client bug, not something the player can act on — report it as
 *  `unavailable` rather than inventing a message per status code. */
function failureFor(status: number): SyncFailure {
  if (status === 401) return 'unauthorized';
  if (status === 422) return 'name_rejected';
  if (status === 429) return 'rate_limited';
  return 'unavailable';
}

export interface CallOptions {
  readonly fetchImpl: typeof fetch;
  readonly path: string;
  readonly method: 'GET' | 'POST' | 'DELETE';
  readonly code?: string;
  readonly body?: unknown;
}

/**
 * One request to the game's own API, with the failure taxonomy above applied.
 * Exported for leaderboard.ts (issue #70), which talks to the same Worker with
 * the same credential and must fail in exactly the same ways — a second copy
 * of this would be a second set of failure semantics for the player.
 */
export async function apiRequest(options: CallOptions): Promise<SyncResult<unknown>> {
  let response: Response;
  try {
    response = await options.fetchImpl(options.path, {
      method: options.method,
      headers: {
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(options.code === undefined ? {} : { Authorization: `Bearer ${options.code}` }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    // No network, a timeout, a blocked request: all the same to the player.
    return { ok: false, reason: 'offline' };
  }
  if (!response.ok) return { ok: false, reason: failureFor(response.status) };
  try {
    return { ok: true, value: await response.json() };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}

/** A profile out of a response body, re-validated: the record goes through
 *  the same `parsePlayerRecord` a stored one does, so a server that grows a
 *  field (or drops one) can never hand the game a malformed record. */
function toProfile(value: unknown): RemoteProfile | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = (value as Record<string, unknown>)['profile'];
  if (typeof raw !== 'object' || raw === null) return null;
  const profile = raw as Record<string, unknown>;
  if (typeof profile['playerId'] !== 'string' || profile['playerId'] === '') return null;
  if (typeof profile['name'] !== 'string' || typeof profile['avatar'] !== 'string') return null;
  return {
    playerId: profile['playerId'],
    name: profile['name'],
    avatar: profile['avatar'],
    record: parsePlayerRecord(profile['record']),
  };
}

function profileResult(result: SyncResult<unknown>): SyncResult<RemoteProfile> {
  if (!result.ok) return result;
  const profile = toProfile(result.value);
  return profile === null ? { ok: false, reason: 'unavailable' } : { ok: true, value: profile };
}

export interface SyncDeps {
  readonly fetchImpl?: typeof fetch;
}

/** Turn sync on: register this device's profile and record, and receive the
 *  player id and recovery code back. */
export async function registerProfile(
  input: { readonly name: string; readonly avatar: string; readonly record: PlayerRecord },
  deps: SyncDeps = {},
): Promise<SyncResult<Registration>> {
  const result = await apiRequest({
    fetchImpl: deps.fetchImpl ?? boundFetch,
    path: `${BASE}/register`,
    method: 'POST',
    body: input,
  });
  const profile = profileResult(result);
  if (!profile.ok) return profile;
  const body = result.ok ? (result.value as Record<string, unknown>) : {};
  const code = body['code'];
  if (typeof code !== 'string' || code === '') return { ok: false, reason: 'unavailable' };
  return {
    ok: true,
    value: {
      credentials: { playerId: profile.value.playerId, code },
      profile: profile.value,
    },
  };
}

/** Push this device's record up and take the merged one back. The name is not
 *  sent: it is screened, and a rejection has to reach the player rather than
 *  fail a background sync (see `pushName`). */
export async function pushRecord(
  credentials: SyncCredentials,
  input: { readonly avatar: string; readonly record: PlayerRecord },
  deps: SyncDeps = {},
): Promise<SyncResult<RemoteProfile>> {
  return profileResult(
    await apiRequest({
      fetchImpl: deps.fetchImpl ?? boundFetch,
      path: `${BASE}/sync`,
      method: 'POST',
      code: credentials.code,
      body: input,
    }),
  );
}

/** Publish a renamed profile. `name_rejected` means the name cannot be shown
 *  publicly — the local profile keeps it, the board does not get it. */
export async function pushName(
  credentials: SyncCredentials,
  name: string,
  deps: SyncDeps = {},
): Promise<SyncResult<RemoteProfile>> {
  return profileResult(
    await apiRequest({
      fetchImpl: deps.fetchImpl ?? boundFetch,
      path: `${BASE}/name`,
      method: 'POST',
      code: credentials.code,
      body: { name },
    }),
  );
}

/** Recover a profile on a new device (or after a reinstall) from its code. */
export async function fetchProfile(
  code: string,
  deps: SyncDeps = {},
): Promise<SyncResult<RemoteProfile>> {
  return profileResult(
    await apiRequest({ fetchImpl: deps.fetchImpl ?? boundFetch, path: BASE, method: 'GET', code }),
  );
}

// --- applying what came back ---------------------------------------------------

/**
 * Merge a server record into a local one, by the same never-regress rule the
 * server applies (worker/profile.mjs `mergeRecords`) — counters take the max,
 * cleared levels the union, and the streak follows the more recent anchor,
 * keeping the longer of the two when they are within a day of each other.
 *
 * Both sides run it because both sides need the answer: the server to store
 * it, the device to show it without waiting for a round trip it may never
 * get. Keep the two in step.
 */
export function mergeRecords(local: PlayerRecord, remote: PlayerRecord): PlayerRecord {
  const streak = ((): { dailyStreak: number; lastDaily: string | null } => {
    if (local.lastDaily === null) {
      return { dailyStreak: remote.dailyStreak, lastDaily: remote.lastDaily };
    }
    if (remote.lastDaily === null) {
      return { dailyStreak: local.dailyStreak, lastDaily: local.lastDaily };
    }
    const day = 24 * 60 * 60 * 1000;
    const gap = Math.abs(
      Math.round(
        (Date.parse(`${remote.lastDaily}T00:00:00Z`) - Date.parse(`${local.lastDaily}T00:00:00Z`)) /
          day,
      ),
    );
    const later = local.lastDaily >= remote.lastDaily ? local : remote;
    return {
      dailyStreak: gap <= 1 ? Math.max(local.dailyStreak, remote.dailyStreak) : later.dailyStreak,
      lastDaily: later.lastDaily,
    };
  })();
  return {
    levelsCleared: Math.max(local.levelsCleared, remote.levelsCleared),
    bestScore: Math.max(local.bestScore, remote.bestScore),
    totalScore: Math.max(local.totalScore, remote.totalScore),
    cleared: Array.from(new Set([...local.cleared, ...remote.cleared])).sort((a, b) => a - b),
    ...streak,
    trophies: Math.max(local.trophies, remote.trophies),
  };
}
