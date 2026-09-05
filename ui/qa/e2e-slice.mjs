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
// Core's own daily-challenge deal (issue #183), so the harness checks the
// page against the same function every device runs — not a re-derivation.
import {
  BASE_PAIR_POINTS,
  dailyChallenges,
  dailyDateKey,
  scoreMultiplierForLevel,
} from '../../core/dist/src/index.js';

/** What a first pair pays on the level this harness pins (47, medium band).
 *  Derived rather than hard-coded: issue #176 scales every pair by the level's
 *  band, so a literal here would have to be re-guessed whenever the multipliers
 *  move — and would quietly stop testing the rule it is named after. */
const FIRST_PAIR_POINTS = Math.round(BASE_PAIR_POINTS * scoreMultiplierForLevel(47));

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
// layouts, so a placement regression fails loudly while antialiasing and
// font-metric drift do not. Every viewport here is the transpose of another, so
// the rotation check below can look its target's expectations up in this table.
//
// Re-measured for issue #99 (compact portrait boards + the reserved booster
// band): portrait tiles grew 23→39.9px on the phone — the ticket's whole point
// — while landscape shrank (a portrait board letterboxes there; PM-accepted
// trade), and tablet landscape now picks the side HUD (the tall board buys
// more from width than from the top edge).
const VIEWPORTS = [
  { name: 'phone portrait', width: 390, height: 844, dpr: 3 },
  { name: 'phone landscape', width: 844, height: 390, dpr: 3 },
  { name: 'tablet portrait', width: 810, height: 1080, dpr: 2 },
  { name: 'tablet landscape', width: 1080, height: 810, dpr: 2 },
].map((vp) => ({
  ...vp,
  ...{
    // 0.81 → 0.74 with the HUD rework: the old header wrapped to two rows
    // (114px) at 390px, the stat-chip header holds one (60px), so the board
    // box gained 54px of height the width-constrained turtle cannot fill —
    // same 39.9px tiles, smaller fill ratio. Measured 0.762.
    '390x844': { hud: 'top', minTileW: 38, minCoverage: 0.74 },
    '844x390': { hud: 'side', minTileW: 26, minCoverage: 0.37 },
    // The floor covers every pool layout the session may have on the table
    // when it rotates in (board aspect now varies per deal — issue #99).
    '810x1080': { hud: 'top', minTileW: 60, minCoverage: 0.63 },
    '1080x810': { hud: 'side', minTileW: 58, minCoverage: 0.61 },
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

/**
 * Put back the stores a section borrowed and re-deal the level, so the next
 * section sees the balances and the fresh board it expects. The daily
 * challenges (issue #183) pay booster charges as they complete, so a section
 * that plays real pairs moves more than its own state.
 */
async function restoreStores(page, entries) {
  await page.evaluate((pairs) => {
    for (const [key, value] of pairs) {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    }
  }, entries);
  await page.reload();
  await page.waitForFunction(() => window.__slice !== undefined);
  // A reload resumes the save, which is mid-board; Restart re-deals the level.
  await page.click('#btn-restart');
  await page.waitForFunction(() => !window.__slice.dealing);
}

/** Deals one deadlock hunt will play through before giving up (see huntDeadlock). */
const DEADLOCK_HUNT_DEALS = 40;

const browser = await chromium.launch({ executablePath: CHROMIUM });
let failures = 0;
/**
 * Viewports whose deadlock hunt (sections 5 and 6 below) found no deadlock
 * and so asserted nothing. A skip on one viewport is the hunt's honest
 * randomness; a skip on every viewport means the spec §4 deadlock coverage
 * ran zero times, and that must fail the run rather than read as a pass
 * (issue #48).
 */
const deadlockSkips = { shuffle: 0, undoOnly: 0 };

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
async function huntDeadlock(maxDeals) {
  const slice = window.__slice;
  // Board tiles carry data-tile-id in #a11y-layer. Held tiles are not
  // activatable any more (issue #93): a pair with one half in the holder is
  // played by tapping the board half.
  const click = (id) => document.querySelector(`#a11y-layer [data-tile-id="${id}"]`)?.click();
  // Issue #64: the first tap on a face-down tile peeks at it — the tap that
  // acts is the next one — unless (issue #165) its match is already held, in
  // which case that first tap clears it and there is nothing left to tap.
  const activate = (id) => {
    if (slice.game.isFaceHidden(id)) {
      click(id);
      if (slice.game.board.get(id).removed) return;
    }
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
    // Issue #99: New game rotates the layout, so the deal is async while the
    // file fetches; input is dropped until it lands, so wait it out.
    while (slice.dealing) await new Promise((r) => setTimeout(r, 10));
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
      // Issue #122 plays a wash/grey-out/pulse theatre before the stuck
      // dialog itself opens (STUCK_DIALOG_DELAY_MS, ~1.5s) — same reason the
      // win and holder-full-loss checks elsewhere in this file wait out
      // `animating()` (which folds the pending dialog timer in) before
      // reading dialog state: `focus` in particular only lands on the way
      // out once that delayed reveal actually runs.
      while (slice.animating()) await new Promise((r) => setTimeout(r, 10));
      return {
        deal,
        tilesLeft: slice.game.tilesLeft,
        title: document.getElementById('overlay-title').textContent,
        shuffleOffered: !document.getElementById('overlay-shuffle').hidden,
        undoOffered: !document.getElementById('overlay-undo').hidden,
        focus: document.activeElement?.id,
        charges: slice.boosterCharges(),
        // Read once the theatre has drained, so a still-stuck rescue below
        // can be held to the same settled value (issue #144).
        desaturation: slice.renderer.desaturation(),
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
 * undo — a redraw with no pair-clear sequence. This is the control for the
 * flight's frame budget (issue #44 / #93), and since issue #58 it carries an
 * absolute floor of its own: draw() now rebuilds only the tiles that changed
 * (it used to tear down and rebuild all 144 on every tap), so a plain tap on
 * a full board has to hold 60fps by itself.
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
    // The single slowest interval — with 23 samples p95 is the second-worst,
    // which is exactly the frame the tap itself lands in slipping through.
    worst: intervals[intervals.length - 1] ?? 0,
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
  // the ladder position to the first turtle_classic level before the app boots
  // (level 21 on the ladder rebuilt for issue #213; it was 47 before).
  await ctx.addInitScript(() => {
    localStorage.setItem('mahjong.progress.v1', JSON.stringify({ level: 21 }));
    // Issue #105: a never-asked player gets the welcome gate over the board,
    // which swallows every click below. Answer it as a guest up front.
    localStorage.setItem('mahjong.profile.v1', JSON.stringify({ choice: 'guest' }));
    // Issue #59: a fresh install boots into the tutorial card, which inerts the
    // board the sections below drive. Take it as already seen; section 8 opens
    // its own fresh context to check the first-run path itself. Seeded only
    // when missing — section 7 changes settings and reloads on purpose.
    if (localStorage.getItem('mahjong.settings.v1') === null) {
      localStorage.setItem('mahjong.settings.v1', JSON.stringify({ showTutorial: false }));
    }
  });
  // Issue #51: the booster checks below assert exact balances from the 5/5/5
  // grant, so take today's daily-login grant as already paid, and mark level
  // 47 as cleared before so the win is a replay and pays no grant (which the
  // win section asserts directly — a replay must not mint charges).
  // Init scripts re-run on every navigation, reloads included, so seed only a
  // missing record — the persistence checks below reload on purpose.
  await ctx.addInitScript((today) => {
    if (localStorage.getItem('mahjong.boosters.v1') === null) {
      localStorage.setItem(
        'mahjong.boosters.v1',
        JSON.stringify({ hint: 5, undo: 5, shuffle: 5, lastLoginGrant: today }),
      );
    }
    if (localStorage.getItem('mahjong.record.v1') === null) {
      localStorage.setItem('mahjong.record.v1', JSON.stringify({ cleared: [47] }));
    }
  }, dailyDateKey());
  await page.goto(url);
  await page.waitForFunction(() => window.__slice !== undefined);

  // Page coordinates of a *visible* point on a tile's top face, via the app's
  // own geometry. The center alone is not enough since issue #99: a stack 3+
  // layers taller one column over projects across a neighbour's center, so
  // the point is sampled the way a player aims — at a spot of the face no
  // higher tile draws over.
  const tileCenter = (id) =>
    page.evaluate((tileId) => {
      const slice = window.__slice;
      const r = slice.tileCssRect(tileId);
      const c = document.querySelector('#board canvas').getBoundingClientRect();
      const z = slice.game.board.get(tileId).slot.z;
      const higher = slice.game.board
        .presentTiles()
        .filter((t) => t.slot.z > z)
        .map((t) => slice.tileCssRect(t.id));
      const clear = (x, y) =>
        !higher.some((h) => x >= h.x && x < h.x + h.w && y >= h.y && y < h.y + h.h);
      // Sample a grid over the face, center first, and take the first clear
      // spot; fall back to the center if the face is fully drawn over.
      const fractions = [0.5, 0.3, 0.7, 0.15, 0.85, 0.05];
      for (const fy of fractions) {
        for (const fx of fractions) {
          const x = r.x + r.w * fx;
          const y = r.y + r.h * fy;
          if (clear(x, y)) return { x: c.x + x, y: c.y + y };
        }
      }
      return { x: c.x + r.x + r.w / 2, y: c.y + r.y + r.h / 2 };
    }, id);

  /** Tap a board tile the way a player has to (issue #64): a face-down tile
   *  takes one extra tap first — the peek — before the tap that acts, except
   *  (issue #165) when its match is already held: then the first tap clears
   *  it and a second click would land on whatever is under the vacated spot.
   *  A tile already in the holder (its partner will fetch it) takes no tap. */
  const tapTile = async (id) => {
    if (await page.evaluate((i) => window.__slice.game.board.isHeld(i), id)) return;
    const c = await tileCenter(id);
    if (await page.evaluate((i) => window.__slice.game.isFaceHidden(i), id)) {
      await page.mouse.click(c.x, c.y);
      if (await page.evaluate((i) => window.__slice.game.board.get(i).removed, id)) return;
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

  // 1a. Settings gear never overlaps a board tile (issue #125): the gear used
  //     to be absolutely positioned inside #board, top-right, where it could
  //     cover that corner's tiles. It now lives in the booster rail, whose
  //     band #board reserves — so its rect should never intersect a tile's.
  {
    const overlap = await page.evaluate(() => {
      const slice = window.__slice;
      const gear = document.getElementById('btn-settings').getBoundingClientRect();
      const canvas = document.querySelector('#board canvas').getBoundingClientRect();
      const hit = slice.game.board.presentTiles().find((t) => {
        const r = slice.tileCssRect(t.id);
        const tx = canvas.x + r.x;
        const ty = canvas.y + r.y;
        return (
          gear.x < tx + r.w && gear.x + gear.width > tx && gear.y < ty + r.h && gear.y + gear.height > ty
        );
      });
      return { hit: hit ? hit.id : null, gear };
    });
    check(overlap.hit === null, 'SETTINGS GEAR does not overlap any tile', overlap);
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
      // Issue #165: a hidden tile whose match is held clears on its peek tap,
      // so the probe wants a tile that will still be there for the edge tap.
      const s = window.__slice;
      const heldFaces = new Set(
        s.holder().slots.filter((id) => id !== null).map((id) => s.game.board.get(id).face),
      );
      const t = s.game
        .hitCandidates()
        .filter((c) => c.free && !heldFaces.has(s.game.board.get(c.id).face))
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
      // Three questions, because they have different answers. Does a plain
      // tap on a full board hold 60fps? — its p95 frame, absolute (issue #58:
      // the redraw is incremental, and the audio setup that used to land in
      // the first tap is paid from idle time). Does the animation itself hold
      // 60fps? — the median frame across the flight. Does it make a tap
      // *worse*? — its worst frame against the plain tap's worst frame.
      check(baseline.p95 <= 16.7, 'FRAME BUDGET: 60fps ON A PLAIN TAP', {
        p95: +baseline.p95.toFixed(2),
        median: +baseline.median.toFixed(2),
      });
      // The tap's own frame, which p95 lets through. Two frames' worth is the
      // ceiling: the full rebuild cost 150–250ms here, so a regression cannot
      // hide under it, while a stray GC pause of a few ms can.
      check(baseline.worst <= 33.4, 'FRAME BUDGET: A PLAIN TAP DROPS AT MOST ONE FRAME', {
        worst: +baseline.worst.toFixed(2),
      });
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
    await page.waitForFunction(() => !window.__slice.dealing && !window.__slice.animating());
  }

  // 2. Mis-tap forgiveness: tap 6 CSS px outside a free tile's edge → selected.
  {
    const probe = await page.evaluate(() => {
      const slice = window.__slice;
      const { game } = slice;
      const c = document.querySelector('#board canvas').getBoundingClientRect();
      const rects = game.board.presentTiles().map((t) => slice.tileCssRect(t.id));
      const inAny = (x, y) =>
        rects.some((h) => x >= h.x && x < h.x + h.w && y >= h.y && y < h.y + h.h);
      // A free tile with truly open space just left of its drawn edge — since
      // issue #99 the taller stacks project over board-x neighbours, so the
      // probe point is checked against every drawn face, not inferred from
      // slot coordinates.
      // Issue #165: a hidden tile whose match is held clears on its peek tap,
      // so the probe wants a tile that will still be there for the edge tap.
      const heldFaces = new Set(
        slice.holder().slots.filter((id) => id !== null).map((id) => game.board.get(id).face),
      );
      const candidates = game
        .hitCandidates()
        .filter((x) => x.free && !heldFaces.has(game.board.get(x.id).face))
        .map((x) => ({ id: x.id, r: slice.tileCssRect(x.id) }))
        .sort((a, b) => a.r.x - b.r.x);
      for (const { id, r } of candidates) {
        const x = r.x - 6;
        const y = r.y + r.h / 2;
        if (!inAny(x, y)) return { id, x: c.x + x, y: c.y + y };
      }
      return null;
    });
    check(probe !== null, 'FORGIVENESS PROBE setup (want an open left edge)', probe);
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

  // 1d. Pressed states (issue #95): a held control visibly presses and
  //     releases back, and reduced motion drops the transition (instant swap).
  {
    const before = failures;
    const box = await (await page.$('#btn-restart')).boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    const pressed = await page.evaluate(() => {
      const n = document.getElementById('btn-restart');
      const cs = getComputedStyle(n);
      return { active: n.matches(':active'), transform: cs.transform, filter: cs.filter };
    });
    await page.mouse.up(); // completes the click: a harmless restart
    await page.waitForFunction(() => !window.__slice.dealing);
    const released = await page.evaluate(() => {
      const cs = getComputedStyle(document.getElementById('btn-restart'));
      return { transform: cs.transform, filter: cs.filter };
    });
    check(
      pressed.active && pressed.transform !== 'none' && pressed.filter !== 'none',
      'a held button shows a pressed state (issue #95)',
      pressed,
    );
    check(
      released.transform === 'none' && released.filter === 'none',
      'and releases back to normal',
      released,
    );
    // Reduced motion (OS preference): the state swap stays, the transition goes.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const reducedTransition = await page.evaluate(
      () => getComputedStyle(document.getElementById('btn-restart')).transitionDuration,
    );
    await page.emulateMedia({ reducedMotion: null });
    check(
      reducedTransition.split(',').every((d) => parseFloat(d) === 0),
      'reduced motion swaps instantly (no transition)',
      { reducedTransition },
    );
    console.log(`${failures === before ? 'ok' : 'FAIL'} — ${vp.name}: pressed states`);
  }

  // 2a. New game vs Restart (issue #94, amended by issue #99): New game deals
  //     the next layout from the band's pool with a fresh seed; Restart
  //     replays the deal being played — including a rotated one — and the
  //     rotation survives a force-quit.
  {
    const before = failures;
    const state = () =>
      page.evaluate(() => ({
        sig: window.__slice.game.board
          .presentTiles()
          .map((t) => `${t.id}:${t.face}`)
          .join(','),
        seed: window.__slice.game.level.seed,
        level: window.__slice.ladderLevel,
        layoutId: window.__slice.layoutId,
      }));
    const dealt = await state();
    await page.click('#btn-new');
    await page.waitForFunction(() => !window.__slice.dealing);
    const rerolled = await state();
    check(rerolled.seed !== dealt.seed, 'New game re-rolls the seed (issue #94)', {
      was: dealt.seed,
      now: rerolled.seed,
    });
    check(rerolled.sig !== dealt.sig, 'and the arrangement visibly changes', {
      changed: rerolled.sig !== dealt.sig,
    });
    check(
      rerolled.level === dealt.level,
      'on the same ladder level',
      rerolled,
    );
    // Issue #99: New game deals the next layout from the band's pool, and
    // every pool holds at least two layouts, so the layout always changes.
    check(
      rerolled.layoutId !== dealt.layoutId,
      'New game rotates to the next layout in the band pool (issue #99)',
      { was: dealt.layoutId, now: rerolled.layoutId },
    );

    await page.click('#btn-restart');
    await page.waitForFunction(() => !window.__slice.dealing);
    const restarted = await state();
    check(
      restarted.seed === rerolled.seed && restarted.sig === rerolled.sig,
      'Restart replays the deal being played — the re-rolled one, not the ladder\'s',
      { rerolled: rerolled.seed, restarted: restarted.seed },
    );

    // The re-rolled deal is a first-class save: a force-quit resumes it.
    await page.reload();
    await page.waitForFunction(() => window.__slice !== undefined);
    const resumed = await state();
    check(
      resumed.seed === rerolled.seed && resumed.sig === rerolled.sig,
      'a re-rolled deal survives a force-quit',
      { rerolled: rerolled.seed, resumed: resumed.seed },
    );
    console.log(`${failures === before ? 'ok' : 'FAIL'} — ${vp.name}: New game re-rolls, Restart replays`);
  }

  // 2b. Daily challenges (issue #183): the HUD's Daily chip opens today's three
  //     goals instead of dealing a board. The panel lists them with live
  //     progress, play ticks them off, a completion pays, and the chip counts
  //     how many are done.
  {
    const before = failures;
    const key = dailyDateKey();
    const want = dailyChallenges(key);
    // Sections below expect the balances and the fresh deal they were left;
    // this one plays real pairs and completions pay charges, so it puts both
    // back before it returns.
    const priorStores = await page.evaluate(() =>
      ['mahjong.daily.v1', 'mahjong.record.v1', 'mahjong.boosters.v1'].map((k) => [
        k,
        localStorage.getItem(k),
      ]),
    );
    // The sections above played real pairs today, and on a day whose set
    // holds a small target that play has already completed a challenge, so
    // the chip would read 1/3 (issue #206). Start from a fresh day: the store
    // is read at boot, so dropping it and reloading is a clean Daily state.
    await restoreStores(page, [['mahjong.daily.v1', null]]);

    const chip = () =>
      page.evaluate(() => {
        const b = document.getElementById('btn-daily');
        const cs = getComputedStyle(b);
        return {
          inHeader: b.closest('header') !== null,
          inSettings: document.querySelector('#settings #btn-daily') !== null,
          name: b.getAttribute('aria-label'),
          state: b.dataset.state,
          animated: cs.animationName !== 'none',
          height: b.getBoundingClientRect().height,
          value: document.getElementById('daily-value').textContent,
          disabled: b.disabled,
        };
      });
    const idle = await chip();
    check(idle.inHeader && !idle.inSettings, 'the Daily chip is in the HUD, not Settings', idle);
    check(/^Daily challenges, \d of 3 complete$/.test(idle.name), 'the chip names how many are done', idle);
    check(idle.state === 'pending' && idle.animated, 'the chip pulses while none are done', idle);
    check(idle.height >= 48, 'the chip is a 48dp touch target', idle);
    check(idle.value === '0/3', 'the chip reads 0/3 on a fresh day', idle);
    check(idle.disabled === false, 'the chip is never disabled — the panel stays readable', idle);

    const ladderBefore = await page.evaluate(() => ({
      level: window.__slice.ladderLevel,
      seed: window.__slice.game.level.seed,
      layoutId: window.__slice.layoutId,
    }));

    await page.click('#btn-daily');
    const panel = await page.evaluate(() => ({
      visible: document.getElementById('daily-panel').classList.contains('visible'),
      rows: [...document.querySelectorAll('#daily-panel .daily-row')].map((row) => ({
        goal: row.querySelector('.daily-text').textContent,
        count: row.querySelector('.daily-count').textContent,
        done: row.dataset.done,
        name: row.getAttribute('aria-label'),
        valuemax: row.querySelector('.daily-track').getAttribute('aria-valuemax'),
        valuetext: row.querySelector('.daily-track').getAttribute('aria-valuetext'),
      })),
      summary: document.getElementById('daily-panel-summary').textContent,
    }));
    check(panel.visible, 'the chip opens the challenge panel', panel);
    check(panel.rows.length === 3, 'the panel lists all three of today\'s challenges', panel);
    check(
      panel.rows.every((r, i) => r.valuemax === String(want[i].target)),
      'each row targets what core deals for the date',
      { want: want.map((c) => c.target), got: panel.rows.map((r) => r.valuemax) },
    );
    check(
      panel.rows.every((r) => r.valuetext === `${r.count.split(' / ')[0]} of ${r.valuemax}`),
      'each row says its own progress the same way in text and to a screen reader',
      panel,
    );

    // The Share button (issue #228) is in the panel, reachable by keyboard.
    const share = await page.evaluate(() => {
      const btn = document.getElementById('daily-share');
      btn.focus();
      return {
        present: btn !== null,
        text: btn.textContent,
        focused: document.activeElement === btn,
      };
    });
    check(share.present, 'the Share button is in the Daily panel', share);
    check(share.text === 'Share', 'the Share button starts labeled "Share"', share);
    check(share.focused, 'the Share button is keyboard-focusable', share);

    // The ladder is untouched: the panel starts nothing.
    const afterOpen = await page.evaluate(() => ({
      level: window.__slice.ladderLevel,
      seed: window.__slice.game.level.seed,
      layoutId: window.__slice.layoutId,
    }));
    check(
      afterOpen.level === ladderBefore.level &&
        afterOpen.seed === ladderBefore.seed &&
        afterOpen.layoutId === ladderBefore.layoutId,
      'opening the challenges deals nothing — the ladder board stays on the table',
      { ladderBefore, afterOpen },
    );

    // Escape closes it, like every other dialog.
    await page.keyboard.press('Escape');
    const closed = await page.evaluate(() =>
      document.getElementById('daily-panel').classList.contains('visible'),
    );
    check(closed === false, 'Escape closes the challenge panel', { closed });

    // Play real pairs: the counters move, and a suit challenge counts only its
    // own suit.
    const played = await page.evaluate(() => {
      const slice = window.__slice;
      // Earlier sections have already played pairs today, so this measures
      // what *these* matches add rather than assuming a fresh day.
      const before = slice.dailyStanding.map((s) => s.count);
      const click = (id) => document.querySelector(`#a11y-layer [data-tile-id="${id}"]`)?.click();
      const act = (id) => {
        if (slice.game.isFaceHidden(id)) {
          click(id);
          if (slice.game.board.get(id).removed) return;
        }
        click(id);
      };
      const suits = [];
      for (let i = 0; i < 6; i++) {
        const free = slice.game.hitCandidates().filter((c) => c.free).map((c) => c.id);
        const byFace = {};
        for (const id of free) (byFace[slice.game.board.get(id).face] ??= []).push(id);
        const pair = Object.values(byFace).find((ids) => ids.length >= 2);
        if (!pair) break;
        suits.push(slice.game.board.get(pair[0]).face.split('-')[0]);
        act(pair[0]);
        act(pair[1]);
      }
      return {
        suits,
        standing: slice.dailyStanding.map((s, i) => ({
          kind: s.challenge.kind,
          suit: s.challenge.suit ?? null,
          gained: s.count - before[i],
          done: s.done,
        })),
      };
    });
    const matched = played.suits.length;
    check(matched > 0, 'the harness could play at least one pair', played);
    for (const slot of played.standing) {
      // A challenge already finished stops counting, which is its own rule
      // (checked in ui/test/daily.test.ts) — not a miscount.
      if (slot.done) continue;
      if (slot.kind === 'pairs') {
        check(slot.gained === matched, 'every match counts toward the pairs challenge', { played, slot });
      }
      if (slot.kind === 'suit') {
        const want = played.suits.filter((s) => s === slot.suit).length;
        check(slot.gained === want, 'a suit challenge counts only its own suit', { played, slot, want });
      }
      if (slot.kind === 'boards') {
        check(slot.gained === 0, 'matching pairs is not finishing a board', { played, slot });
      }
    }
    await restoreStores(page, priorStores);
    console.log(`${failures === before ? 'ok' : 'FAIL'} — ${vp.name}: the Daily chip opens today's challenges and play ticks them off`);
  }

  // 2b2. Issue #183: a completed challenge pays a trophy and a booster charge,
  //      the chip counts it, and the completed row is marked by more than
  //      colour (a check glyph, a bold weight and "completed" in its name).
  {
    const before = failures;
    const key = dailyDateKey();
    const priorStores = await page.evaluate(() =>
      ['mahjong.daily.v1', 'mahjong.record.v1', 'mahjong.boosters.v1'].map((k) => [
        k,
        localStorage.getItem(k),
      ]),
    );

    // Prime exactly one challenge one match short of done, so a single match
    // completes exactly one. It has to be a challenge *any* match finishes:
    // 'pairs' and 'clean-run' both count every match, 'suit' only its own, and
    // 'boards' none. The day serves three of the four kinds, so at least one
    // of 'pairs'/'clean-run' is always dealt — this section must not assume
    // which, or it would fail on the ~28% of dates that omit 'pairs'.
    const day = dailyChallenges(key);
    const primeSlot = day.findIndex((c) => c.kind === 'pairs' || c.kind === 'clean-run');
    const short = await page.evaluate(
      ([k, counts]) => {
        localStorage.setItem(
          'mahjong.daily.v1',
          JSON.stringify({ date: k, counts, done: [false, false, false] }),
        );
        return counts;
      },
      [key, day.map((c, i) => (i === primeSlot ? c.target - 1 : 0))],
    );
    check(
      primeSlot !== -1 && short[primeSlot] === day[primeSlot].target - 1,
      'the fixture primed a challenge that any single match completes',
      { kinds: day.map((c) => c.kind), primeSlot, short },
    );
    await page.reload();
    await page.waitForFunction(() => window.__slice !== undefined);

    const paid = await page.evaluate(() => {
      const slice = window.__slice;
      const trophiesBefore = JSON.parse(localStorage.getItem('mahjong.record.v1') ?? '{}').trophies ?? 0;
      const total = (counts) => counts.hint + counts.undo + counts.shuffle;
      const chargesBefore = total(slice.boosterCharges());
      const click = (id) => document.querySelector(`#a11y-layer [data-tile-id="${id}"]`)?.click();
      const act = (id) => {
        if (slice.game.isFaceHidden(id)) {
          click(id);
          if (slice.game.board.get(id).removed) return;
        }
        click(id);
      };
      const free = slice.game.hitCandidates().filter((c) => c.free).map((c) => c.id);
      const byFace = {};
      for (const id of free) (byFace[slice.game.board.get(id).face] ??= []).push(id);
      const pair = Object.values(byFace).find((ids) => ids.length >= 2);
      act(pair[0]);
      act(pair[1]);
      const record = JSON.parse(localStorage.getItem('mahjong.record.v1') ?? '{}');
      // Read the live region before opening the panel: opening announces its
      // own summary line over whatever the match said.
      const announced = document.getElementById('a11y-status').textContent;
      document.getElementById('btn-daily').click();
      const row = [...document.querySelectorAll('#daily-panel .daily-row')].find(
        (r) => r.dataset.done === 'true',
      );
      return {
        trophiesBefore,
        trophies: record.trophies ?? 0,
        streak: record.dailyStreak ?? 0,
        weekScore: record.weekScore ?? 0,
        levelsCleared: record.levelsCleared ?? 0,
        chargesBefore,
        charges: total(slice.boosterCharges()),
        chip: document.getElementById('daily-value').textContent,
        chipState: document.getElementById('btn-daily').dataset.state,
        announced,
        doneRow: row === undefined ? null : {
          name: row.getAttribute('aria-label'),
          mark: row.querySelector('.daily-mark').textContent,
          weight: getComputedStyle(row.querySelector('.daily-goal')).fontWeight,
          count: row.querySelector('.daily-count').textContent,
        },
      };
    });
    check(paid.trophies === paid.trophiesBefore + 1, 'a completed challenge pays one trophy', paid);
    check(paid.streak === 1, "the day's first completion starts the streak", paid);
    check(paid.charges === paid.chargesBefore + 1, 'and one booster charge', paid);
    check(paid.weekScore === 0 && paid.levelsCleared === 0, 'and no score and no level cleared', paid);
    check(paid.chip === '1/3' && paid.chipState === 'partial', 'the chip counts the completion', paid);
    check(
      /Daily challenge complete/i.test(paid.announced),
      'the completion is announced on the line of the move that earned it',
      paid,
    );
    check(paid.doneRow !== null, 'the panel marks the completed challenge', paid);
    check(
      paid.doneRow !== null && paid.doneRow.mark === '✓' && Number(paid.doneRow.weight) >= 700,
      'the completed row is marked by a check and a bold weight, not colour alone',
      paid.doneRow,
    );
    check(
      paid.doneRow !== null && /completed$/.test(paid.doneRow.name),
      'and its accessible name says completed',
      paid.doneRow,
    );

    await page.evaluate(() => document.getElementById('daily-panel-close').click());
    await restoreStores(page, priorStores);
    console.log(`${failures === before ? 'ok' : 'FAIL'} — ${vp.name}: a completed challenge pays and is marked done`);
  }

  // 2c. The Level chip opens the profile (issue #137): a real button, 48dp,
  //     named for what it shows and where it goes; closing returns focus to
  //     the chip and leaves the game exactly as it was.
  {
    const before = failures;
    const snap = () =>
      page.evaluate(() => ({
        hash: window.__slice.stateHash(),
        score: window.__slice.game.score,
        profileOpen: document.getElementById('profile').classList.contains('visible'),
        focus: document.activeElement?.id,
      }));
    const chip = await page.evaluate(() => {
      const b = document.getElementById('btn-level');
      return {
        isButton: b.tagName === 'BUTTON',
        name: b.getAttribute('aria-label'),
        height: b.getBoundingClientRect().height,
      };
    });
    check(chip.isButton, 'the Level chip is a button', chip);
    check(/^Level \d+, opens your profile$/.test(chip.name), 'the chip is named for its text and destination', chip);
    check(chip.height >= 48, 'the Level chip is a 48dp touch target', chip);
    const idle = await snap();
    await page.click('#btn-level');
    const opened = await snap();
    check(opened.profileOpen && opened.focus === 'profile-close', 'tapping the Level chip opens the profile', opened);
    await page.keyboard.press('Escape');
    const closed = await snap();
    check(!closed.profileOpen && closed.focus === 'btn-level', 'closing returns focus to the chip', closed);
    check(closed.hash === idle.hash && closed.score === idle.score, 'the game state is untouched', { idle, closed });
    console.log(`${failures === before ? 'ok' : 'FAIL'} — ${vp.name}: Level chip opens the profile`);
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
      check(
        matched.score === FIRST_PAIR_POINTS,
        'and scores like any other pair, at this level’s band multiplier',
        { ...matched, expected: FIRST_PAIR_POINTS },
      );
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
    // Issue #99 makes the deal async (the rotated layout fetches), so wait.
    await page.click('#btn-new');
    await page.waitForFunction(() => !window.__slice.dealing);
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
    // Only faces with another *free* copy still on the board are parked: each
    // parked tile then keeps a takeable board–held pair alive, so the level
    // stays 'playing' (not 'stuck') all the way to the fatal fourth park —
    // deal-independent, which matters now that New game re-rolls (issue #94).
    const parkOne = async () => {
      const target = await page.evaluate(() => {
        const b = window.__slice.game.board;
        const parked = new Set(
          window.__slice
            .holder()
            .slots.filter((id) => id !== null)
            .map((id) => b.get(id).face),
        );
        const free = b.freeTileIds();
        // Face-up only (issue #64): the tap below must park, not peek.
        return (
          free.find(
            (id) =>
              !parked.has(b.get(id).face) &&
              !window.__slice.game.isFaceHidden(id) &&
              free.some((other) => other !== id && b.get(other).face === b.get(id).face),
          ) ?? null
        );
      });
      if (target === null) return null;
      const label = await page.evaluate(
        (id) =>
          document.querySelector(`#a11y-layer [data-tile-id="${id}"]`)?.getAttribute('aria-label'),
        target,
      );
      // Activate through the a11y node: the pointer path is already proven by
      // the first park above, and the #99 stacks overhang enough that a canvas
      // click at a tile's centre can land on a taller neighbour.
      await page.evaluate(
        (id) => document.querySelector(`#a11y-layer [data-tile-id="${id}"]`)?.click(),
        target,
      );
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
      bannerShown: !document.getElementById('holder-warning').hidden,
      banner: document.getElementById('holder-warning').textContent.trim(),
    }));
    check(nearlyFull.holder.vacancies === 1, 'three parks leave one slot', nearlyFull);
    check(
      nearlyFull.bannerShown && /one slot left/i.test(nearlyFull.banner) && /undo/i.test(nearlyFull.banner),
      'the one-slot-left banner is up and names Undo (issue #190)',
      nearlyFull,
    );
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

    // The announcement is synchronous with the fatal tap — showStatus sets it
    // before presentLossCelebration ever runs (issue #121 delays only the
    // dialog's own appearance) — so read it now, before the wait below risks
    // a genuinely unrelated announcer.say() landing in between and
    // overwriting the live region: main.ts also schedules a one-off "Daily
    // bonus" announcement 1500ms after boot (the login grant), close enough
    // to LOSS_DIALOG_DELAY_MS (~1.4s) that the two can otherwise race.
    const saidImmediately = await page.evaluate(
      () => document.getElementById('a11y-status').textContent,
    );
    check(
      /holder full\. the level is over/i.test(saidImmediately ?? ''),
      'the loss is announced immediately',
      saidImmediately,
    );

    // Issue #121 plays the slam/shake/wash theatre before the dialog itself
    // opens — LOSS_DIALOG_DELAY_MS (~1.4s) — so, like the win dialog
    // elsewhere in this file, wait the sequence out via `animating()` (which
    // folds the pending timer in) rather than the dialog's own focus landing:
    // that used to be enough on its own (a tap opens the dialog from inside
    // `pointerdown`, and the browser's own `mousedown` default action used to
    // take focus back to <body> in the same task — see showStatus), but now
    // the focus move itself is delayed by the same theatre.
    await page.waitForFunction(() => !window.__slice.animating(), { timeout: 3000 });
    const lost = await page.evaluate(() => ({
      holder: window.__slice.holder(),
      status: window.__slice.game.status(),
      title: document.getElementById('overlay-title').textContent,
      text: document.getElementById('overlay-text').textContent,
      shuffleOffered: !document.getElementById('overlay-shuffle').hidden,
      undoOffered: !document.getElementById('overlay-undo').hidden,
      railInert: document.getElementById('booster-rail').hasAttribute('inert'),
      focus: document.activeElement?.id,
      tilesLeft: window.__slice.game.tilesLeft,
      bannerShown: !document.getElementById('holder-warning').hidden,
    }));
    check(lost.holder.full && lost.status === 'lost', 'the fourth park ends the level', lost);
    check(/undo cannot/i.test(lost.text ?? ''), 'the dialog says Undo cannot rescue it (issue #190)', lost);
    check(!lost.bannerShown, 'and the one-slot-left banner is gone', lost);
    check(/holder full/i.test(lost.title ?? ''), 'the dialog names the reason', lost);
    check(!lost.shuffleOffered, 'a full holder is final: no Shuffle', lost);
    check(!lost.undoOffered, 'and no Undo', lost);
    check(lost.railInert, 'and the rail behind it is inert, so neither is reachable', lost);
    check(lost.focus === 'overlay-restart', 'focus lands on the way out that exists', lost);
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
    await page.waitForFunction(() => !window.__slice.dealing);
  }

  // 3. Play the generator's solution witness end-to-end with real taps.
  const solution = await page.evaluate(() => window.__slice.game.level.solution);
  for (const [a, b] of solution) {
    // tapTile spends the extra peek tap on face-down tiles (issue #64).
    await tapTile(a);
    await tapTile(b);
  }
  // Issue #120: the win dialog no longer appears the instant the board is
  // won — it waits out the celebration's WIN_DIALOG_DELAY_MS (~600ms) so the
  // cascade/lanterns/confetti/cue can play first. `animating()` now folds in
  // that pending delay (main.ts's `animating()` OR's in `pendingWinTimer`),
  // so the same settle-wait the rest of the harness already uses covers it.
  await page.waitForFunction(() => !window.__slice.animating(), { timeout: 2000 });
  const result = await page.evaluate(() => ({
    tilesLeft: window.__slice.game.tilesLeft,
    status: window.__slice.game.status(),
    score: window.__slice.game.score,
    overlay: document.getElementById('overlay-title').textContent,
    overlayVisible: document.getElementById('overlay').classList.contains('visible'),
    grant: window.__slice.grantText(),
    charges: window.__slice.boosterCharges(),
  }));
  // Issue #51/#117: level 47 is seeded as already cleared, so this win is a
  // replay and must pay no grant — no payout line on the dialog.
  //
  // The balance is no longer a proxy for that: since issue #183 a board clear
  // can also complete daily challenges, each of which legitimately pays a
  // charge. The dialog's grant line is the first-clear rule itself, and the
  // per-completion charge is asserted exactly in the daily-challenge section
  // above and in ui/test/boosters-replenish.test.ts.
  const noGrant = result.grant === null;
  const ok =
    result.tilesLeft === 0 &&
    result.status === 'won' &&
    result.overlayVisible &&
    noGrant &&
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
      () =>
        !document.getElementById('overlay').classList.contains('visible') &&
        !window.__slice.dealing,
    );
    // Pin the balances at the starting grant, and take today's challenges as
    // already finished. Everything from here down is about *spending* — "a
    // charge goes only when the booster did something" — and since issue #183
    // play also *earns* charges: a completed daily challenge grants one of a
    // random kind, which would drift these balances by an amount no assertion
    // can predict. Marking the day done closes that channel for the rest of
    // the run; the payout itself is asserted in the daily-challenge section
    // above, and the starting grant in ui/test/boosters.test.ts, where no play
    // can move either.
    await page.evaluate((today) => {
      const stored = JSON.parse(localStorage.getItem('mahjong.boosters.v1') ?? '{}');
      localStorage.setItem(
        'mahjong.boosters.v1',
        JSON.stringify({ ...stored, hint: 5, undo: 5, shuffle: 5 }),
      );
      localStorage.setItem(
        'mahjong.daily.v1',
        JSON.stringify({ date: today, counts: [0, 0, 0], done: [true, true, true] }),
      );
    }, dailyDateKey());
    await page.reload();
    await page.waitForFunction(() => window.__slice !== undefined && !window.__slice.dealing);
    const start = await page.evaluate(() => window.__slice.boosterCharges());
    check(
      start.hint === 5 && start.undo === 5 && start.shuffle === 5,
      'the balances start this section at 5 of each',
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
    // and a match). The pair clears in the holder, so the holder ends empty —
    // and since issue #100 a match is permanent: Undo has nothing to return.
    // Hint points at face-down tiles too (issue #64, PM-intended leak), so the
    // taps may need the extra peek.
    for (const id of hint2) await tapTile(id);
    const matched = await page.evaluate(() => ({
      tilesLeft: window.__slice.game.tilesLeft,
      score: window.__slice.game.score,
    }));
    check(matched.tilesLeft === 142 && matched.score > 0, 'hinted pair is matchable', matched);

    // Undo with an empty holder: no charge, no rewind, and it says why.
    await page.click('#btn-undo');
    const noUndo = await page.evaluate(() => ({
      tilesLeft: window.__slice.game.tilesLeft,
      score: window.__slice.game.score,
      charges: window.__slice.boosterCharges(),
      said: document.getElementById('a11y-status').textContent,
    }));
    check(
      noUndo.tilesLeft === 142 && noUndo.score === matched.score,
      'a match is permanent: undo rewinds nothing (issue #100)',
      noUndo,
    );
    check(noUndo.charges.undo === 5, 'a no-op undo costs nothing', noUndo);
    check(
      /Nothing to undo — the holder is empty\./.test(noUndo.said),
      'a no-op undo explains itself',
      noUndo.said,
    );

    // Park a tile, then Undo returns it: one charge, score untouched.
    const parkedId = await page.evaluate(() => {
      const s = window.__slice;
      const held = new Set(s.holder().slots.filter((id) => id !== null));
      return s.game
        .hitCandidates()
        .find((c) => c.free && !held.has(c.id) && !s.game.isFaceHidden(c.id) && !s.game.pairsWithHeld(c.id))?.id;
    });
    await tapTile(parkedId);
    const parked = await page.evaluate(() => ({
      holder: window.__slice.holder(),
      score: window.__slice.game.score,
    }));
    check(
      parked.holder.slots.some((id) => id !== null),
      'the tap parked a tile to return',
      parked.holder,
    );
    await page.click('#btn-undo');
    const returned = await page.evaluate(() => ({
      tilesLeft: window.__slice.game.tilesLeft,
      score: window.__slice.game.score,
      holder: window.__slice.holder(),
      charges: window.__slice.boosterCharges(),
      said: document.getElementById('a11y-status').textContent,
    }));
    check(
      returned.holder.slots.every((id) => id === null),
      'undo returns the parked tile to the board',
      returned.holder,
    );
    check(
      returned.tilesLeft === 142 && returned.score === parked.score,
      'the return touches neither the matches nor the score',
      returned,
    );
    check(
      returned.charges.undo === 4 && returned.charges.hint === 3,
      'undo spent exactly one undo charge',
      returned.charges,
    );
    check(
      /taken back out of the holder/.test(returned.said),
      'and says what came back',
      returned.said,
    );
    check(/4 undos left\.$/.test(returned.said.trim()), 'undo announces the balance', returned.said);

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
    // 142: the hinted pair above is matched for good (issue #100).
    check(shuffled.tilesLeft === 142, 'shuffle keeps every tile in play', shuffled);
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
      deadlockSkips.shuffle++;
      console.log(`  note — ${vp.name}: no deadlock in ${DEADLOCK_HUNT_DEALS} naive deals; stuck-dialog check skipped`);
    } else {
      check(stuck.title === 'No moves left', 'deadlock raises the stuck dialog', stuck);
      // Issue #190: the one-slot-left banner must not bleed through a dialog.
      // With one vacancy this is exactly the 'stuck' transition the review
      // caught — showStatus opens the dialog without a redraw.
      const bannerWhileStuck = await page.evaluate(() => ({
        vacancies: window.__slice.holder().vacancies,
        bannerShown: !document.getElementById('holder-warning').hidden,
      }));
      check(!bannerWhileStuck.bannerShown, 'no one-slot-left banner under the stuck dialog', bannerWhileStuck);
      check(stuck.shuffleOffered, 'stuck dialog offers Shuffle', stuck);
      check(stuck.focus === 'overlay-shuffle', 'focus lands on the way out', stuck);
      // Issue #159: the grey-out is the resting state of a stuck board, not a
      // fade that ends — read after the theatre drained, it is still full.
      check(stuck.desaturation === 1, 'the board is fully grey under the stuck dialog', stuck);
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
        washPresent: document.querySelector('.fx-loss-wash') !== null,
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
      } else if (/Board shuffled\./.test(rescued.said)) {
        // Third honest outcome: the shuffle went through (solvable faces
        // exist) but the deadlock is gesture-aware (issue #93) — with three
        // tiles parked, a board pair cannot transit one vacancy, so the
        // position stays stuck. The charge was spent on a real shuffle and
        // the dialog stays up offering the next way out.
        check(
          rescued.charges.shuffle === stuck.charges.shuffle - 1,
          'the still-stuck shuffle spent its charge',
          { before: stuck.charges, after: rescued.charges },
        );
        check(rescued.overlayVisible, 'the dialog stays up on a still-stuck board', rescued);
        // Issue #122 follow-up: the still-stuck redraw must not drop the grey
        // wash back to full colour underneath the still-open dialog.
        check(rescued.washPresent, 'the grey wash stays present on a still-stuck board', rescued);
        // Issue #144: the re-applied grey-out is a live effect for one more
        // frame, and whether a synchronous read landed before or after that
        // frame decided the old `desaturation > 0` check. Let it drain (the
        // same `animating()` wait huntDeadlock's own read sits behind) and
        // hold the settled value to what the deadlock itself settled at —
        // the regression this guards is redraw() dropping the grey-out
        // relative to the stuck state, not a particular amount.
        await page.waitForFunction(() => !window.__slice.animating());
        const settled = await page.evaluate(() => ({
          desaturation: window.__slice.renderer.desaturation(),
          washPresent: document.querySelector('.fx-loss-wash') !== null,
          overlayVisible: document.getElementById('overlay').classList.contains('visible'),
        }));
        check(
          settled.desaturation === stuck.desaturation && settled.washPresent && settled.overlayVisible,
          'the still-stuck board settles on the same grey-out the deadlock had',
          { stuck: stuck.desaturation, settled },
        );
        console.log(
          `${failures === before ? 'ok' : 'FAIL'} — ${vp.name}: shuffle re-rolled a still-stuck position honestly (deal ${stuck.deal + 1}, ${stuck.tilesLeft} tiles left)`,
        );
      } else {
        const refused = await page.evaluate(() => ({
          shuffleStillOffered: !document.getElementById('overlay-shuffle').hidden,
          undoOffered: !document.getElementById('overlay-undo').hidden,
          focus: document.activeElement?.id,
          holderHasTile: window.__slice.holder().slots.some((id) => id !== null),
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
        // Issue #100: Undo is a return move, so the dialog offers it only when
        // the holder has a tile to give back.
        if (refused.holderHasTile) {
          check(
            refused.undoOffered && refused.focus === 'overlay-undo',
            'the dialog still offers Undo — a tile is parked',
            refused,
          );
        } else {
          check(
            !refused.undoOffered,
            'no parked tile, so no Undo either (issue #100)',
            refused,
          );
        }
        console.log(
          `${failures === before ? 'ok' : 'FAIL'} — ${vp.name}: unshufflable deadlock degrades honestly (deal ${stuck.deal + 1}, ${stuck.tilesLeft} tiles left)`,
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
    // The login date rides along (issue #51), or the reload would pay the
    // daily bonus and hand Shuffle a charge back — and every ladder level is
    // marked cleared, because the naive hunt below sometimes *wins* a deal,
    // and a first clear (or a milestone) would pay charges the same way.
    await page.evaluate(
      (today) => {
        localStorage.setItem(
          'mahjong.boosters.v1',
          JSON.stringify({ hint: 0, undo: 5, shuffle: 0, lastLoginGrant: today }),
        );
        const cleared = Array.from({ length: 150 }, (_, i) => i + 1);
        localStorage.setItem('mahjong.record.v1', JSON.stringify({ cleared }));
      },
      dailyDateKey(),
    );
    await page.reload();
    await page.waitForFunction(() => window.__slice !== undefined);
    const stuck = await page.evaluate(huntDeadlock, DEADLOCK_HUNT_DEALS);
    if (stuck === null) {
      deadlockSkips.undoOnly++;
      console.log(`  note — ${vp.name}: no deadlock in ${DEADLOCK_HUNT_DEALS} naive deals; Undo-only check skipped`);
    } else {
      check(!stuck.shuffleOffered, 'a spent Shuffle is not offered', stuck);
      const holderHasTile = await page.evaluate(() =>
        window.__slice.holder().slots.some((id) => id !== null),
      );
      if (!holderHasTile) {
        // Issue #100: Undo cannot rescue a deadlock caused purely by matching.
        check(!stuck.undoOffered, 'empty holder: Undo is not offered (issue #100)', stuck);
        console.log(
          `${failures === before ? 'ok' : 'FAIL'} — ${vp.name}: matching-only deadlock offers no Undo (deal ${stuck.deal + 1})`,
        );
      } else {
        check(stuck.undoOffered, 'a parked tile makes Undo the offered way out', stuck);
        check(stuck.focus === 'overlay-undo', 'focus lands on Undo, not Restart', stuck);
        const heldBefore = await page.evaluate(
          () => window.__slice.holder().slots.filter((id) => id !== null).length,
        );
        await page.click('#overlay-undo');
        const rescued = await page.evaluate(() => ({
          status: window.__slice.game.status(),
          overlayVisible: document.getElementById('overlay').classList.contains('visible'),
          charges: window.__slice.boosterCharges(),
          heldNow: window.__slice.holder().slots.filter((id) => id !== null).length,
          said: document.getElementById('a11y-status').textContent,
        }));
        check(
          rescued.heldNow === heldBefore - 1,
          'the rescue undo returned one parked tile',
          rescued,
        );
        check(
          rescued.charges.undo === stuck.charges.undo - 1,
          'the rescue undo spent one charge',
          { before: stuck.charges, after: rescued.charges },
        );
        check(
          /taken back out of the holder/.test(rescued.said),
          'the return is announced',
          rescued.said,
        );
        // The return re-covers what parking freed; it may or may not open a
        // pair, so both a resumed board and a still-stuck dialog are honest.
        check(
          rescued.status === 'playing' ? !rescued.overlayVisible : rescued.status === 'stuck',
          'the board resumes play or stays honestly stuck',
          rescued,
        );
        console.log(
          `${failures === before ? 'ok' : 'FAIL'} — ${vp.name}: parked-tile deadlock handled by Undo (deal ${stuck.deal + 1}, ${rescued.status})`,
        );
      }
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
      // Issue #64: the first tap on a face-down tile peeks — unless its match
      // is held, when it clears right there (issue #165) and the second tap
      // would land on nothing.
      const act = (id) => {
        if (s.game.isFaceHidden(id)) {
          click(id);
          if (s.game.board.get(id).removed) return;
        }
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
    await page.click('#set-highlight-free');
    // Tile size is a slider (issue #139): two ArrowLefts from Extra large land
    // on Medium, and each stop applies as it is reached.
    await page.focus('#set-size');
    await page.keyboard.press('ArrowLeft');
    const oneStop = await page.evaluate(() => ({
      size: window.__slice.settings().tileSize,
      valuetext: document.getElementById('set-size').getAttribute('aria-valuetext'),
      shown: document.getElementById('set-size-value').textContent,
    }));
    check(
      oneStop.size === 'l' && oneStop.valuetext === 'Large' && oneStop.shown === 'Large',
      'one arrow step applies Large and names it for eyes and screen readers',
      oneStop,
    );
    await page.keyboard.press('ArrowLeft');
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
      resumed.settings.highlightFree === true && resumed.settings.tileSize === 'm',
      'settings survive the force-quit',
      resumed.settings,
    );

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
        // A resume re-conceals (issue #64). Its match is held, so a hidden
        // partner clears on that one tap (issue #165); a visible one too.
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
    await page.waitForFunction(() => !window.__slice.dealing);
    const won = await page.evaluate(() => {
      const s = window.__slice;
      const click = (id) => document.querySelector(`#a11y-layer [data-tile-id="${id}"]`)?.click();
      // Issue #64: face-down tiles take the extra peek tap — unless the peek
      // tap already cleared them against the holder (issue #165).
      const act = (id) => {
        if (s.game.isFaceHidden(id)) {
          click(id);
          if (s.game.board.get(id).removed) return;
        }
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

  // Issue #175: face-down tiles start at level 5. The ratio itself is core's
  // (core/test/ladder.test.ts pins the whole ladder); what only the real app
  // can show is the wiring — that the deal reads the ladder level it is
  // actually on. It used to read the band alone, which made the entire easy
  // band face-up. Boot-level, so viewport-independent: runs once.
  //
  // Its own context per level: this file's shared init script pins the ladder
  // to level 47 on every navigation, so a reload here would undo the level
  // being probed.
  if (vp === VIEWPORTS[0]) {
    const before = failures;
    const faceDownAt = async (level) => {
      const fresh = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        deviceScaleFactor: vp.dpr,
        hasTouch: true,
      });
      await fresh.addInitScript((lvl) => {
        localStorage.setItem('mahjong.progress.v1', JSON.stringify({ level: lvl }));
        localStorage.setItem('mahjong.profile.v1', JSON.stringify({ choice: 'guest' }));
        localStorage.setItem('mahjong.settings.v1', JSON.stringify({ showTutorial: false }));
      }, level);
      const p2 = await fresh.newPage();
      p2.on('pageerror', (e) => {
        console.error(`  page error: ${e.message}`);
        failures++;
      });
      await p2.goto(url);
      await p2.waitForFunction(() => window.__slice !== undefined && !window.__slice.dealing);
      const count = () =>
        p2.evaluate(() => {
          const { game } = window.__slice;
          const tiles = game.board.allTiles();
          return {
            level: window.__slice.ladderLevel,
            tiles: tiles.length,
            faceDown: tiles.filter((t) => game.isFaceHidden(t.id)).length,
          };
        });
      const seen = await count();
      // ...and again through a force-quit. The resume path is the one that
      // passes the ratio to reopen(), where a teaching level's 0 must not be
      // read as "no ratio supplied" and fall back to the deal's own
      // difficulty-derived set. Park one tile first: with no save there is
      // nothing to reopen and the reload would just deal afresh.
      await p2.evaluate(() => {
        const { game } = window.__slice;
        const id = game.board.freeTileIds().find((t) => !game.isFaceHidden(t));
        document.querySelector(`#a11y-layer [data-tile-id="${id}"]`).click();
      });
      await p2.waitForFunction(() => window.__slice.savedState() !== null);
      await p2.reload();
      await p2.waitForFunction(() => window.__slice !== undefined && !window.__slice.dealing);
      const resumed = await count();
      await fresh.close();
      return { ...seen, resumedFaceDown: resumed.faceDown };
    };
    const teaching = await faceDownAt(4);
    check(
      teaching.level === 4 && teaching.faceDown === 0,
      'level 4 is a teaching level: nothing face-down',
      teaching,
    );
    check(
      teaching.resumedFaceDown === 0,
      'and it resumes face-up after a force-quit, not at the deal default',
      teaching,
    );
    const first = await faceDownAt(5);
    check(
      first.level === 5 && first.faceDown === 5,
      'level 5 deals face-down tiles — the peek mechanic is introduced there',
      first,
    );
    check(
      first.resumedFaceDown === 5,
      'and a resume re-derives the same 5, never a reveal-all',
      first,
    );
    // The decade spike keeps the 8% it had before the ramp (PM, 2026-09-03):
    // a milestone never conceals less than the base levels around it.
    const spike = await faceDownAt(10);
    check(
      spike.faceDown === 11 && spike.faceDown > first.faceDown,
      'level 10 stays the milestone step up, not a dip',
      { spike, first },
    );
    console.log(`${failures === before ? 'ok' : 'FAIL'} — face-down tiles start at level 5 (issue #175)`);
  }

  // Issue #118: Send feedback — disabled until both fields are filled, the
  // failure state (mocked 503) keeps the typed text and offers a mailto
  // fallback whose href carries the subject, and the success state (mocked
  // 202) shows the thanks message. Network-mocked, so viewport-independent —
  // runs once rather than once per viewport.
  if (vp === VIEWPORTS[0]) {
    const before = failures;
    await page.click('#btn-settings');
    await page.click('#btn-feedback');
    const initialDisabled = await page.evaluate(() => document.getElementById('feedback-send').disabled);
    // `hidden` must actually hide (issue #135): the card's block-level CSS
    // used to beat the attribute, leaving the fallback link and note visible.
    const leaked = await page.evaluate(() =>
      ['feedback-mailto', 'feedback-mailto-note', 'feedback-inbox', 'feedback-copy', 'feedback-report']
        .filter((id) => getComputedStyle(document.getElementById(id)).display !== 'none'),
    );
    check(leaked.length === 0, 'no fallback control renders before a send has failed', leaked);
    check(initialDisabled, 'Send starts disabled', { initialDisabled });

    await page.fill('#feedback-summary', 'Tiles overlap');
    await page.fill('#feedback-body', 'The bamboo tile clips the dot tile.');
    const filledDisabled = await page.evaluate(() => document.getElementById('feedback-send').disabled);
    check(!filledDisabled, 'Send enables once both fields are filled', { filledDisabled });

    // Attachments (issue #130). A JPEG with an EXIF segment spliced in stands
    // for a phone photo: it must come out the other end without it. A fake
    // 11 MB "PNG" and a text file must be refused with a message and change
    // nothing else; a small fake MP4 rides through untouched (video is not
    // decoded, only capped).
    const jpegRaw = await page.screenshot({ type: 'jpeg', clip: { x: 0, y: 0, width: 48, height: 48 } });
    const exifSegment = Buffer.concat([
      Buffer.from([0xff, 0xe1, 0x00, 0x12]),
      Buffer.from('Exif\0\0', 'latin1'),
      Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00]),
    ]);
    const jpegWithExif = Buffer.concat([jpegRaw.subarray(0, 2), exifSegment, jpegRaw.subarray(2)]);
    check(jpegWithExif.includes('Exif'), 'test fixture: the source JPEG carries an EXIF segment');
    const fakeMp4 = Buffer.alloc(1024, 7);
    await page.setInputFiles('#feedback-file', [
      { name: 'IMG_0001.jpeg', mimeType: 'image/jpeg', buffer: jpegWithExif },
      { name: 'huge.png', mimeType: 'image/png', buffer: Buffer.alloc(11 * 1024 * 1024) },
      { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') },
      { name: 'clip.mp4', mimeType: 'video/mp4', buffer: fakeMp4 },
    ]);
    await page.waitForFunction(() => document.querySelectorAll('#feedback-attachments li').length === 2);
    const attachState = () =>
      page.evaluate(() => ({
        names: [...document.querySelectorAll('#feedback-attachments .name')].map((n) => n.textContent),
        previews: [...document.querySelectorAll('#feedback-attachments li > :first-child')].map((n) => n.tagName),
        attachStatus: document.getElementById('feedback-attach-status').textContent,
        addDisabled: document.getElementById('feedback-attach').disabled,
        summary: document.getElementById('feedback-summary').value,
        body: document.getElementById('feedback-body').value,
        sendDisabled: document.getElementById('feedback-send').disabled,
      }));
    const picked = await attachState();
    check(
      picked.names.join(',') === 'IMG_0001.jpg,clip.mp4',
      'the image (re-encoded, renamed .jpg) and the video are attached; the refused files are not',
      picked,
    );
    check(picked.previews.join(',') === 'IMG,VIDEO', 'thumbnails: <img> for the image, <video> for the clip', picked);
    check(
      /Only images/.test(picked.attachStatus),
      'the last refusal (unsupported type) is shown as a short message',
      picked,
    );
    check(
      picked.summary === 'Tiles overlap' && picked.body === 'The bamboo tile clips the dot tile.' && !picked.sendDisabled,
      'refused files leave the rest of the form untouched',
      picked,
    );
    // Over-limit on its own, so its message is the one left showing.
    await page.setInputFiles('#feedback-file', { name: 'huge2.png', mimeType: 'image/png', buffer: Buffer.alloc(11 * 1024 * 1024) });
    await page.waitForFunction(() => /Too big/.test(document.getElementById('feedback-attach-status').textContent));
    const overLimit = await attachState();
    check(overLimit.names.length === 2, 'an over-limit file is refused and adds no thumbnail', overLimit);
    // A third fills the report; a fourth is refused as too many, and Add disables at three.
    const png = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: 24, height: 24 } });
    await page.setInputFiles('#feedback-file', [
      { name: 'third.png', mimeType: 'image/png', buffer: png },
      { name: 'fourth.png', mimeType: 'image/png', buffer: png },
    ]);
    await page.waitForFunction(() => document.querySelectorAll('#feedback-attachments li').length === 3);
    const full = await attachState();
    check(full.names.length === 3 && /Up to 3/.test(full.attachStatus), 'a fourth file is refused: up to 3 per report', full);
    check(full.addDisabled, 'Add disables once three are attached', full);
    await page.click('#feedback-attachments li:nth-child(3) .remove');
    const afterRemove = await attachState();
    check(
      afterRemove.names.join(',') === 'IMG_0001.jpg,clip.mp4' && !afterRemove.addDisabled,
      'Remove (×) drops that one thumbnail and re-enables Add',
      afterRemove,
    );

    // Failure path: the Worker endpoint mocked as unavailable (503).
    await page.route('**/api/feedback', (route) => route.fulfill({ status: 503, body: '{}' }));
    await page.click('#feedback-send');
    await page.waitForFunction(
      () => document.getElementById('feedback-status').textContent.includes("Couldn't send"),
    );
    const failed = await page.evaluate(() => ({
      status: document.getElementById('feedback-status').textContent,
      summary: document.getElementById('feedback-summary').value,
      body: document.getElementById('feedback-body').value,
      mailtoHidden: document.getElementById('feedback-mailto').hidden,
      mailtoHref: document.getElementById('feedback-mailto').getAttribute('href'),
      attachmentCount: document.querySelectorAll('#feedback-attachments li').length,
      noteHidden: document.getElementById('feedback-mailto-note').hidden,
      noteText: document.getElementById('feedback-mailto-note').textContent,
    }));
    check(failed.attachmentCount === 2, 'a failed send keeps the attachments too', failed);
    check(
      !failed.noteHidden && /Attachments couldn't be included/.test(failed.noteText),
      'with attachments pending, the mailto fallback says they could not be included',
      failed,
    );
    check(
      failed.mailtoHref !== null && !failed.mailtoHref.includes('IMG_0001'),
      'the mailto body carries no attachment data',
      failed,
    );
    check(/Couldn't send/.test(failed.status), 'failure shows the try-again message', failed);
    check(
      failed.summary === 'Tiles overlap' && failed.body === 'The bamboo tile clips the dot tile.',
      'a failed send keeps the typed text',
      failed,
    );
    check(!failed.mailtoHidden, 'a failed send offers the mailto fallback', failed);
    check(
      failed.mailtoHref !== null && failed.mailtoHref.includes(encodeURIComponent('Tiles overlap')),
      'the mailto link carries the subject',
      failed,
    );

    // Issue #135: the mailto handoff can be a silent no-op, so the failure
    // state also shows the inbox address as text and offers Copy report —
    // the subject line plus the full email text on the clipboard.
    const shown = await page.evaluate(() => {
      const vis = (id) => {
        const e = document.getElementById(id);
        return !e.hidden && getComputedStyle(e).display !== 'none';
      };
      return {
        inbox: vis('feedback-inbox'),
        inboxText: document.getElementById('feedback-inbox').textContent,
        copy: vis('feedback-copy'),
        report: vis('feedback-report'),
        copyStatus: document.getElementById('feedback-copy-status').textContent,
      };
    });
    check(
      shown.inbox && /dqtgametesting@gmail\.com/.test(shown.inboxText),
      'a failed send shows the inbox address as plain text',
      shown,
    );
    check(shown.copy && !shown.report && shown.copyStatus === '', 'Copy report is offered, the read-only field is not yet', shown);
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: url });
    await page.click('#feedback-copy');
    await page.waitForFunction(() => document.getElementById('feedback-copy-status').textContent !== '');
    const copied = await page.evaluate(async () => ({
      status: document.getElementById('feedback-copy-status').textContent,
      clipboard: await navigator.clipboard.readText(),
      reportHidden: document.getElementById('feedback-report').hidden,
    }));
    check(copied.status === 'Copied', 'Copy report confirms with "Copied"', copied);
    check(
      copied.clipboard.startsWith('[Lantern Tiles feedback] Tiles overlap\n\nThe bamboo tile clips the dot tile.') &&
        /\n---\nSummary: Tiles overlap\nVersion: .+\nLevel: .+\nPlatform: .+\nDate: .+$/.test(copied.clipboard),
      'the clipboard holds the subject line, the details and the context block',
      { clipboard: copied.clipboard },
    );
    check(copied.reportHidden, 'a successful copy leaves the read-only field hidden', copied);
    // A second tap copies the same report again — nothing is consumed.
    await page.evaluate(() => navigator.clipboard.writeText(''));
    await page.click('#feedback-copy');
    await page.waitForFunction(async () => (await navigator.clipboard.readText()) !== '');
    const again = await page.evaluate(async () => ({
      status: document.getElementById('feedback-copy-status').textContent,
      first: (await navigator.clipboard.readText()).split('\n')[0],
    }));
    check(again.status === 'Copied' && again.first === '[Lantern Tiles feedback] Tiles overlap', 'Copy report works a second time', again);
    // Clipboard refused (permission denied, no API): the same text is shown
    // selected in a read-only field instead of a false "Copied".
    await page.evaluate(() => {
      document.getElementById('feedback-copy-status').textContent = '';
      navigator.clipboard.writeText = () => Promise.reject(new Error('denied'));
    });
    await page.click('#feedback-copy');
    await page.waitForFunction(() => document.getElementById('feedback-copy-status').textContent !== '');
    const refused = await page.evaluate(() => {
      const r = document.getElementById('feedback-report');
      return {
        status: document.getElementById('feedback-copy-status').textContent,
        visible: !r.hidden && getComputedStyle(r).display !== 'none',
        readOnly: r.readOnly,
        focused: document.activeElement === r,
        selectedAll: r.value.length > 0 && r.selectionStart === 0 && r.selectionEnd === r.value.length,
        firstLine: r.value.split('\n')[0],
      };
    });
    check(
      refused.status !== 'Copied' && refused.visible && refused.readOnly && refused.focused && refused.selectedAll,
      'when the clipboard refuses, the report is shown selected in a read-only field',
      refused,
    );
    check(refused.firstLine === '[Lantern Tiles feedback] Tiles overlap', 'the read-only field holds the same report', refused);
    await page.unroute('**/api/feedback');

    // Success path: the Worker endpoint mocked as accepting the submission;
    // the request body is captured to check what actually left the browser.
    let posted = null;
    await page.route('**/api/feedback', (route) => {
      posted = JSON.parse(route.request().postData());
      return route.fulfill({ status: 202, body: '{}' });
    });
    await page.click('#feedback-send');
    await page.waitForFunction(() =>
      document.getElementById('feedback-status').textContent.includes('Thanks'),
    );
    const sent = await page.evaluate(() => ({
      status: document.getElementById('feedback-status').textContent,
      attachmentCount: document.querySelectorAll('#feedback-attachments li').length,
      noteHidden: document.getElementById('feedback-mailto-note').hidden,
      copyHidden: document.getElementById('feedback-copy').hidden,
      reportHidden: document.getElementById('feedback-report').hidden,
      inboxHidden: document.getElementById('feedback-inbox').hidden,
      copyStatus: document.getElementById('feedback-copy-status').textContent,
    }));
    check(/Thanks, your feedback was sent/.test(sent.status), 'success shows the thanks message', sent);
    check(sent.attachmentCount === 0 && sent.noteHidden, 'a successful send clears the attachments', sent);
    check(
      sent.copyHidden && sent.reportHidden && sent.inboxHidden && sent.copyStatus === '',
      'a fresh send attempt clears the Copy report state (issue #135)',
      sent,
    );
    const postedShape = posted && {
      count: posted.attachments?.length,
      names: posted.attachments?.map((a) => a.name),
      types: posted.attachments?.map((a) => a.type),
    };
    check(
      postedShape && postedShape.count === 2 && postedShape.names.join(',') === 'IMG_0001.jpg,clip.mp4',
      'the request carries both attachments by name',
      postedShape,
    );
    check(
      postedShape && postedShape.types.join(',') === 'image/jpeg,video/mp4',
      'attachment types travel with the files',
      postedShape,
    );
    if (posted) {
      const image = Buffer.from(posted.attachments[0].content, 'base64');
      const video = Buffer.from(posted.attachments[1].content, 'base64');
      check(
        image[0] === 0xff && image[1] === 0xd8 && !image.includes('Exif'),
        'the image arrives as a JPEG with its EXIF segment stripped',
        { bytes: image.length, hasExif: image.includes('Exif') },
      );
      check(video.equals(fakeMp4), 'the video arrives byte-for-byte as picked', { bytes: video.length });
    }
    await page.unroute('**/api/feedback');

    console.log(`${failures === before ? 'ok' : 'FAIL'} — feedback form: send disabled/attachments/failure/success`);
  }

  // 8. First-run tutorial (issue #59). A genuinely fresh install — no settings
  //    record at all — boots into step 1; Skip and Done both turn "Show
  //    tutorial" OFF and that survives a reload; Settings → ON replays it on
  //    the next deal, not mid-level; and the whole thing costs the player
  //    nothing: same charges, same board, save still there.
  {
    const before = failures;
    const fresh = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: vp.dpr,
      hasTouch: true,
    });
    const p2 = await fresh.newPage();
    p2.on('pageerror', (e) => {
      console.error(`  page error: ${e.message}`);
      failures++;
    });
    await fresh.addInitScript(() => {
      localStorage.setItem('mahjong.progress.v1', JSON.stringify({ level: 47 }));
      localStorage.setItem('mahjong.profile.v1', JSON.stringify({ choice: 'guest' }));
    });
    await p2.goto(url);
    await p2.waitForFunction(() => window.__slice !== undefined);
    const boot = await p2.evaluate(() => ({
      ...window.__slice.tutorial(),
      setting: window.__slice.settings().showTutorial,
      charges: window.__slice.boosterCharges(),
      saved: window.__slice.savedState() !== null,
      hash: window.__slice.stateHash(),
      boardInert: document.getElementById('a11y-layer').hasAttribute('inert'),
    }));
    check(boot.visible && boot.step === 1 && boot.setting && boot.boardInert, 'a fresh install boots into step 1 of the tutorial', boot);

    // Skip from step 2.
    await p2.click('#tutorial-next');
    await p2.click('#tutorial-skip');
    const skipped = await p2.evaluate(() => ({
      ...window.__slice.tutorial(),
      setting: window.__slice.settings().showTutorial,
      charges: window.__slice.boosterCharges(),
      saved: window.__slice.savedState() !== null,
      hash: window.__slice.stateHash(),
      status: window.__slice.game.status(),
      boardInert: document.getElementById('a11y-layer').hasAttribute('inert'),
    }));
    check(!skipped.visible && !skipped.boardInert && skipped.setting === false, 'Skip closes the card and turns Show tutorial OFF', skipped);
    check(
      JSON.stringify(skipped.charges) === JSON.stringify(boot.charges) &&
        skipped.hash === boot.hash &&
        skipped.saved &&
        skipped.status === 'playing',
      'the tutorial cost nothing: charges, board and save untouched, level playable',
      { boot, skipped },
    );

    // A reload is the closest a browser gets to a relaunch: no auto-start.
    await p2.reload();
    await p2.waitForFunction(() => window.__slice !== undefined);
    const again = await p2.evaluate(() => ({
      ...window.__slice.tutorial(),
      setting: window.__slice.settings().showTutorial,
    }));
    check(!again.visible && again.setting === false, 'after a skip the tutorial does not auto-start on a relaunch', again);

    // Settings: the toggle reads OFF; ON arms the next deal, not the current one.
    await p2.click('#btn-settings');
    const reads = await p2.evaluate(() => document.getElementById('set-show-tutorial').checked);
    check(reads === false, 'the Show tutorial toggle reads OFF after a skip', { checked: reads });
    await p2.click('#set-show-tutorial');
    await p2.click('#settings-close');
    const midLevel = await p2.evaluate(() => ({
      ...window.__slice.tutorial(),
      setting: window.__slice.settings().showTutorial,
    }));
    check(!midLevel.visible && midLevel.setting === true, 'turning the toggle on arms the tutorial without opening it mid-level', midLevel);
    await p2.click('#btn-new');
    await p2.waitForFunction(() => !window.__slice.dealing);
    const replay = await p2.evaluate(() => window.__slice.tutorial());
    check(replay.visible && replay.step === 1, 'Settings → Show tutorial ON replays it from step 1 on the next deal', replay);

    // Spotlight (issue #150): on every step the holes as drawn sit exactly on
    // the actors' on-screen rects — tiles through the app's own geometry, HUD
    // panels through their boxes — and none is under the card. A viewport
    // change while a step is up moves the holes with their actors.
    const spotGeometry = () =>
      p2.evaluate(() => {
        const s = window.__slice;
        const spot = s.spotlight();
        const canvas = document.querySelector('#board canvas').getBoundingClientRect();
        const tileRect = (id) => {
          const r = s.tileCssRect(id);
          return { x: canvas.x + r.x, y: canvas.y + r.y, w: r.w, h: r.h + 6 };
        };
        const panelRect = (el) => {
          const r = el.getBoundingClientRect();
          return { x: r.x - 6, y: r.y - 6, w: r.width + 12, h: r.height + 12 };
        };
        const step = s.tutorial().step;
        const expected = [];
        const { free, blocked, pair } = spot.tiles;
        if (free !== undefined) expected.push(tileRect(free));
        if (blocked !== undefined) expected.push(tileRect(blocked));
        for (const id of pair ?? []) expected.push(tileRect(id));
        if (step === 4) expected.push(panelRect(document.querySelector('#booster-rail > div')));
        if (step === 5) expected.push(panelRect(document.getElementById('holder')));
        if (step === 6) expected.push(panelRect(document.getElementById('score').parentElement));
        const close = (a, b) => ['x', 'y', 'w', 'h'].every((k) => Math.abs(a[k] - b[k]) < 1.5);
        const card = document.getElementById('tutorial-card').getBoundingClientRect();
        const underCard = spot.holes.some(
          (h) => h.x < card.x + card.width && h.x + h.w > card.x && h.y < card.y + card.height && h.y + h.h > card.y,
        );
        return {
          step,
          visible: spot.visible,
          holes: spot.holes.length,
          matches: expected.length === spot.holes.length && expected.every((e, i) => close(e, spot.holes[i])),
          underCard,
          gearInside:
            step === 4 &&
            (() => {
              const g = document.getElementById('btn-settings').getBoundingClientRect();
              const h = spot.holes[0];
              return h && g.x >= h.x && g.x + g.width <= h.x + h.w && g.y >= h.y && g.y + g.height <= h.y + h.h;
            })(),
        };
      });
    const geo1 = await spotGeometry();
    check(geo1.step === 1 && !geo1.visible && geo1.holes === 0, 'step 1: whole board lit, no scrim', geo1);
    for (let step = 2; step <= 6; step++) {
      await p2.click('#tutorial-next');
      const geo = await spotGeometry();
      check(geo.step === step && geo.visible && geo.holes > 0 && geo.matches, `step ${step}: holes sit on the actors`, geo);
      check(!geo.underCard, `step ${step}: no actor under the card`, geo);
      if (step === 4) check(!geo.gearInside, 'step 4: the Settings gear is outside the boosters hole', geo);
      if (step === 3) {
        // Turn the phone: the pair moves, and the holes follow it. The app
        // re-fits the board and re-lays the holes synchronously in its
        // `resize` handler, but the viewport change itself lands in the page
        // asynchronously (issue #160: a read straight after setViewportSize
        // sometimes saw the pre-turn holes). Wait for the holes to actually
        // move before reading; a turn that never moves them times out here
        // and fails the "moved" check below on the unchanged coordinates.
        const holesNow = () => window.__slice.spotlight().holes.map((h) => [h.x, h.y]);
        const before = await p2.evaluate(holesNow);
        await p2.setViewportSize({ width: vp.height, height: vp.width });
        await p2.waitForFunction(() => !window.__slice.dealing);
        await p2
          .waitForFunction(
            (was) => JSON.stringify(window.__slice.spotlight().holes.map((h) => [h.x, h.y])) !== was,
            JSON.stringify(before),
            { timeout: 5000 },
          )
          .catch(() => {});
        const turned = await spotGeometry();
        const after = await p2.evaluate(holesNow);
        check(turned.visible && turned.matches && !turned.underCard, 'after a viewport change the holes still sit on the pair', turned);
        check(JSON.stringify(before) !== JSON.stringify(after), 'the holes actually moved with the tiles', { before, after });
        await p2.setViewportSize({ width: vp.width, height: vp.height });
        await p2.waitForFunction(() => !window.__slice.dealing);
      }
    }
    const last = await p2.evaluate(() => ({
      ...window.__slice.tutorial(),
      nextLabel: document.getElementById('tutorial-next').textContent,
    }));
    check(last.step === 6 && last.count === 6 && last.nextLabel === 'Done', 'Next advances one step at a time to Done on step 6', last);
    await p2.click('#tutorial-next');
    const done = await p2.evaluate(() => ({
      ...window.__slice.tutorial(),
      setting: window.__slice.settings().showTutorial,
      status: window.__slice.game.status(),
      hintPair: window.__slice.hintPair.length,
      scrim: window.__slice.spotlight().visible,
    }));
    check(!done.visible && done.setting === false && done.status === 'playing' && done.hintPair === 0, 'Done returns to a playable board and turns the toggle OFF', done);
    check(!done.scrim, 'Done takes the spotlight scrim down with the card', done);

    // OFF survives a relaunch too.
    await p2.reload();
    await p2.waitForFunction(() => window.__slice !== undefined);
    const after = await p2.evaluate(() => ({
      ...window.__slice.tutorial(),
      setting: window.__slice.settings().showTutorial,
    }));
    check(!after.visible && after.setting === false, 'the completed state survives a relaunch', after);

    await fresh.close();
    console.log(`${failures === before ? 'ok' : 'FAIL'} — tutorial: fresh install / skip / replay / done`);
  }

  await ctx.close();
}

// Issue #153: the phone header is one row at every phone width, with a
// five-digit score and a 12-character name on the table, and the bottom bar
// is two groups — boosters flush left, Leaderboard and Settings flush right —
// with the board's reserved band still keeping every tile clear of it.
{
  const before = failures;
  for (const width of [360, 390, 430]) {
    const ctx = await browser.newContext({
      viewport: { width, height: 800 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
    });
    await ctx.addInitScript(() => {
      if (localStorage.getItem('mahjong.settings.v1') === null) {
        localStorage.setItem('mahjong.settings.v1', JSON.stringify({ showTutorial: false }));
      }
      if (localStorage.getItem('mahjong.record.v1') === null) {
        localStorage.setItem('mahjong.record.v1', JSON.stringify({ cleared: [47] }));
      }
    });
    const page = await ctx.newPage();
    await page.goto(url);
    await page.waitForFunction(() => window.__slice !== undefined && !window.__slice.dealing);
    const hud = await page.evaluate(() => {
      // The worst case the ticket names, written straight into the chips: a
      // five-digit score and a 12-character name. Layout only — no profile
      // plumbing is under test here.
      document.getElementById('score').textContent = '12,340';
      document.getElementById('level-label').textContent = 'Bartholomew1';
      const rect = (id) => document.getElementById(id).getBoundingClientRect();
      const header = rect('app-header');
      const controls = ['btn-level', 'btn-daily', 'btn-new', 'btn-restart'].map(rect);
      const tops = new Set(controls.map((r) => Math.round(r.y + r.height / 2)));
      const rail = rect('booster-rail');
      const boosters = document.querySelector('#booster-rail .boosters').getBoundingClientRect();
      const meta = document.querySelector('#booster-rail .meta').getBoundingClientRect();
      const bar = ['btn-hint', 'btn-undo', 'btn-shuffle', 'btn-leaderboard', 'btn-settings'].map(rect);
      const canvas = document.querySelector('#board canvas').getBoundingClientRect();
      const slice = window.__slice;
      const tileBottom = Math.max(
        ...slice.game.board.presentTiles().map((t) => {
          const r = slice.tileCssRect(t.id);
          return canvas.y + r.y + r.h;
        }),
      );
      return {
        headerH: header.height,
        oneRow: tops.size === 1,
        levelLabel: document.getElementById('level-label').textContent,
        boostersLeft: boosters.left,
        metaRight: meta.right,
        railLeft: rail.left,
        railRight: rail.right,
        viewport: innerWidth,
        allTargets48: bar.every((r) => r.width >= 48 && r.height >= 48),
        boostersGroup: [...document.querySelectorAll('[aria-label="Boosters"] button')].map((b) => b.id),
        barClearsTiles: tileBottom <= rail.top,
        tileW: slice.tileCssRect(slice.game.hitCandidates()[0].id).w,
      };
    });
    check(hud.oneRow && hud.headerH <= 70, `one-row header at ${width}px (want ≤ 70px)`, hud);
    check(
      hud.boostersLeft === hud.railLeft && hud.metaRight === hud.railRight && hud.railLeft <= 12 + 1,
      `boosters flush left, Leaderboard + Settings flush right at ${width}px`,
      hud,
    );
    check(hud.allTargets48, `bottom-bar controls are ≥ 48dp at ${width}px`, hud);
    check(
      hud.boostersGroup.join() === 'btn-hint,btn-undo,btn-shuffle',
      'the Boosters group wraps exactly the three boosters',
      hud,
    );
    check(hud.barClearsTiles, `no tile sits under the bottom bar at ${width}px`, hud);
    await ctx.close();
  }

  // The chip itself, through the real profile path this time: a named player
  // on an ordinary level sees the name alone over the number, and the spoken
  // name keeps the word — "NAME · Level N, opens your profile".
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3 });
    await ctx.addInitScript(() => {
      localStorage.setItem('mahjong.progress.v1', JSON.stringify({ level: 47 }));
      localStorage.setItem(
        'mahjong.profile.v1',
        JSON.stringify({ name: 'Bartholomew1', avatar: 'lantern', choice: 'named' }),
      );
      localStorage.setItem('mahjong.settings.v1', JSON.stringify({ showTutorial: false }));
    });
    const page = await ctx.newPage();
    await page.goto(url);
    await page.waitForFunction(() => window.__slice !== undefined && !window.__slice.dealing);
    const chip = await page.evaluate(() => ({
      label: document.getElementById('level-label').textContent,
      level: document.getElementById('level').textContent,
      aria: document.getElementById('btn-level').getAttribute('aria-label'),
    }));
    check(chip.label === 'Bartholomew1', 'a named player sees the name alone over the level number', chip);
    check(
      chip.aria === `Bartholomew1 · Level ${chip.level}, opens your profile`,
      'the chip is still spoken as "NAME · Level N, opens your profile"',
      chip,
    );
    await ctx.close();
  }
  console.log(`${failures === before ? 'ok' : 'FAIL'} — one-row phone header + split bottom bar (issue #153)`);
}

// Issue #48: the deadlock sections above skip silently on a viewport that
// never deadlocked. Coverage that ran nowhere is a failure, not a pass.
for (const [section, skips] of Object.entries(deadlockSkips)) {
  check(
    skips < VIEWPORTS.length,
    `deadlock ${section} coverage ran on at least one viewport`,
    { skipped: skips, viewports: VIEWPORTS.length, dealsPerHunt: DEADLOCK_HUNT_DEALS },
  );
}

await browser.close();
server.close();
if (failures > 0) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log('all viewports passed');
