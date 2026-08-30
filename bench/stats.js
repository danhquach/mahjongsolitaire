// Latency statistics for the benchmark harness (issue #4).
// Pure functions, no platform deps — shared by the browser page and the Node runner.

/**
 * Nearest-rank percentile on an already-sorted ascending array.
 * p in (0, 100]. For n samples: value at index ceil(p/100 * n) - 1.
 */
export function percentileSorted(sorted, p) {
  if (sorted.length === 0) throw new Error('percentile of empty sample set');
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.max(0, rank - 1)];
}

/** Summarize an array of per-iteration durations (ms). */
export function summarize(samples) {
  if (samples.length === 0) throw new Error('summarize of empty sample set');
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    n: sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: sum / sorted.length,
    p50: percentileSorted(sorted, 50),
    p90: percentileSorted(sorted, 90),
    p95: percentileSorted(sorted, 95),
    p99: percentileSorted(sorted, 99),
  };
}
