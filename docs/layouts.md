# Layouts (`/data/layouts`)

Layout geometry is **data, not code** (spec §4). Each file is one layout:

```json
{ "id": "pyramid", "name": "Pyramid", "slots": [ { "x": 8, "y": 0, "z": 0 }, … ] }
```

- `id` — must equal the filename without `.json`; it is the stable key stored in
  saves and level definitions (`{ layoutId, seed }`, spec §9).
- `name` — display name.
- `slots` — ordered slot list. Order is load-bearing: the generator assigns tile
  ids `0..n-1` in this order, and the replay format references those ids, so
  reordering an existing file invalidates saved games. Any order is valid; the
  nine layouts added in issue #17 are sorted by `z`, then `y`, then `x`.
  `turtle_classic.json` predates that convention — its three wing slots are
  appended after the rest of layer 0 — and is left as-is rather than renumbered.

Coordinates are **half-units**: a tile's footprint spans `[x, x+2) × [y, y+2)`
on layer `z` (`z = 0` is the table). Odd coordinates are how a tile straddles
two tiles below — turtle's apex sits at `x: 11`.

## Rules a layout file must satisfy

`parseLayout` (core/src/layouts.ts) rejects a file that breaks any of these, so
a bad layout fails at load time rather than as a corrupt board mid-game:

1. Even, non-zero slot count.
2. Integer coordinates, `z >= 0`, no two slots overlapping on the same layer.
3. No floating slots — every unit cell of a slot's footprint rests on a slot one
   layer down (one supporter, or two half-overlapping ones).

The core suite adds the shipping rules: exactly 144 slots (a full standard set,
spec §3.4), contiguous layers from 0, an id matching the filename, an opening
pair on the first seeds, and a footprint no larger than turtle's 34×18
half-units so every layout renders at the same tile size.

## Adding a layout

1. Write the file, then run `cd core && npm test` (parses + generates) and
   `npm run soak -- --layout <id> --seeds 10000` (the spec §11.1 gate: every
   seed must produce a provably solvable deal).
2. The CI `layout-soak` job discovers layouts from this directory, so a new file
   joins the release gate with no workflow change.

Two things to watch while designing, both learned on the layouts here:

- **Dead ends.** Reverse construction needs at least two free slots at every
  step. Narrow towers (a stack one tile wide) can starve it; the soak reports
  `generator dead-ended` if so.
- **Solver cost.** Deep stacks with few exposed edges push the solver from its
  greedy playouts into the bounded DFS. An early `stairway` draft — five layers
  all anchored to one edge — measured a p95 of 58 ms for generate + validate
  against ~7 ms for every other layout; spreading the same 144 slots diagonally
  (now `terrace`) brought it back to 13 ms. Spec §9 budgets 150 ms p95 on the
  reference low-end device, so a layout that is a 4× outlier here is a problem
  there.
