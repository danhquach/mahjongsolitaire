// Auto-save + resume (issue #14, spec §7/§9).
//
// Acceptance criterion (spec §11.2): "Save/restore across force-quit at every
// move index of a sample level." The sample level is the shipped Turtle deal,
// and the assertion at each index is a full force-quit simulation — capture,
// JSON round-trip through a storage fake, re-parse, regenerate the deal from
// `(layoutId, seed)`, reopen — checked against `MoveStack.stateHash()`, which
// covers every tile's face and removed flag, the selection, and the score
// ladder. Anything less than an identical hash is a resume that lost state.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { generateValidatedLevel, parseLayout } from '@mahjongsolitaire/core';
import type { Layout, TileId } from '@mahjongsolitaire/core';
import { Game } from '../src/game.js';
import { SAVE_STORAGE_KEY, SAVE_VERSION, SaveStore, captureSave, parseSave, reopen } from '../src/save.js';
import type { SaveState } from '../src/save.js';
import type { Hit } from '../src/hit-test.js';
import type { KeyValueStorage } from '../src/storage.js';

const TURTLE_URL = new URL('../../../data/layouts/turtle_classic.json', import.meta.url);
const TURTLE: Layout = parseLayout(JSON.parse(readFileSync(TURTLE_URL, 'utf8')));
const SAMPLE_SEED = 20260831;

const free = (id: TileId): Hit => ({ kind: 'free', id, forgiven: false });

/** In-memory KeyValueStorage — what localStorage does, minus the browser. */
function fakeStorage(seed: Record<string, string> = {}): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(seed));
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

/** The whole force-quit path: capture → JSON → parse → regenerate → reopen. */
function forceQuit(game: Game, context = { shuffles: 0, elapsedMs: 0 }): Game | null {
  const storage = fakeStorage();
  const store = new SaveStore(storage, SAVE_STORAGE_KEY);
  store.write(captureSave(game, context));
  const loaded = store.load();
  assert.notEqual(loaded, null, 'the written save must survive a JSON round-trip');
  return reopen(TURTLE, loaded!);
}

/** A game's full observable state — the hash plus what the HUD shows. */
function fingerprint(game: Game) {
  return {
    hash: game.stateHash(),
    score: game.score,
    tilesLeft: game.tilesLeft,
    selection: game.selection,
    undoDepth: game.undoDepth,
    status: game.status(),
  };
}

// --- the acceptance criterion -------------------------------------------------

test('spec §11.2: save/restore at every move index of the Turtle sample level', () => {
  const level = generateValidatedLevel(TURTLE, SAMPLE_SEED);
  const game = new Game(level);
  const solution = level.solution;
  // Index 0 is the untouched deal; index 72 is the cleared board.
  for (let index = 0; index <= solution.length; index++) {
    const resumed = forceQuit(game, { shuffles: 0, elapsedMs: index * 1500 });
    assert.notEqual(resumed, null, `move index ${index}: resume was refused`);
    assert.deepEqual(fingerprint(resumed!), fingerprint(game), `move index ${index}`);

    const move = solution[index];
    if (!move) break;
    game.tap(free(move[0]), index * 2);
    game.tap(free(move[1]), index * 2 + 1);
  }
  assert.equal(game.tilesLeft, 0, 'the sample level was played to completion');
});

test('a resumed game keeps playing identically to one that never quit', () => {
  const level = generateValidatedLevel(TURTLE, SAMPLE_SEED);
  const live = new Game(level);
  for (const [a, b] of level.solution.slice(0, 20)) {
    live.tap(free(a), 0);
    live.tap(free(b), 0);
  }
  const resumed = forceQuit(live)!;
  // Same 10 further moves, same timestamps: the combo ladder must agree too.
  for (const [a, b] of level.solution.slice(20, 30)) {
    for (const g of [live, resumed]) {
      g.tap(free(a), 0);
      g.tap(free(b), 0);
    }
  }
  assert.deepEqual(fingerprint(resumed), fingerprint(live));
});

test('resume restores a live selection, and the undo stack behind it', () => {
  const level = generateValidatedLevel(TURTLE, SAMPLE_SEED);
  const game = new Game(level);
  for (const [a, b] of level.solution.slice(0, 5)) {
    game.tap(free(a), 0);
    game.tap(free(b), 0);
  }
  game.tap(free(level.solution[5]![0]), 0); // first tap of a pair: selection live
  assert.notEqual(game.selection, null);

  const resumed = forceQuit(game)!;
  assert.equal(resumed.selection, game.selection);
  assert.equal(resumed.undoDepth, 5);
  // Unlimited undo depth (spec §5) survives the quit, all the way back.
  while (resumed.undo());
  assert.equal(resumed.tilesLeft, level.tiles.length);
  assert.equal(resumed.score, 0);
});

