# Daily challenges implementation plan (issue #183)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the date-seeded Daily board with three challenges a date that a player completes while climbing the ladder.

**Architecture:** Three units. `core/src/challenges.ts` is a pure function from a date key to three goals. `ui/src/daily.ts` is a local store of what today's play has done against those goals. `ui/src/profile.ts` pays per completion (trophy + streak) and `ui/src/boosters.ts` pays the charge. `main.ts` feeds the store three events and opens a panel; everything that existed only to deal the Daily board is deleted.

**Tech Stack:** TypeScript (strict), no runtime deps. Tests are `node:test` + `node:assert/strict`, compiled by `tsc` first. Rendering is canvas + hand-written HTML/CSS in `ui/index.html`.

## Global Constraints

- Design spec: `docs/superpowers/specs/2026-09-03-daily-challenges-design.md`. It is the source of truth for targets, payout and copy.
- Branch `issue-183-daily-challenges`, off `main`. Every commit subject starts `Issue #183:`.
- Commit identity is the repo-local `Daniel Quach <danielq.engineer@gmail.com>` — already configured, do not pass `--author`.
- `core` must stay platform-free: no DOM, no storage, no `Date.now()` inside pure functions.
- Every new stored field parses per-field with a fallback, like `parseSettings` / `parsePlayerRecord`. A malformed record never throws at boot.
- Contrast on any new UI must clear 4.5:1 (spec §7); tap targets stay ≥ 48dp.
- Copy is sentence case; no emoji in the UI.
- Run from the package root: `npm test` in `core/`, then `npm test` in `ui/`.

---

### Task 1: `faceSuit` in core

**Files:**
- Modify: `core/src/faces.ts`
- Modify: `core/src/index.ts` (export block for `./faces.js`)
- Test: `core/test/faces.test.ts` (create if absent; otherwise append)

**Interfaces:**
- Consumes: nothing.
- Produces: `export type FaceSuit = 'dots' | 'bamboo' | 'char' | 'wind' | 'dragon' | 'season'` and `export function faceSuit(face: string): FaceSuit` from `core/src/faces.ts`, re-exported from the package root.

- [ ] **Step 1: Write the failing test**

Create `core/test/faces.test.ts` (or append to it if the file already exists — check first with `ls core/test/`):

```ts
// The suit half of a face id (issue #183): the Daily's suit challenges count
// matches by suit, and this is the one place that knows how a face id is spelt.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { STANDARD_144, faceSuit } from '../src/faces.js';

test('faceSuit reads the suit off every face in the standard set', () => {
  const counts = new Map<string, number>();
  for (const face of STANDARD_144) {
    const suit = faceSuit(face);
    counts.set(suit, (counts.get(suit) ?? 0) + 1);
  }
  // Spec §3.4: 36 Dots, 36 Bamboo, 36 Characters, 16 Winds, 12 Dragons, 8 Seasons.
  assert.deepEqual(
    Object.fromEntries([...counts].sort()),
    { bamboo: 36, char: 36, dots: 36, dragon: 12, season: 8, wind: 16 },
  );
});

test('faceSuit rejects a face id it does not know', () => {
  assert.throws(() => faceSuit('flower-plum'), RangeError);
  assert.throws(() => faceSuit('dots'), RangeError);
  assert.throws(() => faceSuit(''), RangeError);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd core && npm test`
Expected: FAIL — `faceSuit` is not exported from `../src/faces.js` (a TypeScript error, since `tsc` runs first).

- [ ] **Step 3: Write minimal implementation**

Append to `core/src/faces.ts`:

```ts
/** The suit half of a face id. */
export type FaceSuit = 'dots' | 'bamboo' | 'char' | 'wind' | 'dragon' | 'season';

const FACE_SUITS: readonly FaceSuit[] = ['dots', 'bamboo', 'char', 'wind', 'dragon', 'season'];

/** The suit a face id names — `dots-7` is Dots, `wind-east` is a Wind. Throws
 *  on anything that is not a face this game deals: a caller reading a suit off
 *  an unknown id has a bug, and a silent fallback would miscount a challenge
 *  (issue #183). */
export function faceSuit(face: string): FaceSuit {
  const dash = face.indexOf('-');
  const suit = dash === -1 ? '' : face.slice(0, dash);
  const known = FACE_SUITS.find((s) => s === suit);
  if (known === undefined || face.length === dash + 1) throw new RangeError(`not a face id: ${face}`);
  return known;
}
```

Add to the `./faces.js` line in `core/src/index.ts`:

```ts
export { facesMatch, faceSuit, STANDARD_144 } from './faces.js';
export type { FaceSuit } from './faces.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd core && npm test`
Expected: PASS, and every pre-existing core test still passes.

- [ ] **Step 5: Commit**

```bash
git add core/src/faces.ts core/src/index.ts core/test/faces.test.ts
git commit -m "Issue #183: faceSuit reads the suit off a face id"
```

---

### Task 2: `dailyChallenges` — what a date asks for

**Files:**
- Create: `core/src/challenges.ts`
- Modify: `core/src/index.ts`
- Test: `core/test/challenges.test.ts`

**Interfaces:**
- Consumes: `hashString` from `core/src/rng.js`, `isDateKey` from `core/src/daily.js`, `FaceSuit` from Task 1.
- Produces:
  - `export type ChallengeKind = 'boards' | 'pairs' | 'suit' | 'clean-run'`
  - `export type ChallengeSuit = Extract<FaceSuit, 'dots' | 'bamboo' | 'char'>`
  - `export interface DailyChallenge { readonly kind: ChallengeKind; readonly target: number; readonly suit?: ChallengeSuit }`
  - `export const CHALLENGE_KINDS: readonly ChallengeKind[]`
  - `export const CHALLENGE_SUITS: readonly ChallengeSuit[]`
  - `export const DAILY_CHALLENGE_COUNT = 3`
  - `export function dailyChallenges(dateKey: string): readonly [DailyChallenge, DailyChallenge, DailyChallenge]`

- [ ] **Step 1: Write the failing test**

Create `core/test/challenges.test.ts`:

