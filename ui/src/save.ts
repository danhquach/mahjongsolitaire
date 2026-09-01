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
// ## Version 2 (issue #43)
//
// The holder made the record a different shape: a move is no longer always a
// pair (hold and unhold were both moves), and the holder's own contents ride
// alongside the faces and removed flags. Version 2 was a clean break rather
// than a shim that reads a v1 record with defaults — this file's whole job is
// to vouch for what it returns, and "assume the fields I cannot see mean
// nothing" is the one thing it must not do.
//
// ## Version 3 (issue #63)
//
// Decision 0009 made the holder one-way, which deletes the `unhold` move type
// outright. A v2 record can carry one; this build has nothing that could replay
// it, and quietly dropping the record would leave an undo stack that no longer
// walks back to a pristine deal. So the version goes up and a v2 record reads
// as absent — the same clean break, for the same reason.
//
// A record whose holder is *full* is not rejected, and must not be: that is a
// lost level, and issue #63 is explicit that a reload cannot be an escape hatch
// from one. It resumes, and `Game.status()` says `lost` on the first frame.
//
// An unreadable record of any version reads as absent, which this module
// already has a defined answer for: a fresh deal.
//
// ## Trust boundary
//
// `parseSave` is the only place untrusted data enters the game. It validates
// every field and every cross-field relationship it can afford to, and returns
// null on anything it cannot vouch for; `reopen` then adds the checks that need
// the regenerated deal. A rejected save means a fresh deal, never a crash — a
// record from an older build, a hand-edited one, or a layout that has since
// changed all land there.

import { HOLDER_SLOTS, generateValidatedLevel } from '@mahjongsolitaire/core';
import type { Layout, MoveRecord, ScoreSnapshot, TileId } from '@mahjongsolitaire/core';
import { Game } from './game.js';
import type { GameSnapshot } from './game.js';
import { clearRecord, readRecord, writeRecord } from './storage.js';
import type { KeyValueStorage } from './storage.js';

export const SAVE_VERSION = 3;
/** The slot key is deliberately *not* versioned with the record: the `version`
 *  field inside is what decides whether a record can be trusted, and renaming
 *  the key would only orphan the old bytes instead of overwriting them. */
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

/** A holder slot index, or null for "came off the board". */
function isSlotIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < HOLDER_SLOTS;
}

/**
 * Undo records, oldest first: well-formed per kind, matched ids each claimed
 * once, timestamps non-decreasing (the ScoreKeeper rejects a backwards clock,
 * so a save carrying one is corrupt).
 *
 * Only the shape of one record is decided here. Whether the records *fit each
 * other* — that every undo in the chain is one the board and holder can
 * actually perform — is checkUndoChain's job below.
 */
function parseMoves(value: unknown): MoveRecord[] | null {
  if (!Array.isArray(value)) return null;
  const moves: MoveRecord[] = [];
  const claimed = new Set<number>();
  let lastMs = -Infinity;
  for (const raw of value) {
    if (!isRecord(raw)) return null;
    const { kind, atMs, prevSelection } = raw;
    const prevScores = parseScores(raw['prevScores']);
    if (!isMs(atMs) || atMs < lastMs) return null;
    if (prevSelection !== null && !isCount(prevSelection)) return null;
    if (prevScores === null) return null;
    const base = { atMs, prevSelection: prevSelection as TileId | null, prevScores };
    lastMs = atMs;
    if (kind === 'match') {
      const { a, b, heldA, heldB } = raw;
      if (!isCount(a) || !isCount(b) || a === b) return null;
      // No tile may be claimed by two matches: undoing the second one would
      // call Board.restore on a tile that is already back, which throws.
      if (claimed.has(a) || claimed.has(b)) return null;
      if (heldA !== null && !isSlotIndex(heldA)) return null;
      if (heldB !== null && !isSlotIndex(heldB)) return null;
      claimed.add(a);
      claimed.add(b);
      moves.push({
        ...base,
        kind: 'match',
        a,
        b,
        heldA: heldA as number | null,
        heldB: heldB as number | null,
      });
    } else if (kind === 'hold') {
      const { tile, slotIndex } = raw;
      if (!isCount(tile) || !isSlotIndex(slotIndex)) return null;
      moves.push({ ...base, kind, tile, slotIndex });
    } else {
      // An unknown kind, or `unhold` from a v2 record — a move this build has
      // no way to replay (decision 0009). The version check above catches a
      // whole v2 record first; this is the belt and braces.
      return null;
    }
  }
  return moves;
}

