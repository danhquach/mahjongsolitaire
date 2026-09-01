// End-to-end acceptance check for issue #11: one full Turtle level playable
// in a real browser on phone + tablet viewports, portrait + landscape, at
// real device pixel ratios.
//
// Not part of `npm test` (needs a browser); run manually or from CI:
//   npm run build && node qa/e2e-slice.mjs
// Set CHROMIUM_PATH if Chromium is not at the default container location.
//
// Drives real pointer events at tile screen positions (via the window.__slice
// debug handle) through the same hit-test path a player's taps take, plays the
// generator's solution witness to completion, and asserts the win overlay.
// Also exercises the 8dp mis-tap forgiveness and asserts the board actually
// fills the viewport (guards HiDPI scaling regressions), and — for issue #13 —
// drives the three boosters through their real buttons, checking that a charge
// is spent per successful use and that the balances survive a page reload.
// For issue #14 it force-quits mid-level (a real page reload) and asserts the
// board, score, holder and settings all come back, and that a won level
// leaves no save behind.
// For issue #43/#93 it parks a tile with one tap, checks the strip and the
// freed tile underneath, matches a pair in the holder, and force-quits with a
// tile still parked.
// For issue #44 it drives three consecutive matches with no waiting between
// them (all resolve, nothing is matched twice, and the taps land while earlier
// pairs are still in flight), asserts the match announcement is written in the
// tap's own task rather than after the animation, samples the flight itself
// for travel and frame budget, re-runs it under an emulated
// prefers-reduced-motion to check nothing travels, and shakes a mismatch.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { chromium } from 'playwright-core';

const CHROMIUM = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium';
const DIST = new URL('../dist-web', import.meta.url).pathname;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };

