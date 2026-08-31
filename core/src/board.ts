// Board model: slot lattice + free-tile rule (spec §3.1–3.2, issue #5).
//
// Coordinates are half-units: a tile's footprint spans [x, x+2) × [y, y+2)
// on layer z. Two tiles on the same layer overlap iff |dx| < 2 and |dy| < 2.
//
// Issue #43 adds the holder: a small fixed set of off-lattice slots a free tile
// can be parked in to reach what is under it. A held tile is still *in play*
// and always matchable — it just no longer occupies its slot, so it blocks
// nothing. Three states, therefore, not two: on the board, held, removed.
//
// The holder lives here rather than beside the Board because it is occupancy
// state: holding vacates a slot and unholding fills it again, and one owner of
// both halves is what makes those two operations exact inverses. Callers that
// serialize a board must carry `allTiles()` *and* `holderSlots()` — rebuilding
// from the tiles alone would drop every held tile back onto the lattice.

/** A position in the 3D lattice. x/y in half-units, z = layer (0 = bottom). */
export interface Slot {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

// Deviation from spec §3.1 (`id: uuid`), deliberate: ids are numeric so the
// §9 save/replay format (`moves: [[12,88],…]`) and state hashing stay compact
// and deterministic. Ids are stable per (layoutId, seed) once assigned by the
// generator (issue #7).
export type TileId = number;

export interface Tile {
  readonly id: TileId;
  readonly slot: Slot;
  /** FaceId — assigned by the generator (issue #7); placeholder faces allowed. */
  readonly face: string;
  readonly removed: boolean;
}

/** What a caller supplies to build a board: identity and geometry, with the
 *  play state optional. Holder membership is *not* a tile field — it is passed
 *  as `BoardOptions.holder`, so a tile list stays a description of the deal. */
export type TileInput = Omit<Tile, 'removed'> & { readonly removed?: boolean };

/** Holder capacity (issue #43): 4 slots, matching the Vita Mahjong box this
 *  assist is modelled on (PM decision, 2026-08-31). */
export const HOLDER_SLOTS = 4;

export interface BoardOptions {
  /** Holder occupancy, one entry per slot and null where a slot is empty
   *  (issue #43) — `holderSlots()` round-trips through here. */
  readonly holder?: readonly (TileId | null)[];
  /** Slot count. Defaults to `holder`'s length when one is given, else
   *  HOLDER_SLOTS. */
  readonly holderCapacity?: number;
}

/** Internal shape: `removed` is mutable only inside Board (via remove/restore). */
type MutableTile = { -readonly [K in keyof Tile]: Tile[K] };

export function slotKey(s: Slot): string {
  return `${s.x},${s.y},${s.z}`;
}

function assertValidSlot(s: Slot): void {
  if (!Number.isInteger(s.x) || !Number.isInteger(s.y) || !Number.isInteger(s.z)) {
    throw new RangeError(`slot coordinates must be integers (half-units): ${slotKey(s)}`);
  }
  if (s.z < 0) throw new RangeError(`layer must be >= 0: ${slotKey(s)}`);
}

/** Overlap of the 2×2 footprints anchored at (ax,ay) and (bx,by), same layer. */
export function footprintsOverlap(ax: number, ay: number, bx: number, by: number): boolean {
  return Math.abs(ax - bx) < 2 && Math.abs(ay - by) < 2;
}

/**
 * Occupancy state of a board's lattice. Holds tiles (removed ones stay in the
 * collection, flagged), answers the free-tile rule, and enforces the lattice
 * invariant that no two present tiles overlap on the same layer.
 */
export class Board {
  private readonly tiles = new Map<TileId, MutableTile>();
  /** On-board tiles indexed by exact slot key — removed and held tiles are not
   *  in here, which is what makes a held tile block nothing. */
  private readonly occupied = new Map<string, MutableTile>();
  /** Holder slots (issue #43), null where empty. */
  private readonly holder: (TileId | null)[];
  private readonly heldIds = new Set<TileId>();
  readonly holderCapacity: number;

  constructor(tiles: Iterable<TileInput>, options: BoardOptions = {}) {
    // Two passes: every tile is registered before the holder is read (a slot
    // names a tile) and before anything is occupied (a held tile must not take
    // its slot, or unholding it later would collide with itself).
    for (const t of tiles) {
      assertValidSlot(t.slot);
      if (this.tiles.has(t.id)) throw new RangeError(`duplicate tile id ${t.id}`);
      this.tiles.set(t.id, {
        id: t.id,
        slot: t.slot,
        face: t.face,
        removed: t.removed ?? false,
      });
    }
    this.holderCapacity = options.holderCapacity ?? options.holder?.length ?? HOLDER_SLOTS;
    this.holder = this.buildHolder(options.holder);
    for (const tile of this.tiles.values()) {
      if (!tile.removed && !this.heldIds.has(tile.id)) this.occupy(tile);
    }
  }

