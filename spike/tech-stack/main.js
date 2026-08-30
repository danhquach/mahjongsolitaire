// Tech-stack spike (roadmap §2.1 / issue #1).
// Validates: (a) PixiJS canvas board with a DOM/ARIA overlay that screen
// readers can traverse, (b) frame-time headroom with a full 144-tile board.
// Plain JS on purpose — no build step needed for the spike; production /core is TS.
import { Application, Container, Graphics, Text } from './node_modules/pixi.js/dist/pixi.min.mjs';

const TILE_W = 54, TILE_H = 68, LAYER_DX = 6, LAYER_DY = 6;

// Simplified 144-tile stacked layout (not the real Turtle — geometry realism
// only: 4 layers, upper layers overlap lower ones).
// layers: cols x rows -> 84 + 40 + 18 + 2 = 144
const LAYERS = [
  { cols: 12, rows: 7 },
  { cols: 8, rows: 5 },
  { cols: 6, rows: 3 },
  { cols: 2, rows: 1 },
];

const SUITS = [
  ...Array.from({ length: 9 }, (_, i) => `Bamboo ${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `Circle ${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `Character ${i + 1}`),
  'East Wind', 'South Wind', 'West Wind', 'North Wind',
  'Red Dragon', 'Green Dragon', 'White Dragon',
  'Flower', 'Season',
];
const GLYPH = f => f.split(' ').map(w => w[0]).join('') + (f.match(/\d/)?.[0] ?? '');

// --- board model ---------------------------------------------------------
let seed = 42;
const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;

const tiles = [];
{
  const boardW = LAYERS[0].cols * TILE_W;
  let id = 0;
  LAYERS.forEach((L, layer) => {
    const x0 = (boardW - L.cols * TILE_W) / 2 + layer * LAYER_DX;
    const y0 = 40 + ((LAYERS[0].rows - L.rows) * TILE_H) / 2 + layer * LAYER_DY;
    for (let r = 0; r < L.rows; r++)
      for (let c = 0; c < L.cols; c++)
        tiles.push({ id: id++, layer, x: x0 + c * TILE_W, y: y0 + r * TILE_H, face: null, removed: false });
  });
  // 36 faces x 4 copies, shuffled
  const faces = SUITS.flatMap(f => [f, f, f, f]);
  for (let i = faces.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [faces[i], faces[j]] = [faces[j], faces[i]];
  }
  tiles.forEach((t, i) => (t.face = faces[i]));
}

const overlaps = (a, b) =>
  Math.abs(a.x - b.x) < TILE_W && Math.abs(a.y - b.y) < TILE_H;

function isCovered(t) {
  return tiles.some(o => !o.removed && o.layer === t.layer + 1 && overlaps(o, t));
}
function isFree(t) {
  if (t.removed || isCovered(t)) return false;
  const left = tiles.some(o => !o.removed && o.layer === t.layer && o.y === t.y && o.x === t.x - TILE_W);
  const right = tiles.some(o => !o.removed && o.layer === t.layer && o.y === t.y && o.x === t.x + TILE_W);
  return !(left && right);
}
const matches = (a, b) =>
  a.face === b.face || (a.face === 'Flower' && b.face === 'Season') || (a.face === 'Season' && b.face === 'Flower');

// --- pixi rendering ------------------------------------------------------
const boardW = LAYERS[0].cols * TILE_W + 60, boardH = LAYERS[0].rows * TILE_H + 100;
const app = new Application();
await app.init({ width: boardW, height: boardH, background: '#1d3557', antialias: true, resolution: devicePixelRatio, autoDensity: true });
document.getElementById('board-wrap').prepend(app.canvas);
document.getElementById('board-wrap').style.width = boardW + 'px';
document.getElementById('board-wrap').style.height = boardH + 'px';

const layerContainers = LAYERS.map(() => new Container());
layerContainers.forEach(c => app.stage.addChild(c));

let selected = null;
for (const t of tiles) {
  const g = new Container();
  const body = new Graphics()
    .roundRect(0, 0, TILE_W - 4, TILE_H - 4, 6)
    .fill(t.layer % 2 ? '#f8f4e3' : '#efe9d0')
    .stroke({ width: 2, color: '#5c4d3c' });
  const label = new Text({ text: GLYPH(t.face), style: { fontSize: 16, fill: '#333', fontFamily: 'system-ui' } });
  label.x = 8; label.y = 8;
  g.addChild(body, label);
  g.x = t.x; g.y = t.y;
  layerContainers[t.layer].addChild(g);
  t.sprite = g; t.bodyG = body;
}

function redrawTile(t) {
  t.sprite.visible = !t.removed;
  const sel = selected === t;
  t.bodyG.clear()
    .roundRect(0, 0, TILE_W - 4, TILE_H - 4, 6)
    .fill(sel ? '#ffd166' : t.layer % 2 ? '#f8f4e3' : '#efe9d0')
    .stroke({ width: 2, color: sel ? '#e07a00' : '#5c4d3c' });
}

// --- ARIA overlay --------------------------------------------------------
const overlay = document.getElementById('overlay');
const announce = document.getElementById('announce');

function tileLabel(t) {
  return `${t.face}, ${isFree(t) ? 'free' : 'blocked'}${selected === t ? ', selected' : ''}`;
}

function syncOverlay() {
  const remaining = tiles.filter(t => !t.removed);
  overlay.setAttribute('aria-label', `Mahjong board, ${remaining.length} tiles remaining`);
  for (const t of tiles) {
    if (t.removed) { t.btn?.remove(); t.btn = null; continue; }
    if (isCovered(t)) { t.btn?.remove(); t.btn = null; continue; } // hidden from AT while covered
    if (!t.btn) {
      t.btn = document.createElement('button');
      t.btn.style.left = t.x + 'px';
      t.btn.style.top = t.y + 'px';
      t.btn.style.width = Math.max(48, TILE_W - 4) + 'px';
      t.btn.style.height = Math.max(48, TILE_H - 4) + 'px';
      t.btn.addEventListener('click', () => onActivate(t));
      overlay.appendChild(t.btn);
    }
    t.btn.setAttribute('aria-label', tileLabel(t));
    t.btn.setAttribute('aria-disabled', String(!isFree(t)));
    t.btn.setAttribute('aria-pressed', String(selected === t));
  }
}

function onActivate(t) {
  if (!isFree(t)) { announce.textContent = `${t.face} is blocked`; return; }
  if (selected === t) { selected = null; }
  else if (selected && matches(selected, t)) {
    selected.removed = t.removed = true;
    announce.textContent = `Matched ${t.face}. ${tiles.filter(x => !x.removed).length} tiles left`;
    const s = selected; selected = null;
    redrawTile(s); redrawTile(t); syncOverlay();
    tiles.forEach(redrawTile);
    return;
  } else if (selected) {
    announce.textContent = `${t.face} does not match ${selected.face}`;
    const prev = selected; selected = t; redrawTile(prev);
  } else { selected = t; }
  redrawTile(t); syncOverlay();
}

tiles.forEach(redrawTile);
syncOverlay();

// --- frame-time harness --------------------------------------------------
const statsEl = document.getElementById('stats');
const deltas = [];
let last = performance.now();
let stress = 0; // frames of stress animation remaining
const stressResult = document.getElementById('stress-result');
let stressDeltas = null;

app.ticker.add(() => {
  const now = performance.now();
  deltas.push(now - last);
  if (deltas.length > 120) deltas.shift();
  if (stress > 0) {
    stressDeltas.push(now - last);
    const t = now / 300;
    tiles.forEach((tile, i) => {
      if (tile.removed) return;
      tile.sprite.x = tile.x + Math.sin(t + i) * 3;
      tile.sprite.y = tile.y + Math.cos(t + i * 0.7) * 3;
      tile.sprite.alpha = 0.85 + 0.15 * Math.sin(t * 2 + i);
    });
    if (--stress === 0) {
      tiles.forEach(tile => { tile.sprite.x = tile.x; tile.sprite.y = tile.y; tile.sprite.alpha = 1; });
      const sorted = [...stressDeltas].sort((a, b) => a - b);
      const avg = stressDeltas.reduce((a, b) => a + b, 0) / stressDeltas.length;
      const p95 = sorted[Math.floor(sorted.length * 0.95)];
      const worst = sorted[sorted.length - 1];
      window.__stress = { frames: stressDeltas.length, avgMs: +avg.toFixed(2), p95Ms: +p95.toFixed(2), worstMs: +worst.toFixed(2) };
      stressResult.textContent = `stress: avg ${avg.toFixed(1)}ms, p95 ${p95.toFixed(1)}ms, worst ${worst.toFixed(1)}ms over ${stressDeltas.length} frames`;
    }
  }
  last = now;
  if (deltas.length === 120) {
    const avg = deltas.reduce((a, b) => a + b, 0) / deltas.length;
    statsEl.textContent = `fps: ${(1000 / avg).toFixed(0)} (avg ${avg.toFixed(1)}ms/frame)`;
  }
});

document.getElementById('stress').addEventListener('click', () => {
  stressDeltas = [];
  stress = 600; // ~10s at 60fps
  stressResult.textContent = 'running…';
});

// hooks for automated verification
window.__spike = { tiles, isFree, onActivate, count: () => tiles.filter(t => !t.removed).length };
window.__app = app;

// Synchronous render benchmark: times N explicit render passes with per-frame
// animation updates. Immune to rAF throttling in hidden tabs; measures CPU
// scene traversal + GPU submit (not vsync-paced real fps).
window.__benchSync = (frames = 300) => {
  const times = [];
  for (let i = 0; i < frames; i++) {
    const t = i / 5;
    tiles.forEach((tile, k) => {
      if (tile.removed) return;
      tile.sprite.x = tile.x + Math.sin(t + k) * 3;
      tile.sprite.y = tile.y + Math.cos(t + k * 0.7) * 3;
      tile.sprite.alpha = 0.85 + 0.15 * Math.sin(t * 2 + k);
    });
    const s = performance.now();
    app.renderer.render(app.stage);
    times.push(performance.now() - s);
  }
  tiles.forEach(tile => { tile.sprite.x = tile.x; tile.sprite.y = tile.y; tile.sprite.alpha = 1; });
  const sorted = [...times].sort((a, b) => a - b);
  return {
    frames,
    avgMs: +(times.reduce((a, b) => a + b, 0) / frames).toFixed(3),
    p95Ms: +sorted[Math.floor(frames * 0.95)].toFixed(3),
    worstMs: +sorted[frames - 1].toFixed(3),
  };
};
