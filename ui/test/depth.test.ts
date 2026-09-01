// Issue #45: stacked layers must read as stacked. These tests pin the three
// constraints the depth palette has to hold, none of which are visible from
// looking at a screenshot:
//
//   * contrast ≥ 4.5:1 between every face and every ink, on every layer, dimmed
//     or not (spec §7, issue #12, Phase 5 a11y gate);
//   * the depth cues survive greyscale — they are luminance, not hue;
//   * no shadow ring escapes its tile up-left, where painter's order has
//     already laid down the neighbours it would smear over.
//
// The suit inks come from STANDARD_144 through faceStyle, so a new face or a
// re-themed suit is covered the moment it ships — not from a copy of the list.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { STANDARD_144 } from '@mahjongsolitaire/core';
import {
  BASE_BORDER,
  BASE_FACE,
  BOARD_FELT,
  BORDER_WIDTH,
  contrastRatio,
  depthSteps,
  DIMMED_STEPS,
  LAYER_FACE_STEP,
  LAYER_INK_STEP,
  relativeLuminance,
  scaleColor,
  SHADOW_DX,
  SHADOW_DY,
  SHADOW_PAD,
  SHADOW_RINGS,
  SHADOW_UP_LEFT_RATIO,
  SIDE_BAND_FACTORS,
  tileShade,
} from '../src/depth.js';
import { faceStyle } from '../src/faces.js';
import { BACK_FACE, BACK_KEYLINE } from '../src/render.js';
import { SIDE_DEPTH, TILE_H, TILE_W } from '../src/geometry.js';

/** Spec §7 / issue #12: text and pips against their own tile face. */
const MIN_TEXT_CONTRAST = 4.5;
/** WCAG 1.4.11: non-text boundaries (the tile outline) against what they separate. */
const MIN_NON_TEXT_CONTRAST = 3;
/** Deepest layer any shipped layout reaches (Turtle, Terrace, Spider: z 0–4). */
const MAX_TOP_Z = 4;

/** Every colour a tile face can paint: the suit ink plus the pip banding
 *  accents (issue #45). Collected from the shipped 144-tile set through
 *  faceStyle, so a new face or a re-themed suit joins the sweep on its own. */
const SUIT_INKS = [
  ...new Set(
    STANDARD_144.flatMap((face) => {
      const style = faceStyle(face);
      return [style.color, ...(style.pips ?? []).map((pip) => pip.accent)];
    }).filter((color): color is number => color !== undefined),
  ),
];

/** Every (layout depth, layer, dim state) a shipped board can produce. */
function everyShade(): { z: number; topZ: number; dimmed: boolean }[] {
  const out: { z: number; topZ: number; dimmed: boolean }[] = [];
  for (let topZ = 0; topZ <= MAX_TOP_Z; topZ++) {
    for (let z = 0; z <= topZ; z++) {
      out.push({ z, topZ, dimmed: false }, { z, topZ, dimmed: true });
    }
  }
  return out;
}

// --- contrast gate ------------------------------------------------------------

test('every ink holds 4.5:1 against its own face, on every layer, dimmed or not', () => {
  assert.ok(SUIT_INKS.length >= 7, `expected all seven suits, got ${SUIT_INKS.length}`);
  let worst = { ratio: Infinity, where: '' };
  for (const { z, topZ, dimmed } of everyShade()) {
    const shade = tileShade(z, topZ, dimmed);
    for (const suit of SUIT_INKS) {
      const ratio = contrastRatio(shade.face, shade.ink(suit));
      if (ratio < worst.ratio) {
        worst = { ratio, where: `z=${z} topZ=${topZ} dimmed=${dimmed} ink=#${suit.toString(16)}` };
      }
    }
  }
  assert.ok(
    worst.ratio >= MIN_TEXT_CONTRAST,
    `worst ink contrast ${worst.ratio.toFixed(2)}:1 at ${worst.where}`,
  );
});

test('issue #82: the face-down back never sinks into the felt, on any undimmed layer', () => {
  // The soft-background / strong-tile rule: the felt is the muted variant, the
  // back the saturated one, and the pair must hold WCAG 1.4.11's non-text 3:1
  // on every layer a shipped layout reaches. Dimmed shades are exempt — the
  // "Highlight free tiles" aid dims blocked tiles on purpose.
  let worst = { ratio: Infinity, where: '' };
  for (const { z, topZ, dimmed } of everyShade()) {
    if (dimmed) continue;
    const factor = 1 - LAYER_FACE_STEP * depthSteps(z, topZ);
    const ratio = contrastRatio(scaleColor(BACK_FACE, factor), BOARD_FELT);
    if (ratio < worst.ratio) worst = { ratio, where: `z=${z} topZ=${topZ}` };
  }
  assert.ok(
    worst.ratio >= MIN_NON_TEXT_CONTRAST,
    `worst back-vs-felt contrast ${worst.ratio.toFixed(2)}:1 at ${worst.where}`,
  );
});

