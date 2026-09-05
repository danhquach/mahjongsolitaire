// The page a browser gets when it lands somewhere that is not the game
// (issue #210). Static assets are served before this script runs, so a
// navigation only reaches here when its path matches no file: a mistyped
// share link, a guessed `/leaderboard`. `{"error":"not_found"}` on a white
// page told a player nothing and left no way back; this does both, in the
// game's own idiom: three tiles dealt on the felt read 4 · 0 · 4, the zero
// being the White Dragon's empty frame (a tile with nothing on it — the page
// that is not there). The 503 deals the same three tiles face down: the board
// is being reshuffled.
//
// API callers are unaffected: the router asks `isNavigation` and only a
// browser navigation to a non-API path gets HTML. The page is one string with
// its style and its art inline and no script, image or stylesheet, so it
// renders when the asset bundle or the database is the thing that is broken.
// Colours are the game's (ui/index.html felt and paper; ui/src/faces.ts inks).

const COPY = {
  404: {
    title: 'Page not found',
    heading: 'No matching pair here',
    body: 'The link you followed does not lead to a tile on the board.',
    label: 'Three tiles reading four, zero, four',
  },
  503: {
    title: 'Back soon',
    heading: 'The board is being reshuffled',
    body: 'Lantern Tiles is taking a short break. Try again in a moment.',
    label: 'Three tiles face down',
  },
};

/** A browser navigation, as opposed to a fetch from the game or a script. A
 *  modern browser says so in `Sec-Fetch-Mode`; an older one, or a tool
 *  imitating one, is taken at its `Accept` word. Anything that says neither
 *  is a program and gets JSON. */
export function isNavigation(request) {
  const mode = request.headers.get('Sec-Fetch-Mode');
  if (mode !== null) return mode === 'navigate';
  return (request.headers.get('Accept') ?? '').includes('text/html');
}

// --- Tile art -------------------------------------------------------------
// Tile geometry is 84 × 112 face units. A tile is its side (the darker slab
// offset down-right, the game's bevel) under its face. Faces follow the
// game's own drawing rules: Dots are two-tone rings, the White Dragon is a
// white-filled double frame, and a back is the felt-green slab with a
// keyline. Nothing here is traced from an existing set (decision 0002).

const FACE = '#f7f1e1';
const SIDE = '#c9b98f';
const KEY = '#e2d7bb';
const PINE = '#1a6b52';
const RED = '#b91c1c';
const SLATE = '#334155';
const BACK = '#1f7a4a';
const BACK_KEY = '#bbf7d0';

function slab(fill, key) {
  return (
    `<rect x="4" y="6" width="84" height="112" rx="10" fill="${SIDE}"/>` +
    `<rect x="0" y="0" width="84" height="112" rx="10" fill="${fill}" stroke="${key}" stroke-width="2"/>`
  );
}

/** A Dots ring: the game's two-tone split, accent half on top. */
function ring(cx, cy, accent) {
  return (
    `<circle cx="${cx}" cy="${cy}" r="11" fill="none" stroke="${PINE}" stroke-width="5"/>` +
    `<path d="M ${cx - 11} ${cy} A 11 11 0 0 1 ${cx + 11} ${cy}" fill="none" stroke="${accent}" stroke-width="5"/>` +
    `<circle cx="${cx}" cy="${cy}" r="3.5" fill="${PINE}"/>`
  );
}

function fourDots() {
  // Four rings in the corners; the outer rows take the traditional green
  // accent, so a 4 is pine with a whisper of the lighter ring colour on top.
  return slab(FACE, KEY) + ring(26, 34, '#5eead4') + ring(58, 34, '#5eead4') + ring(26, 78, '#5eead4') + ring(58, 78, '#5eead4');
}

