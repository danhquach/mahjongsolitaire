// Ladder progress (issue #79): which of the 150 ladder levels the player is
// on. One number, persisted on its own key — deliberately not inside the
// per-level save record: the save is dropped when a level is won or goes
// unreadable, and losing the resume must never lose the ladder position.

import { LADDER_LENGTH } from '@mahjongsolitaire/core';
import { readRecord, writeRecord } from './storage.js';
import type { KeyValueStorage } from './storage.js';

export const PROGRESS_STORAGE_KEY = 'mahjong.progress.v1';

/** The stored record, or level 1 for anything absent or malformed. */
function parseLevel(doc: unknown): number {
  if (typeof doc !== 'object' || doc === null) return 1;
  const level = (doc as Record<string, unknown>)['level'];
  if (typeof level !== 'number' || !Number.isInteger(level)) return 1;
  return Math.min(Math.max(level, 1), LADDER_LENGTH);
}

export class ProgressStore {
  private current: number;

  constructor(
    private readonly storage: KeyValueStorage | undefined = undefined,
    private readonly key = PROGRESS_STORAGE_KEY,
  ) {
    this.current = parseLevel(readRecord(storage, key));
  }

  /** The 1-based ladder level the player is on, 1..LADDER_LENGTH. */
  get level(): number {
    return this.current;
  }

  /** A level was cleared: move to the next, capped at the ladder's end (the
   *  last level replays until a post-v1 decision says otherwise). Persisted
   *  best-effort, like every other store here. */
  advance(): number {
    this.current = Math.min(this.current + 1, LADDER_LENGTH);
    writeRecord(this.storage, this.key, { level: this.current });
    return this.current;
  }
}
