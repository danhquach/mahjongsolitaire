# On-device benchmark harness for `/core` (issue #4)

Measures the Phase 1 exit gate: **generate + solvability-validate p95 < 150 ms
on the reference low-end Android device** (spec §9, roadmap Phase 1). Headless
by design — it predates the app shell and needs only a browser on the device.

## What it measures

One benchmark iteration = one full `run(layoutId, seed)` cycle: seeded
generation plus solvability validation, the exact operation spec §9 budgets at
150 ms. Iteration `i` uses seed `baseSeed + i`, so any run is reproducible.
The harness reports p50/p95 (plus p90/p99, mean, min, max, nearest-rank
percentiles) and a PASS/FAIL verdict against the 150 ms p95 gate.

## Running on the target device (the binding measurement)

1. On a machine on the same network as the device:

   ```sh
   python3 -m http.server 8080   # from the repo root
   ```

   Any plain static server works. **Do not use `serve`/`vercel serve`** — its
   clean-URL redirect (`/bench/index.html` → `/bench`) breaks the page's
   relative module imports.

2. On the device, open Chrome at `http://<host-ip>:8080/bench/index.html`.
3. Tap **Run benchmark** (defaults: 200 iterations, 20 warm-up, seed 1).
4. Read the PASS/FAIL row, then **Copy JSON report** and paste the report into
   the ticket/PR. The report includes device info (UA, cores, memory) and a
   determinism checksum.

One-tap runs: URL params `?autorun=1&iterations=200&warmup=20&seed=1` start
the benchmark on page load.

## Running headless (CI / local iteration — not the gate)

```sh
node bench/run-node.mjs [--iterations 200] [--warmup 20] [--seed 1] [--layout <id>]
```

Prints the same JSON report; exits non-zero if any iteration produced an
unsolvable board. Numbers from a dev host don't satisfy the gate — the
roadmap requires a real device, not an emulator.

Tests: `node --test bench/test/`

## Plugging in the real `/core`

The harness loads its workload via `target.js`:

- If `core/dist/bench.js` exists (built ES module), it is used automatically.
  It must export `benchTarget = { name, layouts, run(layoutId, seed) }` where
  `run` synchronously performs one full generate + solvability-validate cycle
  and returns `{ solvable, tilesPlaced }`. See `target.js` for the full
  contract.
- Otherwise the harness falls back to `target-stub.js` — a stand-in workload
  (seeded reverse-construction generator + bounded-DFS+memo solver over a
  simplified 144-tile, 4-layer lattice). It validates the harness and gives a
  ballpark device number, but **stub numbers do not satisfy the Phase 1 gate**;
  the page shows a warning banner whenever the stub is running.
