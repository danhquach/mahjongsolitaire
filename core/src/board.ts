// Board model: slot lattice + free-tile rule (spec §3.1–3.2, issue #5).
//
// Coordinates are half-units: a tile's footprint spans [x, x+2) × [y, y+2)
// on layer z. Two tiles on the same layer overlap iff |dx| < 2 and |dy| < 2.

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
  /** Present (non-removed) tiles indexed by exact slot key. */
  private readonly occupied = new Map<string, MutableTile>();

  constructor(tiles: Iterable<Omit<Tile, 'removed'> & { removed?: boolean }>) {
    for (const t of tiles) {
      assertValidSlot(t.slot);
      if (this.tiles.has(t.id)) throw new RangeError(`duplicate tile id ${t.id}`);
      const tile: MutableTile = { id: t.id, slot: t.slot, face: t.face, removed: t.removed ?? false };
      this.tiles.set(tile.id, tile);
      if (!tile.removed) this.occupy(tile);
    }
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

  /** Present (non-removed) tiles. */
  presentTiles(): readonly Tile[] {
    return [...this.occupied.values()];
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
    if (this.get(id).removed) return false;
    return !this.isCovered(id) && (!this.isBlockedLeft(id) || !this.isBlockedRight(id));
  }

  /** Ids of all present tiles that are currently free, ascending — order must
   *  stay deterministic regardless of remove/restore history (spec §9 invariant). */
  freeTileIds(): TileId[] {
    return this.presentTiles()
      .filter((t) => this.isFree(t.id))
      .map((t) => t.id)
      .sort((a, b) => a - b);
  }

  /** Mark a present tile removed, freeing its slot. */
  remove(id: TileId): void {
    const t = this.getMutable(id);
    if (t.removed) throw new RangeError(`tile ${id} already removed`);
    t.removed = true;
    this.occupied.delete(slotKey(t.slot));
  }

  /** Undo a removal: put the tile back in its slot. */
  restore(id: TileId): void {
    const t = this.getMutable(id);
    if (!t.removed) throw new RangeError(`tile ${id} is not removed`);
    this.occupy(t);
    t.removed = false;
  }
}