const server = createServer(async (req, res) => {
  const path = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  let body;
  try {
    body = await readFile(join(DIST, path));
  } catch {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' });
  res.end(body);
});
await new Promise((r) => server.listen(0, r));
const url = `http://127.0.0.1:${server.address().port}/`;

// `hud` / `minTileW` / `minCoverage` are the issue #37 expectations: which edge
// the measured fit rule must pick, and the board size that choice has to buy.
// Floors sit ~1px / ~0.02 below the values measured in Chromium on the shipped
// Turtle layout, so a placement regression fails loudly while antialiasing and
// font-metric drift do not. Every viewport here is the transpose of another, so
// the rotation check below can look its target's expectations up in this table.
const VIEWPORTS = [
  { name: 'phone portrait', width: 390, height: 844, dpr: 3 },
  { name: 'phone landscape', width: 844, height: 390, dpr: 3 },
  { name: 'tablet portrait', width: 810, height: 1080, dpr: 2 },
  { name: 'tablet landscape', width: 1080, height: 810, dpr: 2 },
].map((vp) => ({
  ...vp,
  ...{
    '390x844': { hud: 'top', minTileW: 23, minCoverage: 0.29 },
    '844x390': { hud: 'side', minTileW: 34, minCoverage: 0.64 },
    '810x1080': { hud: 'top', minTileW: 51, minCoverage: 0.5 },
    // Lowered for issue #43 (the holder strip takes its height out of the fit)
    // and again for issue #66 (slots grew to full tile size — the accepted
    // trade: measured 59.95px here, floor ~1px below).
    '1080x810': { hud: 'top', minTileW: 59, minCoverage: 0.79 },
  }[`${vp.width}x${vp.height}`],
}));

const expectationFor = (width, height) =>
  VIEWPORTS.find((vp) => vp.width === width && vp.height === height);

/**
 * Board fit as the player gets it, measured through the app's own geometry:
 * chosen HUD edge, on-screen tile width, and how much of the play area the
 * board actually covers. Runs in the page (issue #37).
 */
function measureFit() {
  const slice = window.__slice;
  const rects = slice.game.hitCandidates().map((c) => slice.tileCssRect(c.id));
  const minX = Math.min(...rects.map((r) => r.x));
  const maxX = Math.max(...rects.map((r) => r.x + r.w));
  const minY = Math.min(...rects.map((r) => r.y));
  const maxY = Math.max(...rects.map((r) => r.y + r.h));
  const board = document.getElementById('board');
  const canvas = document.querySelector('#board canvas');
  return {
    hud: slice.hudPlacement(),
    scale: slice.renderer.scale,
    tileW: rects[0].w,
    boardW: maxX - minX,
    boardH: maxY - minY,
    areaW: board.clientWidth,
    areaH: board.clientHeight,
    canvasW: canvas.clientWidth,
    canvasH: canvas.clientHeight,
  };
}

/** Deals one deadlock hunt will play through before giving up (see huntDeadlock). */
const DEADLOCK_HUNT_DEALS = 40;

const browser = await chromium.launch({ executablePath: CHROMIUM });
let failures = 0;

/**
 * Deal and play naive greedy lines in the page until one deadlocks — how a real
 * player walks into a dead end — and report the stuck dialog's state. Returns
 * null if every deal worked out. Runs entirely in the page (tile activation
 * through the a11y layer), so it costs no round-trips per move.
 *
 * The deal budget was 12 until issue #43. The holder made real deadlocks rarer
 * twice over — `status()` now looks through hold sequences before it says stuck,
 * and this hunt itself parks a tile when no pair is visible — which pushed the
 * skip rate on phone viewports from 0 to ~30% (measured: 7 skips in 24 hunts).
 * A skip is a silent hole in the spec §4 "never hard-fail" coverage, so the
 * budget is sized to close it rather than left where it was. Deals are played
 * in-page with no round trips, so this costs wall-clock, not flakiness.
 */
function huntDeadlock(maxDeals) {
  const slice = window.__slice;
  // Board tiles carry data-tile-id in #a11y-layer. Held tiles are not
  // activatable any more (issue #93): a pair with one half in the holder is
  // played by tapping the board half.
  const click = (id) => document.querySelector(`#a11y-layer [data-tile-id="${id}"]`)?.click();
  // Issue #64: the first tap on a face-down tile only peeks at it — the tap
  // that acts is the next one.
  const activate = (id) => {
    if (slice.game.isFaceHidden(id)) click(id);
    click(id);
  };
  const pairs = () => {
    const byFace = {};
    for (const c of slice.game.hitCandidates()) {
      if (c.free) (byFace[slice.game.board.get(c.id).face] ??= []).push(c.id);
    }
    return Object.values(byFace)
      .filter((ids) => ids.length > 1)
      .map((ids) => [ids[0], ids[1]]);
  };
  for (let deal = 0; deal < maxDeals; deal++) {
    document.getElementById('btn-new').click();
    for (let move = 0; slice.game.status() === 'playing' && move < 400; move++) {
      const held = new Set(slice.holder().slots.filter((id) => id !== null));
      const heldFaces = new Set([...held].map((id) => slice.game.board.get(id).face));
      // A board tile whose match is already parked clears in one tap (#93) —
      // asked of the game's own rule, not a re-derived face set.
      const clearer = slice.game
        .hitCandidates()
        .find((c) => c.free && slice.game.pairsWithHeld(c.id));
      if (clearer) {
        click(clearer.id);
        continue;
      }
      const options = pairs().filter(([a]) => !held.has(a));
      // Deterministic but unstrategic pick: the point is to lose sometimes.
      const pair = options.length ? options[(deal * 7 + move * 3) % options.length] : null;
      // Every pair transits the holder now (issue #93): the first tap parks,
      // the second clears. That transit needs a slot that is not the fatal
      // fourth, so a board pair is only played with two vacancies in hand.
      if (pair && slice.holder().vacancies >= 2) {
        activate(pair[0]);
        activate(pair[1]);
        continue;
      }
      // No pair playable: park a free singleton — parking frees what it
      // covered. Issue #63: the park that fills the last slot loses the level,
      // and this hunt is looking for a *deadlock*; stop one slot short.
      const free = slice.game.board
        .freeTileIds()
        .filter((id) => !heldFaces.has(slice.game.board.get(id).face));
      if (free.length === 0 || slice.holder().vacancies < 2) break;
      const target = free[(deal * 5 + move) % free.length];
      activate(target);
    }
    if (slice.game.status() === 'stuck') {
      return {
        deal,
        tilesLeft: slice.game.tilesLeft,
        title: document.getElementById('overlay-title').textContent,
        shuffleOffered: !document.getElementById('overlay-shuffle').hidden,
        undoOffered: !document.getElementById('overlay-undo').hidden,
        focus: document.activeElement?.id,
        charges: slice.boosterCharges(),
      };
    }
  }
  return null;
}

/**
 * Up to `want` matchable pairs among the free tiles, as [a, b] id pairs. Runs
 * in the page (issue #44).
 */
function freePairs(want) {
  const slice = window.__slice;
  const seen = new Map();
  const pairs = [];
  // Face-up only (issue #64): the probes tap each tile of a pair once, so a
  // face-down tile — whose first tap is a peek — would break their accounting.
  const parkedFaces = new Set(
    slice
      .holder()
      .slots.filter((id) => id !== null)
      .map((id) => slice.game.board.get(id).face),
  );
  for (const c of slice.game
    .hitCandidates()
    .filter(
      (t) =>
        t.free &&
        !slice.game.isFaceHidden(t.id) &&
        !parkedFaces.has(slice.game.board.get(t.id).face),
    )) {
    const face = slice.game.board.get(c.id).face;
    const partner = seen.get(face);
    if (partner === undefined) {
      seen.set(face, c.id);
      continue;
    }
    pairs.push([partner, c.id]);
    seen.delete(face);
    if (pairs.length === want) break;
  }
  return pairs;
}

/**
 * Tap one matchable pair and watch the tray effects frame by frame (issue
 * #93): how far the flying DOM copies actually travelled, how long the
 * sequence ran, the frame intervals it ran at, and whether the fx layer came
 * back empty. Runs in the page.
 */
async function flightProbe(pair) {
  const slice = window.__slice;
  const canvas = document.querySelector('#board canvas');
  const box = canvas.getBoundingClientRect();
  if (!pair) return { tapped: false };
  const before = slice.game.tilesLeft;
  const origins = new Map();
  for (const id of pair) {
    const r = slice.tileCssRect(id);
    canvas.dispatchEvent(
      new PointerEvent('pointerdown', {
        clientX: box.x + r.x + r.w / 2,
        clientY: box.y + r.y + r.h / 2,
        bubbles: true,
      }),
    );
  }
  const frames = [];
  let maxTravel = 0;
  const started = performance.now();
  let previous = started;
  await new Promise((resolve) => {
    const step = (now) => {
      frames.push(now - previous);
      previous = now;
      for (const node of document.querySelectorAll('#fx-layer .fx-tile')) {
        const r = node.getBoundingClientRect();
        const from = origins.get(node) ?? { x: r.x, y: r.y };
        if (!origins.has(node)) origins.set(node, from);
        maxTravel = Math.max(maxTravel, Math.hypot(r.x - from.x, r.y - from.y));
      }
      if (slice.animating() && now - started < 2500) requestAnimationFrame(step);
      else resolve();
    };
    requestAnimationFrame(step);
  });
  // Drop the first interval: it spans the gap from the tap to the first frame.
  const intervals = frames.slice(1).sort((a, b) => a - b);
  return {
    tapped: true,
    maxTravel,
    durationMs: performance.now() - started,
    cleared: before - slice.game.tilesLeft,
    settled:
      !slice.animating() && document.querySelectorAll('#fx-layer *').length === 0,
    frames: intervals.length,
    slowest: intervals.slice(-4).map((v) => +v.toFixed(1)),
    median: intervals[Math.floor(intervals.length / 2)] ?? 0,
    p95: intervals[Math.floor(intervals.length * 0.95)] ?? 0,
  };
}

/**
 * The same frame sampling as flightProbe, but over a plain park tap and its
 * undo — full-board redraws with no pair-clear sequence. This is the control:
 * draw() tears the board down and rebuilds all 144 tiles on every tap, which
 * costs far more than the animation does, so an absolute frame-time floor
 * would be measuring the renderer rather than the effects (issue #44 / #93).
 */
async function baselineProbe() {
  const slice = window.__slice;
  const canvas = document.querySelector('#board canvas');
  const box = canvas.getBoundingClientRect();
  const parkedFaces = new Set(
    slice
      .holder()
      .slots.filter((id) => id !== null)
      .map((id) => slice.game.board.get(id).face),
  );
  // Face-up, and a face the holder does not carry (issue #93): the tap must
  // park, not peek and not clear a pair.
  const target = slice.game
    .hitCandidates()
    .find(
      (t) =>
        t.free &&
        !slice.game.isFaceHidden(t.id) &&
        !parkedFaces.has(slice.game.board.get(t.id).face),
    );
  if (!target || slice.holder().vacancies < 2) return { tapped: false };
  const r = slice.tileCssRect(target.id);
  const frames = [];
  let previous = performance.now();
  const sampled = new Promise((resolve) => {
    const step = (now) => {
      frames.push(now - previous);
      previous = now;
      if (frames.length < 24) requestAnimationFrame(step);
      else resolve();
    };
    requestAnimationFrame(step);
  });
  canvas.dispatchEvent(
    new PointerEvent('pointerdown', {
      clientX: box.x + r.x + r.w / 2,
      clientY: box.y + r.y + r.h / 2,
      bubbles: true,
    }),
  );
  await sampled;
  // Put the tile back so the probe leaves the board as it found it. Free —
  // charge accounting only spends on the button path, and this is the model.
  window.__slice.game.undo();
  const intervals = frames.slice(1).sort((a, b) => a - b);
  return {
    tapped: true,
    median: intervals[Math.floor(intervals.length / 2)] ?? 0,
    p95: intervals[Math.floor(intervals.length * 0.95)] ?? 0,
  };
}

/**
 * Activate a blocked tile and watch its own container: it must leave its slot
 * and come back to it (issue #44's shake; a mismatch no longer exists under
 * issue #93, so the blocked tap is the shake's remaining trigger).
 */
async function blockedProbe() {
  const slice = window.__slice;
  const target = slice.game.hitCandidates().find((t) => !t.free);
  if (!target) return { tapped: false };
  // Through the a11y layer: a blocked tile's own button routes a real blocked
  // activation without having to find an uncovered sliver to aim a pointer at.
  document.querySelector(`#a11y-layer [data-tile-id="${target.id}"]`)?.click();
  let maxOffset = 0;
  const started = performance.now();
  await new Promise((resolve) => {
    const step = (now) => {
      const node = slice.renderer.tileNode(target.id);
      if (node) maxOffset = Math.max(maxOffset, Math.abs(node.position.x));
      if (slice.animating() && now - started < 2000) requestAnimationFrame(step);
      else resolve();
    };
    requestAnimationFrame(step);
  });
  const node = slice.renderer.tileNode(target.id);
  const resting = !node || (node.position.x === 0 && node.position.y === 0);
  return { tapped: true, maxOffset, restedAt0: resting };
}

function check(ok, label, data) {
  if (ok) return;
  console.error(`  ${label} FAIL:`, data);
  failures++;
}

for (const vp of VIEWPORTS) {
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: vp.dpr,
    hasTouch: true,
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => {
    console.error(`  page error: ${e.message}`);
    failures++;
  });
  // Issue #79: a fresh profile now boots ladder level 1 (butterfly). This
  // harness's geometry thresholds are calibrated on the Turtle slice, so seed
  // the ladder position to the first turtle_classic level before the app boots.
  await ctx.addInitScript(() => {
    localStorage.setItem('mahjong.progress.v1', JSON.stringify({ level: 47 }));
  });
  await page.goto(url);
  await page.waitForFunction(() => window.__slice !== undefined);

  // Page coordinates of a tile's top-face center, via the app's own geometry.
  const tileCenter = (id) =>
    page.evaluate((tileId) => {
      const r = window.__slice.tileCssRect(tileId);
      const c = document.querySelector('#board canvas').getBoundingClientRect();
      return { x: c.x + r.x + r.w / 2, y: c.y + r.y + r.h / 2 };
    }, id);

  /** Tap a board tile the way a player has to (issue #64): a face-down tile
   *  takes one extra tap first — the peek — before the tap that acts. A tile
   *  already in the holder (its partner will fetch it) takes no tap at all. */
  const tapTile = async (id) => {
    if (await page.evaluate((i) => window.__slice.game.board.isHeld(i), id)) return;
    const c = await tileCenter(id);
    if (await page.evaluate((i) => window.__slice.game.isFaceHidden(i), id)) {
      await page.mouse.click(c.x, c.y);
    }
    await page.mouse.click(c.x, c.y);
  };

  // 1. The board fills the viewport: the scaled board spans ≥ 90% of the
  //    canvas along its constraining axis (catches HiDPI 1/DPR-scale bugs),
  //    and — issue #37 — the HUD sits on the edge that buys the larger board,
  //    with the tile size and play-area coverage that choice is worth.
  {
    const fit = await page.evaluate(measureFit);
    const fillW = fit.boardW / fit.canvasW;
    const fillH = fit.boardH / fit.canvasH;
    if (Math.max(fillW, fillH) < 0.9) {
      console.error(`  EXTENT FAIL (dpr ${vp.dpr}):`, fit);
      failures++;
    }
    const coverage = (fit.boardW * fit.boardH) / (fit.areaW * fit.areaH);
    check(fit.hud === vp.hud, `HUD PLACEMENT (want ${vp.hud})`, fit);
    check(fit.tileW >= vp.minTileW, `TILE SIZE (want ≥ ${vp.minTileW}px)`, {
      tileW: fit.tileW,
      hud: fit.hud,
    });
    check(coverage >= vp.minCoverage, `PLAY-AREA COVERAGE (want ≥ ${vp.minCoverage})`, {
      coverage: +coverage.toFixed(3),
      hud: fit.hud,
    });
  }

  // 1b. Rotation (issue #37): the placement and the fit are re-decided live on
  //     an orientation change, not just at startup — and a forgiven tap still
  //     lands afterwards, so the new scale did not cost input accuracy. Every
  //     viewport's transpose is in VIEWPORTS, so the target's own expectations
  //     apply. Ends back where it started; the playthrough below is unaffected.
  {
    const rotated = expectationFor(vp.height, vp.width);
    await page.setViewportSize({ width: vp.height, height: vp.width });
    let fit;
    try {
      // Pixi re-fits on a frame, so poll rather than sleep a fixed time.
      await page.waitForFunction(
        (want) => window.__slice.hudPlacement() === want,
        rotated.hud,
        { timeout: 4000 },
      );
      fit = await page.evaluate(measureFit);
    } catch {
      fit = await page.evaluate(measureFit);
    }
    const coverage = (fit.boardW * fit.boardH) / (fit.areaW * fit.areaH);
    check(fit.hud === rotated.hud, `ROTATED HUD PLACEMENT (want ${rotated.hud})`, fit);
    check(fit.tileW >= rotated.minTileW, `ROTATED TILE SIZE (want ≥ ${rotated.minTileW}px)`, {
      tileW: fit.tileW,
      hud: fit.hud,
    });
    check(coverage >= rotated.minCoverage, `ROTATED COVERAGE (want ≥ ${rotated.minCoverage})`, {
      coverage: +coverage.toFixed(3),
      hud: fit.hud,
    });
    // 8dp forgiveness at the rotated scale (spec §7), through a real tap.
    const probe = await page.evaluate(() => {
      const t = window.__slice.game
        .hitCandidates()
        .filter((c) => c.free)
        .sort((a, b) => a.slot.x - b.slot.x)[0];
      const r = window.__slice.tileCssRect(t.id);
      const c = document.querySelector('#board canvas').getBoundingClientRect();
      return { id: t.id, x: c.x + r.x - 6, y: c.y + r.y + r.h / 2 };
    });
    // Issue #64: if the leftmost tile is face-down, peek it first (one center
    // tap) so the edge tap below acts instead of peeking.
    if (await page.evaluate((i) => window.__slice.game.isFaceHidden(i), probe.id)) {
      const cc = await tileCenter(probe.id);
      await page.mouse.click(cc.x, cc.y);
    }
    await page.mouse.click(probe.x, probe.y);
    // The forgiven tap acts (issue #93: it goes to the holder, or clears a
    // pair there) — either way the tile has left the board.
    const rotatedActed = await page.evaluate(
      (i) => !window.__slice.game.board.presentTiles().some((t) => t.id === i),
      probe.id,
    );
    check(rotatedActed, 'ROTATED FORGIVENESS', { want: probe.id, acted: rotatedActed });
    // A fresh deal: the probe parked a tile the sections below do not expect.
    await page.click('#btn-restart');
    await page.waitForFunction(() => !window.__slice.dealing);

    await page.setViewportSize({ width: vp.width, height: vp.height });
    try {
      await page.waitForFunction((want) => window.__slice.hudPlacement() === want, vp.hud, {
        timeout: 4000,
      });
    } catch {
      check(false, 'ROTATE BACK', await page.evaluate(measureFit));
    }
  }

  // 1c. Match feedback animation (issue #44). Everything here is about the
  //     animation *not* getting in the way: input stays live, the pair is
  //     really gone from the model at tap time, the announcement is not waiting
  //     on 320ms of tweening — and the motion itself actually happens, at the
  //     frame budget, and stops happening under reduced motion.
  {
    const pairs = await page.evaluate(freePairs, 3);
    check(pairs.length === 3, 'MATCH ANIM setup (want 3 free pairs)', { found: pairs.length });

    if (pairs.length === 3) {
      const before = await page.evaluate(() => window.__slice.game.tilesLeft);
      const taps = [];
      for (const [a, b] of pairs) {
        // Read *before* tapping: from the second pair on, the previous match
        // must still be in flight — that is the "input is not throttled" claim.
        const inFlight = await page.evaluate(() => window.__slice.animating());
        for (const id of [a, b]) {
          const c = await tileCenter(id);
          await page.mouse.click(c.x, c.y);
        }
        taps.push({
          inFlight,
          ...(await page.evaluate(() => ({
            said: document.getElementById('a11y-status').textContent ?? '',
            left: window.__slice.game.tilesLeft,
          }))),
        });
      }
      check(taps.at(-1).left === before - 6, 'RAPID MATCHES (want 6 tiles removed)', {
        before,
        after: taps.at(-1).left,
      });
      check(
        taps.every((t) => /matched/i.test(t.said)),
        'MATCH ANNOUNCED IN THE TAP\'S OWN TASK',
        taps.map((t) => t.said),
      );
      check(
        taps.slice(1).every((t) => t.inFlight),
        'TAP ACCEPTED WHILE AN EARLIER MATCH IS STILL FLYING',
        taps.map((t) => t.inFlight),
      );
      const removed = await page.evaluate(
        (ids) => ids.filter((id) => window.__slice.game.board.get(id).removed).length,
        pairs.flat(),
      );
      check(removed === 6, 'NO DOUBLE MATCH (want all 6 removed exactly once)', { removed });
    }

    // The control first: the same board, the same redraw, nothing animating.
    const baseline = await page.evaluate(baselineProbe);
    // Then the flight itself, sampled frame by frame from inside the page.
    const flight = await page.evaluate(flightProbe, (await page.evaluate(freePairs, 1))[0]);
    check(flight.tapped, 'FLIGHT PROBE setup (want a free pair)', flight);
    if (flight.tapped) {
      check(flight.maxTravel > 1, 'TILES TRAVEL (want > 1 board px of motion)', {
        maxTravel: +flight.maxTravel.toFixed(2),
      });
      check(flight.settled, 'BOARD SETTLES (want the fx layer empty)', flight);
      // Flight + dwell + clear is 550ms (anim.ts); the score popup rides
      // another 650ms after the clear. All decoration — input never waits.
      check(flight.durationMs < 1300, 'SEQUENCE UNDER 1300ms', {
        durationMs: Math.round(flight.durationMs),
      });
      // Two questions, because they have different answers. Does the
      // animation itself hold 60fps? — the median frame across the flight.
      // Does it make a tap *worse*? — its worst frame against the worst frame
      // of a plain select tap, which pays the same full-board redraw and
      // animates nothing. The redraw spike is pre-existing (issue #45's
      // renderer) and is the larger of the two by some margin.
      check(flight.median <= 16.7, 'FRAME BUDGET: 60fps THROUGH THE FLIGHT', {
        median: +flight.median.toFixed(2),
        p95: +flight.p95.toFixed(2),
        frames: flight.frames,
      });
      check(
        flight.p95 <= Math.max(16.7, baseline.p95),
        'FRAME BUDGET: THE ANIMATION COSTS NO MORE THAN THE REDRAW ALREADY DID',
        {
          matchP95: +flight.p95.toFixed(2),
          plainTapP95: +baseline.p95.toFixed(2),
          slowest: flight.slowest,
        },
      );
    }

    // Reduced motion, from the OS preference alone: cross-fade, no travel.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    check(
      await page.evaluate(() => window.__slice.reducedMotion()),
      'OS REDUCED-MOTION PREFERENCE HONOURED',
      {},
    );
    const reduced = await page.evaluate(flightProbe, (await page.evaluate(freePairs, 1))[0]);
    if (reduced.tapped) {
      check(reduced.maxTravel === 0, 'REDUCED MOTION: NO TRAVEL', {
        maxTravel: reduced.maxTravel,
      });
      check(reduced.cleared === 2, 'REDUCED MOTION: PAIR STILL CLEARS', reduced);
      check(reduced.settled, 'REDUCED MOTION: BOARD SETTLES', reduced);
    }
    await page.emulateMedia({ reducedMotion: null });

    // Blocked tap: the red outline is issue #11's; the shake is issue #44's
    // (the mismatch trigger retired with issue #93).
    const shake = await page.evaluate(blockedProbe);
    check(shake.tapped, 'BLOCKED PROBE setup (want a blocked tile)', shake);
    if (shake.tapped) {
      check(shake.maxOffset > 0.5, 'BLOCKED TAP SHAKES', { maxOffset: +shake.maxOffset.toFixed(2) });
      check(shake.restedAt0, 'SHAKEN TILE ENDS BACK ON ITS SLOT', shake);
    }

    // Back to a clean deal so the playthrough below starts where it expects.
    await page.click('#btn-new');
    await page.waitForFunction(() => !window.__slice.animating());
  }

  // 2. Mis-tap forgiveness: tap 6 CSS px outside a free tile's edge → selected.
  {
    const probe = await page.evaluate(() => {
      const { game } = window.__slice;
      // The leftmost free tile (the turtle's left wing) has open space to its left.
      const t = game
        .hitCandidates()
        .filter((c) => c.free)
        .sort((a, b) => a.slot.x - b.slot.x)[0];
      const r = window.__slice.tileCssRect(t.id);
      const c = document.querySelector('#board canvas').getBoundingClientRect();
      return { id: t.id, x: c.x + r.x - 6, y: c.y + r.y + r.h / 2 };
    });
    // Issue #64: peek a face-down leftmost tile first, so the edge tap acts.
    if (await page.evaluate((i) => window.__slice.game.isFaceHidden(i), probe.id)) {
      const cc = await tileCenter(probe.id);
      await page.mouse.click(cc.x, cc.y);
    }
    await page.mouse.click(probe.x, probe.y);
    const acted = await page.evaluate(
      (i) => !window.__slice.game.board.presentTiles().some((t) => t.id === i),
      probe.id,
    );
    if (!acted) {
      console.error(`  FORGIVENESS FAIL: tile ${probe.id} did not act on the forgiven tap`);
      failures++;
    }
    // A fresh deal: the forgiven tap parked a tile section 2b must not inherit.
    await page.click('#btn-restart');
    await page.waitForFunction(() => !window.__slice.dealing);
  }

  // 2b. The holder (issues #43, #93), driven the way a player drives it: park a
  //     free tile with one tap on the canvas, check the strip shows it and the
  //     tile it was covering is now free, clear it against its partner in a
  //     single tap, then force-quit with a tile still parked. The rail's Hold
  //     control is gone (#62), so its absence is checked too.
  {
    const before = failures;
    const slotMetrics = () =>
      page.evaluate(() => {
        const slots = [...document.querySelectorAll('#holder .slot')];
        return {
          count: slots.length,
          filled: slots.filter((n) => n.classList.contains('filled')).length,
          allDisabled: slots.every((n) => n.disabled),
          tooSmall: slots.filter((n) => {
            const r = n.getBoundingClientRect();
            return r.width < 48 || r.height < 48;
          }).length,
          groupLabel: document.getElementById('holder').getAttribute('aria-label'),
          holdButton: document.getElementById('btn-hold') !== null,
        };
      });

    const empty = await slotMetrics();
    check(empty.count === 4, 'the holder shows four slots', empty);
    check(empty.filled === 0, 'a fresh deal starts with an empty holder', empty);
    check(empty.allDisabled, 'slots are information, not controls (issue #93)', empty);
    check(empty.tooSmall === 0, 'every holder slot is a 48dp target', empty);
    check(/0 of 4 slots used/.test(empty.groupLabel ?? ''), 'the strip names its state', empty);
    check(!empty.holdButton, 'the rail no longer carries a Hold control (issue #62)', empty);

    // A free tile that is the *sole* cover of some tile below it, and whose
    // partner is also free: parking it proves both halves at once — the tile
    // underneath is uncovered, and it can then be matched out of the holder.
    // "Sole" matters: Turtle's half-offset rows let two upper tiles straddle one
    // lower tile, and parking either of those uncovers nothing.
    const target = await page.evaluate(() => {
      const b = window.__slice.game.board;
      const present = b.presentTiles();
      const free = b.freeTileIds();
      const byFace = {};
      for (const id of free) (byFace[b.get(id).face] ??= []).push(id);
      const covers = (a, t) =>
        a.slot.z === t.slot.z + 1 &&
        Math.abs(a.slot.x - t.slot.x) < 2 &&
        Math.abs(a.slot.y - t.slot.y) < 2;
      for (const id of free) {
        // Both halves face-up (issue #64): the park below is one plain tap,
        // and the clear is one tap on the partner.
        if (window.__slice.game.isFaceHidden(id)) continue;
        const partner = (byFace[b.get(id).face] ?? []).find(
          (x) => x !== id && !window.__slice.game.isFaceHidden(x),
        );
        if (partner === undefined) continue;
        const self = b.get(id);
        const witness = present.find(
          (t) => covers(self, t) && present.filter((c) => covers(c, t)).length === 1,
        );
        if (witness) return { id, partner, witness: witness.id };
      }
      return null;
    });
    check(target !== null, 'the deal has a tile worth parking', target);
    if (target !== null) {
      const tilesBefore = await page.evaluate(() => window.__slice.game.tilesLeft);
      const coveredBefore = await page.evaluate(
        (t) => window.__slice.game.board.isCovered(t.witness),
        target,
      );
      check(coveredBefore, 'the tile under it starts covered', target);

      // Park: one tap is the whole gesture (issue #93).
      const c = await tileCenter(target.id);
      await page.mouse.click(c.x, c.y);
      const parked = await page.evaluate(
        (t) => ({
          holder: window.__slice.holder(),
          onBoard: window.__slice.game.board.presentTiles().some((x) => x.id === t.id),
          stillCovered: window.__slice.game.board.isCovered(t.witness),
          slotLabel: document
            .querySelector(`#holder [data-tile-id="${t.id}"]`)
            ?.getAttribute('aria-label'),
          said: document.getElementById('a11y-status').textContent,
          tilesLeft: window.__slice.game.tilesLeft,
          // Issue #66: the parked tile's visual vs a board tile's on-screen
          // top-face size. The slot draws face + side depth, so the ratio is
          // (TILE+SIDE)/TILE — a little over 1 on both axes, and equal-scale.
          slotTile: (() => {
            const r = document
              .querySelector(`#holder [data-tile-id="${t.id}"] .tile`)
              ?.getBoundingClientRect();
            const free = window.__slice.game.hitCandidates()[0];
            const b = window.__slice.tileCssRect(free.id);
            return r ? { wRatio: r.width / b.w, hRatio: r.height / b.h } : null;
          })(),
        }),
        target,
      );
      const strip = await slotMetrics();
      check(
        parked.slotTile !== null &&
          parked.slotTile.wRatio >= 1 &&
          parked.slotTile.wRatio <= 1.2 &&
          parked.slotTile.hRatio >= 1 &&
          parked.slotTile.hRatio <= 1.2 &&
          // Equal scale on both axes, ratios normalised by (TILE+SIDE)/TILE per
          // axis (71/64, 91/84); tolerance covers the strip's whole-px rounding
          // at phone scale, where 1px is ~4% of a tile.
          Math.abs(parked.slotTile.wRatio / (71 / 64) - parked.slotTile.hRatio / (91 / 84)) < 0.05,
        'a parked tile reads the same size as a board tile (issue #66)',
        parked.slotTile,
      );
      check(parked.holder.slots[0] === target.id, 'the tile is in the first slot', parked);
      check(parked.holder.holdsUsed === 1, 'the hold is counted', parked);
      check(!parked.onBoard, 'a parked tile is off the board', parked);
      check(parked.tilesLeft === tilesBefore, 'but still counts as a tile left', parked);
      check(!parked.stillCovered, 'parking uncovers the tile underneath', parked);
      check(/in holder slot 1/.test(parked.slotLabel ?? ''), 'the slot names its tile', parked);
      check(/sent to holder slot 1/.test(parked.said ?? ''), 'the hold is announced', parked.said);
      check(strip.filled === 1, 'the strip draws the parked tile', strip);
      check(/1 of 4 slots used/.test(strip.groupLabel ?? ''), 'and counts it', strip);

      // One tap on the partner clears the pair in the holder (issue #93) —
      // no aiming at the strip, and no second tap.
      const p = await tileCenter(target.partner);
      await page.mouse.click(p.x, p.y);
      const matched = await page.evaluate(() => ({
        holder: window.__slice.holder(),
        selection: window.__slice.selection,
        tilesLeft: window.__slice.game.tilesLeft,
        score: window.__slice.game.score,
        filled: [...document.querySelectorAll('#holder .slot.filled')].length,
        said: document.getElementById('a11y-status').textContent,
      }));
      check(matched.holder.slots[0] === null, 'one tap frees the slot', matched);
      check(matched.tilesLeft === tilesBefore - 2, 'and clears both tiles', matched);
      check(matched.score === 100, 'and scores like any other pair', matched);
      check(matched.selection === null, 'and leaves nothing selected', matched);
      check(matched.filled === 0, 'and the strip empties', matched);
      check(/pair matched/i.test(matched.said ?? ''), 'and is announced as a match', matched);

      // Park one more tile and force-quit: the holder is part of the save.
      const spare = await page.evaluate(() =>
        window.__slice.game.board.freeTileIds().find((id) => !window.__slice.game.isFaceHidden(id)),
      );
      const sc = await tileCenter(spare);
      await page.mouse.click(sc.x, sc.y);
      const beforeQuit = await page.evaluate(() => ({
        holder: window.__slice.holder(),
        hash: window.__slice.stateHash(),
      }));
      await page.reload();
      await page.waitForFunction(() => window.__slice !== undefined);
      const afterQuit = await page.evaluate(() => ({
        holder: window.__slice.holder(),
        hash: window.__slice.stateHash(),
        filled: [...document.querySelectorAll('#holder .slot.filled')].length,
      }));
      check(
        JSON.stringify(afterQuit.holder.slots) === JSON.stringify(beforeQuit.holder.slots) &&
          afterQuit.hash === beforeQuit.hash &&
          afterQuit.holder.holdsUsed === beforeQuit.holder.holdsUsed,
        'the holder comes back after a force-quit',
        { beforeQuit, afterQuit },
      );
      check(afterQuit.filled === 1, 'and the strip redraws it', afterQuit);
    }
    console.log(
      `${failures === before ? 'ok' : 'FAIL'} — ${vp.name}: holder park / one-tap clear / resume`,
    );
    // A fresh deal for the end-to-end play-through below. Through the app's own
    // control, not localStorage + reload: the unload handler writes the save on
    // the way out, so a cleared slot would be refilled before the next boot.
    await page.click('#btn-new');
  }

  // 2c. The one-way holder and its loss (issue #63 / decision 0009): park until
  //     the holder is full and check the whole chain — the warning on the last
  //     empty slot before the fatal step, the loss dialog with no Shuffle and no
  //     Undo, the rail inert behind it, and a reload that comes back lost rather
  //     than handing the board back.
  {
    const before = failures;
    // Park a face the holder does not already carry, so the tap parks rather
    // than clearing a pair (issue #93). The tile's accessible name is read
    // *before* the tap — that is the cue that has to arrive before the step.
    const parkOne = async () => {
      const target = await page.evaluate(() => {
        const b = window.__slice.game.board;
        const parked = new Set(
          window.__slice
            .holder()
            .slots.filter((id) => id !== null)
            .map((id) => b.get(id).face),
        );
        // Face-up only (issue #64): the tap below must park, not peek.
        return (
          b
            .freeTileIds()
            .find(
              (id) => !parked.has(b.get(id).face) && !window.__slice.game.isFaceHidden(id),
            ) ?? null
        );
      });
      if (target === null) return null;
      const label = await page.evaluate(
        (id) =>
          document.querySelector(`#a11y-layer [data-tile-id="${id}"]`)?.getAttribute('aria-label'),
        target,
      );
      const c = await tileCenter(target);
      await page.mouse.click(c.x, c.y);
      return { target, label };
    };

    let warned = null;
    for (let i = 0; i < 3; i++) {
      const step = await parkOne();
      check(step !== null, `park ${i + 1} found a tile to park`, step);
      if (step === null) break;
      if (i === 2) warned = step;
    }
    const nearlyFull = await page.evaluate(() => ({
      holder: window.__slice.holder(),
      status: window.__slice.game.status(),
      group: document.getElementById('holder').getAttribute('aria-label'),
      lastMarked: [...document.querySelectorAll('#holder .slot.last')].map((n) => n.dataset.slot),
      lastLabel: document.querySelector('#holder .slot.last')?.getAttribute('aria-label'),
      said: document.getElementById('a11y-status').textContent,
      overlay: document.getElementById('overlay').classList.contains('visible'),
    }));
    check(nearlyFull.holder.vacancies === 1, 'three parks leave one slot', nearlyFull);
    check(nearlyFull.status === 'playing', 'and the level is still on', nearlyFull);
    check(!nearlyFull.overlay, 'no dialog yet', nearlyFull);
    check(nearlyFull.lastMarked.length === 1, 'exactly one slot is marked as the last', nearlyFull);
    check(
      /one slot left/i.test(nearlyFull.group ?? '') && /ends the level/i.test(nearlyFull.group ?? ''),
      'the holder group warns what filling it costs',
      nearlyFull,
    );
    check(
      /the last one; a tile with no match in the holder ends the level/i.test(
        nearlyFull.lastLabel ?? '',
      ),
      'and so does the slot itself',
      nearlyFull,
    );
    check(
      /one holder slot left/i.test(nearlyFull.said ?? ''),
      'the third park is announced with the warning',
      nearlyFull.said,
    );

    // The warning reaches the tile the player is about to activate, which is the
    // one cue that arrives *before* the irreversible step.
    const fatal = await parkOne();
    check(fatal !== null, 'a fourth tile is available to park', fatal);
    check(
      /activate to send it to the last holder slot, which ends the level/i.test(
        fatal?.label ?? '',
      ),
      'the tile named the fatal park before the tap',
      fatal?.label,
    );
    // …and `warned` is the control: the third park offered no such warning.
    check(
      /activate to send it to the holder$/i.test(warned?.label ?? ''),
      'while the park before it did not',
      warned?.label,
    );

    // The dialog's focus is repaired on the next task — a tap opens it from
    // inside `pointerdown`, and the browser's own `mousedown` takes focus to
    // <body> straight afterwards (see showStatus). Playwright's click resolves
    // before that task runs, so settle first and then assert.
    await page
      .waitForFunction(() => document.getElementById('overlay').contains(document.activeElement), {
        timeout: 2000,
      })
      .catch(() => {});
    const lost = await page.evaluate(() => ({
      holder: window.__slice.holder(),
      status: window.__slice.game.status(),
      title: document.getElementById('overlay-title').textContent,
      text: document.getElementById('overlay-text').textContent,
      shuffleOffered: !document.getElementById('overlay-shuffle').hidden,
      undoOffered: !document.getElementById('overlay-undo').hidden,
      railInert: document.getElementById('booster-rail').hasAttribute('inert'),
      focus: document.activeElement?.id,
      said: document.getElementById('a11y-status').textContent,
      tilesLeft: window.__slice.game.tilesLeft,
    }));
    check(lost.holder.full && lost.status === 'lost', 'the fourth park ends the level', lost);
    check(/holder full/i.test(lost.title ?? ''), 'the dialog names the reason', lost);
    check(!lost.shuffleOffered, 'a full holder is final: no Shuffle', lost);
    check(!lost.undoOffered, 'and no Undo', lost);
    check(lost.railInert, 'and the rail behind it is inert, so neither is reachable', lost);
    check(lost.focus === 'overlay-restart', 'focus lands on the way out that exists', lost);
    check(/holder full\. the level is over/i.test(lost.said ?? ''), 'the loss is announced', lost.said);
    check(lost.tilesLeft > 0, 'tiles are still on the board — this is a loss, not a win', lost);

    // A reload is not an escape hatch (issue #63).
    const beforeQuit = await page.evaluate(() => window.__slice.stateHash());
    await page.reload();
    await page.waitForFunction(() => window.__slice !== undefined);
    const afterQuit = await page.evaluate(() => ({
      status: window.__slice.game.status(),
      hash: window.__slice.stateHash(),
      title: document.getElementById('overlay-title').textContent,
      shuffleOffered: !document.getElementById('overlay-shuffle').hidden,
    }));
    check(afterQuit.status === 'lost', 'a lost level resumes lost', { beforeQuit, afterQuit });
    check(afterQuit.hash === beforeQuit, 'with the same state', { beforeQuit, afterQuit });
    check(/holder full/i.test(afterQuit.title ?? ''), 'and the same dialog', afterQuit);
    check(!afterQuit.shuffleOffered, 'still offering nothing but a restart', afterQuit);

    // Restart hands a playable board back.
    await page.click('#overlay-restart');
    const restarted = await page.evaluate(() => ({
      status: window.__slice.game.status(),
      holder: window.__slice.holder(),
      overlay: document.getElementById('overlay').classList.contains('visible'),
      marked: document.querySelectorAll('#holder .slot.last').length,
    }));
    check(restarted.status === 'playing', 'restart deals a playable board', restarted);
    check(restarted.holder.vacancies === 4, 'with an empty holder', restarted);
    check(!restarted.overlay && restarted.marked === 0, 'and no warning left over', restarted);
    console.log(
      `${failures === before ? 'ok' : 'FAIL'} — ${vp.name}: one-way holder, loss, resume, restart`,
    );
    await page.click('#btn-new');
  }

  // 3. Play the generator's solution witness end-to-end with real taps.
  const solution = await page.evaluate(() => window.__slice.game.level.solution);
  for (const [a, b] of solution) {
    // tapTile spends the extra peek tap on face-down tiles (issue #64).
    await tapTile(a);
    await tapTile(b);
  }
  const result = await page.evaluate(() => ({
    tilesLeft: window.__slice.game.tilesLeft,
    status: window.__slice.game.status(),
    score: window.__slice.game.score,
    overlay: document.getElementById('overlay-title').textContent,
    overlayVisible: document.getElementById('overlay').classList.contains('visible'),
  }));
  const ok =
    result.tilesLeft === 0 &&
    result.status === 'won' &&
    result.overlayVisible &&
    /^Level \d+ complete!$/.test(result.overlay ?? '');
  if (!ok) {
    console.error(`  END-TO-END FAIL:`, result);
    failures++;
  }
  console.log(
    `${ok ? 'ok' : 'FAIL'} — ${vp.name} (${vp.width}×${vp.height} @${vp.dpr}x): level cleared, score ${result.score}`,
  );

  // 4. Boosters (issue #13) driven through their real buttons: each one does
  //    its job, a charge is spent only when it did something, and the balances
  //    outlive a reload (the acceptance criterion "charges persist across
  //    restarts"). Runs after the win on a restarted deal.
  {
    const before = failures;
    // The won dialog offers "Next level", not a restart (issue #79). The next
    // level's layout is fetched before the dialog closes, so wait it out.
    await page.click('#overlay-new');
    await page.waitForFunction(
      () => !document.getElementById('overlay').classList.contains('visible'),
    );
    const start = await page.evaluate(() => window.__slice.boosterCharges());
    check(
      start.hint === 5 && start.undo === 5 && start.shuffle === 5,
      'starting grant is 5 of each',
      start,
    );

    // Hint: highlights a playable pair, spends 1, announces where it is.
    await page.click('#btn-hint');
    const hint1 = await page.evaluate(() => {
      const g = window.__slice.game;
      const byFace = {};
      for (const c of g.hitCandidates()) {
        if (c.free) (byFace[g.board.get(c.id).face] ??= []).push(c.id);
      }
      return {
        pair: [...window.__slice.hintPair],
        charges: window.__slice.boosterCharges(),
        said: document.getElementById('a11y-status').textContent,
        freePairs: Object.values(byFace).reduce(
          (n, ids) => n + (ids.length * (ids.length - 1)) / 2,
          0,
        ),
      };
    });
    check(hint1.pair.length === 2, 'hint highlights a pair', hint1);
    check(hint1.charges.hint === 4, 'hint spent one charge', hint1.charges);
    check(
      /^Hint: two .+ tiles, row \d+ column \d+ and row \d+ column \d+\. 4 hints left\.$/.test(
        hint1.said.trim(),
      ),
      'hint is announced with both positions and the balance',
      hint1.said,
    );

    // A repeat press cycles to another pair (spec §5), when one exists.
    await page.click('#btn-hint');
    const hint2 = await page.evaluate(() => [...window.__slice.hintPair]);
    check(
      hint1.freePairs > 1
        ? String(hint2) !== String(hint1.pair)
        : String(hint2) === String(hint1.pair),
      'repeat hint cycles to a different pair',
      { hint1: hint1.pair, hint2, freePairs: hint1.freePairs },
    );

    // Play the hinted pair with real taps (two moves since issue #93: a hold
    // and a match), then Undo both: board, score and holder come back; each
    // Undo costs one charge, Hint is untouched. Hint points at face-down tiles
    // too (issue #64, PM-intended leak), so the taps may need the extra peek.
    for (const id of hint2) await tapTile(id);
    const matched = await page.evaluate(() => ({
      tilesLeft: window.__slice.game.tilesLeft,
      score: window.__slice.game.score,
    }));
    check(matched.tilesLeft === 142 && matched.score > 0, 'hinted pair is matchable', matched);
    await page.click('#btn-undo');
    const undone = await page.evaluate(() => ({
      tilesLeft: window.__slice.game.tilesLeft,
      score: window.__slice.game.score,
      holder: window.__slice.holder(),
      charges: window.__slice.boosterCharges(),
      said: document.getElementById('a11y-status').textContent,
    }));
    check(
      undone.tilesLeft === 144 && undone.score === 0,
      'undo restores the pair and the score',
      undone,
    );
    check(
      undone.holder.slots.some((id) => id !== null),
      'the match undoes back into the holder (issue #93)',
      undone.holder,
    );
    check(
      undone.charges.undo === 4 && undone.charges.hint === 3,
      'undo spent exactly one undo charge',
      undone.charges,
    );
    check(/4 undos left\.$/.test(undone.said.trim()), 'undo announces the balance', undone.said);

    // The second undo takes back the hold itself.
    await page.click('#btn-undo');
    const unheld = await page.evaluate(() => ({
      holder: window.__slice.holder(),
      charges: window.__slice.boosterCharges(),
      said: document.getElementById('a11y-status').textContent,
    }));
    check(
      unheld.holder.slots.every((id) => id === null),
      'a second undo takes the hold back',
      unheld,
    );
    check(
      /taken back out of the holder/.test(unheld.said),
      'and says what came back',
      unheld.said,
    );

    // Undo with an empty stack: no charge, and it says why.
    await page.click('#btn-undo');
    const noUndo = await page.evaluate(() => ({
      charges: window.__slice.boosterCharges(),
      said: document.getElementById('a11y-status').textContent,
    }));
    check(noUndo.charges.undo === 3, 'a no-op undo costs nothing', noUndo);
    check(/Nothing to undo yet\./.test(noUndo.said), 'a no-op undo explains itself', noUndo.said);

    // Shuffle: same tiles in the same slots, still playable, one charge spent.
    const beforeShuffle = await page.evaluate(() =>
      window.__slice.game.board
        .presentTiles()
        .map((t) => [t.id, t.face].join(':'))
        .join(','),
    );
    await page.click('#btn-shuffle');
    const shuffled = await page.evaluate(() => ({
      signature: window.__slice.game.board
        .presentTiles()
        .map((t) => [t.id, t.face].join(':'))
        .join(','),
      tilesLeft: window.__slice.game.tilesLeft,
      status: window.__slice.game.status(),
      charges: window.__slice.boosterCharges(),
      said: document.getElementById('a11y-status').textContent,
    }));
    check(shuffled.tilesLeft === 144, 'shuffle keeps every tile in play', shuffled);
    check(shuffled.status === 'playing', 'shuffled board is playable', shuffled);
    check(shuffled.signature !== beforeShuffle, 'shuffle re-randomized the faces', {
      changed: shuffled.signature !== beforeShuffle,
    });
    check(shuffled.charges.shuffle === 4, 'shuffle spent one charge', shuffled.charges);

    // Exhaust Hint, then press once more: the balance floors at zero.
    for (let i = 0; i < 3; i++) await page.click('#btn-hint');
    await page.click('#btn-hint');
    const exhausted = await page.evaluate(() => ({
      charges: window.__slice.boosterCharges(),
      said: document.getElementById('a11y-status').textContent,
      dimmed: document.getElementById('btn-hint').classList.contains('spent'),
      name: document.getElementById('btn-hint').getAttribute('aria-label'),
    }));
    check(exhausted.charges.hint === 0, 'hint charges floor at zero', exhausted.charges);
    check(/No hints left\./.test(exhausted.said), 'an exhausted booster says so', exhausted.said);
    check(
      exhausted.dimmed && exhausted.name === 'Hint, no hints left',
      'an exhausted booster is dimmed and named accordingly',
      exhausted,
    );

    // Restart the app: the balances come back from storage.
    await page.reload();
    await page.waitForFunction(() => window.__slice !== undefined);
    const resumed = await page.evaluate(() => ({
      charges: window.__slice.boosterCharges(),
      badges: ['hint', 'undo', 'shuffle'].map(
        (k) => document.getElementById(`charges-${k}`).textContent,
      ),
    }));
    check(
      resumed.charges.hint === 0 && resumed.charges.undo === 3 && resumed.charges.shuffle === 4,
      'charges persist across a restart',
      resumed.charges,
    );
    check(
      resumed.badges.join('/') === '0/3/4',
      'the restored balances are on the buttons',
      resumed.badges,
    );
    console.log(
      `${failures === before ? 'ok' : 'FAIL'} — ${vp.name}: boosters + charge persistence`,
    );
  }

  // 5. Deadlock way out (spec §4: never hard-fail the player): the dialog offers
  //    Shuffle, and taking it either hands back a playable board or refuses
  //    honestly and falls back to Undo.
  {
    const before = failures;
    const stuck = await page.evaluate(huntDeadlock, DEADLOCK_HUNT_DEALS);
    if (stuck === null) {
      console.log(`  note — ${vp.name}: no deadlock in ${DEADLOCK_HUNT_DEALS} naive deals; stuck-dialog check skipped`);
    } else {
      check(stuck.title === 'No moves left', 'deadlock raises the stuck dialog', stuck);
      check(stuck.shuffleOffered, 'stuck dialog offers Shuffle', stuck);
      check(stuck.focus === 'overlay-shuffle', 'focus lands on the way out', stuck);
      // Spec §7 48dp, measured while the stuck dialog actually shows them
      // (the a11y audit can only measure the controls a win reveals).
      const small = await page.evaluate(() =>
        [...document.querySelectorAll('#overlay-shuffle, #overlay-undo')]
          .filter((n) => n.offsetParent !== null)
          .map((n) => ({
            id: n.id,
            w: n.getBoundingClientRect().width,
            h: n.getBoundingClientRect().height,
          }))
          .filter((r) => r.w + 0.01 < 48 || r.h + 0.01 < 48),
      );
      check(small.length === 0, 'deadlock controls are ≥ 48dp', small);
      await page.click('#overlay-shuffle');
      const rescued = await page.evaluate(() => ({
        status: window.__slice.game.status(),
        overlayVisible: document.getElementById('overlay').classList.contains('visible'),
        charges: window.__slice.boosterCharges(),
        focusIsTile: document.activeElement?.classList.contains('tile-node') === true,
        said: document.getElementById('a11y-status').textContent,
      }));
      // Two honest outcomes: the shuffle rescues the deal, or it refuses because
      // this end position has no solvable face assignment (a pair stacked on
      // itself). Spec §4's "never hard-fail" then rests on Undo, which the
      // dialog must still be offering.
      if (rescued.status === 'playing') {
        check(!rescued.overlayVisible, 'a rescued deal closes the dialog', rescued);
        check(
          rescued.charges.shuffle === stuck.charges.shuffle - 1,
          'the rescue shuffle spent one charge',
          { before: stuck.charges, after: rescued.charges },
        );
        check(rescued.focusIsTile, 'focus returns to the board, not <body>', rescued);
        check(/Board shuffled\./.test(rescued.said), 'the rescue is announced', rescued.said);
        console.log(
          `${failures === before ? 'ok' : 'FAIL'} — ${vp.name}: deadlock rescued by Shuffle (deal ${stuck.deal + 1}, ${stuck.tilesLeft} tiles left)`,
        );
      } else {
        const refused = await page.evaluate(() => ({
          shuffleStillOffered: !document.getElementById('overlay-shuffle').hidden,
          undoOffered: !document.getElementById('overlay-undo').hidden,
          focus: document.activeElement?.id,
        }));
        check(
          rescued.charges.shuffle === stuck.charges.shuffle,
          'a refused shuffle costs nothing',
          { before: stuck.charges, after: rescued.charges },
        );
        check(
          /cannot be shuffled\./.test(rescued.said),
          'a refused shuffle explains itself',
          rescued.said,
        );
        check(!refused.shuffleStillOffered, 'a refused shuffle stops being offered', refused);
        check(
          refused.undoOffered && refused.focus === 'overlay-undo',
          'the dialog still offers Undo as the way out',
          refused,
        );
        console.log(
          `${failures === before ? 'ok' : 'FAIL'} — ${vp.name}: unshufflable deadlock degrades to Undo (deal ${stuck.deal + 1}, ${stuck.tilesLeft} tiles left)`,
        );
      }
    }
  }

  // 6. The same deadlock with no Shuffle left: Undo has to be the offered way
  //    out, and it has to be the control focus lands on. Forced rather than
  //    hoped for — section 5 only reaches this path when a deal happens to be
  //    unshufflable.
  {
    const before = failures;
    await page.evaluate(() =>
      localStorage.setItem('mahjong.boosters.v1', JSON.stringify({ hint: 0, undo: 5, shuffle: 0 })),
    );
    await page.reload();
    await page.waitForFunction(() => window.__slice !== undefined);
    const stuck = await page.evaluate(huntDeadlock, DEADLOCK_HUNT_DEALS);
    if (stuck === null) {
      console.log(`  note — ${vp.name}: no deadlock in ${DEADLOCK_HUNT_DEALS} naive deals; Undo-only check skipped`);
    } else {
      check(!stuck.shuffleOffered, 'a spent Shuffle is not offered', stuck);
      check(stuck.undoOffered, 'Undo is offered as the remaining way out', stuck);
      check(stuck.focus === 'overlay-undo', 'focus lands on Undo, not Restart', stuck);
      await page.click('#overlay-undo');
      const resumed = await page.evaluate(() => ({
        status: window.__slice.game.status(),
        overlayVisible: document.getElementById('overlay').classList.contains('visible'),
        charges: window.__slice.boosterCharges(),
        focusIsTile: document.activeElement?.classList.contains('tile-node') === true,
        said: document.getElementById('a11y-status').textContent,
      }));
      check(
        resumed.status === 'playing' && !resumed.overlayVisible,
        'undoing out of a deadlock resumes play',
        resumed,
      );
      check(resumed.charges.undo === 4, 'the rescue undo spent one charge', resumed.charges);
      check(resumed.focusIsTile, 'focus returns to the board, not <body>', resumed);
      // Whatever came back is named: a pair, or a hold the hunt took to get
      // here (issue #43 makes holds undoable moves too).
      check(
        /(pair restored|the holder)\./.test(resumed.said),
        'the undo rescue is announced',
        resumed.said,
      );
      console.log(
        `${failures === before ? 'ok' : 'FAIL'} — ${vp.name}: deadlock rescued by Undo when Shuffle is spent (deal ${stuck.deal + 1})`,
      );
    }
  }

  // 7. Auto-save + resume (issue #14, spec §7). A page reload is the closest a
  //    browser gets to a force-quit: the tab's JS heap is gone, so everything
  //    the board comes back with came out of storage.
  {
    const before = failures;
    // Refill the boosters section 6 spent, then deal fresh through the real
    // button. Note that clearing storage and reloading would NOT give a fresh
    // boot: the outgoing page's `pagehide` handler saves the board it is
    // leaving, which is exactly the force-quit protection under test here.
    await page.evaluate(() =>
      localStorage.setItem('mahjong.boosters.v1', JSON.stringify({ hint: 5, undo: 5, shuffle: 5 })),
    );
    await page.reload();
    await page.waitForFunction(() => window.__slice !== undefined);
    await page.click('#btn-new');
    // The deal is async when the ladder level's layout differs from the loaded
    // one (issue #79); input is dropped until it lands, so wait it out.
    await page.waitForFunction(() => !window.__slice.dealing);

    // Play the generator's witness (naive greedy play can deadlock in a few
    // moves — that is what huntDeadlock above is for), then shuffle: shuffled
    // faces are the state a move-list replay could not reproduce. Then leave a
    // tile parked mid-pair (issue #93), which is state too.
    const played = await page.evaluate(() => {
      const s = window.__slice;
      const click = (id) => document.querySelector(`#a11y-layer [data-tile-id="${id}"]`)?.click();
      // Issue #64: the first tap on a face-down tile only peeks.
      const act = (id) => {
        if (s.game.isFaceHidden(id)) click(id);
        click(id);
      };
      for (const [a, b] of s.game.level.solution.slice(0, 4)) {
        act(a);
        act(b);
      }
      document.getElementById('btn-shuffle').click();
      // A shuffled board is solver-validated solvable, so a free matching pair
      // exists; park one of its tiles mid-pair. Face-up tiles only (issue
      // #64): the tap below must park, not peek.
      const seen = new Map();
      for (const id of s.game.board.freeTileIds().filter((t) => !s.game.isFaceHidden(t))) {
        const face = s.game.board.get(id).face;
        if (seen.has(face)) {
          click(seen.get(face));
          break;
        }
        seen.set(face, id);
      }
      return {
        hash: s.stateHash(),
        score: s.game.score,
        tilesLeft: s.game.tilesLeft,
        holder: s.holder().slots,
        seed: s.game.level.seed,
        undoDepth: s.game.undoDepth,
        saved: s.savedState() !== null,
      };
    });
    check(played.tilesLeft === 136, 'four witness pairs were played', played);
    check(played.saved, 'a mid-level board is saved', played);
    check(
      played.holder.some((id) => id !== null),
      'the test left a tile parked mid-pair to restore',
      played,
    );

    // Change two settings through the real controls before quitting.
    await page.click('#btn-settings');
    await page.click('#set-timed');
    await page.click('#set-size-m');
    await page.click('#settings-close');

    await page.reload();
    await page.waitForFunction(() => window.__slice !== undefined);
    const resumed = await page.evaluate(() => {
      const s = window.__slice;
      return {
        hash: s.stateHash(),
        score: s.game.score,
        tilesLeft: s.game.tilesLeft,
        holder: s.holder().slots,
        seed: s.game.level.seed,
        undoDepth: s.game.undoDepth,
        settings: s.settings(),
        timerShown: !document.getElementById('time-stat').hidden,
        said: document.getElementById('a11y-status').textContent,
      };
    });
    check(
      resumed.hash === played.hash &&
        resumed.score === played.score &&
        resumed.tilesLeft === played.tilesLeft &&
        JSON.stringify(resumed.holder) === JSON.stringify(played.holder) &&
        resumed.seed === played.seed &&
        resumed.undoDepth === played.undoDepth,
      'a force-quit mid-level resumes the identical board, score and holder',
      { played, resumed },
    );
    check(/Game resumed\./.test(resumed.said), 'the resume is announced', resumed.said);
    check(
      resumed.settings.timedMode === true && resumed.settings.tileSize === 'm',
      'settings survive the force-quit',
      resumed.settings,
    );
    check(resumed.timerShown, 'opting into the timer shows the readout', resumed);

    // The resumed board is a live game, not a museum piece. This is the check
    // that caught the resume clock: performance.now() restarts at 0 on the new
    // page, so a combo ladder restored from the old one rejected every match.
    const kept = await page.evaluate(() => {
      const s = window.__slice;
      const click = (id) => document.querySelector(`#a11y-layer [data-tile-id="${id}"]`)?.click();
      // The restored parked tile is mid-pair: one tap on its board partner is
      // the whole match (issue #93). Held tiles are face-up in the strip.
      const heldId = s.holder().slots.find((id) => id !== null);
      const heldFace = s.game.board.get(heldId).face;
      const partner = s.game.board
        .freeTileIds()
        .find((id) => s.game.board.get(id).face === heldFace);
      if (partner !== undefined) {
        // A resume re-conceals (issue #64), so the partner may need its peek.
        if (s.game.isFaceHidden(partner)) click(partner);
        click(partner);
      }
      return { tilesLeft: s.game.tilesLeft, score: s.game.score, status: s.game.status() };
    });
    check(
      kept.tilesLeft === played.tilesLeft - 2 && kept.score > played.score,
      'play continues normally on the resumed board',
      { played, kept },
    );

    // Finishing a level must leave nothing to resume into. Dealt fresh, because
    // the shuffle above invalidated this deal's witness.
    await page.click('#btn-new');
    const won = await page.evaluate(() => {
      const s = window.__slice;
      const click = (id) => document.querySelector(`#a11y-layer [data-tile-id="${id}"]`)?.click();
      // Issue #64: face-down tiles take the extra peek tap.
      const act = (id) => {
        if (s.game.isFaceHidden(id)) click(id);
        click(id);
      };
      for (const [a, b] of s.game.level.solution) {
        act(a);
        act(b);
      }
      return {
        status: s.game.status(),
        saved: s.savedState(),
        raw: localStorage.getItem('mahjong.save.v1'),
      };
    });
    check(won.status === 'won', 'the fresh deal plays to a win', won.status);
    check(won.saved === null && won.raw === null, 'a won level leaves no save behind', won);

    await page.reload();
    await page.waitForFunction(() => window.__slice !== undefined);
    const afterWin = await page.evaluate(() => ({
      tilesLeft: window.__slice.game.tilesLeft,
      score: window.__slice.game.score,
    }));
    check(
      afterWin.tilesLeft === 144 && afterWin.score === 0,
      'the next boot after a win deals a fresh level',
      afterWin,
    );
    console.log(
      `${failures === before ? 'ok' : 'FAIL'} — ${vp.name}: auto-save + resume across a force-quit`,
    );
  }

  await ctx.close();
}

await browser.close();
server.close();
if (failures > 0) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log('all viewports passed');