  private buildHolder(slots: readonly (TileId | null)[] | undefined): (TileId | null)[] {
    if (!Number.isInteger(this.holderCapacity) || this.holderCapacity < 0) {
      throw new RangeError(`holder capacity must be a non-negative integer`);
    }
    const holder = new Array<TileId | null>(this.holderCapacity).fill(null);
    if (!slots) return holder;
    if (slots.length > this.holderCapacity) {
      throw new RangeError(`holder has ${slots.length} slots, capacity is ${this.holderCapacity}`);
    }
    slots.forEach((id, i) => {
      if (id === null) return;
      const tile = this.tiles.get(id);
      if (!tile) throw new RangeError(`holder slot ${i} names unknown tile ${id}`);
      if (tile.removed) throw new RangeError(`holder slot ${i} holds removed tile ${id}`);
      if (this.heldIds.has(id)) throw new RangeError(`tile ${id} is in two holder slots`);
      this.heldIds.add(id);
      holder[i] = id;
    });
    return holder;
  }

  private occupy(tile: MutableTile): void {
    const clash = this.tileOverlappingFootprint(tile.slot.x, tile.slot.y, tile.slot.z, tile.id);
    if (clash) {
      throw new RangeError(
        `tile ${tile.id} at ${slotKey(tile.slot)} overlaps tile ${clash.id} at ${slotKey(clash.slot)}`,
      );
    }
    this.occupied.set(slotKey(tile.slot), tile);
  }

