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
// fills the viewport (guards HiDPI scaling regressions).

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

const VIEWPORTS = [
  { name: 'phone portrait', width: 390, height: 844, dpr: 3 },
  { name: 'phone landscape', width: 844, height: 390, dpr: 3 },
  { name: 'tablet portrait', width: 810, height: 1080, dpr: 2 },
  { name: 'tablet landscape', width: 1080, height: 810, dpr: 2 },
];

const browser = await chromium.launch({ executablePath: CHROMIUM });
let failures = 0;

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
  //    canvas along its constraining axis (catches HiDPI 1/DPR-scale bugs).
  {
    const extent = await page.evaluate(() => {
      const { game, renderer } = window.__slice;
      const xs = game.hitCandidates().map((t) => window.__slice.tileCssRect(t.id));
      const maxX = Math.max(...xs.map((r) => r.x + r.w));
      const minX = Math.min(...xs.map((r) => r.x));
      const maxY = Math.max(...xs.map((r) => r.y + r.h));
      const minY = Math.min(...xs.map((r) => r.y));
      const canvas = document.querySelector('#board canvas');
      return {
        boardW: maxX - minX,
        boardH: maxY - minY,
        canvasW: canvas.clientWidth,
        canvasH: canvas.clientHeight,
        scale: renderer.scale,
      };
    });
    const fillW = extent.boardW / extent.canvasW;
    const fillH = extent.boardH / extent.canvasH;
    if (Math.max(fillW, fillH) < 0.9) {
      console.error(`  EXTENT FAIL (dpr ${vp.dpr}):`, extent);
      failures++;
    }
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
  await ctx.close();
}

await browser.close();
server.close();
if (failures > 0) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log('all viewports passed');
