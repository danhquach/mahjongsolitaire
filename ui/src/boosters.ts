// Booster charge accounting (issue #13, spec §5). Charges are the whole
// economy: every player starts with a grant of each booster and spends one
// charge per *successful* use. Replenishment is issue #51 — three
// ads-independent channels, so a player who runs dry can always earn charges
// back without enabling ads or buying anything (PM numbers, 2026-08-31):
//
//   * every third *distinct* level first-cleared: +1 of a random type — the
//     dialog announces what landed, the player never picks (issue #117; the
//     per-level first-clear grant #51 had was dropped there as too easy to
//     stock up on). Replays never count: levels are one tap from a restart,
//     and a grant per completion would mint charges off one easy level;
//   * milestone level (the decade spike — 10, 20, 30, …) first-cleared:
//     +1 of *each* type — the hard level pays the full set (issue #117);
//   * daily first launch: +1 of each, once per calendar day — the renewable
//     trickle that covers a player who is completely out.
//
// Both level channels can land on one clear (level 30 first-cleared as the
// 15th distinct clear); the dialog lists each.
//
// Every channel clamps at BOOSTER_CAP (99) rather than refusing. Rewarded
// video and an IAP bundle (spec §5) would sit on top of this later; the game
// is never dependent on ads being on to stay playable.
//
// Balances persist across restarts (issue #13 acceptance criterion) through an
// injectable key/value store — `localStorage` in the browser, a plain object in
// tests. Storage is best-effort: Safari private mode throws on write, and a
// corrupt or absent record falls back to a fresh grant rather than failing to
// boot. The daily-login date rides in the same record as the balances, so a
// failed write loses both together and the next launch simply grants again
// from the balance it actually persisted — never twice on top of a grant that
// stuck. The full board auto-save is issue #14; this only owns the charges.
//
// Issue #272: the charges follow a synced profile to other devices. A balance
// cannot merge by "take the larger" the way the record does — it goes down
// when spent, so the larger side would hand spent charges back. What is stored
// and synced instead is a ledger: per device, every charge it was ever granted
// and every one it spent, per kind. Both only grow, so two devices merge by
// taking the larger of each (per device), and the balance everywhere is the
// starting grant plus everything earned minus everything spent, clamped to
// 0..BOOSTER_CAP. The starting grant is the profile's, paid once — a second
// device restoring the profile does not bring a second one. The ledger also
// carries the last day the daily grant was paid on *any* device, so a profile
// collects it once a day, not once per device (as long as the devices have
// synced in between — two devices launched offline on the same day each pay it).

import { daysBetween, isDateKey } from '@mahjongsolitaire/core';

export type BoosterKind = 'hint' | 'undo' | 'shuffle';

export const BOOSTER_KINDS: readonly BoosterKind[] = ['hint', 'undo', 'shuffle'];

/** Spec §5 / issue #13: starting grant, per booster. */
export const STARTING_GRANT = 5;

/** Issue #51 (PM, 2026-08-31): the ceiling any channel clamps to — a
 *  two-digit display, and no unbounded integer. */
export const BOOSTER_CAP = 99;
/** Every THIRD_CLEAR_EVERY distinct first-clears: THIRD_CLEAR_GRANT charges
 *  of a random type (issue #117: down from 3). */
export const THIRD_CLEAR_GRANT = 1;
export const THIRD_CLEAR_EVERY = 3;
/** First clear of a milestone level (the ladder's decade spike): this many
 *  of *each* booster (issue #117). */
export const MILESTONE_LEVEL_GRANT = 1;
/** First launch of a calendar day: this many of *each* booster. */
export const DAILY_LOGIN_GRANT = 1;

export const CHARGES_STORAGE_KEY = 'mahjong.boosters.v1';

/** The slice of the DOM Storage API this module needs (`localStorage` fits). */
export interface ChargeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type Counts = Record<BoosterKind, number>;

