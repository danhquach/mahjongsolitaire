// Score verification by replay (issue #187, decision 0030).
//
// A leaderboard submission used to be believed if its score was inside what
// one run could pay. Now the server is the authority on the record: it takes
// the deal the client says it played — `(layoutId, seed)`, which has to be a
// ladder level — regenerates it with core's own generator, plays the submitted
// moves through core's own move stack, and the score is whatever that earns.
// The client's `score` is a cross-check; a run the server cannot reproduce is
// refused and never touches the standing.
//
// Everything that knows the rules is imported from core's build: the Worker
// has no scoring logic of its own, so a change to the combo ladder or the band
// multipliers reaches both sides in one commit. That import is why `core` has
// to be built before `wrangler deploy` — see .github/workflows/ci.yml and the
// note in wrangler.jsonc.
//
// The ladder and the ten layouts ride along as JSON modules. They are the same
// files the client fetches (`ui/dist-web/ladder.json`, `layouts/*.json` — Vite
// copies `data/` in), so a deal the client could have played is one this file
// can regenerate, and a deal the client could not is `unknown_deal`.

import ladderDoc from '../data/ladder.json' with { type: 'json' };
import bridge from '../data/layouts/bridge.json' with { type: 'json' };
import butterfly from '../data/layouts/butterfly.json' with { type: 'json' };
import cat from '../data/layouts/cat.json' with { type: 'json' };
import fortress from '../data/layouts/fortress.json' with { type: 'json' };
import moonGate from '../data/layouts/moon_gate.json' with { type: 'json' };
import pyramid from '../data/layouts/pyramid.json' with { type: 'json' };
import spider from '../data/layouts/spider.json' with { type: 'json' };
import terrace from '../data/layouts/terrace.json' with { type: 'json' };
import turtleClassic from '../data/layouts/turtle_classic.json' with { type: 'json' };
import windmill from '../data/layouts/windmill.json' with { type: 'json' };

import {
  generateLevel,
  parseLadder,
  parseLayout,
  replayMoves,
  scoreMultiplierForLevel,
} from '../core/dist/src/index.js';

/** Parsed once at module load, so a malformed data file fails the deploy's
 *  first request loudly rather than one submission at a time. */
const LAYOUTS = new Map(
  [bridge, butterfly, cat, fortress, moonGate, pyramid, spider, terrace, turtleClassic, windmill]
    .map(parseLayout)
    .map((layout) => [layout.id, layout]),
);
const LADDER = parseLadder(ladderDoc);
/** `layoutId:seed` → ladder level. The deal alone does not say which level it
 *  is, and the level is what sets the band multiplier (issue #176). */
const LEVEL_OF_DEAL = new Map(LADDER.map((e) => [`${e.layoutId}:${e.seed}`, e.level]));

/**
 * The most shuffles one run can carry. Each recorded shuffle costs a solver
 * pass on replay, and the history is the one part of a request whose CPU cost
 * the client controls, so it is bounded by the most a player could actually
 * have used: the booster cap in ui/src/boosters.ts (99 charges of a kind).
 */
export const MAX_SHUFFLES_PER_RUN = 99;

function isCount(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * Replay `history` and check it against what the client claimed.
 *
 * `{ ok: true, score, lastMs }` for a run that regenerates, replays legally
 * to a cleared board and earns exactly `claimed.score`; otherwise
 * `{ ok: false, reason }` — with `index` naming the move when the replay is
 * what refused it. `lastMs` is the last move's timestamp, for the route to
 * hold `elapsedMs` against.
 */
export function verifyRun(history, claimed) {
  if (history === null || history === undefined) return { ok: false, reason: 'history_missing' };
  if (typeof history !== 'object' || Array.isArray(history)) {
    return { ok: false, reason: 'history_malformed' };
  }
  const { layoutId, seed, moves } = history;
  if (typeof layoutId !== 'string' || !isCount(seed) || !Array.isArray(moves)) {
    return { ok: false, reason: 'history_malformed' };
  }
  const level = LEVEL_OF_DEAL.get(`${layoutId}:${seed}`);
  if (level === undefined) return { ok: false, reason: 'unknown_deal' };
  if (moves.filter((m) => m !== null && typeof m === 'object' && m.kind === 'shuffle').length > MAX_SHUFFLES_PER_RUN) {
    return { ok: false, reason: 'too_many_shuffles' };
  }

  // The ladder stores the seed that validated, so plain generation reproduces
  // the deal exactly — no reseeding, which could land on a different one.
  const deal = generateLevel(LAYOUTS.get(layoutId), seed);
  const replay = replayMoves(deal, moves, scoreMultiplierForLevel(level));
  if (!replay.ok) return { ok: false, reason: replay.reason, index: replay.index };
  // The board ranks ladder *clears*: a run that stopped short is not one.
  if (!replay.cleared) return { ok: false, reason: 'not_cleared' };
  // The moves say what was earned. A client that disagrees is either
  // dishonest or out of step with this build; either way the run is refused
  // rather than silently corrected, so the disagreement is visible.
  if (replay.score !== claimed.score) return { ok: false, reason: 'score_mismatch' };
  return { ok: true, score: replay.score, lastMs: replay.lastMs };
}