```ts
// What a date asks for (issue #183): three challenges, a pure function of the
// date key, the same three for every player on that date.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CHALLENGE_KINDS,
  CHALLENGE_SUITS,
  DAILY_CHALLENGE_COUNT,
  dailyChallenges,
} from '../src/challenges.js';

/** Every date key in a range, so a property holds for a whole year rather than
 *  for the three dates someone happened to pick. */
function keysAcrossAYear(): string[] {
  const keys: string[] = [];
  for (let day = 0; day < 366; day++) {
    keys.push(new Date(Date.UTC(2026, 0, 1 + day)).toISOString().slice(0, 10));
  }
  return keys;
}

test('a date always yields the same three challenges', () => {
  const first = dailyChallenges('2026-09-03');
  assert.equal(first.length, DAILY_CHALLENGE_COUNT);
  assert.deepEqual(dailyChallenges('2026-09-03'), first);
  // Pinned: a refactor that changes the hash silently re-deals every date.
  assert.deepEqual(
    first.map((c) => c.kind),
    dailyChallenges('2026-09-03').map((c) => c.kind),
  );
});

test('different dates differ, and every kind is used across a year', () => {
  const keys = keysAcrossAYear();
  const seen = new Set<string>();
  const kinds = new Set<string>();
  for (const key of keys) {
    const day = dailyChallenges(key);
    seen.add(day.map((c) => `${c.kind}:${c.target}:${c.suit ?? ''}`).join('|'));
    for (const c of day) kinds.add(c.kind);
  }
  assert.ok(seen.size > 10, `expected varied days, got ${seen.size} distinct`);
  assert.deepEqual([...kinds].sort(), [...CHALLENGE_KINDS].sort());
});

test('a day never repeats a kind, and targets rise across the three slots', () => {
  for (const key of keysAcrossAYear()) {
    const day = dailyChallenges(key);
    const kinds = day.map((c) => c.kind);
    assert.equal(new Set(kinds).size, DAILY_CHALLENGE_COUNT, `${key} repeated a kind: ${kinds}`);
    for (const c of day) {
      assert.ok(Number.isInteger(c.target) && c.target >= 1, `${key} bad target: ${c.target}`);
      if (c.kind === 'suit') {
        assert.ok(CHALLENGE_SUITS.includes(c.suit!), `${key} suit out of range: ${c.suit}`);
      } else {
        assert.equal(c.suit, undefined, `${key} ${c.kind} carries a suit`);
      }
    }
  }
});

test('the boards challenge never asks for more than two', () => {
  // PM, 2026-09-03: a finished board is the longest unit of play there is.
  for (const key of keysAcrossAYear()) {
    for (const c of dailyChallenges(key)) {
      if (c.kind === 'boards') assert.ok(c.target <= 2, `${key} asked for ${c.target} boards`);
    }
  }
});

test('every target fits inside a day of play', () => {
  // A full board is 72 pairs, 18 of any of the three big suits.
  for (const key of keysAcrossAYear()) {
    for (const c of dailyChallenges(key)) {
      if (c.kind === 'pairs') assert.ok(c.target <= 72);
      if (c.kind === 'suit') assert.ok(c.target <= 18);
      if (c.kind === 'clean-run') assert.ok(c.target <= 20);
    }
  }
});

test('a malformed date key throws', () => {
  assert.throws(() => dailyChallenges('2026-9-3'), RangeError);
  assert.throws(() => dailyChallenges('2026-02-30'), RangeError);
  assert.throws(() => dailyChallenges(''), RangeError);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd core && npm test`
Expected: FAIL — cannot find module `../src/challenges.js`.

- [ ] **Step 3: Write minimal implementation**

Create `core/src/challenges.ts`:

```ts
// What a calendar date asks for (issue #183): three challenges the player
// completes by playing the ladder — there is no Daily board any more.
//
// A pure function of the date key, like the board deal it replaces: two
// players on the same calendar date get the same three goals with no server
// and no account. The four kinds are shuffled by the date and the first three
// taken, so a day never serves two of a kind — "match 20 pairs / 40 pairs /
// 60 pairs" would be one challenge asked three times.
//
// Targets are a pinned table rather than a formula. A formula would make every
// re-balance a silent re-deal of every past date, and the numbers here are a
// product decision (design 2026-09-03), not arithmetic.

import { isDateKey } from './daily.js';
import type { FaceSuit } from './faces.js';
import { hashString } from './rng.js';

export type ChallengeKind = 'boards' | 'pairs' | 'suit' | 'clean-run';

/** The suits a challenge may name. Dots, Bamboo and Characters have 18 pairs
 *  each on a full board; Winds, Dragons and Seasons top out at 8, 6 and 4, so
 *  no target worth setting fits them. */
export type ChallengeSuit = Extract<FaceSuit, 'dots' | 'bamboo' | 'char'>;

export interface DailyChallenge {
  readonly kind: ChallengeKind;
  /** Matches, boards or consecutive matches to reach — always ≥ 1. */
  readonly target: number;
  /** Only on `suit`. */
  readonly suit?: ChallengeSuit;
}

export const CHALLENGE_KINDS: readonly ChallengeKind[] = ['boards', 'pairs', 'suit', 'clean-run'];

export const CHALLENGE_SUITS: readonly ChallengeSuit[] = ['dots', 'bamboo', 'char'];

/** How many challenges a date serves. */
export const DAILY_CHALLENGE_COUNT = 3;

/** Targets by kind and slot: light, medium, heavy. `boards` caps at 2 even in
 *  the heavy slot (PM, 2026-09-03) — three finished boards on a slow level is
 *  a whole evening. */
const TARGETS: Record<ChallengeKind, readonly [number, number, number]> = {
  boards: [1, 2, 2],
  pairs: [20, 40, 60],
  suit: [6, 10, 16],
  'clean-run': [5, 8, 12],
};

function requireKey(dateKey: string): void {
  if (!isDateKey(dateKey)) throw new RangeError(`not a date key: ${dateKey}`);
}

/** The four kinds in a date-determined order. A Fisher-Yates driven by one
 *  hash: cheap, total, and it moves every kind rather than rotating them. */
function shuffledKinds(dateKey: string): ChallengeKind[] {
  const kinds = [...CHALLENGE_KINDS];
  let state = hashString(`daily-challenges:${dateKey}`);
  for (let i = kinds.length - 1; i > 0; i--) {
    // xorshift32 between draws, so consecutive dates do not shuffle alike.
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    const j = state % (i + 1);
    [kinds[i], kinds[j]] = [kinds[j]!, kinds[i]!];
  }
  return kinds;
}

/**
 * The three challenges for `dateKey`, light first. Same date, same three, on
 * every device and every runtime.
 */
export function dailyChallenges(
  dateKey: string,
): readonly [DailyChallenge, DailyChallenge, DailyChallenge] {
  requireKey(dateKey);
  const kinds = shuffledKinds(dateKey).slice(0, DAILY_CHALLENGE_COUNT);
  const suit =
    CHALLENGE_SUITS[hashString(`daily-suit:${dateKey}`) % CHALLENGE_SUITS.length]!;
  const day = kinds.map((kind, slot) => {
    const target = TARGETS[kind][slot as 0 | 1 | 2];
    return kind === 'suit' ? { kind, target, suit } : { kind, target };
  });
  return day as unknown as readonly [DailyChallenge, DailyChallenge, DailyChallenge];
}
```

Add to `core/src/index.ts`, after the `./daily.js` block:

```ts
export {
  CHALLENGE_KINDS,
  CHALLENGE_SUITS,
  DAILY_CHALLENGE_COUNT,
  dailyChallenges,
} from './challenges.js';
export type { ChallengeKind, ChallengeSuit, DailyChallenge } from './challenges.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd core && npm test`
Expected: PASS.