/** One device's side of the wallet (issue #272): every charge it was ever
 *  granted and every one it spent, per kind. Both only grow, which is what
 *  lets two devices merge by taking the larger of each — a merge can never
 *  undo a spend, and nothing earned anywhere is lost. */
export interface DeviceTally {
  readonly earned: Counts;
  readonly spent: Counts;
}

/** The wallet as it syncs: one tally per device that has played the profile,
 *  and the last day the daily grant was paid on any of them. */
export interface BoosterLedger {
  /** Date key of the last daily-login grant, or null if never granted. */
  readonly day: string | null;
  readonly devices: Readonly<Record<string, DeviceTally>>;
}

export const EMPTY_LEDGER: BoosterLedger = { day: null, devices: {} };

/** A device id is short lowercase base32 (`randomDeviceId`); any other key in
 *  a ledger is hand-edited and dropped. Same shape as worker/profile.mjs. */
const DEVICE_ID = /^[a-z0-9]{1,16}$/;
/** More devices than one player could plausibly own is a hand-edited ledger.
 *  The cut keeps the lowest ids, so both sides of a merge cut the same ones
 *  (worker/profile.mjs `MAX_DEVICES`, kept identical). */
export const MAX_DEVICES = 32;
/** A tally past this is hand-edited (the Worker's MAX_COUNTER). */
const MAX_TALLY = 1e12;

function zero(): Counts {
  return { hint: 0, undo: 0, shuffle: 0 };
}

function tally(raw: unknown): number {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw <= MAX_TALLY ? raw : 0;
}

function parseCounts(raw: unknown): Counts {
  const counts = zero();
  if (typeof raw === 'object' && raw !== null) {
    for (const kind of BOOSTER_KINDS) counts[kind] = tally((raw as Record<string, unknown>)[kind]);
  }
  return counts;
}

function capDevices(devices: Record<string, DeviceTally>): Record<string, DeviceTally> {
  return Object.fromEntries(
    Object.keys(devices)
      .sort()
      .slice(0, MAX_DEVICES)
      .map((id) => [id, devices[id]!]),
  );
}

/** A ledger from storage or the server, field by field: a malformed tally
 *  reads as zero, a malformed device id or day is dropped. */
export function parseLedger(raw: unknown): BoosterLedger {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return EMPTY_LEDGER;
  const r = raw as Record<string, unknown>;
  const devices: Record<string, DeviceTally> = {};
  const rawDevices = r['devices'];
  if (typeof rawDevices === 'object' && rawDevices !== null && !Array.isArray(rawDevices)) {
    for (const [id, t] of Object.entries(rawDevices as Record<string, unknown>)) {
      if (!DEVICE_ID.test(id) || typeof t !== 'object' || t === null) continue;
      const side = t as Record<string, unknown>;
      devices[id] = { earned: parseCounts(side['earned']), spent: parseCounts(side['spent']) };
    }
  }
  const day = r['day'];
  return { day: isDateKey(day) ? day : null, devices: capDevices(devices) };
}

function maxCounts(a: Counts, b: Counts): Counts {
  return { hint: Math.max(a.hint, b.hint), undo: Math.max(a.undo, b.undo), shuffle: Math.max(a.shuffle, b.shuffle) };
}

/** Merge two ledgers: per device, the larger of each tally; the later daily
 *  grant day. Commutative and idempotent — both sides run it, and sync runs
 *  it again and again on already-merged ledgers (worker/profile.mjs
 *  `mergeLedgers`, kept identical). */
export function mergeLedgers(a: BoosterLedger, b: BoosterLedger): BoosterLedger {
  const devices: Record<string, DeviceTally> = {};
  for (const id of new Set([...Object.keys(a.devices), ...Object.keys(b.devices)])) {
    const x = a.devices[id];
    const y = b.devices[id];
    devices[id] =
      x === undefined ? y! : y === undefined ? x : { earned: maxCounts(x.earned, y.earned), spent: maxCounts(x.spent, y.spent) };
  }
  const day = a.day === null ? b.day : b.day === null || a.day >= b.day ? a.day : b.day;
  return { day, devices: capDevices(devices) };
}

