#!/usr/bin/env python3
"""Cut seamless felt textures out of the generated felt sheet (issue #229 slice 2).

Usage: cut-felts.py <sheet.jpg> <out-dir>

The sheet is one row of 6 felt swatches on cream (#fdf6e3) with a label under
each. Each swatch becomes one CSS background tile for #play-area
(ui/index.html), shown at one sheet pixel per CSS pixel — the "2x" scale the PM
chose on 2026-09-05 from a composite — and the PM asked that the repeats join
without visible seams. Two ways, chosen per swatch:

- **Periodic patterns** (hex tile, diamond lattice, diagonal weave): the
  period along x and y is read off the swatch's autocorrelation, and the tile
  is cropped to a whole number of periods, refined to the crop width and
  height whose wrap-around seam is smallest. Plain tiling then continues the
  lattice exactly; there is no mirror axis to break it on a wide screen.
- **Non-periodic surfaces** (wood grain, plain): the swatch is mirrored into
  a 2 x 2 block, so opposite edges are identical by construction. Grain has
  no lattice for a mirror to break.

Either way the wrap-around seam is measured — mean absolute difference between
the tile's last column and first column (and last row / first row) against the
same measure between neighbouring interior columns — and the script refuses a
tile whose seam is worse than SEAM_MAX times its interior. Tiles are quantised
to 48 colours: the JPEG noise around a tone-on-tone weave is what makes a
truecolour PNG large, not the weave.

felt-lantern is the default and stays a flat colour; it is skipped. For each
written felt the script prints the line to paste into ui/src/depth.ts `FELTS`:
the tile size (`texture`, what the CSS tiles at) and the brightest pixel
(`light`, what the back-vs-felt proof runs against). Point <out-dir> at
`data/felts/`; a contact sheet goes to docs/design/felts/ next to this script.
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

CREAM = np.array([0xFD, 0xF6, 0xE3], dtype=np.float32)
NAMES = ["felt-lantern", "felt-forest", "felt-teal", "felt-slate", "felt-walnut", "felt-ink"]
INSET = 6
MIN_PERIOD = 16
PERIODIC_MIN = 0.3  # normalised autocorrelation peak that counts as a lattice
SEAM_MAX = 1.5


def bands(profile, min_gap):
    idx = np.flatnonzero(profile)
    runs = []
    start = prev = idx[0]
    for i in idx[1:]:
        if i - prev > min_gap:
            runs.append((int(start), int(prev + 1)))
            start = i
        prev = i
    runs.append((int(start), int(prev + 1)))
    return runs


def luminance(rgb):
    c = np.asarray(rgb, dtype=np.float64) / 255
    lin = np.where(c <= 0.03928, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    return lin @ [0.2126, 0.7152, 0.0722]


def autocorr(gray):
    g = gray - gray.mean()
    f = np.fft.fft2(g)
    ac = np.fft.ifft2(f * np.conj(f)).real
    return ac / ac[0, 0]


def period(ac_line, lo, hi):
    """Offset of the strongest autocorrelation peak in [lo, hi), and its height."""
    seg = ac_line[lo:hi]
    k = int(seg.argmax())
    return lo + k, float(seg[k])


def seam(tile):
    """Wrap-around seam vs interior: (right|left, bottom|top) each as a ratio."""
    a = np.asarray(tile, dtype=np.float32)
    # A flat swatch has no interior difference; the epsilon keeps the ratio
    # finite so a non-zero wrap on it still fails, and a zero one passes.
    interior_x = max(np.abs(a[:, 1:] - a[:, :-1]).mean(), 1e-3)
    interior_y = max(np.abs(a[1:, :] - a[:-1, :]).mean(), 1e-3)
    wrap_x = np.abs(a[:, 0] - a[:, -1]).mean()
    wrap_y = np.abs(a[0, :] - a[-1, :]).mean()
    return wrap_x / interior_x, wrap_y / interior_y


def best_crop(cell, px, py):
    """Crop to whole periods; refine each side a few px to the smallest seam."""
    w, h = cell.size
    nx, ny = max(1, (w - 8) // px), max(1, (h - 8) // py)
    best = None
    for cw in range(nx * px - 4, min(w, nx * px + 5)):
        for ch in range(ny * py - 4, min(h, ny * py + 5)):
            x0, y0 = (w - cw) // 2, (h - ch) // 2
            crop = cell.crop((x0, y0, x0 + cw, y0 + ch))
            sx, sy = seam(crop)
            score = sx + sy
            if best is None or score < best[0]:
                best = (score, crop)
    return best[1]


def mirrored(cell):
    w, h = cell.size
    tile = Image.new("RGB", (2 * w, 2 * h))
    tile.paste(cell, (0, 0))
    tile.paste(cell.transpose(Image.Transpose.FLIP_LEFT_RIGHT), (w, 0))
    tile.paste(cell.transpose(Image.Transpose.FLIP_TOP_BOTTOM), (0, h))
    tile.paste(cell.transpose(Image.Transpose.ROTATE_180), (w, h))
    return tile


def main(sheet, out_dir):
    img = Image.open(sheet).convert("RGB")
    rgb = np.asarray(img, dtype=np.float32)
    mask = np.linalg.norm(rgb - CREAM, axis=2) > 40
    y0, y1 = bands(mask.any(axis=1), 3)[0]
    cols = bands(mask[y0:y1].any(axis=0), 8)
    if len(cols) != len(NAMES):
        sys.exit(f"expected {len(NAMES)} swatches, found {len(cols)}: {cols}")
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    cut = []
    for (x0, x1), name in zip(cols, NAMES):
        if name == NAMES[0]:
            continue
        cell = img.crop((x0 + INSET, y0 + INSET, x1 - INSET, y1 - INSET))
        gray = np.asarray(cell.convert("L"), dtype=np.float64)
        ac = autocorr(gray)
        h, w = gray.shape
        px, ax = period(ac[0, :], MIN_PERIOD, w // 2)
        py, ay = period(ac[:, 0], MIN_PERIOD, h // 2)
        if min(ax, ay) >= PERIODIC_MIN:
            tile, how = best_crop(cell, px, py), f"periodic {px}x{py} px (peaks {ax:.2f}/{ay:.2f})"
        else:
            tile, how = mirrored(cell), f"mirrored (peaks {ax:.2f}/{ay:.2f})"
        sx, sy = seam(tile)
        if max(sx, sy) > SEAM_MAX:
            sys.exit(f"{name}: seam {sx:.2f}/{sy:.2f} x interior, over {SEAM_MAX} — {how}")
        tile.quantize(48, method=Image.Quantize.MEDIANCUT).save(out / f"{name}.png", optimize=True)
        arr = np.asarray(tile).reshape(-1, 3)
        light = arr[luminance(arr).argmax()]
        base = np.median(arr, axis=0).astype(int)
        cut.append((name, tile))
        print(
            f"{name}.png: {tile.width}x{tile.height}, {how}, seam {sx:.2f}/{sy:.2f} x interior, "
            f"base #{base[0]:02x}{base[1]:02x}{base[2]:02x}"
            f"  →  texture: [{tile.width}, {tile.height}], light: 0x{light[0]:02x}{light[1]:02x}{light[2]:02x}"
        )
    cellw = 220
    contact = Image.new("RGB", (len(cut) * cellw, cellw + 40), (120, 120, 120))
    for i, (name, tile) in enumerate(cut):
        # Show 2 x 2 repeats so a seam would be visible on the contact sheet.
        rep = Image.new("RGB", (tile.width * 2, tile.height * 2))
        for dx in (0, tile.width):
            for dy in (0, tile.height):
                rep.paste(tile, (dx, dy))
        rep.thumbnail((cellw - 16, cellw - 16))
        contact.paste(rep, (i * cellw + 8, 8))
        ImageDraw.Draw(contact).text((i * cellw + 8, cellw + 12), name, fill=(255, 255, 255))
    contact_dir = Path(__file__).resolve().parent / "felts"
    contact_dir.mkdir(exist_ok=True)
    contact.save(contact_dir / "_contact-felts.png")
    print(f"wrote {len(cut)} felts to {out} and _contact-felts.png to {contact_dir}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(*sys.argv[1:])
