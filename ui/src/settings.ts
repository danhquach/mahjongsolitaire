// Player settings (issue #14, spec §7). Six independent preferences, each
// persisted the moment it changes so the settings screen needs no Save button:
//
//   audio        gentle sound effects  — default ON (§7)
//   haptics      gentle vibration      — default ON, independent of audio (§7)
//   tileSize     S / M / L / XL        — default XL (§1.2/§7: oversized tiles)
//   timedMode    opt-in elapsed clock  — default OFF (§6: no timer pressure)
//   ads          ads master toggle     — default OFF (§8, decision 0004, #3)
//   highlightFree dim the blocked tiles — default OFF (issue #45)
//
// Nothing reads `ads` yet: ads are suspended for v1.0 and issue #20 gates the
// ad-SDK init on this toggle in Phase 4. It ships now so the settings screen
// lands once (ROADMAP Phase 2 deliverables).
//
// A stored value is honoured only when it is the right shape — an unknown tile
// size or a non-boolean falls back to that field's default rather than
// discarding the whole record.

import { readRecord, writeRecord } from './storage.js';
import type { KeyValueStorage } from './storage.js';

export type TileSize = 's' | 'm' | 'l' | 'xl';

export const TILE_SIZES: readonly TileSize[] = ['s', 'm', 'l', 'xl'];

/**
 * Tile size as a fraction of the fit-to-viewport scale (PM decision,
 * 2026-08-31): the board already fits the screen, so XL *is* the largest the
 * viewport allows and the smaller steps scale down from it. Zooming past the
 * fit would need a pan gesture; issue #37 chose the HUD edge that makes the fit
 * as large as it can be instead, and left pan/zoom unbuilt.
 */
export const TILE_SIZE_FACTOR: Record<TileSize, number> = {
  s: 0.64,
  m: 0.76,
  l: 0.88,
  xl: 1,
};

/** Human-readable names for the settings screen and announcements. */
export const TILE_SIZE_LABEL: Record<TileSize, string> = {
  s: 'Small',
  m: 'Medium',
  l: 'Large',
  xl: 'Extra large',
};

export interface Settings {
  readonly audio: boolean;
  readonly haptics: boolean;
  readonly tileSize: TileSize;
  readonly timedMode: boolean;
  readonly ads: boolean;
  /**
   * Shade blocked tiles one depth step further back so the free ones are the
   * bright tiles (issue #45 item 5). Default OFF: the drop shadow, side
   * shading and per-layer value shift are meant to make the stack readable on
   * their own, and dimming half the board is a strong enough change that it
   * should be the player's choice, not ours. Doubles as an accessibility aid
   * for players who cannot resolve the depth cues.
   */
  readonly highlightFree: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  audio: true,
  haptics: true,
  tileSize: 'xl',
  timedMode: false,
  ads: false,
  highlightFree: false,
};

export const SETTINGS_STORAGE_KEY = 'mahjong.settings.v1';

function isTileSize(value: unknown): value is TileSize {
  return typeof value === 'string' && (TILE_SIZES as readonly string[]).includes(value);
}

/** Per-field validation: a bad field falls back, a bad record starts fresh. */
export function parseSettings(record: unknown): Settings {
  if (typeof record !== 'object' || record === null) return DEFAULT_SETTINGS;
  const raw = record as Record<string, unknown>;
  const bool = (key: 'audio' | 'haptics' | 'timedMode' | 'ads' | 'highlightFree'): boolean =>
    typeof raw[key] === 'boolean' ? (raw[key] as boolean) : DEFAULT_SETTINGS[key];
  return {
    audio: bool('audio'),
    haptics: bool('haptics'),
    tileSize: isTileSize(raw['tileSize']) ? raw['tileSize'] : DEFAULT_SETTINGS.tileSize,
    timedMode: bool('timedMode'),
    ads: bool('ads'),
    highlightFree: bool('highlightFree'),
  };
}

/** Current settings, persisted on every change. */
export class SettingsStore {
  private current: Settings;

  constructor(
    private readonly storage: KeyValueStorage | undefined = undefined,
    private readonly key: string = SETTINGS_STORAGE_KEY,
  ) {
    this.current = parseSettings(readRecord(storage, key));
  }

  get value(): Settings {
    return this.current;
  }

  /** Change one preference. Returns whether it actually changed. */
  set<K extends keyof Settings>(key: K, value: Settings[K]): boolean {
    if (this.current[key] === value) return false;
    this.current = { ...this.current, [key]: value };
    writeRecord(this.storage, this.key, this.current);
    return true;
  }
}
