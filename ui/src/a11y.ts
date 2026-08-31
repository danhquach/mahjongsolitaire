// Accessibility foundation for the canvas board (issue #12; ROADMAP Phase 2:
// "built here, not retrofitted"). A canvas has no semantics tree, so every
// tile also exists as a real, focusable DOM button in an overlay that mirrors
// the renderer's geometry — that is what VoiceOver/TalkBack traverse.
//
// Three rules from spec §7 shape this module:
//   * 48×48 dp minimum touch target — focus proxies grow about the tile center
//     when the board is scaled down on small viewports (`focusRect`).
//   * every action ≤ 2 taps from the board — the layer adds no navigation; all
//     controls stay on the board screen.
//   * no drag / long-press / pinch — activation is a single click (or Enter /
//     Space / an assistive-technology activate), never a gesture.
//
// The overlay is `pointer-events: none`: sighted taps keep flowing to the
// canvas so the 8dp mis-tap forgiveness in hit-test.ts stays the single
// pointer path. Keyboard and AT activation dispatch `click` on the element
// directly, which is unaffected by pointer-events.

import type { Slot, TileId } from '@mahjongsolitaire/core';
import { faceStyle } from './faces.js';
import { TILE_H, TILE_W, tileRect } from './geometry.js';
import type { Rect } from './geometry.js';

/** Spec §7: minimum touch target, in dp (≈ CSS px on the web). */
export const MIN_TOUCH_TARGET_PX = 48;

export type Direction = 'left' | 'right' | 'up' | 'down';

export interface A11yTile {
  readonly id: TileId;
  readonly slot: Slot;
  readonly face: string;
  readonly free: boolean;
}

/**
 * Reading order for assistive-technology traversal: top row first, then left
 * to right, then bottom layer up. Matches how a sighted player scans the
 * board, so swipe-next never jumps around.
 */
export function traversalOrder(tiles: readonly A11yTile[]): A11yTile[] {
  return [...tiles].sort((a, b) => a.slot.y - b.slot.y || a.slot.x - b.slot.x || a.slot.z - b.slot.z);
}

/**
 * Spoken name for a tile: what it is, whether it can be played, and where it
 * sits. The row/column is what lets a screen-reader player find the second
 * half of a pair after hearing the first.
 */
export function tileAriaLabel(tile: A11yTile): string {
  const { label } = faceStyle(tile.face);
  const state = tile.free ? 'available' : 'blocked';
  // Slots are half-units (spec §3.1); Turtle has half-offset rows/columns, so
  // round to the nearest whole cell for a name a human can act on.
  const row = Math.round(tile.slot.y / 2) + 1;
  const col = Math.round(tile.slot.x / 2) + 1;
  return `${label}, ${state}, row ${row}, column ${col}`;
}

/**
 * Grow a tile's on-screen rect about its center to at least the 48dp minimum
 * touch target. Tiles are 64×84 board px, so this only engages once the board
 * is scaled below ~0.75 — i.e. on phones, exactly where it matters.
 */
export function focusRect(r: Rect, min: number = MIN_TOUCH_TARGET_PX): Rect {
  const w = Math.max(r.w, min);
  const h = Math.max(r.h, min);
  return { x: r.x + (r.w - w) / 2, y: r.y + (r.h - h) / 2, w, h };
}