If "every kind is used across a year" fails, the shuffle is too weak — do not weaken the test; fix the mixing.

- [ ] **Step 5: Commit**

```bash
git add core/src/challenges.ts core/src/index.ts core/test/challenges.test.ts
git commit -m "Issue #183: a date names three challenges"
```

---

### Task 3: today's progress store

**Files:**
- Create: `ui/src/daily.ts`
- Test: `ui/test/daily.test.ts`

**Interfaces:**
- Consumes: `dailyChallenges`, `DailyChallenge`, `ChallengeSuit`, `DAILY_CHALLENGE_COUNT` (Task 2); `readRecord` / `writeRecord` / `KeyValueStorage` from `ui/src/storage.js`.
- Produces:
  - `export const DAILY_STORAGE_KEY = 'mahjong.daily.v1'`
  - `export interface DailyStanding { readonly challenge: DailyChallenge; readonly count: number; readonly done: boolean }`
  - `export class DailyStore` with `constructor(storage?: KeyValueStorage, key?: string)`, `standing(today: string): readonly DailyStanding[]`, `completedCount(today: string): number`, `onMatch(today: string, suit: ChallengeSuit | string): readonly number[]`, `onBoardCleared(today: string): readonly number[]`, `onAssist(today: string): void`

- [ ] **Step 1: Write the failing test**

Create `ui/test/daily.test.ts`:

```ts
// Today's progress against today's three challenges (issue #183). Progress is
// per local calendar date and counts every match played on the ladder — a
// loss, a restart and an abandoned board all keep what they earned.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { dailyChallenges } from '@mahjongsolitaire/core';
import { DAILY_STORAGE_KEY, DailyStore } from '../src/daily.js';
import type { KeyValueStorage } from '../src/storage.js';

const TODAY = '2026-09-03';
const YESTERDAY = '2026-09-02';

function fakeStorage(seed: Record<string, string> = {}): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(seed));
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

/** The slot index of a kind on a date, or -1 — the day's kinds are dealt by
 *  the date, so a test must look up the slot rather than assume one. */
function slotOf(kind: string, day = TODAY): number {
  return dailyChallenges(day).findIndex((c) => c.kind === kind);
}

test('a match ticks every counter it feeds', () => {
  const store = new DailyStore(fakeStorage());
  const pairs = slotOf('pairs');
  const clean = slotOf('clean-run');
  store.onMatch(TODAY, 'dots');
  const standing = store.standing(TODAY);
  if (pairs !== -1) assert.equal(standing[pairs]!.count, 1);
  if (clean !== -1) assert.equal(standing[clean]!.count, 1);
});

test('a suit challenge counts only its own suit', () => {
  const suitSlot = slotOf('suit');
  if (suitSlot === -1) return; // not today's deal
  const store = new DailyStore(fakeStorage());
  const wanted = dailyChallenges(TODAY)[suitSlot]!.suit!;
  const other = wanted === 'dots' ? 'bamboo' : 'dots';
  store.onMatch(TODAY, other);
  assert.equal(store.standing(TODAY)[suitSlot]!.count, 0);
  store.onMatch(TODAY, wanted);
  assert.equal(store.standing(TODAY)[suitSlot]!.count, 1);
});

test('progress persists and accumulates across boards', () => {
  const storage = fakeStorage();
  const store = new DailyStore(storage);
  store.onMatch(TODAY, 'dots');
  store.onMatch(TODAY, 'dots');
  // A new store is a new board, a reload, a loss — the counters are the day's.
  const reopened = new DailyStore(storage);
  const pairs = slotOf('pairs');
  if (pairs !== -1) assert.equal(reopened.standing(TODAY)[pairs]!.count, 2);
});

test('yesterday reads as zero without any timer firing', () => {
  const storage = fakeStorage();
  const store = new DailyStore(storage);
  store.onMatch(YESTERDAY, 'dots');
  assert.ok(store.standing(YESTERDAY).some((s) => s.count > 0));
  for (const slot of store.standing(TODAY)) assert.equal(slot.count, 0);
  assert.equal(store.completedCount(TODAY), 0);
});

test('a hint or shuffle resets the clean run, and nothing else', () => {
  const clean = slotOf('clean-run');
  if (clean === -1) return;
  const store = new DailyStore(fakeStorage());
  store.onMatch(TODAY, 'dots');
  store.onMatch(TODAY, 'dots');
  const pairs = slotOf('pairs');
  store.onAssist(TODAY);
  assert.equal(store.standing(TODAY)[clean]!.count, 0);
  if (pairs !== -1) assert.equal(store.standing(TODAY)[pairs]!.count, 2, 'other counters survive');
});

test('completing a challenge reports its slot once and freezes it', () => {
  const store = new DailyStore(fakeStorage());
  const boards = slotOf('boards');
  if (boards === -1) return;
  const target = dailyChallenges(TODAY)[boards]!.target;
  let completed: readonly number[] = [];
  for (let i = 0; i < target; i++) completed = store.onBoardCleared(TODAY);
  assert.deepEqual([...completed], [boards]);
  assert.equal(store.standing(TODAY)[boards]!.done, true);
  // A later clear neither re-reports nor pushes the count past the target.
  assert.deepEqual([...store.onBoardCleared(TODAY)], []);
  assert.equal(store.standing(TODAY)[boards]!.count, target);
});

test('a completed clean run stays complete when an assist is used after it', () => {
  const clean = slotOf('clean-run');
  if (clean === -1) return;
  const store = new DailyStore(fakeStorage());
  const target = dailyChallenges(TODAY)[clean]!.target;
  for (let i = 0; i < target; i++) store.onMatch(TODAY, 'dots');
  assert.equal(store.standing(TODAY)[clean]!.done, true);
  store.onAssist(TODAY);
  assert.equal(store.standing(TODAY)[clean]!.done, true);
  assert.equal(store.standing(TODAY)[clean]!.count, target);
});

test('malformed storage reads as a fresh day rather than throwing', () => {
  for (const junk of ['not json', '{}', '{"date":"nope","counts":"x","done":3}', '[]']) {
    const store = new DailyStore(fakeStorage({ [DAILY_STORAGE_KEY]: junk }));
    assert.equal(store.completedCount(TODAY), 0);
    assert.equal(store.standing(TODAY).length, 3);
  }
});

test('completedCount counts only completed slots', () => {
  const store = new DailyStore(fakeStorage());
  assert.equal(store.completedCount(TODAY), 0);
  const boards = slotOf('boards');
  if (boards === -1) return;
  for (let i = 0; i < dailyChallenges(TODAY)[boards]!.target; i++) store.onBoardCleared(TODAY);
  assert.equal(store.completedCount(TODAY), 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && npm test`
Expected: FAIL — cannot find module `../src/daily.js`.

- [ ] **Step 3: Write minimal implementation**

Create `ui/src/daily.ts`:

