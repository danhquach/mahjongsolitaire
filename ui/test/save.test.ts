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
import { HOLDER_SLOTS, concealedTileIds, generateValidatedLevel, parseLayout } from '@mahjongsolitaire/core';
import type { Layout, TileId } from '@mahjongsolitaire/core';
import { Game } from '../src/game.js';
import { SAVE_STORAGE_KEY, SAVE_VERSION, SaveStore, captureSave, parseSave, reopen } from '../src/save.js';
import type { SaveState } from '../src/save.js';
import type { Hit } from '../src/hit-test.js';
import type { KeyValueStorage } from '../src/storage.js';

const TURTLE_URL = new URL('../../../data/layouts/turtle_classic.json', import.meta.url);
const TURTLE: Layout = parseLayout(JSON.parse(readFileSync(TURTLE_URL, 'utf8')));
// Re-picked for the issue #99 compact turtle: the tap-gesture replay in
// sampleSave needs the first dozen witness pairs to carry distinct faces
// (a face collision would clear across pairs via the holder).
const SAMPLE_SEED = 20260832;

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
    holder: game.holderSlots(),
    holdsUsed: game.holdsUsed,
  };
}

/** Issue #93's park: one tap on a revealed free tile is the whole gesture. */
function park(game: Game, id: TileId, atMs: number): void {
  reveal(game, id, atMs);
  game.tap(free(id), atMs + 1);
}

/** Peek a face-down tile so the next tap acts on it (issue #64: the first tap
 *  on a hidden tile only reveals it). No-op for a face-up tile. */
function reveal(game: Game, id: TileId, nowMs: number): void {
  if (game.isFaceHidden(id)) game.tap(free(id), nowMs);
}

/** Tap a tile wherever it is. A held tile is a no-op (issue #93: a held tile
 *  is not tappable — its partner's board tap is what clears the pair). */
function tapAnywhere(game: Game, id: TileId, nowMs: number): void {
  if (game.board.isHeld(id) || game.board.get(id).removed) return;
  reveal(game, id, nowMs);
  game.tap(free(id), nowMs);
}

/** In-play copies of a tile's face, the holder included. */
function copiesInPlay(game: Game, id: TileId): number {
  const face = game.board.get(id).face;
  return game.board.inPlayTiles().filter((t) => t.face === face).length;
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
    tapAnywhere(game, move[0], index * 2);
    tapAnywhere(game, move[1], index * 2 + 1);
  }
  assert.equal(game.tilesLeft, 0, 'the sample level was played to completion');
});

test('issue #43: save/restore at every move index of a level played with holds', () => {
  // Same force-quit sweep as above, on a game that uses the holder throughout:
  // the solution witness stays playable regardless, because a parked tile is
  // still matchable — it just has to be tapped in the holder rather than on the
  // board. Parks are taken on a fixed cadence so the sweep crosses the holder's
  // states: empty, part full, and emptied again as the solution reaches each
  // parked tile.
  //
  // Only a face with exactly two copies still in play is ever parked, and never
  // one already in the holder. That keeps the solution witness in step with the
  // one-tap clear (issue #62 rule 2): the parked tile's only partner is its own
  // solution partner, so the pair is always played as the solution intended —
  // sometimes as select-then-match, sometimes as one tap that clears both.
  const level = generateValidatedLevel(TURTLE, SAMPLE_SEED);
  const game = new Game(level);
  let holds = 0;
  for (let index = 0; index <= level.solution.length; index++) {
    const resumed = forceQuit(game, { shuffles: 0, elapsedMs: index * 1500 });
    assert.notEqual(resumed, null, `move index ${index}: resume was refused`);
    assert.deepEqual(fingerprint(resumed!), fingerprint(game), `move index ${index}`);

    const move = level.solution[index];
    if (!move) break;
    const t = index * 4;
    // Park an extra free tile every third move, so a force-quit lands on a
    // mid-hold state. Since issue #93 every pair transits the holder too, so
    // the backlog is capped: the transit park needs a slot of its own, and a
    // backlog of three would make it the fatal fourth (decision 0009).
    if (index % 3 === 0 && game.holderVacancies >= 3) {
      const parkedFaces = new Set(
        game
          .holderSlots()
          .filter((id): id is TileId => id !== null)
          .map((id) => game.board.get(id).face),
      );
      const target = game.board
        .freeTileIds()
        .find((id) => copiesInPlay(game, id) === 2 && !parkedFaces.has(game.board.get(id).face));
      if (target !== undefined) {
        reveal(game, target, t);
        if (game.tap(free(target), t + 1).kind === 'held') holds++;
      }
    }
    tapAnywhere(game, move[0], t + 2);
    // The first tap did both when the partner was parked (issue #93).
    if (!game.board.get(move[1]).removed) tapAnywhere(game, move[1], t + 3);
  }
  assert.equal(game.tilesLeft, 0, 'the sample level was played to completion');
  assert.ok(holds > 4, `the sweep should park extra singletons (${holds} parks)`);
  assert.ok(game.holdsUsed > holds, 'every pair transits the holder too (issue #93)');
});