test('issue #82: the back keyline holds 3:1 on the back, on every layer, dimmed or not', () => {
  let worst = Infinity;
  for (const { z, topZ, dimmed } of everyShade()) {
    const factor = 1 - LAYER_FACE_STEP * depthSteps(z, topZ, dimmed);
    worst = Math.min(worst, contrastRatio(scaleColor(BACK_FACE, factor), scaleColor(BACK_KEYLINE, factor)));
  }
  assert.ok(worst >= MIN_NON_TEXT_CONTRAST, `worst keyline contrast ${worst.toFixed(2)}:1`);
});

test('receding never tightens the contrast budget: the worst case only improves', () => {
  // The reason LAYER_INK_STEP > LAYER_FACE_STEP. Darkening the face alone would
  // eat the figure/ground budget layer by layer, and the top layer is already
  // the binding case at ~4.65:1 (bamboo) — there is nothing there to give.
  //
  // What has to hold is the *minimum* over the suits, layer by layer: the
  // already-dark inks (Wind, Character) lose a little ratio as the face comes
  // down, but they sit near 9:1 and never come close to binding the gate.
  assert.ok(LAYER_INK_STEP > LAYER_FACE_STEP);
  const worstAt = (steps: number): number => {
    const shade = tileShade(MAX_TOP_Z - steps, MAX_TOP_Z);
    return Math.min(...SUIT_INKS.map((suit) => contrastRatio(shade.face, shade.ink(suit))));
  };
  const top = worstAt(0);
  for (let steps = 1; steps <= MAX_TOP_Z + DIMMED_STEPS; steps++) {
    assert.ok(
      worstAt(steps) >= top,
      `worst ink ${steps} steps back: ${worstAt(steps).toFixed(2)} < ${top.toFixed(2)} at the top`,
    );
  }
});

test('the outline clears the 3:1 non-text bar against its own face on every layer', () => {
  // Same-layer neighbours have no shadow between them — a tile's shadow falls
  // where its right/lower neighbours paint — so the outline is the whole cue.
  assert.ok(BORDER_WIDTH >= 2, 'the old 1.5px hairline was too thin to separate neighbours');
  assert.ok(
    contrastRatio(BASE_FACE, BASE_BORDER) > contrastRatio(BASE_FACE, 0x8a7a55),
    'the new outline must be darker than the hairline it replaces',
  );
  for (const { z, topZ, dimmed } of everyShade()) {
    const shade = tileShade(z, topZ, dimmed);
    const ratio = contrastRatio(shade.face, shade.border);
    assert.ok(ratio >= MIN_NON_TEXT_CONTRAST, `outline ${ratio.toFixed(2)}:1 at z=${z}/${topZ}`);
  }
});

// --- greyscale survival -------------------------------------------------------

test('the layer shift is a pure luminance ladder, so depth survives greyscale', () => {
  for (let topZ = 1; topZ <= MAX_TOP_Z; topZ++) {
    for (let z = 1; z <= topZ; z++) {
      const upper = relativeLuminance(tileShade(z, topZ).face);
      const lower = relativeLuminance(tileShade(z - 1, topZ).face);
      assert.ok(upper > lower, `z=${z} must be lighter than z=${z - 1} (topZ=${topZ})`);
      assert.ok(
        upper - lower >= 0.04,
        `z=${z}→${z - 1} luminance step ${(upper - lower).toFixed(3)} is too small to see`,
      );
    }
  }
});

test('the side face ramps from light at the top face to near-dark at its base', () => {
  const { sideBands } = tileShade(MAX_TOP_Z, MAX_TOP_Z);
  assert.equal(sideBands.length, SIDE_BAND_FACTORS.length);
  const lums = sideBands.map(relativeLuminance);
  for (let i = 1; i < lums.length; i++) {
    assert.ok(lums[i]! > lums[i - 1]!, `band ${i} must be lighter than band ${i - 1} (base first)`);
  }
  // The ramp has to be a ramp, not a tint: a wide luminance span across the
  // bands, every band darker than the face above them, and a base dark enough
  // to read as a contact edge on its own. The old flat side sat at 2.1:1
  // everywhere, which is part of why a stack looked like one slab.
  const face = tileShade(MAX_TOP_Z, MAX_TOP_Z).face;
  const span = lums[lums.length - 1]! - lums[0]!;
  assert.ok(span >= 0.4, `band luminance span ${span.toFixed(2)} is too flat to read`);
  assert.ok(lums.every((l) => l < relativeLuminance(face)));
  assert.ok(contrastRatio(face, sideBands[0]!) >= 4, 'base band vs face');
});

test('the drop shadow is achromatic, so it cannot be a colour-only cue', () => {
  // Black at low alpha: it darkens whatever it lands on and nothing else.
  assert.ok(SHADOW_RINGS.every((r) => r.alpha > 0 && r.alpha < 0.5));
  const accumulated = 1 - SHADOW_RINGS.reduce((acc, r) => acc * (1 - r.alpha), 1);
  assert.ok(
    accumulated >= 0.2 && accumulated <= 0.5,
    `contact-edge shadow alpha ${accumulated.toFixed(2)} should read without muddying the board`,
  );
});

