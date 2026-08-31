// Auto-save + resume (issue #14, spec §7 "Auto-save on every move; resume
// mid-level after force-quit").
//
// ## Why a state snapshot and not a move list
//
// Spec §9 sketches the save as `(seed, moves: [[12,88],…], score)` — replay the
// moves to rebuild the board. That cannot express this game: Shuffle permutes
// the faces of the tiles *present at that moment*, and Undo can then restore a
// pair the shuffle never saw. Replaying `[m1, shuffle]` shuffles a board that
// still holds m2's tiles and lands on different faces than the live board did.
// Move timestamps are missing from the sketch too, and the §6 combo ladder is a
// function of them. So the record here is the state itself: faces and removed
// flags per tile, plus the undo stack (whose records carry each move's
// timestamp and the score state before it). Deal geometry still comes from
// `(layoutId, seed)` — see decision 0007.
//
// ## Trust boundary
//
// `parseSave` is the only place untrusted data enters the game. It validates
// every field and every cross-field relationship it can afford to, and returns
// null on anything it cannot vouch for; `reopen` then adds the checks that need
// the regenerated deal. A rejected save means a fresh deal, never a crash — a
// record from an older build, a hand-edited one, or a layout that has since
// changed all land there.

import { generateValidatedLevel } from '@mahjongsolitaire/core';
import type { Layout, MoveRecord, ScoreSnapshot, TileId } from '@mahjongsolitaire/core';
import { Game } from './game.js';
import type { GameSnapshot } from './game.js';
import { clearRecord, readRecord, writeRecord } from './storage.js';
import type { KeyValueStorage } from './storage.js';

export const SAVE_VERSION = 1;
export const SAVE_STORAGE_KEY = 'mahjong.save.v1';

/** One level in progress. `shuffles` keeps the Shuffle booster's seed sequence
 *  going across a resume, so a resumed deal shuffles the same way it would
 *  have; `elapsedMs` feeds timed mode (spec §9 field of the same name). */
export interface SaveState {
  readonly version: number;
  readonly layoutId: string;
  readonly seed: number;
  readonly shuffles: number;
  readonly elapsedMs: number;
  readonly snapshot: GameSnapshot;
}

/** Everything about the session that is not the Game itself. */
export interface SaveContext {
  readonly shuffles: number;
  readonly elapsedMs: number;
}

/** Capture the current game. Cheap enough to call on every move (144 faces). */
export function captureSave(game: Game, context: SaveContext): SaveState {
  return {
    version: SAVE_VERSION,
    layoutId: game.level.layoutId,
    seed: game.level.seed,
    shuffles: context.shuffles,
    elapsedMs: context.elapsedMs,
    snapshot: game.snapshot(),
  };
}

// --- validation ---------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isMs(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function parseScores(value: unknown): ScoreSnapshot | null {
  if (!isRecord(value)) return null;
  const { score, streak, lastMatchMs } = value;
  if (!isCount(score) || !isCount(streak)) return null;
  if (lastMatchMs !== null && !isMs(lastMatchMs)) return null;
  return { score, streak, lastMatchMs: lastMatchMs as number | null };
}

/** Undo records, oldest first: ids present, timestamps non-decreasing (the
 *  ScoreKeeper rejects a backwards clock, so a save carrying one is corrupt). */
function parseMoves(value: unknown): MoveRecord[] | null {
  if (!Array.isArray(value)) return null;
  const moves: MoveRecord[] = [];
  let lastMs = -Infinity;
  for (const raw of value) {
    if (!isRecord(raw)) return null;
    const { a, b, atMs, prevSelection } = raw;
    const prevScores = parseScores(raw['prevScores']);
    if (!isCount(a) || !isCount(b) || a === b) return null;
    if (!isMs(atMs) || atMs < lastMs) return null;
    if (prevSelection !== null && !isCount(prevSelection)) return null;
    if (prevScores === null) return null;
    lastMs = atMs;
    moves.push({ a, b, atMs, prevSelection: prevSelection as TileId | null, prevScores });
  }
  return moves;
}

function parseSnapshot(value: unknown): GameSnapshot | null {
  if (!isRecord(value)) return null;
  const { faces, removed, stack } = value;
  if (!Array.isArray(faces) || faces.length === 0) return null;
  if (!faces.every((f) => typeof f === 'string' && f.length > 0)) return null;
  if (!Array.isArray(removed) || !removed.every(isCount)) return null;
  // Ascending and duplicate-free — `snapshot()` writes them that way, and a
  // repeated id would restore one tile of a pair twice.
  if (removed.some((id, i) => i > 0 && id <= (removed[i - 1] as number))) return null;
  if (!isRecord(stack)) return null;
  const moves = parseMoves(stack['moves']);
  const scores = parseScores(stack['scores']);
  const selection = stack['selection'];
  if (moves === null || scores === null) return null;
  if (selection !== null && !isCount(selection)) return null;
  // Every removal is the trace of exactly one played move.
  if (removed.length !== moves.length * 2) return null;
  const removedSet = new Set(removed as number[]);
  if (moves.some((m) => !removedSet.has(m.a) || !removedSet.has(m.b))) return null;
  return {
    faces: faces as string[],
    removed: removed as TileId[],
    stack: { moves, selection: selection as TileId | null, scores },
  };
}

/** A validated save, or null if the record cannot be trusted. */
export function parseSave(record: unknown): SaveState | null {
  if (!isRecord(record)) return null;
  const { version, layoutId, seed, shuffles, elapsedMs } = record;
  if (version !== SAVE_VERSION) return null;
  if (typeof layoutId !== 'string' || layoutId.length === 0) return null;
  // Not capped at 2^32: a deal reseeded near the ceiling (generateValidatedLevel
  // tries seed+1, seed+2, …) legitimately carries a larger seed.
  if (!isCount(seed) || !Number.isSafeInteger(seed)) return null;
  if (!isCount(shuffles) || !isMs(elapsedMs)) return null;
  const snapshot = parseSnapshot(record['snapshot']);
  if (snapshot === null) return null;
  return { version, layoutId, seed, shuffles, elapsedMs, snapshot };
}

// --- resume -------------------------------------------------------------------

/**
 * Rebuild the saved game on `layout`, or null when it does not belong there:
 * a different layout, a seed that no longer regenerates the same deal, or a
 * snapshot the deal rejects (wrong tile count, unknown id, unselectable
 * selection). The deal is regenerated rather than stored — `(layoutId, seed)`
 * reproduces it exactly (spec §9 key invariant), and the validating generator
 * confirms the seed still validates on this build.
 */
export function reopen(layout: Layout, save: SaveState): Game | null {
  if (layout.id !== save.layoutId) return null;
  try {
    const level = generateValidatedLevel(layout, save.seed);
    // A reseeded deal is a different deal: the save's tile ids and faces belong
    // to the seed that validated when it was written.
    if (level.seed !== save.seed) return null;
    return new Game(level, save.snapshot);
  } catch {
    return null;
  }
}

// --- storage ------------------------------------------------------------------

/** The one save slot (spec §7 is per-level resume, not a save-game library). */
export class SaveStore {
  constructor(
    private readonly storage: KeyValueStorage | undefined = undefined,
    private readonly key: string = SAVE_STORAGE_KEY,
  ) {}

  /** The stored save, or null when there is none to trust. */
  load(): SaveState | null {
    return parseSave(readRecord(this.storage, this.key));
  }

  write(save: SaveState): void {
    writeRecord(this.storage, this.key, save);
  }

  /** Drop the save — the level ended, so there is nothing to resume into. */
  clear(): void {
    clearRecord(this.storage, this.key);
  }
}