test('resume reproduces shuffled faces, including undo across a shuffle', () => {
  const level = generateValidatedLevel(TURTLE, SAMPLE_SEED);
  const game = new Game(level);
  for (const [a, b] of level.solution.slice(0, 8)) {
    game.tap(free(a), 0);
    game.tap(free(b), 0);
  }
  assert.equal(game.shuffle(0xbeef), true);
  // Undo *after* a shuffle is exactly the case a move-list replay cannot
  // reproduce (see save.ts): the restored pair predates the shuffle.
  assert.notEqual(game.undo(), null);

  const resumed = forceQuit(game, { shuffles: 1, elapsedMs: 0 })!;
  assert.deepEqual(fingerprint(resumed), fingerprint(game));
  assert.deepEqual(
    [...resumed.board.allTiles()].sort((a, b) => a.id - b.id).map((t) => t.face),
    [...game.board.allTiles()].sort((a, b) => a.id - b.id).map((t) => t.face),
  );
});

test('the save carries the session fields the HUD needs back', () => {
  const game = new Game(generateValidatedLevel(TURTLE, SAMPLE_SEED));
  const save = captureSave(game, { shuffles: 3, elapsedMs: 91400 });
  assert.equal(save.version, SAVE_VERSION);
  assert.equal(save.layoutId, 'turtle_classic');
  assert.equal(save.seed, SAMPLE_SEED);
  assert.equal(save.shuffles, 3);
  assert.equal(save.elapsedMs, 91400);
});

// --- rejecting what cannot be trusted -----------------------------------------

/** Three pairs played on real, advancing timestamps — an all-zero clock would
 *  make the elapsed-time rejection cases below vacuous. */
function sampleSave(): SaveState {
  const game = new Game(generateValidatedLevel(TURTLE, SAMPLE_SEED));
  const solution = game.level.solution;
  solution.slice(0, 3).forEach(([a, b], i) => {
    game.tap(free(a), (i + 1) * 100);
    game.tap(free(b), (i + 1) * 100 + 10);
  });
  return captureSave(game, { shuffles: 0, elapsedMs: 1000 });
}

const snap = (save: Record<string, unknown>): Record<string, unknown> =>
  save['snapshot'] as Record<string, unknown>;
const stack = (save: Record<string, unknown>): Record<string, unknown> =>
  snap(save)['stack'] as Record<string, unknown>;

/** Deep clone through JSON — mutating a save the way a hand-edit would. */
function corrupt(mutate: (save: Record<string, unknown>) => void): unknown {
  const raw = JSON.parse(JSON.stringify(sampleSave())) as Record<string, unknown>;
  mutate(raw);
  return raw;
}

test('a well-formed save parses; an absent one is simply absent', () => {
  assert.notEqual(parseSave(JSON.parse(JSON.stringify(sampleSave()))), null);
  assert.equal(new SaveStore(fakeStorage()).load(), null);
  assert.equal(parseSave(null), null);
});

test('parseSave rejects every malformed record instead of trusting it', () => {
  const cases: Record<string, (save: Record<string, unknown>) => void> = {
    'wrong version': (s) => void (s['version'] = 2),
    'missing layoutId': (s) => void delete s['layoutId'],
    'non-integer seed': (s) => void (s['seed'] = 1.5),
    'unsafe-integer seed': (s) => void (s['seed'] = Number.MAX_SAFE_INTEGER + 2),
    'negative elapsed': (s) => void (s['elapsedMs'] = -1),
    'negative shuffles': (s) => void (s['shuffles'] = -2),
    'no snapshot': (s) => void delete s['snapshot'],
    'empty faces': (s) => void (snap(s)['faces'] = []),
    'non-string face': (s) => void ((snap(s)['faces'] as unknown[])[0] = 7),
    'duplicate removal': (s) => void (snap(s)['removed'] = [4, 4, 5, 6, 7, 8]),
    'unsorted removals': (s) => void (snap(s)['removed'] = (snap(s)['removed'] as number[]).reverse()),
    'removals without moves': (s) => void (stack(s)['moves'] = []),
    'move outside the removals': (s) => void ((stack(s)['moves'] as Record<string, unknown>[])[0]!['a'] = 999),
    'self-matching move': (s) => {
      const move = (stack(s)['moves'] as Record<string, unknown>[])[0]!;
      move['b'] = move['a'];
    },
    'backwards timestamps': (s) => {
      const moves = stack(s)['moves'] as Record<string, unknown>[];
      moves[0]!['atMs'] = 500;
      moves[1]!['atMs'] = 100;
    },
    // The two cases a membership-and-count check let through: a record that
    // claims one tile twice (and so orphans another) parses, reopens, and
    // hashes identically to an honest game, then throws out of Board.restore
    // several undos later.
    'a tile claimed by two moves': (s) => {
      const moves = stack(s)['moves'] as Record<string, unknown>[];
      moves[1]!['a'] = moves[0]!['a'];
    },
    'a removal no move accounts for': (s) => {
      const moves = stack(s)['moves'] as Record<string, unknown>[];
      moves.pop(); // leaves two removals unexplained
    },
    'elapsed time behind the last match': (s) => void (s['elapsedMs'] = 0),
    'elapsed time behind a move timestamp': (s) => {
      stack(s)['scores'] = { score: 300, streak: 0, lastMatchMs: null };
      s['elapsedMs'] = 1;
    },
    'malformed score snapshot': (s) => void (stack(s)['scores'] = { score: -1, streak: 0, lastMatchMs: null }),
    'non-integer selection': (s) => void (stack(s)['selection'] = 'first'),
  };
  for (const [name, mutate] of Object.entries(cases)) {
    assert.equal(parseSave(corrupt(mutate)), null, `should reject: ${name}`);
  }
});

