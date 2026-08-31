// Booster charge accounting (issue #13, spec §5). Charges are the whole
// economy for now: every player starts with a grant of each booster and spends
// one charge per *successful* use. Replenishment (rewarded video / IAP) belongs
// to issues #20/#21 — ads are suspended for v1.0 (ROADMAP §2.4), so a booster
// at zero simply stays at zero and the UI says so.
//
// Balances persist across restarts (issue #13 acceptance criterion) through an
// injectable key/value store — `localStorage` in the browser, a plain object in
// tests. Storage is best-effort: Safari private mode throws on write, and a
// corrupt or absent record falls back to a fresh grant rather than failing to
// boot. The full board auto-save is issue #14; this only owns the charges.

export type BoosterKind = 'hint' | 'undo' | 'shuffle';

export const BOOSTER_KINDS: readonly BoosterKind[] = ['hint', 'undo', 'shuffle'];

/** Spec §5 / issue #13: starting grant, per booster. */
export const STARTING_GRANT = 5;

export const CHARGES_STORAGE_KEY = 'mahjong.boosters.v1';

/** The slice of the DOM Storage API this module needs (`localStorage` fits). */
export interface ChargeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

type Counts = Record<BoosterKind, number>;

function freshGrant(): Counts {
  return { hint: STARTING_GRANT, undo: STARTING_GRANT, shuffle: STARTING_GRANT };
}

/** A stored count is only honoured when it is a non-negative integer. */
function readCount(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 ? raw : null;
}

function load(storage: ChargeStorage | undefined, key: string): Counts {
  const counts = freshGrant();
  if (!storage) return counts;
  let record: unknown;
  try {
    const raw = storage.getItem(key);
    if (raw === null) return counts;
    record = JSON.parse(raw);
  } catch {
    return counts; // unreadable storage or malformed JSON: start fresh
  }
  if (typeof record !== 'object' || record === null) return counts;
  for (const kind of BOOSTER_KINDS) {
    const value = readCount((record as Record<string, unknown>)[kind]);
    if (value !== null) counts[kind] = value;
  }
  return counts;
}

/**
 * Remaining charges per booster, persisted on every change.
 *
 * Accounting rule: the caller performs the booster action first and spends only
 * when it did something (`spend` after a successful Hint / Undo / Shuffle). A
 * hint with no legal pair, an undo with an empty move stack, or a shuffle the
 * solver cannot validate therefore costs the player nothing.
 */
export class BoosterCharges {
  private readonly counts: Counts;

  constructor(
    private readonly storage: ChargeStorage | undefined = undefined,
    private readonly key: string = CHARGES_STORAGE_KEY,
  ) {
    this.counts = load(storage, key);
  }

  remaining(kind: BoosterKind): number {
    return this.counts[kind];
  }

  has(kind: BoosterKind): boolean {
    return this.counts[kind] > 0;
  }

  /** Spend one charge. Returns false, changing nothing, when none remain. */
  spend(kind: BoosterKind): boolean {
    if (!this.has(kind)) return false;
    this.counts[kind]--;
    this.persist();
    return true;
  }

  private persist(): void {
    if (!this.storage) return;
    try {
      this.storage.setItem(this.key, JSON.stringify(this.counts));
    } catch {
      // Write-blocked storage (private mode, quota): charges stay in memory for
      // this session rather than taking the game down.
    }
  }
}