/** Holder occupancy: within capacity, known-looking ids, no id in two slots. */
function parseHolder(value: unknown): (TileId | null)[] | null {
  if (!Array.isArray(value) || value.length > HOLDER_SLOTS) return null;
  const held = new Set<number>();
  const slots: (TileId | null)[] = [];
  for (const raw of value) {
    if (raw === null) {
      slots.push(null);
      continue;
    }
    if (!isCount(raw) || held.has(raw)) return null;
    held.add(raw);
    slots.push(raw);
  }
  // Normalise the length rather than honouring it. An honest capture always
  // writes one entry per slot, and Board takes its capacity from this array
  // when it is not told otherwise — so a record with two entries would quietly
  // hand the player a two-slot holder for the rest of the level.
  while (slots.length < HOLDER_SLOTS) slots.push(null);
  return slots;
}

/**
 * Walk the undo stack backwards and check every step is one the game could
 * actually take, ending at a pristine deal — nothing removed, holder empty.
 * Two kinds since decision 0009: a match and a hold.
 *
 * This is the check that makes the record safe to *play*, not just to load.
 * Reopening a save only replays the state, so an incoherent stack loads fine
 * and then throws several undos later, out of a click handler: a match whose
 * tiles are not currently removed, a hold record for a tile that is not in that
 * slot, a match claiming a slot something else is sitting in. Each of those is
 * a throw from Board, and each is unreachable for an honest capture.
 *
 * Reaching the empty start state also *is* the older "moves must partition
 * `removed`" rule: every removal is accounted for by exactly one match, and
 * every match by two removals, or the walk does not end clean.
 *
 * What this does *not* check, because it cannot: whether the ids are ids this
 * deal has. That falls to `applySnapshot` in game.ts (unknown removed id) and
 * to Board's constructor (unknown or removed id in a holder slot), and
 * `reopen` turns either throw into "no save". The three together are what makes
 * a parsed record safe to play — change one and re-read the other two.
 */
function checkUndoChain(
  removed: readonly TileId[],
  holder: readonly (TileId | null)[],
  moves: readonly MoveRecord[],
): boolean {
  const gone = new Set<TileId>(removed);
  const slots: (TileId | null)[] = [...holder];
  for (let i = moves.length - 1; i >= 0; i--) {
    const move = moves[i]!;
    if (move.kind === 'match') {
      if (!gone.delete(move.a) || !gone.delete(move.b)) return false;
      for (const [id, slot] of [
        [move.a, move.heldA],
        [move.b, move.heldB],
      ] as const) {
        if (slot === null) continue;
        if (slot >= slots.length || slots[slot] !== null) return false;
        slots[slot] = id;
      }
    } else {
      if (move.slotIndex >= slots.length || slots[move.slotIndex] !== move.tile) return false;
      slots[move.slotIndex] = null;
    }
  }
  return gone.size === 0 && slots.every((s) => s === null);
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
  const holder = parseHolder(value['holder']);
  if (holder === null) return null;
  if (!isRecord(stack)) return null;
  const moves = parseMoves(stack['moves']);
  const scores = parseScores(stack['scores']);
  const selection = stack['selection'];
  if (moves === null || scores === null) return null;
  if (selection !== null && !isCount(selection)) return null;
  // A held tile is still in play, so it cannot also be removed.
  const removedSet = new Set(removed as number[]);
  if (holder.some((id) => id !== null && removedSet.has(id))) return null;
  // …and the whole undo stack has to be one the board and holder can walk back.
  if (!checkUndoChain(removed as TileId[], holder, moves)) return null;
  return {
    faces: faces as string[],
    removed: removed as TileId[],
    holder,
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
  // The clock must not run behind the game it is resuming. main.ts continues
  // play at `elapsedMs`, and core's ScoreKeeper rejects a timestamp earlier
  // than the last match it recorded — so a record whose elapsed time predates
  // its own last match would reject *every* match after the resume, silently
  // and for as long as it took real play to catch up. An honest capture cannot
  // produce one (see captureSave), so such a record is corrupt.
  const latestMs = Math.max(
    snapshot.stack.scores.lastMatchMs ?? 0,
    ...snapshot.stack.moves.map((m) => m.atMs),
  );
  if (elapsedMs < latestMs) return null;
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