test('unreadable storage reads as no save, and a blocked write is not fatal', () => {
  const hostile: KeyValueStorage = {
    getItem: () => '{not json',
    setItem: () => {
      throw new Error('QuotaExceededError');
    },
    removeItem: () => {
      throw new Error('blocked');
    },
  };
  const store = new SaveStore(hostile);
  assert.equal(store.load(), null);
  assert.doesNotThrow(() => store.write(sampleSave()));
  assert.doesNotThrow(() => store.clear());
});

test('reopen refuses a save that does not belong to this deal', () => {
  const save = sampleSave();
  const otherLayout: Layout = { ...TURTLE, id: 'other_layout' };
  assert.equal(reopen(otherLayout, save), null, 'a different layout is not this save');

  // A snapshot with the wrong tile count (a layout that has since changed).
  const shortened: SaveState = {
    ...save,
    snapshot: { ...save.snapshot, faces: save.snapshot.faces.slice(0, 100) },
  };
  assert.equal(reopen(TURTLE, shortened), null);

  // A selection that is not free on the restored board.
  const buried: SaveState = {
    ...save,
    snapshot: { ...save.snapshot, stack: { ...save.snapshot.stack, selection: save.snapshot.removed[0]! } },
  };
  assert.equal(reopen(TURTLE, buried), null);
});

test('clear removes the save, so the next boot deals a fresh level', () => {
  const storage = fakeStorage();
  const store = new SaveStore(storage);
  store.write(sampleSave());
  assert.notEqual(store.load(), null);
  store.clear();
  assert.equal(store.load(), null);
  assert.equal(storage.data.size, 0);
});

// --- the resume clock ---------------------------------------------------------

test('every saved move timestamp is within the saved elapsed time', () => {
  // The contract that makes a resumed game playable: the app's clock is elapsed
  // *play* time (main.ts), which the save carries, so play can continue from
  // `elapsedMs` without ever handing the ScoreKeeper a backwards timestamp.
  const level = generateValidatedLevel(TURTLE, SAMPLE_SEED);
  const game = new Game(level);
  level.solution.slice(0, 6).forEach(([a, b], i) => {
    game.tap(free(a), i * 1000);
    game.tap(free(b), i * 1000 + 10);
  });
  const save = captureSave(game, { shuffles: 0, elapsedMs: 5_010 });
  const stamps = save.snapshot.stack.moves.map((m) => m.atMs);
  assert.ok(stamps.every((ms) => ms <= save.elapsedMs), `${stamps} vs ${save.elapsedMs}`);
});

test('a resumed game accepts the next match at the restored elapsed time', () => {
  // Regression (found by qa/e2e-slice.mjs section 7): resuming with a clock
  // that restarts at 0 — performance.now() on a fresh page — made the very
  // next match throw "timestamps must be monotonic" and silently do nothing.
  const level = generateValidatedLevel(TURTLE, SAMPLE_SEED);
  const game = new Game(level);
  level.solution.slice(0, 4).forEach(([a, b], i) => {
    game.tap(free(a), 10_000 + i * 1000);
    game.tap(free(b), 10_000 + i * 1000 + 10);
  });
  const elapsedMs = 13_010;
  const resumed = forceQuit(game, { shuffles: 0, elapsedMs })!;

  const [a, b] = level.solution[4]!;
  resumed.tap(free(a), elapsedMs + 1);
  const outcome = resumed.tap(free(b), elapsedMs + 2);
  assert.equal(outcome.kind, 'matched');
  assert.equal(resumed.tilesLeft, game.tilesLeft - 2);

  // And the opposite: a clock that restarted at 0 is exactly what used to break.
  const restarted = forceQuit(game, { shuffles: 0, elapsedMs })!;
  restarted.tap(free(a), 0);
  assert.throws(() => restarted.tap(free(b), 1), /monotonic/);
});
