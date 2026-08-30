#!/usr/bin/env node
// Headless Node runner for the same benchmark loop (issue #4).
// The binding Phase 1 gate runs in the browser on the target device
// (index.html); this runner is for CI smoke checks and local iteration.
//
// Usage: node bench/run-node.mjs [--iterations 200] [--warmup 20] [--seed 1] [--layout <id>]

import { runBenchmark } from './harness.js';
import { loadTarget } from './target.js';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

const P95_GATE_MS = 150;
const { target, isStub } = await loadTarget();
const layoutId = arg('layout', target.layouts[0]);
const iterations = Number(arg('iterations', 200));
const warmup = Number(arg('warmup', 20));
const baseSeed = Number(arg('seed', 1));

if (isStub) {
  console.error('warning: running the STAND-IN workload (target-stub.js), /core bench entry not found');
}

const report = await runBenchmark({ target, layoutId, baseSeed, iterations, warmup });

console.log(JSON.stringify({
  issue: 4,
  gate: { metric: 'p95_ms', threshold: P95_GATE_MS, pass: report.stats.p95 < P95_GATE_MS },
  note: 'binding gate is measured on-device via bench/index.html, not on this host',
  target: target.name,
  isStub,
  layoutId,
  baseSeed,
  iterations,
  warmup,
  stats: report.stats,
  failures: report.failures,
  checksum: report.checksum,
  host: { node: process.version, platform: process.platform, arch: process.arch },
  timestamp: new Date().toISOString(),
}, null, 2));

if (report.failures > 0) process.exit(1);
