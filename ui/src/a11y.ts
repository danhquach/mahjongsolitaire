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
  /** Face hidden this frame (issue #64): announce as face-down, never by face.
   *  Computed visibility, not deal-time concealment — a peeked tile shows its
   *  face, so it announces it too. */
  readonly concealed?: boolean;
  /** This tile's face matches a held tile (issue #93): activating it clears
   *  the pair rather than parking it, and the label says which. Never true
   *  for a hidden face (issue #165): a face-down tile whose match is held does
   *  clear on activation, but saying so would leak the face. */
  readonly pairsWithHeld?: boolean;
  /** This tile's face matches the current peek (issue #169, amending decision
   *  0025 point 2): activating it clears the pair through the holder rather
   *  than parking it — same label as `pairsWithHeld`, and the same reason it
   *  is never true for a hidden face. */
  readonly pairsWithPeek?: boolean;
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
 * Spoken name for a tile: what it is, whether it can be played, where it sits,
 * and what activating it does. The row/column is what lets a screen-reader
 * player find the second half of a pair after hearing the first.
 *
 * Issue #93 made one tap the whole gesture, so every free tile spells its
 * action out: clear the pair when its match is already in the holder, send it
 * to the holder otherwise. Sighted players discover that by trying it; a
 * screen-reader player has to be told.
 *
 * `parkEndsLevel` is the warning half of that, and it is not optional
 * politeness (issue #63): with one holder slot left, the very tap that parks
 * an unmatched tile loses the level. A sighted player has the marked last slot
 * in the strip to look at; this sentence is that cue, for someone who cannot.
 */
export function tileAriaLabel(tile: A11yTile, parkEndsLevel = false): string {
  const state = tile.free ? 'available' : 'blocked';
  const { row, col } = slotPosition(tile.slot);
  // A face-down tile must announce as face-down, not by its face (issue #64) —
  // reading the glyph out would hand a screen-reader player what a sighted one
  // cannot see. "Peek" is the only action ever offered on a hidden face
  // (issue #165): when its match is already held the activation clears the
  // pair instead, but announcing that would name the face by implication.
  if (tile.concealed) {
    const action = tile.free ? ', activate to peek at it' : '';
    return `Face-down tile, ${state}, row ${row}, column ${col}${action}`;
  }
  const { label } = faceStyle(tile.face);
  const action = !tile.free
    ? ''
    : tile.pairsWithHeld || tile.pairsWithPeek
      ? ', activate to clear it with its match in the holder'
      : parkEndsLevel
        ? ', activate to send it to the last holder slot, which ends the level'
        : ', activate to send it to the holder';
  return `${label}, ${state}, row ${row}, column ${col}${action}`;
}

/**
 * Human-facing row/column of a slot, 1-based. Slots are half-units (spec §3.1)
 * and Turtle has half-offset rows/columns, so round to the nearest whole cell:
 * a spoken position only has to be findable, not exact. Shared with the Hint
 * booster's announcement (issue #13) so both name a tile the same way.
 */
export function slotPosition(slot: Slot): { row: number; col: number } {
  return { row: Math.round(slot.y / 2) + 1, col: Math.round(slot.x / 2) + 1 };
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
 * every outcome (match, park, peek, blocked tap, win, loss, stuck) is spoken
 * here.
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
  /** Last sync's traversal order — where a vanished tab stop was, so the next
   *  one can be its nearest surviving neighbour (issue #93: every activation
   *  of a free tile removes its node, so this fallback runs on every move). */
  private lastOrderIds: TileId[] = [];

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
  sync(
    tiles: readonly A11yTile[],
    cssRect: CssRectOf,
    /** One holder slot left, so parking an unmatched tile ends the level
     *  (issue #63; reworded for issue #93). */
    parkEndsLevel = false,
  ): void {
    this.order = traversalOrder(tiles);
    const hadFocus = this.root.contains(document.activeElement);
    const wasActiveBefore = this.activeId;

    // A tile can come *back* to the board — a new deal, an undone match, or a
    // held tile returned from the holder (issue #43) — and a rebuild is the only
    // way to guarantee DOM order still matches traversal order. It used to be a
    // new-deal-only path, which is why it simply dropped the tab stop; a return
    // is a mid-level move the player just made, so the tab stop follows the tile
    // it was already on rather than jumping to the top of the board.
    if (this.order.some((t) => !this.nodes.has(t.id))) {
      const wasActive = this.activeId;
      this.root.replaceChildren();
      this.nodes.clear();
      for (const t of this.order) {
        const node = this.createNode(t.id);
        this.nodes.set(t.id, node);
        this.root.appendChild(node);
      }
      this.activeId = wasActive !== null && this.nodes.has(wasActive) ? wasActive : null;
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
      node.setAttribute('aria-label', tileAriaLabel(t, parkEndsLevel));
      node.setAttribute('aria-disabled', String(!t.free));
    }

    if (this.activeId === null || !this.nodes.has(this.activeId)) {
      // Under issue #93 the activated tile always leaves the board (park or
      // match), so the tab stop would otherwise jump to the top of the board
      // on every single move — stay on the nearest surviving neighbour in
      // traversal order instead, falling back to the first free tile only
      // when there is no previous position to stay near (a fresh deal).
      this.activeId =
        this.nearestSurvivor(wasActiveBefore) ??
        (this.order.find((t) => t.free) ?? this.order[0])?.id ??
        null;
      // A match removes the node the user just activated; put focus back on
      // the board rather than letting it fall to <body>.
      if (hadFocus && this.activeId !== null && document.activeElement === document.body) {
        this.nodes.get(this.activeId)?.focus();
      }
    }
    for (const [id, node] of this.nodes) {
      node.tabIndex = id === this.activeId ? 0 : -1;
    }
    this.lastOrderIds = this.order.map((t) => t.id);
  }

  /** The surviving tile nearest to `lostId`'s place in the previous traversal
   *  order — forward first on a tie, matching reading direction. */
  private nearestSurvivor(lostId: TileId | null): TileId | null {
    if (lostId === null) return null;
    const at = this.lastOrderIds.indexOf(lostId);
    if (at === -1) return null;
    for (let d = 1; d < this.lastOrderIds.length; d++) {
      for (const idx of [at + d, at - d]) {
        const id = this.lastOrderIds[idx];
        if (id !== undefined && this.nodes.has(id)) return id;
      }
    }
    return null;
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