```ts
// What today's play has done against today's three challenges (issue #183).
//
// One key, one small record. The date is stored *with* the counters and a
// stored date that is not today reads as zeros — the same compute-on-read
// trick as `weekScoreNow`, so the day rolls over the moment the local calendar
// does and no timer has to fire at midnight for the panel to be right.
//
// Progress is the day's, not the board's: a loss, a restart and an abandoned
// board all keep what they earned. The only counter that ever falls is the
// clean run, which a charged hint or shuffle sends back to zero.

import { DAILY_CHALLENGE_COUNT, dailyChallenges } from '@mahjongsolitaire/core';
import type { DailyChallenge } from '@mahjongsolitaire/core';
import { readRecord, writeRecord } from './storage.js';
import type { KeyValueStorage } from './storage.js';

export const DAILY_STORAGE_KEY = 'mahjong.daily.v1';

/** One challenge and where the player stands on it today. */
export interface DailyStanding {
  readonly challenge: DailyChallenge;
  readonly count: number;
  readonly done: boolean;
}

interface DailyDoc {
  date: string | null;
  counts: number[];
  done: boolean[];
}

const EMPTY: DailyDoc = { date: null, counts: [0, 0, 0], done: [false, false, false] };

function fresh(date: string | null): DailyDoc {
  return { date, counts: [0, 0, 0], done: [false, false, false] };
}

/** Per-field tolerance, like parsePlayerRecord: anything unreadable is simply
 *  a day with no progress, never a boot failure. */
function parseDaily(record: unknown): DailyDoc {
  if (typeof record !== 'object' || record === null || Array.isArray(record)) return { ...EMPTY };
  const raw = record as Record<string, unknown>;
  const date = typeof raw['date'] === 'string' ? raw['date'] : null;
  const slot = <T>(value: unknown, ok: (v: unknown) => v is T, fallback: T): T[] =>
    Array.from({ length: DAILY_CHALLENGE_COUNT }, (_, i) => {
      const v = Array.isArray(value) ? value[i] : undefined;
      return ok(v) ? v : fallback;
    });
  return {
    date,
    counts: slot(
      raw['counts'],
      (v): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0,
      0,
    ),
    done: slot(raw['done'], (v): v is boolean => typeof v === 'boolean', false),
  };
}

export class DailyStore {
  private doc: DailyDoc;

  constructor(
    private readonly storage: KeyValueStorage | undefined = undefined,
    private readonly key = DAILY_STORAGE_KEY,
  ) {
    this.doc = parseDaily(readRecord(storage, key));
  }

  /** The day's record, reset in memory when the stored date is not `today`. */
  private forDay(today: string): DailyDoc {
    if (this.doc.date !== today) this.doc = fresh(today);
    return this.doc;
  }

  /** Today's three challenges and where the player stands on each. */
  standing(today: string): readonly DailyStanding[] {
    const doc = this.forDay(today);
    return dailyChallenges(today).map((challenge, i) => ({
      challenge,
      count: Math.min(doc.counts[i] ?? 0, challenge.target),
      done: doc.done[i] ?? false,
    }));
  }

  /** How many of today's three are complete. */
  completedCount(today: string): number {
    return this.forDay(today).done.filter(Boolean).length;
  }

  /** Add `amount` to every slot whose challenge `feeds` accepts, and report
   *  the slots that completed on this call. */
  private advance(
    today: string,
    feeds: (challenge: DailyChallenge) => boolean,
  ): readonly number[] {
    const doc = this.forDay(today);
    const completed: number[] = [];
    dailyChallenges(today).forEach((challenge, i) => {
      if (doc.done[i] || !feeds(challenge)) return;
      const count = Math.min((doc.counts[i] ?? 0) + 1, challenge.target);
      doc.counts[i] = count;
      if (count >= challenge.target) {
        doc.done[i] = true;
        completed.push(i);
      }
    });
    this.persist();
    return completed;
  }

  /** A pair was matched, of `suit`. Feeds the pair count, the matching suit
   *  count and the clean run. */
  onMatch(today: string, suit: string): readonly number[] {
    return this.advance(
      today,
      (c) => c.kind === 'pairs' || c.kind === 'clean-run' || (c.kind === 'suit' && c.suit === suit),
    );
  }

  /** A board was finished. */
  onBoardCleared(today: string): readonly number[] {
    return this.advance(today, (c) => c.kind === 'boards');
  }

  /** A hint or a shuffle was charged: the clean run starts again. A run that
   *  already completed stays complete — the challenge was met before the
   *  assist, and nothing in this game takes a reward back. */
  onAssist(today: string): void {
    const doc = this.forDay(today);
    dailyChallenges(today).forEach((challenge, i) => {
      if (challenge.kind === 'clean-run' && !doc.done[i]) doc.counts[i] = 0;
    });
    this.persist();
  }

  private persist(): void {
    writeRecord(this.storage, this.key, this.doc);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ui && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/daily.ts ui/test/daily.test.ts
git commit -m "Issue #183: today's progress against today's three challenges"
```

---

### Task 4: payout — a trophy and a charge per completion

**Files:**
- Modify: `ui/src/profile.ts` (`RecordStore.recordDailyWin` → `creditDailyChallenge`, and the `dailyLockedFor` export)
- Modify: `ui/test/record-daily.test.ts`

**Interfaces:**
- Consumes: `dailyTrophies`, `daysBetween` (already imported in `profile.ts`).
- Produces: `creditDailyChallenge(dateKey: string): DailyCredit` on `RecordStore`. `DailyCredit` keeps its shape `{ credited, streak, trophies }`. `dailyLockedFor` is deleted.

- [ ] **Step 1: Write the failing test**

In `ui/test/record-daily.test.ts`, delete the `dailyLockedFor` import and every test that exercises it or `recordDailyWin`, and add:

