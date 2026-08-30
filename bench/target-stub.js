// Stand-in bench target (issue #4).
//
// `/core` does not exist yet — this harness predates it (roadmap Phase 1 exit
// gate). To validate the harness end-to-end on a real device today, this
// module implements a workload with the same shape as the real one: a seeded
// reverse-construction generator plus a bounded-DFS + memo solver over a
// 144-tile, 4-layer lattice (geometry borrowed from spike/tech-stack).
//
// It is NOT the real engine — no layout JSON, simplified lattice, no scoring.
// Once `/core` ships its bench entry (see target.js for the contract), the
// harness picks that up automatically and this file stops being loaded.

const TILE_W = 54;
const TILE_H = 68;
const LAYER_DX = 6;
const LAYER_DY = 6;

// 84 + 40 + 18 + 2 = 144 slots
const LAYERS = [
  { cols: 12, rows: 7 },
  { cols: 8, rows: 5 },
  { cols: 6, rows: 3 },
  { cols: 2, rows: 1 },
];

// Bounded DFS per spec §4: a board whose validation blows past the budget is
// abandoned and reseeded. 10k nodes keeps the stand-in's worst case bounded
// while a 200-seed sweep still validates with zero reseed exhaustions.
const SOLVER_NODE_BUDGET = 10_000;
const MAX_RESEEDS = 20;

// --- deterministic RNG (mulberry32) --------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- slot lattice ----------------------------------------------------------

function buildSlots() {
  const slots = [];
  const boardW = LAYERS[0].cols * TILE_W;
  LAYERS.forEach((L, layer) => {
    const x0 = (boardW - L.cols * TILE_W) / 2 + layer * LAYER_DX;
    const y0 = ((LAYERS[0].rows - L.rows) * TILE_H) / 2 + layer * LAYER_DY;
    for (let r = 0; r < L.rows; r++) {
      for (let c = 0; c < L.cols; c++) {
        slots.push({ id: slots.length, layer, x: x0 + c * TILE_W, y: y0 + r * TILE_H });
      }
    }
  });

  const overlaps = (a, b) => Math.abs(a.x - b.x) < TILE_W && Math.abs(a.y - b.y) < TILE_H;
  for (const s of slots) {
    s.above = slots.filter((o) => o.layer === s.layer + 1 && overlaps(o, s)).map((o) => o.id);
    s.below = slots.filter((o) => o.layer === s.layer - 1 && overlaps(o, s)).map((o) => o.id);
    s.left = slots.filter((o) => o.layer === s.layer && o.y === s.y && o.x === s.x - TILE_W).map((o) => o.id);
    s.right = slots.filter((o) => o.layer === s.layer && o.y === s.y && o.x === s.x + TILE_W).map((o) => o.id);
  }
  return slots;
}

const SLOTS = buildSlots();

// --- tile faces ------------------------------------------------------------
// 34 standard faces x 4 copies (68 pairs) + 4 flowers (2 pairs) + 4 seasons
// (2 pairs) = 144 tiles / 72 pairs. Matching is identical-face only (spec
// §3.3 as amended by decision 0005); flower/season classes here stand in for
// the two identical-copy faces each — pair counts and perf are unchanged.

const FACE_STANDARD_COUNT = 34; // face classes 0..33
const FACE_FLOWER = 34;
const FACE_SEASON = 35;

function buildPairInventory(rnd) {
  const pairs = [];
  for (let f = 0; f < FACE_STANDARD_COUNT; f++) pairs.push(f, f);
  pairs.push(FACE_FLOWER, FACE_FLOWER, FACE_SEASON, FACE_SEASON);
  // Fisher–Yates
  for (let i = pairs.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [pairs[i], pairs[j]] = [pairs[j], pairs[i]];
  }
  return pairs; // 72 entries; entry k is the face class of the k-th placed pair
}

// --- generator: reverse construction (spec §4) ------------------------------

/**
 * Generate a board for `seed` by iterating a removal order backwards
 * (spec §4 step 2): start from a fully-filled board of blank tiles, repeatedly
 * remove a random *free* pair, and give each removed pair a matching face.
 * The recorded removal order is then a guaranteed solution path.
 *
 * Returns { faces, placed } where faces[slotId] is a face class, or null if
 * the peel dead-ends (< 2 free tiles left, e.g. a final stacked pair) —
 * caller reseeds.
 */