/** What the player has of `kind`: the starting grant, plus everything earned,
 *  minus everything spent, on every device. Clamped to 0..BOOSTER_CAP. Two
 *  devices spending the same charges offline can leave the sum below zero;
 *  later grants pay that back before the badge moves. */
export function balanceOf(ledger: BoosterLedger, kind: BoosterKind): number {
  let net = STARTING_GRANT;
  for (const t of Object.values(ledger.devices)) net += t.earned[kind] - t.spent[kind];
  return Math.min(Math.max(net, 0), BOOSTER_CAP);
}

const ID_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

/** A fresh device id: 10 random base32 symbols (2^50), plenty to keep one
 *  player's handful of devices apart. */
export function randomDeviceId(): string {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => ID_ALPHABET[b & 31]).join('');
}

/** A stored count from before issue #272 is only honoured when it is a
 *  non-negative integer; one above the cap (hand-edited) is clamped rather
 *  than thrown away. */
function readCount(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 ? Math.min(raw, BOOSTER_CAP) : null;
}

interface Stored {
  readonly device: string;
  readonly ledger: BoosterLedger;
  /** False for a record from before issue #272, whose tally the constructor
   *  writes at once under its new id. A fresh device has no tally to protect,
   *  so it writes nothing until it first earns or spends. */
  readonly settled: boolean;
}

function load(storage: ChargeStorage | undefined, key: string, newDeviceId: () => string): Stored {
  const fresh = (): Stored => ({ device: newDeviceId(), ledger: EMPTY_LEDGER, settled: true });
  if (!storage) return fresh();
  let record: unknown;
  try {
    const raw = storage.getItem(key);
    if (raw === null) return fresh();
    record = JSON.parse(raw);
  } catch {
    return fresh(); // unreadable storage or malformed JSON: start fresh
  }
  if (typeof record !== 'object' || record === null) return fresh();
  const raw = record as Record<string, unknown>;
  const device = raw['device'];
  if (typeof device === 'string' && DEVICE_ID.test(device)) {
    return { device, ledger: parseLedger(raw['ledger']), settled: true };
  }
  // A record from before issue #272 holds balances, not a ledger. This
  // device's tally is whatever moved each balance off the starting grant, so
  // the badges read the same after the upgrade as before it.
  const id = newDeviceId();
  const earned = zero();
  const spent = zero();
  for (const kind of BOOSTER_KINDS) {
    const count = readCount(raw[kind]);
    if (count === null) continue;
    if (count > STARTING_GRANT) earned[kind] = count - STARTING_GRANT;
    else spent[kind] = STARTING_GRANT - count;
  }
  const last = raw['lastLoginGrant'];
  return {
    device: id,
    ledger: { day: isDateKey(last) ? last : null, devices: { [id]: { earned, spent } } },
    settled: false,
  };
}