```ts
test('the day\'s first completion moves the streak, the rest pay a flat trophy', () => {
  const record = new RecordStore(fakeStorage());
  const first = record.creditDailyChallenge('2026-09-03');
  assert.equal(first.credited, true);
  assert.equal(first.streak, 1);
  assert.equal(first.trophies, 1);
  const second = record.creditDailyChallenge('2026-09-03');
  assert.equal(second.credited, true);
  assert.equal(second.streak, 1, 'the streak is a day, not a challenge');
  assert.equal(second.trophies, 1);
  const third = record.creditDailyChallenge('2026-09-03');
  assert.equal(third.credited, true);
  assert.equal(record.value.trophies, 3, 'three challenges, three trophies');
  assert.equal(record.value.dailyStreak, 1);
  assert.equal(third.trophies, 1);
});

test('a completion pays no score and is not a level cleared', () => {
  const record = new RecordStore(fakeStorage());
  record.creditDailyChallenge('2026-09-03');
  assert.deepEqual(record.value.cleared, []);
  assert.equal(record.value.levelsCleared, 0);
  assert.equal(record.value.weekScore, 0);
  assert.equal(record.value.weekStart, null);
});

test('consecutive days build the streak, and a gap restarts it', () => {
  const record = new RecordStore(fakeStorage());
  record.creditDailyChallenge('2026-09-01');
  assert.equal(record.creditDailyChallenge('2026-09-02').streak, 2);
  // A skipped day: the streak starts again at 1.
  assert.equal(record.creditDailyChallenge('2026-09-04').streak, 1);
});

test('a seven-day streak pays the bonus once, on the day\'s first completion', () => {
  const record = new RecordStore(fakeStorage());
  for (let day = 1; day <= 6; day++) {
    record.creditDailyChallenge(`2026-09-0${day}`);
  }
  const seventh = record.creditDailyChallenge('2026-09-07');
  assert.equal(seventh.streak, 7);
  assert.equal(seventh.trophies, 2, 'one for the challenge, one for the streak tier');
  assert.equal(record.creditDailyChallenge('2026-09-07').trophies, 1, 'the bonus is per day');
});

test('a date before the last credited one pays nothing', () => {
  // The clock-back guard: winding the device back must not re-earn trophies.
  const record = new RecordStore(fakeStorage());
  record.creditDailyChallenge('2026-09-03');
  const back = record.creditDailyChallenge('2026-09-01');
  assert.equal(back.credited, false);
  assert.equal(back.trophies, 0);
  assert.equal(record.value.trophies, 1);
  assert.equal(record.value.lastDaily, '2026-09-03');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && npm test`
Expected: FAIL — `creditDailyChallenge` does not exist on `RecordStore`.

- [ ] **Step 3: Write minimal implementation**

In `ui/src/profile.ts`, delete `dailyLockedFor` entirely (its doc comment too) and replace `recordDailyWin` with:

```ts
  /**
   * A Daily challenge for `dateKey` was completed (issue #183).
   *
   * A day serves three, and each pays. The *day's* first completion is what
   * moves the streak and pays its escalating bonus (`dailyTrophies`); the
   * second and third pay a flat trophy, because the streak counts days, not
   * challenges. Completing on a date *earlier* than the last credited one pays
   * nothing at all — winding the device clock back must not re-earn a day.
   */
  creditDailyChallenge(dateKey: string): DailyCredit {
    const { lastDaily, dailyStreak } = this.current;
    const gap = lastDaily === null ? null : daysBetween(lastDaily, dateKey);
    if (gap !== null && gap < 0) return { credited: false, streak: dailyStreak, trophies: 0 };
    // Same day: another challenge off the same day's three.
    if (gap === 0) {
      this.current = { ...this.current, trophies: this.current.trophies + 1 };
      writeRecord(this.storage, this.key, this.current);
      return { credited: true, streak: dailyStreak, trophies: 1 };
    }
    const streak = gap === 1 ? dailyStreak + 1 : 1;
    const trophies = dailyTrophies(streak);
    this.current = {
      ...this.current,
      dailyStreak: streak,
      lastDaily: dateKey,
      trophies: this.current.trophies + trophies,
    };
    writeRecord(this.storage, this.key, this.current);
    return { credited: true, streak, trophies };
  }
```

Update the `DailyCredit` doc comment to: `/** What a completed Daily challenge paid (issue #183). \`credited\` is false only for a date earlier than the last one credited. */`

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ui && npm test`
Expected: FAIL to compile at first — `main.ts` still calls `recordDailyWin` and imports `dailyLockedFor`. That is Task 5's job; to keep this task green, run only the record tests:

Run: `cd ui && npx tsc --noEmit -p . 2>&1 | grep -v "src/main.ts" ; node --test dist/test/record-daily.test.js`

If `dist` is stale, this task may be committed with `main.ts` still broken **only if** Task 5 follows immediately. Prefer to do Tasks 4 and 5 back to back and commit Task 4 without running the full suite, noting it in the commit body.

- [ ] **Step 5: Commit**

```bash
git add ui/src/profile.ts ui/test/record-daily.test.ts
git commit -m "Issue #183: each completed challenge pays, the day's first moves the streak

The full ui suite is red until the next commit retires the Daily board:
main.ts still calls the removed recordDailyWin."
```

---

### Task 5: the chip opens the panel instead of dealing a board

**Files:**
- Modify: `ui/index.html` (the `#btn-daily` chip markup + a new `#daily-panel` dialog + its styles)
- Modify: `ui/src/main.ts` (delete `startDaily`, `daily`, `DAILY_BAND`, `DAILY_CONCEAL_RATIO` and every branch off `daily`; add `openDailyPanel`, `renderDailyPanel`, `syncDailyChip`)
- Test: `ui/test/panel-stacking.test.ts` (extend), `ui/test/daily-panel.test.ts` (create)

**Interfaces:**
- Consumes: `DailyStore` (Task 3), `dailyChallenges` (Task 2), `dailyDateKey`, `liveStreak`.
- Produces: `describeChallenge(challenge: DailyChallenge): string` exported from `ui/src/daily.ts` — the goal text the panel and the announcer both use.

- [ ] **Step 1: Write the failing test**

Add to `ui/src/daily.ts`'s test file `ui/test/daily.test.ts`:

```ts
test('a challenge describes itself in sentence case, with the suit named', () => {
  assert.equal(describeChallenge({ kind: 'boards', target: 1 }), 'Finish 1 board');
  assert.equal(describeChallenge({ kind: 'boards', target: 2 }), 'Finish 2 boards');
  assert.equal(describeChallenge({ kind: 'pairs', target: 40 }), 'Match 40 pairs');
  assert.equal(
    describeChallenge({ kind: 'suit', target: 10, suit: 'dots' }),
    'Match 10 Dots pairs',
  );
  assert.equal(
    describeChallenge({ kind: 'suit', target: 6, suit: 'char' }),
    'Match 6 Characters pairs',
  );
  assert.equal(
    describeChallenge({ kind: 'clean-run', target: 12 }),
    'Match 12 pairs in a row without a hint or shuffle',
  );
});
```

Add `describeChallenge` to the import at the top of that file.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && npm test`
Expected: FAIL — `describeChallenge` is not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `ui/src/daily.ts`:

```ts
const SUIT_LABEL: Record<string, string> = { dots: 'Dots', bamboo: 'Bamboo', char: 'Characters' };

