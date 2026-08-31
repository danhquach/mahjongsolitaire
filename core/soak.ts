// Layout soak: the spec §11.1 / roadmap Phase 3 release gate — 10,000 seeds ×
// every shipped layout → 100% solvable (issue #17). Builds to core/dist/soak.js
// and runs as the `layout-soak` CI job, one shard per layout.
//
// "Solvable" is proved the way the generator's own acceptance sweep proves it
// (core/test/generator.test.ts): replay the reverse-construction witness
// through the free-tile and match rules and require an empty board. That is a
// sound proof, unlike the bounded DFS, which may answer 'unknown' on a state
// budget and would turn a healthy deal into a red build.
//
// Usage: node dist/soak.js [--seeds 10000] [--layout <id>] [--from 0]

import { readFileSync, readdirSync } from 'node:fs';

import { Board } from './src/board.js';
import { facesMatch } from './src/faces.js';
import { generateLevel } from './src/generator.js';
import type { GeneratedLevel } from './src/generator.js';
import { parseLayout } from './src/layouts.js';
import type { LayoutFile } from './src/layouts.js';

const LAYOUT_DIR = new URL('../../data/layouts/', import.meta.url);

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const value = i === -1 ? undefined : process.argv[i + 1];
  return value ?? fallback;
}

function loadLayouts(only: string): LayoutFile[] {
  const files = readdirSync(LAYOUT_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort();
  const layouts = files.map((f) => parseLayout(JSON.parse(readFileSync(new URL(f, LAYOUT_DIR), 'utf8'))));
  if (only === 'all') return layouts;
  const picked = layouts.find((l) => l.id === only);
  if (!picked) throw new RangeError(`unknown layout id: ${only} (have ${layouts.map((l) => l.id).join(', ')})`);
  return [picked];
}

/** Replay the solution witness; returns the reason it failed, or null. */
function witnessFailure(level: GeneratedLevel): string | null {
  const board = new Board(level.tiles);
  for (const [a, b] of level.solution) {
    if (!board.isFree(a) || !board.isFree(b)) return `pair ${a},${b} not free when played`;
    if (!facesMatch(board.get(a).face, board.get(b).face)) return `pair ${a},${b} faces differ`;
    board.remove(a);
    board.remove(b);
  }
  const left = board.presentTiles().length;
  return left === 0 ? null : `${left} tiles left on the board`;
}

const seeds = Number(arg('seeds', '10000'));
const from = Number(arg('from', '0'));
const layouts = loadLayouts(arg('layout', 'all'));

let failures = 0;
const results = layouts.map((layout) => {
  const started = Date.now();
  const problems: string[] = [];
  let unsolvable = 0;
  for (let seed = from; seed < from + seeds; seed++) {
    let reason: string | null;
    try {
      reason = witnessFailure(generateLevel(layout, seed));
    } catch (e) {
      reason = e instanceof Error ? e.message : String(e);
    }
    if (reason !== null) {
      failures++;
      unsolvable++;
      if (problems.length < 5) problems.push(`seed ${seed}: ${reason}`);
    }
  }
  return {
    layout: layout.id,
    tiles: layout.slots.length,
    seeds,
    from,
    solvable: seeds - unsolvable,
    unsolvable,
    problems,
    ms: Date.now() - started,
  };
});

console.log(
  JSON.stringify(
    {
      issue: 17,
      gate: { metric: 'solvable_ratio', threshold: 1, pass: failures === 0 },
      spec: '§11.1 — generator: for each layout × 10,000 seeds → assert solvable',
      results,
      host: { node: process.version, platform: process.platform, arch: process.arch },
    },
    null,
    2,
  ),
);

if (failures > 0) {
  console.error(`layout soak FAILED: ${failures} unsolvable deal(s)`);
  process.exit(1);
}