/** Board-pixel center of a tile's top face (layer lift included). */
function center(tile: A11yTile): { x: number; y: number } {
  const r = tileRect(tile.slot);
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

/**
 * Nearest tile in `dir` for arrow-key navigation. Candidates must lie strictly
 * in that direction *and* within one tile of the source on the cross axis, so
 * arrows walk a row or a column instead of drifting diagonally; ties break on
 * cross-axis offset, then id. Blocked tiles are included — traversal has to
 * cover the whole board, not just the playable tiles.
 */
export function nextInDirection(
  tiles: readonly A11yTile[],
  fromId: TileId,
  dir: Direction,
): TileId | null {
  const from = tiles.find((t) => t.id === fromId);
  if (!from) return null;
  const origin = center(from);
  const horizontal = dir === 'left' || dir === 'right';
  const sign = dir === 'right' || dir === 'down' ? 1 : -1;
  const band = horizontal ? TILE_H : TILE_W;

  let best: A11yTile | null = null;
  let bestAlong = Infinity;
  let bestCross = Infinity;
  for (const t of tiles) {
    if (t.id === fromId) continue;
    const c = center(t);
    const along = (horizontal ? c.x - origin.x : c.y - origin.y) * sign;
    const cross = Math.abs(horizontal ? c.y - origin.y : c.x - origin.x);
    if (along <= 0 || cross >= band) continue;
    if (
      best === null ||
      along < bestAlong ||
      (along === bestAlong && (cross < bestCross || (cross === bestCross && t.id < best.id)))
    ) {
      best = t;
      bestAlong = along;
      bestCross = cross;
    }
  }
  return best?.id ?? null;
}

/**
 * Polite live region. Canvas changes are invisible to assistive technology, so
 * every outcome (match, mismatch, blocked tap, win, stuck) is spoken here.
 */
export class Announcer {
  constructor(private readonly node: HTMLElement) {}

  say(message: string): void {
    // Re-setting identical text is not a change, so it is never announced —
    // pad alternate repeats with a trailing space to force the update.
    this.node.textContent = this.node.textContent === message ? `${message} ` : message;
  }
}

/** Canvas-relative CSS-px rect of a tile's top face. */
export type CssRectOf = (tile: A11yTile) => Rect;

/**
 * The DOM/ARIA mirror of the board. One `<button>` per present tile, kept in
 * traversal order, with a roving tabindex so keyboard users get one tab stop
 * and arrow keys instead of 144 tab stops.
 */
export class A11yLayer {
  private readonly nodes = new Map<TileId, HTMLButtonElement>();
  private order: A11yTile[] = [];
  private activeId: TileId | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly onActivate: (id: TileId) => void,
  ) {
    root.setAttribute('role', 'group');
    root.setAttribute('aria-label', 'Game board');
    root.addEventListener('click', (ev) => {
      const id = this.idOf(ev.target);
      if (id !== null) this.onActivate(id);
    });
    root.addEventListener('focusin', (ev) => {
      const id = this.idOf(ev.target);
      if (id !== null) this.setActive(id);
    });
    root.addEventListener('keydown', (ev) => this.onKeyDown(ev));
  }

  /** Tile currently holding the layer's single tab stop. */
  get active(): TileId | null {
    return this.activeId;
  }

  /**
   * Mirror the current board state. Nodes for removed tiles are deleted and
   * survivors are updated in place, so focus is never dropped by a redraw.
   */
  sync(tiles: readonly A11yTile[], selection: TileId | null, cssRect: CssRectOf): void {
    this.order = traversalOrder(tiles);
    const hadFocus = this.root.contains(document.activeElement);

    // Tiles are only ever added by a new deal, never mid-level: a full rebuild
    // is needed exactly when an unseen id shows up, and it is the only way to
    // guarantee DOM order matches traversal order.
    if (this.order.some((t) => !this.nodes.has(t.id))) {
      this.root.replaceChildren();
      this.nodes.clear();
      for (const t of this.order) {
        const node = this.createNode(t.id);
        this.nodes.set(t.id, node);
        this.root.appendChild(node);
      }
      this.activeId = null;
    } else {
      const present = new Set(this.order.map((t) => t.id));
      for (const [id, node] of this.nodes) {
        if (present.has(id)) continue;
        node.remove();
        this.nodes.delete(id);
        if (this.activeId === id) this.activeId = null;
      }
    }

    for (const t of this.order) {
      const node = this.nodes.get(t.id);
      if (!node) continue;
      const r = focusRect(cssRect(t));
      node.style.left = `${r.x}px`;
      node.style.top = `${r.y}px`;
      node.style.width = `${r.w}px`;
      node.style.height = `${r.h}px`;
      node.setAttribute('aria-label', tileAriaLabel(t));
      node.setAttribute('aria-pressed', String(selection === t.id));
      node.setAttribute('aria-disabled', String(!t.free));
    }

    if (this.activeId === null || !this.nodes.has(this.activeId)) {
      const fallback = this.order.find((t) => t.free) ?? this.order[0];
      this.activeId = fallback?.id ?? null;
      // A match removes the node the user just activated; put focus back on
      // the board rather than letting it fall to <body>.
      if (hadFocus && this.activeId !== null && document.activeElement === document.body) {
        this.nodes.get(this.activeId)?.focus();
      }
    }
    for (const [id, node] of this.nodes) {
      node.tabIndex = id === this.activeId ? 0 : -1;
    }
  }

  /** Put focus on the board's current tab stop (returning from a dialog). */
  focusActive(): void {
    if (this.activeId === null) return;
    this.nodes.get(this.activeId)?.focus();
  }

  /** Take the overlay out of the tab order and the a11y tree (modal dialogs). */
  setInert(inert: boolean): void {
    if (inert) this.root.setAttribute('inert', '');
    else this.root.removeAttribute('inert');
  }

  private createNode(id: TileId): HTMLButtonElement {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = 'tile-node';
    node.dataset['tileId'] = String(id);
    node.tabIndex = -1;
    return node;
  }

  private idOf(target: EventTarget | null): TileId | null {
    if (!(target instanceof HTMLElement)) return null;
    const raw = target.dataset['tileId'];
    return raw === undefined ? null : Number(raw);
  }

  private setActive(id: TileId): void {
    if (this.activeId === id) return;
    if (this.activeId !== null) {
      const previous = this.nodes.get(this.activeId);
      if (previous) previous.tabIndex = -1;
    }
    this.activeId = id;
    const node = this.nodes.get(id);
    if (node) node.tabIndex = 0;
  }

  private focus(id: TileId | null): void {
    if (id === null) return;
    this.setActive(id);
    this.nodes.get(id)?.focus();
  }

  private onKeyDown(ev: KeyboardEvent): void {
    const from = this.idOf(ev.target);
    if (from === null) return;
    const arrows: Record<string, Direction> = {
      ArrowLeft: 'left',
      ArrowRight: 'right',
      ArrowUp: 'up',
      ArrowDown: 'down',
    };
    const dir = arrows[ev.key];
    if (dir) {
      ev.preventDefault();
      this.focus(nextInDirection(this.order, from, dir));
      return;
    }
    if (ev.key === 'Home' || ev.key === 'End') {
      ev.preventDefault();
      const target = ev.key === 'Home' ? this.order[0] : this.order[this.order.length - 1];
      this.focus(target?.id ?? null);
    }
  }
}
