// Layout = ordered slot list (spec §4: "Load layout geometry (ordered slot
// list)"). The 10 shipped layouts are JSON data files under /data/layouts
// (issue #17), loaded through parseLayout below; the three seed layouts here
// live in code only to gate the generator (issue #7 acceptance: 10,000 seeds ×
// 3 seed layouts) without a filesystem dependency.

import { Board, slotKey } from './board.js';
import type { Slot } from './board.js';

export interface Layout {
  readonly id: string;
  readonly slots: readonly Slot[];
}

function grid(xs: number[], ys: number[], z: number): Slot[] {
  const slots: Slot[] = [];
  for (const y of ys) for (const x of xs) slots.push({ x, y, z });
  return slots;
}

function range(from: number, count: number, step = 2): number[] {
  return Array.from({ length: count }, (_, i) => from + i * step);
}

/** 4×4 base with a 2×2 second layer — exercises the cover rule. 20 tiles. */
const PYRAMID: Layout = {
  id: 'seed-pyramid',
  slots: [...grid(range(0, 4), range(0, 4), 0), ...grid([2, 4], [2, 4], 1)],
};

/** Two flat 8-tile rows — exercises left/right edge blocking. 16 tiles. */
const ROWS: Layout = {
  id: 'seed-rows',
  slots: [...grid(range(0, 8), [0], 0), ...grid(range(0, 8), [4], 0)],
};

/** Brick rows with half-offset upper tiles straddling two supporters —
 *  exercises half-unit lattice overlap. 18 tiles. */
const BRICKS: Layout = {
  id: 'seed-bricks',
  slots: [
    ...grid(range(0, 6), [0], 0),
    ...grid([1, 3, 5, 7], [0], 1),
    ...grid(range(0, 6), [3], 0),
    ...grid([2, 8], [3], 1),
  ],
};

export const SEED_LAYOUTS: readonly Layout[] = [PYRAMID, ROWS, BRICKS];

/** A layout as it ships on disk: geometry plus its display name. */
export interface LayoutFile extends Layout {
  /** Display name, e.g. "Turtle". */
  readonly name: string;
}

function isSlot(v: unknown): v is Slot {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Record<string, unknown>;
  return typeof s['x'] === 'number' && typeof s['y'] === 'number' && typeof s['z'] === 'number';
}

/**
 * Every unit cell of a slot's 2×2 footprint must sit on a slot one layer down
 * (spec §4: "a slot is placeable if all slots it would rest on are filled").
 * The Board free-tile rule never looks downwards, so a floating slot would
 * generate and play as a normal tile — it has to be rejected at load time.
 */
function findFloatingSlot(slots: readonly Slot[]): { slot: Slot; index: number } | undefined {
  const occupied = new Set(slots.map(slotKey));
  for (const [index, slot] of slots.entries()) {
    if (slot.z === 0) continue;
    for (const cx of [slot.x, slot.x + 1]) {
      for (const cy of [slot.y, slot.y + 1]) {
        // Footprints are 2 wide, so only the four anchors at (cx|cx-1, cy|cy-1)
        // can cover the unit cell at (cx, cy).
        const supported =
          occupied.has(slotKey({ x: cx, y: cy, z: slot.z - 1 })) ||
          occupied.has(slotKey({ x: cx - 1, y: cy, z: slot.z - 1 })) ||
          occupied.has(slotKey({ x: cx, y: cy - 1, z: slot.z - 1 })) ||
          occupied.has(slotKey({ x: cx - 1, y: cy - 1, z: slot.z - 1 }));
        if (!supported) return { slot, index };
      }
    }
  }
  return undefined;
}

/**
 * Parse and validate a layout JSON document (spec §4: layouts are data files,
 * not code). Throws with a descriptive message on any structural problem —
 * malformed geometry must fail loudly at load time, never as a corrupt board
 * mid-game. Same-layer overlaps and non-integer coordinates are caught by
 * constructing a Board.
 */
export function parseLayout(doc: unknown): LayoutFile {
  if (typeof doc !== 'object' || doc === null) throw new TypeError('layout: not an object');
  const d = doc as Record<string, unknown>;
  if (typeof d['id'] !== 'string' || d['id'] === '') throw new TypeError('layout: missing id');
  const id = d['id'];
  if (typeof d['name'] !== 'string' || d['name'] === '') {
    throw new TypeError(`layout ${id}: missing name`);
  }
  if (!Array.isArray(d['slots'])) throw new TypeError(`layout ${id}: slots must be an array`);
  const slots = d['slots'].map((s: unknown, i: number): Slot => {
    if (!isSlot(s)) throw new TypeError(`layout ${id}: slot ${i} malformed`);
    return { x: s.x, y: s.y, z: s.z };
  });
  if (slots.length === 0 || slots.length % 2 !== 0) {
    throw new RangeError(`layout ${id}: slot count must be even and > 0, got ${slots.length}`);
  }
  // Board's constructor enforces integer half-units and no same-layer overlap.
  new Board(slots.map((slot, i) => ({ id: i, slot, face: 'validate' })));
  const floating = findFloatingSlot(slots);
  if (floating) {
    throw new RangeError(
      `layout ${id}: slot ${floating.index} at ${slotKey(floating.slot)} floats — layer ${
        floating.slot.z - 1
      } does not support its full footprint`,
    );
  }
  return { id, name: d['name'], slots };
}