function generate(seed) {
  const rnd = mulberry32(seed);
  const pairFaces = buildPairInventory(rnd);
  const removed = new Array(SLOTS.length).fill(false);
  const faces = new Array(SLOTS.length).fill(-1);

  for (let pair = 0; pair < SLOTS.length / 2; pair++) {
    // Removing the first tile of the pair can only free tiles, never block
    // them, so both picks can come from the same free set.
    const free = freeTiles(removed);
    if (free.length < 2) return null;
    const ai = Math.floor(rnd() * free.length);
    const a = free[ai];
    free.splice(ai, 1);
    const b = free[Math.floor(rnd() * free.length)];
    removed[a] = removed[b] = true;
    faces[a] = pairFaces[pair];
    faces[b] = pairFaces[pair];
  }
  return { faces, placed: SLOTS.length };
}

// --- solver: bounded DFS + memo (spec §4) -----------------------------------

function stateKey(removed) {
  // 144 bits -> 5 uint32 words, joined as a string key
  const words = new Uint32Array(5);
  for (let i = 0; i < removed.length; i++) {
    if (removed[i]) words[i >> 5] |= 1 << (i & 31);
  }
  return `${words[0]},${words[1]},${words[2]},${words[3]},${words[4]}`;
}

function freeTiles(removed) {
  const out = [];
  for (const s of SLOTS) {
    if (removed[s.id]) continue;
    if (s.above.some((a) => !removed[a])) continue;
    const leftBlocked = s.left.some((l) => !removed[l]);
    const rightBlocked = s.right.some((r) => !removed[r]);
    if (leftBlocked && rightBlocked) continue;
    out.push(s.id);
  }
  return out;
}

/** Returns { solvable, nodes }. Bounded DFS with visited-state memo. */
function solve(faces) {
  const removed = new Array(SLOTS.length).fill(false);
  const remainingByFace = new Array(FACE_STANDARD_COUNT + 2).fill(4);
  const visited = new Set();
  let nodes = 0;
  let remaining = SLOTS.length;

  const take = (ids) => {
    for (const id of ids) {
      removed[id] = true;
      remainingByFace[faces[id]]--;
    }
    remaining -= ids.length;
  };
  const untake = (ids) => {
    for (const id of ids) {
      removed[id] = false;
      remainingByFace[faces[id]]++;
    }
    remaining += ids.length;
  };

  function dfs() {
    if (remaining === 0) return true;
    if (++nodes > SOLVER_NODE_BUDGET) return false;

    const free = freeTiles(removed);
    const byFace = new Map();
    for (const id of free) {
      const f = faces[id];
      if (!byFace.has(f)) byFace.set(f, []);
      byFace.get(f).push(id);
    }

    // Safe-move pruning: when every remaining copy of a face is free, clearing
    // them can never block anything else — take them without branching.
    const safe = [];
    for (const [f, ids] of byFace) {
      if (ids.length === remainingByFace[f] && ids.length >= 2) safe.push(...ids);
    }
    if (safe.length > 0) {
      take(safe);
      const ok = dfs();
      untake(safe);
      return ok;
    }

    const key = stateKey(removed);
    if (visited.has(key)) return false;
    visited.add(key);

    for (const ids of byFace.values()) {
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const pair = [ids[i], ids[j]];
          take(pair);
          const ok = dfs();
          untake(pair);
          if (ok) return true;
        }
      }
    }
    return false;
  }

  return { solvable: dfs(), nodes };
}

// --- bench target ------------------------------------------------------------

export const benchTarget = {
  name: 'stub_reverse_construction (stand-in — NOT /core)',
  layouts: ['stub_144'],
  /** One full generate + validate-solve cycle, deterministic per seed. */
  run(layoutId, seed) {
    if (layoutId !== 'stub_144') throw new Error(`unknown layout ${layoutId}`);
    let s = seed >>> 0;
    for (let attempt = 0; attempt < MAX_RESEEDS; attempt++) {
      const board = generate(s);
      if (board) {
        const { solvable } = solve(board.faces);
        if (solvable) return { solvable: true, tilesPlaced: board.placed };
      }
      // reseed fallback (spec §4): derive the next seed deterministically
      s = (Math.imul(s ^ 0x9e3779b9, 0x85ebca6b) + attempt + 1) >>> 0;
    }
    return { solvable: false, tilesPlaced: 0 };
  },
};