test('a resumed game keeps playing identically to one that never quit', () => {
  const level = generateValidatedLevel(TURTLE, SAMPLE_SEED);
  const live = new Game(level);
  for (const [a, b] of level.solution.slice(0, 20)) {
    reveal(live, a, 0);
    live.tap(free(a), 0);
    reveal(live, b, 0);
    live.tap(free(b), 0);
  }
  const resumed = forceQuit(live)!;
  // Same 10 further moves, same timestamps: the combo ladder must agree too.
  // Peeks are per-game: a resume re-conceals (issue #64), so the resumed game
  // may need a reveal tap the live one does not — the tracked state stays equal.
  for (const [a, b] of level.solution.slice(20, 30)) {
    for (const g of [live, resumed]) {
      reveal(g, a, 0);
      g.tap(free(a), 0);
      reveal(g, b, 0);
      g.tap(free(b), 0);
    }
  }
  assert.deepEqual(fingerprint(resumed), fingerprint(live));
});

test('reopen with a conceal bucket re-derives that band’s concealment (issue #79)', () => {
  const level = generateValidatedLevel(TURTLE, SAMPLE_SEED);
  const live = new Game(level, undefined, concealedTileIds(level, 'medium'));
  const save = captureSave(live, { shuffles: 0, elapsedMs: 0 });
  const resumed = reopen(TURTLE, save, 'medium');
  assert.notEqual(resumed, null);
  const hidden = (g: Game) =>
    g.board
      .allTiles()
      .filter((t) => g.isFaceHidden(t.id))
      .map((t) => t.id);
  assert.deepEqual(hidden(resumed!), hidden(live));
  assert.ok(hidden(live).length > 0, 'the medium band conceals at least one tile');
  // Without the bucket the default (difficulty-derived) set applies, as before.
  const plain = reopen(TURTLE, save);
  assert.notEqual(plain, null);
});

test('resume restores a mid-pair holder, and the undo stack behind it', () => {
  const level = generateValidatedLevel(TURTLE, SAMPLE_SEED);
  const game = new Game(level);
  for (const [a, b] of level.solution.slice(0, 5)) {
    reveal(game, a, 0);
    game.tap(free(a), 0);
    reveal(game, b, 0);
    game.tap(free(b), 0);
  }
  reveal(game, level.solution[5]![0], 0);
  game.tap(free(level.solution[5]![0]), 0); // first half of a pair: parked
  assert.notEqual(game.holderSlots()[0], null);

  const resumed = forceQuit(game)!;
  assert.deepEqual(resumed.holderSlots(), game.holderSlots());
  assert.equal(resumed.undoDepth, game.undoDepth);
  // The parked tile is still returnable after the quit (issue #100); the
  // matches stay played, and so does their score.
  const scoreBefore = resumed.score;
  assert.equal(resumed.undo()?.kind, 'hold');
  assert.equal(resumed.undo(), null, 'matches are permanent');
  assert.equal(resumed.tilesLeft, level.tiles.length - 10, 'the 5 pairs stay gone');
  assert.equal(resumed.score, scoreBefore);
});