function whiteDragon() {
  return (
    slab(FACE, KEY) +
    `<rect x="18" y="20" width="48" height="72" rx="7" fill="#fff" stroke="${SLATE}" stroke-width="5"/>` +
    `<rect x="28" y="32" width="28" height="48" rx="4" fill="none" stroke="${SLATE}" stroke-width="4"/>`
  );
}

function back() {
  return (
    slab(BACK, BACK_KEY) +
    `<rect x="10" y="10" width="64" height="92" rx="6" fill="none" stroke="${BACK_KEY}" stroke-width="2" opacity=".55"/>` +
    `<circle cx="42" cy="56" r="12" fill="none" stroke="${BACK_KEY}" stroke-width="2" opacity=".55"/>`
  );
}

function tile(art, x, tilt) {
  return `<g transform="translate(${x} 0) rotate(${tilt} 42 56)">${art}</g>`;
}

function deal(status) {
  const faces = status === 404 ? [fourDots(), whiteDragon(), fourDots()] : [back(), back(), back()];
  return (
    `<svg class="deal" viewBox="-10 -14 320 150" width="320" height="150" role="img" aria-label="${COPY[status].label}">` +
    `<ellipse cx="150" cy="122" rx="150" ry="16" fill="#000" opacity=".28"/>` +
    tile(faces[0], 0, -6) +
    tile(faces[1], 108, 2) +
    tile(faces[2], 216, 5) +
    `</svg>`
  );
}

/** The HTML response for `status` (404 or 503). */
export function errorPage(status) {
  const { title, heading, body } = COPY[status];
  const accent = status === 404 ? RED : PINE;
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — Lantern Tiles</title>
<style>
html,body{margin:0;min-height:100%;background:#14532d;font-family:system-ui,sans-serif;color:#f0fdf4}
body{position:relative;overflow:hidden;display:flex;align-items:center;justify-content:center;padding:32px 20px;box-sizing:border-box;min-height:100vh;
  background:radial-gradient(ellipse 70% 55% at 50% 38%,rgba(245,184,74,.32),rgba(245,184,74,0) 70%),#14532d}
.lantern{position:absolute;left:50%;top:-8vh;width:44vmin;height:44vmin;margin-left:-22vmin;border-radius:50%;
  background:radial-gradient(circle,rgba(255,214,120,.55),rgba(255,214,120,0) 65%);animation:breathe 5s ease-in-out infinite;pointer-events:none}
@keyframes breathe{50%{transform:scale(1.08);opacity:.85}}
main{position:relative;text-align:center;max-width:420px;width:100%}
.deal{display:block;margin:0 auto 12px;max-width:100%;height:auto;filter:drop-shadow(0 10px 14px rgba(0,0,0,.35))}
.brand{margin:0 0 10px;max-width:none;font-size:13px;font-weight:600;letter-spacing:.18em;text-transform:uppercase;color:#bbf7d0}
h1{margin:0 0 10px;font-size:clamp(26px,7vw,34px);line-height:1.15;letter-spacing:-.01em}
p{margin:0 auto 28px;max-width:34ch;font-size:17px;line-height:1.45;color:#d1fae5}
a{display:inline-block;background:#f0fdf4;color:#14532d;text-decoration:none;font-weight:700;font-size:16px;padding:14px 26px;border-radius:12px;
  min-width:48px;min-height:48px;line-height:20px;box-sizing:border-box;border-bottom:4px solid ${SIDE};box-shadow:0 8px 16px rgba(0,0,0,.3)}
a:hover{background:#fff}
a:active{transform:translateY(2px);border-bottom-width:2px}
a:focus-visible{outline:3px solid ${accent};outline-offset:3px}
@media (prefers-reduced-motion:reduce){.lantern{animation:none}}
</style>
</head>
<body>
<div class="lantern" aria-hidden="true"></div>
<main>
${deal(status)}
<p class="brand">Lantern Tiles</p>
<h1>${heading}</h1>
<p>${body}</p>
<a href="/">Back to the board</a>
</main>
</body>
</html>
`;
  return new Response(html, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}