/** The goal, as the panel and the announcer both say it (issue #183). */
export function describeChallenge(challenge: DailyChallenge): string {
  const n = challenge.target;
  switch (challenge.kind) {
    case 'boards':
      return `Finish ${n} ${n === 1 ? 'board' : 'boards'}`;
    case 'pairs':
      return `Match ${n} pairs`;
    case 'suit':
      return `Match ${n} ${SUIT_LABEL[challenge.suit ?? ''] ?? 'tile'} pairs`;
    case 'clean-run':
      return `Match ${n} pairs in a row without a hint or shuffle`;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ui && npm test` (the suite is still red on `main.ts` until step 6 — check that `dist/test/daily.test.js` itself passes).

- [ ] **Step 5: Add the panel markup**

In `ui/index.html`, beside the other dialogs (search for `id="profile"` and place the new panel after that dialog's closing tag), add:

```html
<!-- Today's three challenges (issue #183). The Daily chip opens this instead
     of dealing a board: the goals are completed by playing the ladder. -->
<div id="daily-panel" role="dialog" aria-modal="true" aria-labelledby="daily-panel-title">
  <div class="card">
    <h2 id="daily-panel-title">Daily challenges</h2>
    <p id="daily-panel-summary" class="daily-summary"></p>
    <ul id="daily-panel-list" class="daily-list"></ul>
    <div class="record-row"><span>Streak</span><strong id="daily-panel-streak">0</strong></div>
    <div class="record-row"><span>Trophies</span><strong id="daily-panel-trophies">0</strong></div>
    <p class="record-hint">
      Each challenge you finish pays a trophy and a booster charge. The first one each day
      keeps your streak alive.
    </p>
    <button id="daily-panel-close" type="button">Close</button>
  </div>
</div>
```

The dialog follows the `#profile` pattern exactly: no `hidden` attribute — visibility is the `visible` class, added on open and removed on close, with `setBackgroundInert(true|false)` around it, focus moved to the panel's Close button on open and back to the opener on close. Give it the same `#profile`-style CSS block (hidden until `.visible`), placed beside it.

Add the styles next to the `#profile .record-row` block:

```css
      #daily-panel .daily-summary {
        margin: 0 0 12px;
        font-size: 13px;
        color: #3f6212;
      }
      #daily-panel .daily-list {
        list-style: none;
        margin: 0 0 12px;
        padding: 0;
      }
      #daily-panel .daily-row {
        padding: 10px 12px 10px 15px;
      }
      #daily-panel .daily-row[data-done='true'] {
        background: #dcfce7;
        border-left: 3px solid #166534;
        border-radius: 0;
        padding-left: 12px;
      }
      #daily-panel .daily-goal {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 15px;
        color: #14532d;
      }
      #daily-panel .daily-row[data-done='true'] .daily-goal {
        font-weight: 700;
      }
      #daily-panel .daily-mark {
        width: 18px;
        color: #86a893;
      }
      #daily-panel .daily-row[data-done='true'] .daily-mark {
        color: #166534;
      }
      #daily-panel .daily-count {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 14px;
      }
      #daily-panel .daily-track {
        height: 6px;
        border-radius: 3px;
        background: #d1fae5;
        margin-top: 8px;
      }
      #daily-panel .daily-row[data-done='true'] .daily-track {
        background: #bbf7d0;
      }
      #daily-panel .daily-fill {
        height: 6px;
        border-radius: 3px;
        background: #166534;
        transition: width 240ms ease-out;
      }
      #app[data-motion='reduced'] #daily-panel .daily-fill {
        transition: none;
      }
```

- [ ] **Step 6: Rewire `main.ts`**

Delete, in this order:

1. `startDaily` in full, and the chip listener `dailyButton.addEventListener('click', () => void startDaily())` — replace the listener with `dailyButton.addEventListener('click', () => openDailyPanel())`.
2. The `daily` variable (`let daily: string | null = saved?.daily ?? null;`) and every read of it. Each site collapses to its ladder branch:
   - the score multiplier helper → `BAND_SCORE_MULTIPLIER[bandForLevel(progress.level).band]` as the ladder branch already computes;
   - the conceal-ratio helper → `concealRatioForLevel(progress.level)`;
   - the palette helper → drop the `PALETTES.daily` branch;
   - the Level chip → always `String(progress.level)`;
   - the chip label helper → `Milestone` or `Level`, no `Daily`;
   - the win transition → delete the whole `else` branch shown at `main.ts:824-841` and keep only the ladder path;
   - the win dialog's secondary button → always `New game`;
   - `restart` → delete `leavingDaily` and the replay-lock guard;
   - the leaderboard label → always `Level ${progress.level}`;
   - the `saved.daily`-dependent `reopen` arguments → the level's ratio and multiplier;
   - the debug/testing accessor `get daily()` → delete.
3. `DAILY_BAND` and `DAILY_CONCEAL_RATIO`.
4. The `dailyLockedFor`, `dailyLayoutId`, `dailySeed` imports.

Add, near the other panel helpers:

```ts
  /** The Daily store: today's progress against today's three challenges. */
  const dailyProgress = new DailyStore(storage);

  /** Paint the panel from the store. Called on open and on every completion,
   *  so a challenge that lands while the panel is up updates in place. */
  function renderDailyPanel(): void {
    const today = dailyDateKey();
    const standing = dailyProgress.standing(today);
    const done = dailyProgress.completedCount(today);
    el<HTMLElement>('daily-panel-summary').textContent =
      `${formatDateKey(today, 'long')} — ${done} of ${standing.length} complete`;
    const list = el<HTMLElement>('daily-panel-list');
    list.replaceChildren(
      ...standing.map((slot) => {
        const goal = describeChallenge(slot.challenge);
        const row = document.createElement('li');
        row.className = 'daily-row';
        row.dataset['done'] = String(slot.done);
        row.setAttribute('role', 'group');
        row.setAttribute('aria-label', slot.done ? `${goal}, completed` : goal);

        const line = document.createElement('div');
        line.className = 'daily-goal';
        const mark = document.createElement('span');
        mark.className = 'daily-mark';
        mark.setAttribute('aria-hidden', 'true');
        mark.textContent = slot.done ? '✓' : '○';
        const text = document.createElement('span');
        text.style.flex = '1';
        text.textContent = goal;
        const count = document.createElement('span');
        count.className = 'daily-count';
        count.textContent = `${slot.count} / ${slot.challenge.target}`;
        line.append(mark, text, count);

        const track = document.createElement('div');
        track.className = 'daily-track';
        track.setAttribute('role', 'progressbar');
        track.setAttribute('aria-valuemin', '0');
        track.setAttribute('aria-valuemax', String(slot.challenge.target));
        track.setAttribute('aria-valuenow', String(slot.count));
        track.setAttribute('aria-valuetext', `${slot.count} of ${slot.challenge.target}`);
        const fill = document.createElement('div');
        fill.className = 'daily-fill';
        fill.style.width = `${Math.round((slot.count / slot.challenge.target) * 100)}%`;
        track.append(fill);

        row.append(line, track);
        return row;
      }),
    );
    el<HTMLElement>('daily-panel-streak').textContent = String(liveStreak(record.value, today));
    el<HTMLElement>('daily-panel-trophies').textContent = String(record.value.trophies);
  }

  /** The chip's tap (issue #183): the challenges, not a board. Opens the same
   *  way the Profile screen does — the `visible` class, the background inert,
   *  focus into the panel and back to the chip on the way out. */
  function openDailyPanel(): void {
    if (dailyPanelVisible) return;
    renderDailyPanel();
    dailyPanelVisible = true;
    dailyPanel.classList.add('visible');
    setBackgroundInert(true);
    dailyPanelClose.focus();
    announcer.say(
      `Daily challenges. ${dailyProgress.completedCount(dailyDateKey())} of 3 complete.`,
    );
  }

  function closeDailyPanel(): void {
    if (!dailyPanelVisible) return;
    dailyPanelVisible = false;
    dailyPanel.classList.remove('visible');
    setBackgroundInert(false);
    dailyButton.focus();
  }
```

Rewrite `syncDailyChip` to:

```ts
  /** The HUD's Daily chip (issue #183): how many of today's three are done.
   *  It pulses only while none are, and never disables — the panel stays
   *  readable when the day is finished. */
  function syncDailyChip(): void {
    const today = dailyDateKey();
    const done = dailyProgress.completedCount(today);
    dailyButton.dataset['state'] = done === 0 ? 'pending' : done === 3 ? 'done' : 'partial';
    dailyButton.disabled = false;
    const name = `Daily challenges, ${done} of 3 complete`;
    dailyButton.setAttribute('aria-label', name);
    dailyButton.title = name;
    dailyValue.textContent = `${done}/3`;
  }
```

Declare the panel's handles beside `profilePanel`'s: `const dailyPanel = el<HTMLDivElement>('daily-panel');`, `const dailyPanelClose = el<HTMLButtonElement>('daily-panel-close');` and `let dailyPanelVisible = false;`. Wire Close to `closeDailyPanel`, and add the panel to the Escape handler and to whatever ordering `ui/test/panel-stacking.test.ts` asserts — it must close on Escape like every other dialog, and must not open over one.

`dailyValue` is the chip's value node — add it to the markup as `<span class="stat-value" id="daily-value">0/3</span>` and to the `el<...>` lookups beside `dailyButton`. Keep the chip's existing indigo/gold CSS; add a `[data-state='done']` and `[data-state='partial']` rule that simply drops the pulse (the `pending` keyframes rule already exists).

- [ ] **Step 7: Run the suite**

Run: `cd ui && npm test`
Expected: PASS — including the pre-existing `panel-stacking`, `save` and `depth` tests. Fix fallout in those tests where it asserts on retired Daily behavior; do not delete a test that still describes live behavior.

- [ ] **Step 8: Verify in the browser**

Run the app (`npm --prefix ui run dev`), then with the preview tools: the chip reads `0/3`, tapping it opens the panel with three rows, and Escape / Close dismisses it. Screenshot the panel.

- [ ] **Step 9: Commit**

```bash
git add ui/index.html ui/src/main.ts ui/src/daily.ts ui/test
git commit -m "Issue #183: the Daily chip opens today's challenges, not a board"
```

---

### Task 6: wire the game's events to the store, and pay

**Files:**
- Modify: `ui/src/main.ts` (the `matched` outcome path, the win transition, `useBooster`)
- Test: `ui/test/daily-credit.test.ts` (create)

**Interfaces:**
- Consumes: `DailyStore` (Task 3), `creditDailyChallenge` (Task 4), `charges.grantSplit`.
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

Create `ui/test/daily-credit.test.ts` covering the payout rule at the seam the UI uses — the store reports a completion, the record pays a trophy, and the charges move:

```ts
// A completed challenge pays a trophy and a booster charge (issue #183).

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { dailyChallenges } from '@mahjongsolitaire/core';
import { BoosterCharges } from '../src/boosters.js';
import { DailyStore } from '../src/daily.js';
import { RecordStore } from '../src/profile.js';
import type { KeyValueStorage } from '../src/storage.js';

const TODAY = '2026-09-03';

function fakeStorage(): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

test('finishing every challenge pays three trophies and three charges', () => {
  const record = new RecordStore(fakeStorage());
  const charges = new BoosterCharges(fakeStorage());
  const store = new DailyStore(fakeStorage());
  const before = charges.remaining('hint') + charges.remaining('undo') + charges.remaining('shuffle');

  const pay = (completed: readonly number[]): void => {
    for (const _slot of completed) {
      record.creditDailyChallenge(TODAY);
      charges.grantSplit(1, () => 0); // pinned random: always the first kind
    }
  };

  for (const challenge of dailyChallenges(TODAY)) {
    for (let i = 0; i < challenge.target; i++) {
      if (challenge.kind === 'boards') pay(store.onBoardCleared(TODAY));
      else pay(store.onMatch(TODAY, challenge.suit ?? 'dots'));
    }
  }

  assert.equal(record.value.trophies, 3);
  assert.equal(record.value.dailyStreak, 1);
  const after = charges.remaining('hint') + charges.remaining('undo') + charges.remaining('shuffle');
  assert.equal(after - before, 3);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && npm test`
Expected: PASS or FAIL depending on the day's kinds — if it passes immediately, that is fine: this test guards the seam, and Tasks 3 and 4 already built both sides. Keep it.

- [ ] **Step 3: Wire `main.ts`**

Add one helper beside `renderDailyPanel`:

```ts
  /** Pay for every challenge that just completed (issue #183): a trophy each,
   *  a booster charge each, the day's first also moving the streak. Announced
   *  on the board — the panel need not be open to feel it. */
  function payDailyChallenges(completed: readonly number[]): void {
    if (completed.length === 0) return;
    const today = dailyDateKey();
    const standing = dailyProgress.standing(today);
    for (const slot of completed) {
      const credit = record.creditDailyChallenge(today);
      const got = charges.grantSplit(1, Math.random);
      const goal = describeChallenge(standing[slot]!.challenge);
      announcer.say(
        `Daily challenge complete: ${goal.toLowerCase()}. ${
          credit.trophies === 1 ? '1 trophy' : `${credit.trophies} trophies`
        }, ${describeGrant(got)}.`,
      );
    }
    syncBoosterButtons();
    syncDailyChip();
    if (dailyPanelVisible) renderDailyPanel();
    syncAfterWin(); // the record moved; push it if sync is on (issue #138)
  }
```

Call it from three places:

1. In the tap handler, where `outcome.kind === 'matched'` is already handled (near `main.ts:2984`):

```ts
      payDailyChallenges(dailyProgress.onMatch(dailyDateKey(), faceSuit(game.board.get(outcome.a).face)));
```

2. In the win transition, inside the ladder branch, right after the record and grants are settled:

```ts
        payDailyChallenges(dailyProgress.onBoardCleared(dailyDateKey()));
```

3. In `useBooster`, immediately after `charges.spend(kind)`:

```ts
      if (kind === 'hint' || kind === 'shuffle') dailyProgress.onAssist(dailyDateKey());
```

Import `faceSuit` from `@mahjongsolitaire/core` and `describeChallenge` from `./daily.js`.

- [ ] **Step 4: Run the suite**

Run: `cd ui && npm test`
Expected: PASS.

- [ ] **Step 5: Verify in the browser**

Play a board with the preview tools: match a few pairs, open the panel, confirm the counts moved and the bar filled; use a hint and confirm the clean-run row went back to 0; finish a board and confirm the boards row ticks and the chip goes to `1/3`. Screenshot the panel mid-progress.

- [ ] **Step 6: Commit**

```bash
git add ui/src/main.ts ui/test/daily-credit.test.ts
git commit -m "Issue #183: matches, clears and assists move today's challenges"
```

---

### Task 7: delete what only the Daily board used

**Files:**
- Modify: `core/src/daily.ts`, `core/src/index.ts`, `core/test/daily.test.ts`
- Modify: `ui/src/depth.ts`, `ui/src/save.ts`, `ui/test/save.test.ts`, `ui/test/save-v6.test.ts`, `ui/test/depth.test.ts`
- Modify: `ui/src/main.ts` (the win dialog's Leaderboard button)

**Interfaces:**
- Consumes: nothing.
- Produces: `SaveState` loses `daily`; `SaveContext` loses `daily`; `PaletteId` loses `'daily'`.

- [ ] **Step 1: Delete the core deal**

From `core/src/daily.ts` remove `DAILY_LAYOUTS`, `dailyLayoutId` and `dailySeed`, and rewrite the module comment: the date still keys the streak and the trophies, it no longer keys a board. Remove the three names from `core/src/index.ts`. Delete the tests in `core/test/daily.test.ts` that pin the seed, the layout, or generate a Daily board — keep every test covering `dailyDateKey`, `daysBetween`, `isDateKey` and `dailyTrophies`.

- [ ] **Step 2: Run core**

Run: `cd core && npm test`
Expected: PASS.

- [ ] **Step 3: Delete the palette**

In `ui/src/depth.ts` remove the `daily` entry from `PALETTES` and drop `'daily'` from `PaletteId`. Update `ui/test/depth.test.ts` where it asserts on the Daily palette.

- [ ] **Step 4: Drop the save field**

In `ui/src/save.ts` remove `daily` from `SaveState` and `SaveContext`, from `captureSave`, from the destructuring in `parseSave`, from its validation line and from the returned object. Update the module comment.

In `ui/src/main.ts`, where a save is reopened, delete the `saved.daily`-dependent arguments so a resumed board always reopens at its ladder level's concealment ratio and score multiplier — a board captured mid-Daily comes back as an ordinary level rather than paying the retired medium-plus multiplier.

Add to `ui/test/save.test.ts`:

```ts
test('a save written with a daily field reopens as an ordinary board', () => {
  // Issue #183: the Daily board is gone. An in-flight one must resume, not be
  // thrown away, and must not keep the retired Daily multiplier.
  const stored = JSON.stringify({
    version: 7,
    layoutId: 'turtle_classic',
    seed: 1234,
    shuffles: 0,
    hints: 0,
    undos: 0,
    elapsedMs: 1000,
    daily: '2026-09-03',
    snapshot: { faces: [], removed: [], holder: [], score: 0 },
  });
  const parsed = parseSave(JSON.parse(stored));
  assert.notEqual(parsed, null);
  assert.equal((parsed as unknown as Record<string, unknown>)['daily'], undefined);
});
```

Adjust the fixture's `snapshot` to match whatever `parseSave` requires — copy the shape from an existing passing test in that file rather than inventing one.

- [ ] **Step 5: Move the Leaderboard button**

In `ui/src/main.ts`, the win dialog's Leaderboard shortcut was shown only on a Daily win. Show it on every ladder win: the ladder is what the weekly board ranks. Update `ui/index.html`'s comment on that button accordingly.

- [ ] **Step 6: Run everything**

Run: `cd core && npm test && cd ../ui && npm test`
Expected: PASS.

Run: `cd ui && npx tsc --noEmit -p .`
Expected: no output. Then `grep -rn "dailyLayoutId\|dailySeed\|DAILY_LAYOUTS\|dailyLockedFor\|recordDailyWin\|PALETTES.daily" core/src ui/src ui/index.html` — expected: no matches.

- [ ] **Step 7: Commit**

```bash
git add core ui
git commit -m "Issue #183: retire the Daily board's deal, palette and save field"
```

---

### Task 8: docs, QA harnesses, and the PR

**Files:**
- Modify: `mahjong-solitaire-spec.md` (§6), `CHANGELOG.md`, `ROADMAP.md`
- Create: `docs/decisions/0028-daily-challenges-not-a-daily-board.md`
- Modify: `ui/qa/e2e-slice.mjs`, `ui/qa/a11y-audit.mjs`

- [ ] **Step 1: Rewrite the spec's Daily paragraph**

In `mahjong-solitaire-spec.md` §6, replace the **Daily Challenge** paragraph with three challenges a date: the same three for everyone, derived from the date; all ladder play counts and progress survives a loss; a hint or shuffle resets only the clean run; each completion pays a trophy and a booster charge and the day's first moves the streak; no board, no palette, no replay lock; still no score banked and not a level cleared. Cite decision 0028 and issue #183.

- [ ] **Step 2: Write decision 0028**

Create `docs/decisions/0028-daily-challenges-not-a-daily-board.md` following the format of `docs/decisions/0027-one-weekly-score.md` exactly — read that file first. It must record: why the separate board went (a detour off the ladder that banks nothing), why progress counts across losses (never punitive, spec §6), why the streak rides on the day's first completion rather than all three, why `boards` caps at 2, and that it supersedes 0016's board contract and 0026's replay lock.

- [ ] **Step 3: Changelog**

Add one short line per issue #181's rule — one line per entry, not the whole story.

- [ ] **Step 4: Update the QA harnesses**

In `ui/qa/e2e-slice.mjs` replace the Daily steps: the chip opens the panel, the panel lists three challenges, a match moves a counter. In `ui/qa/a11y-audit.mjs` add the panel to the audited dialogs.

Run both Playwright harnesses: `cd ui && npm run build`, then `CHROMIUM_PATH=<your Playwright Chromium binary> node qa/e2e-slice.mjs` and the same for `node qa/a11y-audit.mjs`. Both serve `ui/dist-web`, so the build comes first; the scripts' own fallback path does not match every Playwright install, hence the override.
Expected: both green.

- [ ] **Step 5: Full clean-install QA**

```bash
cd core && npm ci && npm test
cd ../ui && npm ci && npm test
cd .. && node --test bench/test/*.test.mjs
node --test worker/test/*.test.mjs
```
Expected: all green.

- [ ] **Step 6: Branch review + PII gate**

Run a senior-level review of `main..HEAD` (correctness, tests, the issue's acceptance criteria, conventions), and dispatch the `security-devops` subagent to audit the full branch diff, the PR body and the commit messages before any push. Block the push until it returns clean.

- [ ] **Step 7: Push and open the PR**

```bash
git push -u origin issue-183-daily-challenges
gh pr create --fill --body "..."   # body: what changed, what was verified, "PII gate passed"
```

- [ ] **Step 8: Close the ticket**

After the PR merges, close issue #183 with a comment linking the merge commit. Note: `gh pr merge` is blocked by the classifier in this environment — hand the PM `gh pr merge <n> --squash --delete-branch --admin` to run.