  /**
   * First present tile whose footprint overlaps the 2×2 footprint anchored at
   * (x, y) on layer z, or undefined. Same-layer overlap requires anchor deltas
   * in (-2, 2), so only the 3×3 half-unit neighborhood needs checking.
   */
  private tileOverlappingFootprint(x: number, y: number, z: number, excludeId?: TileId): Tile | undefined {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const t = this.occupied.get(`${x + dx},${y + dy},${z}`);
        if (t && t.id !== excludeId) return t;
      }
    }
    return undefined;
  }

  get(id: TileId): Tile {
    return this.getMutable(id);
  }

  private getMutable(id: TileId): MutableTile {
    const t = this.tiles.get(id);
    if (!t) throw new RangeError(`no tile with id ${id}`);
    return t;
  }

  /** All tiles, removed included. */
  allTiles(): readonly Tile[] {
    return [...this.tiles.values()];
  }

  /** Tiles on the board: neither removed nor held. */
  presentTiles(): readonly Tile[] {
    return [...this.occupied.values()];
  }

  /** Tiles still in play — on the board plus in the holder (issue #43). This,
   *  not `presentTiles()`, is what "tiles left" and "board cleared" mean. */
  inPlayTiles(): readonly Tile[] {
    return [...this.tiles.values()].filter((t) => !t.removed);
  }

  /** Rule §3.2(1): some present tile overlaps this tile's footprint at z+1. */
  isCovered(id: TileId): boolean {
    const { slot } = this.get(id);
    return this.tileOverlappingFootprint(slot.x, slot.y, slot.z + 1) !== undefined;
  }

  /** Rule §3.2(2): a present tile overlaps the adjacent 2×2 footprint on the left, same z. */
  isBlockedLeft(id: TileId): boolean {
    const { slot } = this.get(id);
    return this.tileOverlappingFootprint(slot.x - 2, slot.y, slot.z) !== undefined;
  }

  /** Rule §3.2(2): a present tile overlaps the adjacent 2×2 footprint on the right, same z. */
  isBlockedRight(id: TileId): boolean {
    const { slot } = this.get(id);
    return this.tileOverlappingFootprint(slot.x + 2, slot.y, slot.z) !== undefined;
  }

  /**
   * Free-tile rule (spec §3.2): free iff not covered at z+1 AND (left edge
   * fully unblocked OR right edge fully unblocked) at the same z. Vertical
   * adjacency (tiles directly below) never blocks. Removed tiles are not free.
   */
  isFree(id: TileId): boolean {
    if (this.get(id).removed || this.heldIds.has(id)) return false;
    return !this.isCovered(id) && (!this.isBlockedLeft(id) || !this.isBlockedRight(id));
  }

  /** Ids of all on-board tiles that are currently free, ascending — order must
   *  stay deterministic regardless of remove/restore history (spec §9 invariant). */
  freeTileIds(): TileId[] {
    return this.presentTiles()
      .filter((t) => this.isFree(t.id))
      .map((t) => t.id)
      .sort((a, b) => a - b);
  }

  // --- holder (issue #43) -----------------------------------------------------

  /** Holder occupancy, one entry per slot and null where empty. Pair it with
   *  `allTiles()` to rebuild this board exactly. */
  holderSlots(): readonly (TileId | null)[] {
    return [...this.holder];
  }

  isHeld(id: TileId): boolean {
    this.get(id); // reject an unknown id rather than answering false for it
    return this.heldIds.has(id);
  }

  /** Ids of the held tiles, ascending (determinism, as freeTileIds). */
  heldTileIds(): TileId[] {
    return [...this.heldIds].sort((a, b) => a - b);
  }

  /** Every slot taken. Hold is refused here — it never ends the level. */
  holderFull(): boolean {
    return !this.holder.includes(null);
  }

  /**
   * Can this tile be half of a pair? A held tile always can — it is off the
   * lattice, so nothing can block it (spec §3.3 as amended by issue #43); an
   * on-board tile must be free.
   */
  isMatchable(id: TileId): boolean {
    if (this.get(id).removed) return false;
    return this.heldIds.has(id) || this.isFree(id);
  }

  /** Ids of every matchable tile — free on the board, or held — ascending. */
  matchableTileIds(): TileId[] {
    return [...this.freeTileIds(), ...this.heldTileIds()].sort((a, b) => a - b);
  }

  /**
   * Park a free tile in the first empty holder slot; returns that slot's index.
   * Throws — changing nothing — on a tile that is not free or a full holder;
   * callers check `holderFull()` first, because a full holder disables Hold
   * rather than ending the level (issue #43 rule 5).
   */
  hold(id: TileId): number {
    if (!this.isFree(id)) throw new RangeError(`tile ${id} is not free`);
    const index = this.holder.indexOf(null);
    if (index === -1) throw new RangeError(`holder is full (${this.holderCapacity} slots)`);
    this.holdAt(id, index);
    return index;
  }

  /**
   * Move an on-board tile into a named slot. The free-tile policy is `hold()`'s;
   * this is the bare mechanism, and the one undo re-runs — a tile coming back
   * out of a holder match belongs in the slot it was matched from, whatever the
   * lattice looks like now.
   */
  holdAt(id: TileId, index: number): void {
    const t = this.getMutable(id);
    if (t.removed) throw new RangeError(`tile ${id} is removed`);
    if (this.heldIds.has(id)) throw new RangeError(`tile ${id} is already held`);
    if (!Number.isInteger(index) || index < 0 || index >= this.holder.length) {
      throw new RangeError(`no holder slot ${index}`);
    }
    if (this.holder[index] !== null) {
      throw new RangeError(`holder slot ${index} already holds tile ${this.holder[index]}`);
    }
    this.occupied.delete(slotKey(t.slot));
    this.holder[index] = id;
    this.heldIds.add(id);
  }

  /**
   * Return a held tile to its own slot (issue #43 rule 4). Always legal, and
   * that is a property of the model rather than a hope: tiles only ever *leave*
   * the lattice, so the slot a held tile vacated cannot have been taken or
   * covered since — `occupy` is the assertion that says so.
   */
  unhold(id: TileId): void {
    const t = this.getMutable(id);
    const index = this.holder.indexOf(id);
    if (index === -1) throw new RangeError(`tile ${id} is not held`);
    this.occupy(t);
    this.holder[index] = null;
    this.heldIds.delete(id);
  }

  // --- removal ----------------------------------------------------------------

  /** Mark an in-play tile removed, freeing its slot — or its holder slot. */
  remove(id: TileId): void {
    const t = this.getMutable(id);
    if (t.removed) throw new RangeError(`tile ${id} already removed`);
    const index = this.holder.indexOf(id);
    if (index === -1) {
      this.occupied.delete(slotKey(t.slot));
    } else {
      this.holder[index] = null;
      this.heldIds.delete(id);
    }
    t.removed = true;
  }

  /** Reassign a tile's face in place (Shuffle booster, spec §5 / issue #10).
   *  Occupancy is untouched — only the face changes. */
  setFace(id: TileId, face: string): void {
    this.getMutable(id).face = face;
  }

  /** Undo a removal: put the tile back on the lattice. A tile that was removed
   *  *out of the holder* comes back here first and is re-parked by `holdAt` —
   *  the move stack owns that pairing (issue #43). */
  restore(id: TileId): void {
    const t = this.getMutable(id);
    if (!t.removed) throw new RangeError(`tile ${id} is not removed`);
    this.occupy(t);
    t.removed = false;
  }
}
