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
// board, score, selection and settings all come back, and that a won level
// leaves no save behind.
// For issue #43 it parks a tile with the Hold button, checks the strip and the
// freed tile underneath, returns it, matches a pair out of the holder, and
// force-quits with a tile still parked.
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
    // Lowered for issue #43: the holder strip takes its height out of the fit
    // (68px of 810 here), which costs this viewport ~9% of its tile width.
    '1080x810': { hud: 'top', minTileW: 60, minCoverage: 0.79 },
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
  // Either layer: board tiles carry data-tile-id in #a11y-layer, held ones in
  // the holder strip (issue #43).
  const click = (id) => document.querySelector(`[data-tile-id="${id}"]`)?.click();
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
      const options = pairs();
      // Deterministic but unstrategic pick: the point is to lose sometimes.
      // With no pair on the board, fall back to the game's own hint, which can
      // name a holder pair the board-only scan above cannot see (issue #43).
      const pair = options.length
        ? options[(deal * 7 + move * 3) % options.length]
        : slice.game.hint();
      if (pair) {
        click(pair[0]);
        click(pair[1]);
        continue;
      }
      // No pair anywhere, and the game still says 'playing': the way on is the
      // holder — parking a free tile frees what it covered. This is the branch
      // that used to crash the hunt, because "playing" no longer implies "a
      // pair is on the board".
      const free = slice.game.board.freeTileIds();
      if (free.length === 0) break;
      click(free[(deal * 5 + move) % free.length]);
      document.getElementById('btn-hold').click();
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
  for (const c of slice.game.hitCandidates().filter((t) => t.free)) {
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
 * Tap one matchable pair and watch the flight frame by frame (issue #44):
 * how far the copies actually travelled from where they started, how long the
 * sequence ran, the frame intervals it ran at, and whether the effects layer
 * came back empty. Runs in the page.
 */
async function flightProbe(pair) {
  const slice = window.__slice;
  const canvas = document.querySelector('#board canvas');
  const box = canvas.getBoundingClientRect();
  if (!pair) return { tapped: false };
  const before = slice.game.tilesLeft;
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
      for (const child of slice.renderer.effects.children) {
        // The flying copies pivot on the centre they started from, so the gap
        // between position and pivot *is* the distance travelled.
        if (!child.pivot || (child.pivot.x === 0 && child.pivot.y === 0)) continue;
        maxTravel = Math.max(
          maxTravel,
          Math.hypot(child.position.x - child.pivot.x, child.position.y - child.pivot.y),
        );
      }
      if (slice.animating() && now - started < 2000) requestAnimationFrame(step);
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
    settled: !slice.animating() && slice.renderer.effects.children.length === 0,
    frames: intervals.length,
    slowest: intervals.slice(-4).map((v) => +v.toFixed(1)),
    median: intervals[Math.floor(intervals.length / 2)] ?? 0,
    p95: intervals[Math.floor(intervals.length * 0.95)] ?? 0,
  };
}

/**
 * The same frame sampling as flightProbe, but over a select + deselect — two
 * full-board redraws and no animation at all. This is the control: draw()
 * tears the board down and rebuilds all 144 tiles on every tap, which costs
 * far more than a match animation does, so an absolute frame-time floor would
 * be measuring the renderer rather than this ticket (issue #44).
 */
async function baselineProbe() {
  const slice = window.__slice;
  const canvas = document.querySelector('#board canvas');
  const box = canvas.getBoundingClientRect();
  const target = slice.game.hitCandidates().find((t) => t.free);
  if (!target) return { tapped: false };
  const tap = () => {
    const r = slice.tileCssRect(target.id);
    canvas.dispatchEvent(
      new PointerEvent('pointerdown', {
        clientX: box.x + r.x + r.w / 2,
        clientY: box.y + r.y + r.h / 2,
        bubbles: true,
      }),
    );
  };
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
  tap(); // select
  tap(); // deselect — a second redraw, still nothing animating
  await sampled;
  const intervals = frames.slice(1).sort((a, b) => a - b);
  return {
    tapped: true,
    median: intervals[Math.floor(intervals.length / 2)] ?? 0,
    p95: intervals[Math.floor(intervals.length * 0.95)] ?? 0,
  };
}

/**
 * Tap two free tiles that do not match and watch the shaken tile's own
 * container: it must leave its slot and come back to it (issue #44).
 */
async function mismatchProbe() {
  const slice = window.__slice;
  const canvas = document.querySelector('#board canvas');
  const box = canvas.getBoundingClientRect();
  const free = slice.game.hitCandidates().filter((t) => t.free);
  const first = free[0];
  const other = free.find((t) => slice.game.board.get(t.id).face !== slice.game.board.get(first.id).face);
  if (!first || !other) return { tapped: false };
  for (const id of [first.id, other.id]) {
    const r = slice.tileCssRect(id);
    canvas.dispatchEvent(
      new PointerEvent('pointerdown', {
        clientX: box.x + r.x + r.w / 2,
        clientY: box.y + r.y + r.h / 2,
        bubbles: true,
      }),
    );
  }
  let maxOffset = 0;
  const started = performance.now();
  await new Promise((resolve) => {
    const step = (now) => {
      for (const id of [first.id, other.id]) {
        const node = slice.renderer.tileNode(id);
        if (node) maxOffset = Math.max(maxOffset, Math.abs(node.position.x));
      }
      if (slice.animating() && now - started < 2000) requestAnimationFrame(step);
      else resolve();
    };
    requestAnimationFrame(step);
  });
  const resting = [first.id, other.id]
    .map((id) => slice.renderer.tileNode(id))
    .filter((n) => n)
    .every((n) => n.position.x === 0 && n.position.y === 0);
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
  await page.goto(url);
  await page.waitForFunction(() => window.__slice !== undefined);

  // Page coordinates of a tile's top-face center, via the app's own geometry.
  const tileCenter = (id) =>
    page.evaluate((tileId) => {
      const r = window.__slice.tileCssRect(tileId);
      const c = document.querySelector('#board canvas').getBoundingClientRect();
      return { x: c.x + r.x + r.w / 2, y: c.y + r.y + r.h / 2 };
    }, id);

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
    await page.mouse.click(probe.x, probe.y);
    const rotatedSel = await page.evaluate(() => window.__slice.game.selection);
    check(rotatedSel === probe.id, 'ROTATED FORGIVENESS', { want: probe.id, got: rotatedSel });
    await page.mouse.click(probe.x, probe.y); // deselect

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
      check(flight.settled, 'BOARD SETTLES (want the effects layer empty)', flight);
      check(flight.durationMs < 400, 'SEQUENCE UNDER 400ms', {
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

    // Mismatch: the red outline is issue #11's; the shake is this ticket's.
    const shake = await page.evaluate(mismatchProbe);
    check(shake.tapped, 'MISMATCH PROBE setup (want two unlike free tiles)', shake);
    if (shake.tapped) {
      check(shake.maxOffset > 0.5, 'MISMATCH SHAKES', { maxOffset: +shake.maxOffset.toFixed(2) });
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
    await page.mouse.click(probe.x, probe.y);
    const sel = await page.evaluate(() => window.__slice.game.selection);
    if (sel !== probe.id) {
      console.error(`  FORGIVENESS FAIL: expected selection ${probe.id}, got ${sel}`);
      failures++;
    }
    await page.mouse.click(probe.x, probe.y); // deselect via the same forgiven tap
  }

  // 2b. The holder (issue #43), driven through its real controls: park a free
  //     tile with the Hold button, check the strip shows it and the tile it was
  //     covering is now free, take it back with the same button (now Return),
  //     park it again and clear it against its partner, then force-quit with a
  //     tile still parked.
  {
    const before = failures;
    const slotMetrics = () =>
      page.evaluate(() => {
        const slots = [...document.querySelectorAll('#holder .slot')];
        return {
          count: slots.length,
          filled: slots.filter((n) => n.classList.contains('filled')).length,
          emptyAreDisabled: slots.every((n) => n.classList.contains('filled') || n.disabled),
          tooSmall: slots.filter((n) => {
            const r = n.getBoundingClientRect();
            return r.width < 48 || r.height < 48;
          }).length,
          groupLabel: document.getElementById('holder').getAttribute('aria-label'),
          holdLabel: document.getElementById('btn-hold').getAttribute('aria-label'),
        };
      });

    const empty = await slotMetrics();
    check(empty.count === 4, 'the holder shows four slots', empty);
    check(empty.filled === 0, 'a fresh deal starts with an empty holder', empty);
    check(empty.emptyAreDisabled, 'an empty slot is not a tab stop', empty);
    check(empty.tooSmall === 0, 'every holder slot is a 48dp target', empty);
    check(/0 of 4 slots used/.test(empty.groupLabel ?? ''), 'the strip names its state', empty);
    check(/select a tile first/i.test(empty.holdLabel ?? ''), 'Hold says what it needs', empty);

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
        const partner = (byFace[b.get(id).face] ?? []).find((x) => x !== id);
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

      const c = await tileCenter(target.id);
      await page.mouse.click(c.x, c.y); // select it on the canvas
      await page.click('#btn-hold');
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
        }),
        target,
      );
      const strip = await slotMetrics();
      check(parked.holder.slots[0] === target.id, 'the tile is in the first slot', parked);
      check(parked.holder.holdsUsed === 1, 'the hold is counted', parked);
      check(!parked.onBoard, 'a parked tile is off the board', parked);
      check(parked.tilesLeft === tilesBefore, 'but still counts as a tile left', parked);
      check(!parked.stillCovered, 'parking uncovers the tile underneath', parked);
      check(/in holder slot 1/.test(parked.slotLabel ?? ''), 'the slot names its tile', parked);
      check(/held in slot 1/.test(parked.said ?? ''), 'the hold is announced', parked.said);
      check(strip.filled === 1, 'the strip draws the parked tile', strip);
      check(/1 of 4 slots used/.test(strip.groupLabel ?? ''), 'and counts it', strip);

      // Selecting the parked tile turns Hold into Return, and Return puts it
      // back in its own slot — always legal (issue #43 rule 4).
      await page.click(`#holder [data-tile-id="${target.id}"]`);
      const asReturn = await page.evaluate(() => ({
        action: window.__slice.holder().action,
        label: document.getElementById('btn-hold').getAttribute('aria-label'),
        pressed: document
          .querySelector('#holder .slot.filled')
          ?.getAttribute('aria-pressed'),
      }));
      check(asReturn.action === 'return', 'the control flips to Return', asReturn);
      check(/return/i.test(asReturn.label ?? ''), 'and says so', asReturn);
      check(asReturn.pressed === 'true', 'the selected slot reads as pressed', asReturn);
      await page.click('#btn-hold');
      const returned = await page.evaluate(
        (t) => ({
          holder: window.__slice.holder(),
          onBoard: window.__slice.game.board.presentTiles().some((x) => x.id === t.id),
          free: window.__slice.game.board.isFree(t.id),
        }),
        target,
      );
      check(returned.holder.slots[0] === null, 'the slot is empty again', returned);
      check(returned.onBoard && returned.free, 'the tile is back on the board, free', returned);
      check(returned.holder.holdsUsed === 1, 'a return does not un-count the hold', returned);

      // Park it again, then match it out of the holder against its partner.
      const c2 = await tileCenter(target.id);
      await page.mouse.click(c2.x, c2.y);
      await page.click('#btn-hold');
      const p = await tileCenter(target.partner);
      await page.mouse.click(p.x, p.y);
      await page.click(`#holder [data-tile-id="${target.id}"]`);
      const matched = await page.evaluate(() => ({
        holder: window.__slice.holder(),
        tilesLeft: window.__slice.game.tilesLeft,
        score: window.__slice.game.score,
        filled: [...document.querySelectorAll('#holder .slot.filled')].length,
      }));
      check(matched.holder.slots[0] === null, 'a holder match frees the slot', matched);
      check(matched.tilesLeft === tilesBefore - 2, 'and clears both tiles', matched);
      check(matched.score === 100, 'and scores like any other pair', matched);
      check(matched.filled === 0, 'and the strip empties', matched);

      // Park one more tile and force-quit: the holder is part of the save.
      const spare = await page.evaluate(() => window.__slice.game.board.freeTileIds()[0]);
      const sc = await tileCenter(spare);
      await page.mouse.click(sc.x, sc.y);
      await page.click('#btn-hold');
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
      `${failures === before ? 'ok' : 'FAIL'} — ${vp.name}: holder park / return / match / resume`,
    );
    // A fresh deal for the end-to-end play-through below. Through the app's own
    // control, not localStorage + reload: the unload handler writes the save on
    // the way out, so a cleared slot would be refilled before the next boot.
    await page.click('#btn-new');
  }

  // 3. Play the generator's solution witness end-to-end with real taps.
  const solution = await page.evaluate(() => window.__slice.game.level.solution);
  for (const [a, b] of solution) {
    for (const id of [a, b]) {
      const c = await tileCenter(id);
      await page.mouse.click(c.x, c.y);
    }
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
    result.overlay === 'Level complete!';
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
    await page.click('#overlay-restart');
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

    // Play the hinted pair with real taps, then Undo it: board, score and
    // selection come back; Undo costs one charge, Hint is untouched.
    for (const id of hint2) {
      const c = await tileCenter(id);
      await page.mouse.click(c.x, c.y);
    }
    const matched = await page.evaluate(() => ({
      tilesLeft: window.__slice.game.tilesLeft,
      score: window.__slice.game.score,
    }));
    check(matched.tilesLeft === 142 && matched.score > 0, 'hinted pair is matchable', matched);
    await page.click('#btn-undo');
    const undone = await page.evaluate(() => ({
      tilesLeft: window.__slice.game.tilesLeft,
      score: window.__slice.game.score,
      charges: window.__slice.boosterCharges(),
      said: document.getElementById('a11y-status').textContent,
    }));
    check(
      undone.tilesLeft === 144 && undone.score === 0,
      'undo restores the pair and the score',
      undone,
    );
    check(
      undone.charges.undo === 4 && undone.charges.hint === 3,
      'undo spent exactly one undo charge',
      undone.charges,
    );
    check(/4 undos left\.$/.test(undone.said.trim()), 'undo announces the balance', undone.said);

    // Undo with an empty stack: no charge, and it says why.
    await page.click('#btn-undo');
    const noUndo = await page.evaluate(() => ({
      charges: window.__slice.boosterCharges(),
      said: document.getElementById('a11y-status').textContent,
    }));
    check(noUndo.charges.undo === 4, 'a no-op undo costs nothing', noUndo);
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
      resumed.charges.hint === 0 && resumed.charges.undo === 4 && resumed.charges.shuffle === 4,
      'charges persist across a restart',
      resumed.charges,
    );
    check(
      resumed.badges.join('/') === '0/4/4',
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

    // Play the generator's witness (naive greedy play can deadlock in a few
    // moves — that is what huntDeadlock above is for), then shuffle: shuffled
    // faces are the state a move-list replay could not reproduce. Then leave a
    // selection live mid-pair, which is state too.
    const played = await page.evaluate(() => {
      const s = window.__slice;
      const click = (id) => document.querySelector(`#a11y-layer [data-tile-id="${id}"]`)?.click();
      for (const [a, b] of s.game.level.solution.slice(0, 4)) {
        click(a);
        click(b);
      }
      document.getElementById('btn-shuffle').click();
      // A shuffled board is solver-validated solvable, so a free matching pair
      // exists; take one of its tiles as the live selection.
      const seen = new Map();
      for (const id of s.game.board.freeTileIds()) {
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
        selection: s.game.selection,
        seed: s.game.level.seed,
        undoDepth: s.game.undoDepth,
        saved: s.savedState() !== null,
      };
    });
    check(played.tilesLeft === 136, 'four witness pairs were played', played);
    check(played.saved, 'a mid-level board is saved', played);
    check(played.selection !== null, 'the test left a live selection to restore', played);

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
        selection: s.game.selection,
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
        resumed.selection === played.selection &&
        resumed.seed === played.seed &&
        resumed.undoDepth === played.undoDepth,
      'a force-quit mid-level resumes the identical board, score and selection',
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
      const seen = new Map();
      for (const id of s.game.board.freeTileIds()) {
        const face = s.game.board.get(id).face;
        if (seen.has(face)) {
          // The restored selection may already be this pair's first tile —
          // tapping it again would just deselect it.
          const partner = seen.get(face);
          if (s.game.selection !== partner) click(partner);
          click(id);
          break;
        }
        seen.set(face, id);
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
      for (const [a, b] of s.game.level.solution) {
        click(a);
        click(b);
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