/** Does the Nth distinct first-clear pay the every-third bonus (issue #51)? */
export function thirdClearDue(distinctCleared: number): boolean {
  return distinctCleared > 0 && distinctCleared % THIRD_CLEAR_EVERY === 0;
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
  private ledger: BoosterLedger;
  /** This device's key in the ledger: the only tally it ever writes to. */
  private readonly device: string;

  constructor(
    private readonly storage: ChargeStorage | undefined = undefined,
    private readonly key: string = CHARGES_STORAGE_KEY,
    newDeviceId: () => string = randomDeviceId,
  ) {
    const stored = load(storage, key, newDeviceId);
    this.device = stored.device;
    this.ledger = stored.ledger;
    // The id is written straight away: a migrated tally that synced under one
    // id and came back next launch under another would count twice.
    if (!stored.settled) this.persist();
  }

  remaining(kind: BoosterKind): number {
    return balanceOf(this.ledger, kind);
  }

  has(kind: BoosterKind): boolean {
    return this.remaining(kind) > 0;
  }

  /** The ledger as it syncs (issue #272). */
  get synced(): BoosterLedger {
    return this.ledger;
  }

  /** Merge a synced ledger in — after a push's reply, or a restore. Never
   *  loses a charge earned or spent on this device. */
  adopt(remote: BoosterLedger): void {
    this.ledger = mergeLedgers(this.ledger, remote);
    this.persist();
  }

  /** Spend one charge. Returns false, changing nothing, when none remain. */
  spend(kind: BoosterKind): boolean {
    if (!this.has(kind)) return false;
    this.bump('spent', kind, 1);
    this.persist();
    return true;
  }

  /** Add `n` charges of `kind`, clamped at the cap. Returns how many actually
   *  landed (0 at the cap), so the caller can say what was granted. */
  grant(kind: BoosterKind, n: number): number {
    if (!Number.isInteger(n) || n < 0) throw new RangeError(`grant must be a non-negative integer: ${n}`);
    const added = Math.min(n, BOOSTER_CAP - this.remaining(kind));
    if (added <= 0) return 0;
    this.bump('earned', kind, added);
    this.persist();
    return added;
  }

  /** Split `total` charges across the three types at random (`random` in
   *  [0, 1), injectable so a test can pin the outcome) and grant them,
   *  each type clamped at the cap. Returns what actually landed per type. */
  grantSplit(total: number, random: () => number): Counts {
    const got: Counts = { hint: 0, undo: 0, shuffle: 0 };
    for (let i = 0; i < total; i++) {
      const kind = BOOSTER_KINDS[Math.min(Math.floor(random() * BOOSTER_KINDS.length), BOOSTER_KINDS.length - 1)]!;
      got[kind] += this.grant(kind, 1);
    }
    return got;
  }

  /**
   * The daily first-launch grant (issue #51): DAILY_LOGIN_GRANT of each, once
   * per calendar day. `today` is the local date key (see core's
   * dailyDateKey). Granted only when today is strictly *after* the last
   * grant's date — a clock moved forward grants once, moved back grants
   * nothing, moved forward again to a day already granted grants nothing —
   * so the channel cannot be farmed by winding the device clock. Returns what
   * landed, or null when nothing was due.
   */
  grantDailyLogin(today: string): Counts | null {
    if (!isDateKey(today)) throw new RangeError(`not a date key: ${today}`);
    const last = this.ledger.day;
    if (last !== null && daysBetween(last, today) < 1) return null;
    // The date is set before the single write below, so a failed write drops
    // the date and the charges together.
    this.ledger = { ...this.ledger, day: today };
    return this.grantEach(DAILY_LOGIN_GRANT);
  }

  /** Add `n` charges of *every* booster, each clamped at the cap, in one
   *  write. Returns what actually landed per type. */
  grantEach(n: number): Counts {
    if (!Number.isInteger(n) || n < 0) throw new RangeError(`grant must be a non-negative integer: ${n}`);
    const got: Counts = { hint: 0, undo: 0, shuffle: 0 };
    for (const kind of BOOSTER_KINDS) {
      const added = Math.min(n, BOOSTER_CAP - this.remaining(kind));
      this.bump('earned', kind, added);
      got[kind] = added;
    }
    this.persist();
    return got;
  }

  /** Add `n` to one side of this device's own tally. */
  private bump(side: keyof DeviceTally, kind: BoosterKind, n: number): void {
    if (n <= 0) return;
    const own = this.ledger.devices[this.device] ?? { earned: zero(), spent: zero() };
    const next: DeviceTally = { ...own, [side]: { ...own[side], [kind]: own[side][kind] + n } };
    this.ledger = { ...this.ledger, devices: { ...this.ledger.devices, [this.device]: next } };
  }

  private persist(): void {
    if (!this.storage) return;
    try {
      this.storage.setItem(this.key, JSON.stringify({ device: this.device, ledger: this.ledger }));
    } catch {
      // Write-blocked storage (private mode, quota): charges stay in memory for
      // this session rather than taking the game down.
    }
  }
}