// --- the "free tiles pop" aid (item 5, default off) ---------------------------

test('dimming pushes a blocked tile behind a free one on the same layer', () => {
  assert.ok(DIMMED_STEPS >= 1);
  for (let topZ = 0; topZ <= MAX_TOP_Z; topZ++) {
    for (let z = 0; z <= topZ; z++) {
      const free = relativeLuminance(tileShade(z, topZ, false).face);
      const blocked = relativeLuminance(tileShade(z, topZ, true).face);
      assert.ok(blocked < free, `dimmed z=${z}/${topZ} must be darker than free`);
    }
  }
});

// --- anchoring ----------------------------------------------------------------

test('the top layer is the brightest on every layout, however shallow', () => {
  for (let topZ = 0; topZ <= MAX_TOP_Z; topZ++) {
    assert.equal(depthSteps(topZ, topZ), 0, `topZ=${topZ}`);
    assert.equal(
      tileShade(topZ, topZ).face,
      BASE_FACE,
      'a two-layer layout must not be dimmed for having no depth to show',
    );
  }
  // Anchored on the layout's own top layer, not an absolute z.
  assert.equal(depthSteps(0, 4), 4);
  assert.equal(depthSteps(0, 1), 1);
  // A z above the layout's top (a layout we have not shipped) clamps rather
  // than brightening past the palette.
  assert.equal(depthSteps(7, 4), 0);
});

// --- shadow geometry ----------------------------------------------------------

test('no shadow ring escapes its tile up-left, where the neighbours already painted', () => {
  // Painter's order only covers what comes *after* a tile: anything the shadow
  // reaches up or left of the silhouette lands on an already-painted neighbour
  // and stays there. The offset has to swallow every ring's backward reach.
  for (const ring of SHADOW_RINGS) {
    const back = ring.grow * SHADOW_UP_LEFT_RATIO;
    assert.ok(back < SHADOW_DX, `ring grow=${ring.grow} reaches ${back} left of the silhouette`);
    assert.ok(back < SHADOW_DY, `ring grow=${ring.grow} reaches ${back} above the silhouette`);
  }
});

test('rings run largest-first, so the stack accumulates toward the contact edge', () => {
  const grows = SHADOW_RINGS.map((r) => r.grow);
  assert.deepEqual(grows, [...grows].sort((a, b) => b - a));
  assert.ok(grows[grows.length - 1]! > 0);
});

test('the baked texture is big enough to hold every ring', () => {
  const maxGrow = Math.max(...SHADOW_RINGS.map((r) => r.grow));
  const width = TILE_W + SIDE_DEPTH + 2 * SHADOW_PAD;
  const height = TILE_H + SIDE_DEPTH + 2 * SHADOW_PAD;
  // Left/top: the ring's own start must land inside the padded canvas.
  assert.ok(SHADOW_PAD + SHADOW_DX - maxGrow * SHADOW_UP_LEFT_RATIO >= 0);
  assert.ok(SHADOW_PAD + SHADOW_DY - maxGrow * SHADOW_UP_LEFT_RATIO >= 0);
  // Right/bottom: and so must its far edge, or the shadow is clipped square.
  assert.ok(SHADOW_PAD + SHADOW_DX + TILE_W + SIDE_DEPTH + maxGrow <= width);
  assert.ok(SHADOW_PAD + SHADOW_DY + TILE_H + SIDE_DEPTH + maxGrow <= height);
});

test('the shadow reaches far enough down-right to clear the layer lift', () => {
  // A tile sits SIDE_DEPTH up-left of the layer below it. A shadow shorter than
  // that never actually lands on the tile underneath, which is the whole point.
  const reach = SHADOW_DX + Math.max(...SHADOW_RINGS.map((r) => r.grow));
  assert.ok(reach > SIDE_DEPTH, `shadow reach ${reach} must exceed the ${SIDE_DEPTH}px lift`);
});

// --- colour arithmetic --------------------------------------------------------

test('scaleColor stays inside a byte per channel', () => {
  assert.equal(scaleColor(0xffffff, 2), 0xffffff);
  assert.equal(scaleColor(0xffffff, 0), 0x000000);
  assert.equal(scaleColor(0x804020, 0.5), 0x402010);
  assert.equal(scaleColor(0x000000, -1), 0x000000);
});

test('contrastRatio is symmetric and bounded by the WCAG range', () => {
  assert.equal(contrastRatio(0xffffff, 0x000000).toFixed(0), '21');
  assert.equal(contrastRatio(0x123456, 0x123456), 1);
  assert.equal(contrastRatio(BASE_FACE, BASE_BORDER), contrastRatio(BASE_BORDER, BASE_FACE));
});
