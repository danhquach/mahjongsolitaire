// Layout JSON validation (spec §9: layouts ship as /data JSON, issue #17).
// The UI never trusts a layout file: malformed geometry must fail loudly at
// load time, not as a corrupt board mid-game.

import { Board } from '@mahjongsolitaire/core';
import type { Layout, Slot } from '@mahjongsolitaire/core';

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
 * Parse and validate a layout JSON document. Throws with a descriptive
 * message on any structural problem; lattice-level problems (non-integer
 * coordinates, same-layer overlaps) are caught by constructing a Board.
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
  return { id, name: d['name'], slots };
}