test('resume reproduces shuffled faces, including undo across a shuffle', () => {
  const level = generateValidatedLevel(TURTLE, SAMPLE_SEED);
  const game = new Game(level);
  for (const [a, b] of level.solution.slice(0, 8)) {
    game.tap(free(a), 0);
    game.tap(free(b), 0);
  }
  // Park a tile before the shuffle, then return it after: the returned tile
  // predates the shuffle, which is exactly the case a move-list replay cannot
  // reproduce (see save.ts).
  game.tap(free(game.board.freeTileIds()[0]!), 0);
  assert.equal(game.shuffle(0xbeef), true);
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

/** The same, with a hold and a holder match in the move stack and a tile left
 *  parked — what the holder-specific rejection cases below need to corrupt. */
function heldSave(): SaveState {
  const game = new Game(generateValidatedLevel(TURTLE, SAMPLE_SEED));
  const [a, b] = game.level.solution[0]!;
  park(game, a, 100); // park half of the first pair…
  game.tap(free(b), 120); // …and clear it in the holder with one tap (issue #93)
  const parked = game.level.solution[1]![0];
  park(game, parked, 140); // leave a second tile in the holder
  return captureSave(game, { shuffles: 0, elapsedMs: 1000 });
}

const snap = (save: Record<string, unknown>): Record<string, unknown> =>
  save['snapshot'] as Record<string, unknown>;
const stack = (save: Record<string, unknown>): Record<string, unknown> =>
  snap(save)['stack'] as Record<string, unknown>;

/** Deep clone through JSON — mutating a save the way a hand-edit would. */
function corrupt(
  mutate: (save: Record<string, unknown>) => void,
  base: SaveState = sampleSave(),
): unknown {
  const raw = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
  mutate(raw);
  return raw;
}

const holderOf = (save: Record<string, unknown>): (number | null)[] =>
  snap(save)['holder'] as (number | null)[];
const movesOf = (save: Record<string, unknown>): Record<string, unknown>[] =>
  stack(save)['moves'] as Record<string, unknown>[];
/** The match moves only — every pair is a hold + a match since issue #93. */
const matchesOf = (save: Record<string, unknown>): Record<string, unknown>[] =>
  movesOf(save).filter((m) => m['kind'] === 'match');

test('a well-formed save parses; an absent one is simply absent', () => {
  assert.notEqual(parseSave(JSON.parse(JSON.stringify(sampleSave()))), null);
  assert.equal(new SaveStore(fakeStorage()).load(), null);
  assert.equal(parseSave(null), null);
});

test('parseSave rejects every malformed record instead of trusting it', () => {
  const cases: Record<string, (save: Record<string, unknown>) => void> = {
    // A v1 record is a *shape* this build cannot vouch for (no holder, no move
    // kinds), so it reads as absent and the player gets a fresh deal (#43).
    'a stale version': (s) => void (s['version'] = 1),
    'a pre-#93 v3 record': (s) => void (s['version'] = 3),
    'a version from the future': (s) => void (s['version'] = 99),
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
    'move outside the removals': (s) => void (matchesOf(s)[0]!['a'] = 999),
    'self-matching move': (s) => {
      const move = matchesOf(s)[0]!;
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
      const moves = matchesOf(s);
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
    'an unknown move kind': (s) => void (movesOf(s)[0]!['kind'] = 'teleport'),
    'a move with no kind at all': (s) => void delete movesOf(s)[0]!['kind'],
  };
  for (const [name, mutate] of Object.entries(cases)) {
    assert.equal(parseSave(corrupt(mutate)), null, `should reject: ${name}`);
  }
});

test('parseSave rejects a holder the rest of the record does not agree with', () => {
  // Every one of these loads and hashes like an honest game and then throws out
  // of Board several undos later, which is exactly what the record has to be
  // checked for rather than discovered by playing it (issue #43).
  const cases: Record<string, (save: Record<string, unknown>) => void> = {
    'no holder field at all': (s) => void delete snap(s)['holder'],
    'a holder longer than its capacity': (s) =>
      void (snap(s)['holder'] = [0, 1, 2, 3, 4, 5, 6, 7, 8]),
    'the same tile in two slots': (s) => {
      const holder = holderOf(s);
      holder[1] = holder.find((id) => id !== null) ?? 0;
    },
    'a held tile that is also removed': (s) =>
      void (holderOf(s)[1] = (snap(s)['removed'] as number[])[0]!),
    'a non-integer slot': (s) => void (holderOf(s)[1] = 1.5 as unknown as number),
    'a hold record whose tile is not in that slot': (s) => {
      const hold = movesOf(s).find((m) => m['kind'] === 'hold')!;
      hold['tile'] = 999;
    },
    'a hold record naming a slot out of range': (s) => {
      const hold = movesOf(s).find((m) => m['kind'] === 'hold')!;
      hold['slotIndex'] = 99;
    },
    'a match claiming a holder slot that is taken': (s) => {
      // heldA already names the slot the match was played out of; pointing
      // heldB at the slot the later hold refills makes two tiles claim one.
      const match = movesOf(s).find((m) => m['kind'] === 'match')!;
      match['heldB'] = holderOf(s).findIndex((id) => id !== null);
    },
    'a holder left full at the start of the stack': (s) => {
      stack(s)['moves'] = [];
      snap(s)['removed'] = [];
    },
  };
  const base = heldSave();
  assert.notEqual(parseSave(JSON.parse(JSON.stringify(base))), null, 'the base save is honest');
  assert.ok(
    base.snapshot.holder.some((id) => id !== null),
    'the base save has a tile parked',
  );
  for (const [name, mutate] of Object.entries(cases)) {
    assert.equal(parseSave(corrupt(mutate, base)), null, `should reject: ${name}`);
  }
});

test('issue #63: a v2 record is refused outright, `unhold` and all', () => {
  // Decision 0009 deleted the return, so nothing in this build can replay an
  // `unhold` record — and silently dropping one would leave an undo stack that
  // no longer walks back to a pristine deal. The version bump is the whole
  // answer: a v2 record reads as absent and the player gets a fresh deal.
  const v2 = JSON.parse(JSON.stringify(sampleSave())) as Record<string, unknown>;
  v2['version'] = 2;
  assert.equal(parseSave(v2), null, 'a v2 record is not a current record');

  // …and the move-kind check behind it, in case a record ever claims the
  // current version while carrying the old shape.
  const forged = JSON.parse(JSON.stringify(heldSave())) as Record<string, unknown>;
  const hold = movesOf(forged).find((m) => m['kind'] === 'hold');
  assert.notEqual(hold, undefined, 'the base save has a hold to re-label');
  hold!['kind'] = 'unhold';
  assert.equal(parseSave(forged), null, 'an unhold move is not a move this build knows');
});

test('a short holder array is padded, not honoured as a smaller holder', () => {
  // Board takes its capacity from the array it is given, so a hand-edited
  // record with fewer entries would shrink the holder for the rest of the level
  // — which under decision 0009 would also move the level's loss line.
  const raw = JSON.parse(JSON.stringify(sampleSave())) as Record<string, unknown>;
  (raw['snapshot'] as Record<string, unknown>)['holder'] = [null, null];
  const parsed = parseSave(raw);
  assert.notEqual(parsed, null, 'a short holder is still a readable record');
  assert.equal(parsed!.snapshot.holder.length, HOLDER_SLOTS);
  const resumed = reopen(TURTLE, parsed!)!;
  assert.notEqual(resumed, null);
  assert.equal(resumed.holderSlots().length, HOLDER_SLOTS);
  assert.equal(resumed.holderVacancies, HOLDER_SLOTS);
  // And all four slots are usable, not two. Each park needs a face the holder
  // does not already carry, or the first tap clears the pair instead (#62), and
  // a clock past the save's own last match, which the ScoreKeeper enforces.
  let t = 10_000;
  for (let i = 0; i < HOLDER_SLOTS; i++) {
    const parkedFaces = new Set(
      resumed
        .holderSlots()
        .filter((id): id is TileId => id !== null)
        .map((id) => resumed.board.get(id).face),
    );
    // Face-up only: the first tap on a concealed tile peeks (issue #64), and
    // the deeper #99 geometry can derive a concealed set for this deal.
    const target = resumed.board
      .freeTileIds()
      .find((id) => !parkedFaces.has(resumed.board.get(id).face) && !resumed.isFaceHidden(id))!;
    assert.equal(resumed.tap(free(target), (t += 10)).kind, 'held', `slot ${i + 1}`);
  }
  assert.equal(resumed.holderFull, true);
  assert.equal(resumed.status(), 'lost', 'the fourth one loses, as on a full-length holder');
});

test('a lost level still saves, so a reload is not an escape hatch (issue #63)', () => {
  // The holder is one-way and a full one ends the level; reopening the tab must
  // bring the loss back rather than a playable board.
  const game = new Game(generateValidatedLevel(TURTLE, SAMPLE_SEED));
  let t = 0;
  while (!game.holderFull) {
    const parkedFaces = new Set(
      game
        .holderSlots()
        .filter((id): id is TileId => id !== null)
        .map((id) => game.board.get(id).face),
    );
    const target = game.board
      .freeTileIds()
      .find((id) => !parkedFaces.has(game.board.get(id).face))!;
    park(game, target, (t += 10));
  }
  assert.equal(game.status(), 'lost');

  const resumed = forceQuit(game, { shuffles: 0, elapsedMs: 5000 });
  assert.notEqual(resumed, null, 'a lost level is saved, not dropped');
  assert.equal(resumed!.status(), 'lost', 'and it comes back lost');
  assert.deepEqual(resumed!.holderSlots(), game.holderSlots());
  assert.equal(resumed!.stateHash(), game.stateHash());
});

test('a resumed game can return every tile still parked', () => {
  // The whole point of validating the undo chain: what parses must also play.
  const resumed = forceQuit(new Game(generateValidatedLevel(TURTLE, SAMPLE_SEED)));
  assert.notEqual(resumed, null);
  const fromHolder = reopen(TURTLE, heldSave())!;
  assert.notEqual(fromHolder, null);
  assert.ok(fromHolder.holdsUsed > 0);
  const tilesBefore = fromHolder.tilesLeft;
  while (fromHolder.undoDepth > 0) assert.notEqual(fromHolder.undo(), null);
  assert.equal(fromHolder.undo(), null, 'matches stay permanent');
  assert.deepEqual(fromHolder.holderSlots(), [null, null, null, null]);
  assert.equal(fromHolder.tilesLeft, tilesBefore, 'returns move tiles, never revive them');
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

  // A face this deal does not contain — a save written before the tile set
  // changed (issue #75 removed `flower-*`; decision 0012 calls this a
  // discarded save, not a board of unknown tiles).
  const staleFaces: SaveState = {
    ...save,
    snapshot: {
      ...save.snapshot,
      faces: ['flower-1', ...save.snapshot.faces.slice(1)],
    },
  };
  assert.equal(reopen(TURTLE, staleFaces), null);
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
