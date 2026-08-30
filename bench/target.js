// Bench target loader (issue #4).
//
// Contract for `/core` (Phase 1): export a bench entry at core/dist/bench.js
// (built ES module, importable with zero platform deps) of the shape:
//
//   export const benchTarget = {
//     name: string,                     // e.g. "core@<version>"
//     layouts: string[],                // layout ids it can generate, e.g. ["turtle_classic"]
//     run(layoutId, seed) {             // ONE full generate + solvability-validate cycle
//       return { solvable: boolean, tilesPlaced: number };
//     },
//   };
//
// run() must be synchronous, deterministic per (layoutId, seed), and
// side-effect free — it is what the 150ms p95 gate (spec §9) measures.
//
// Until that entry exists, the loader falls back to the stand-in workload in
// target-stub.js so the harness itself can be validated on-device now.
// A core entry that exists but fails to load (syntax error, bad import,
// missing export) is a loud failure, never a silent stub fallback.

function isModuleNotFound(err) {
  // Node: ERR_MODULE_NOT_FOUND. Browsers: dynamic-import fetch failures
  // surface as a TypeError (there is no dedicated error code).
  return err?.code === 'ERR_MODULE_NOT_FOUND' || err instanceof TypeError;
}

export async function loadTarget() {
  let core;
  try {
    core = await import('../core/dist/bench.js');
  } catch (err) {
    if (!isModuleNotFound(err)) {
      throw new Error(`core/dist/bench.js exists but failed to load: ${err}`, { cause: err });
    }
    const stub = await import('./target-stub.js');
    return { target: stub.benchTarget, isStub: true };
  }
  if (!core.benchTarget) throw new Error('core/dist/bench.js loaded but has no benchTarget export');
  return { target: core.benchTarget, isStub: false };
}
