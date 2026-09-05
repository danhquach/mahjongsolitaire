#!/usr/bin/env python3
"""Cut labelled tile-face glyphs out of a generated sprite sheet.

Usage: cut-glyphs.py <sheet.png> <set-letter> <out-dir>

The sheet is a cream (#fdf6e3) background with six rows of glyphs, each row
followed by a row of small grey labels. Rows are found by horizontal
projection, glyphs within a row by vertical projection, and names come from
the fixed inventory order (dots 1-9, bamboo 1-9, char 1-9, winds, dragons,
seasons). The cream is keyed to alpha. A contact sheet is written alongside
for a visual check.

Output files are named `<face>.png` (`dots-1.png`, `wind-east.png`, ...) so
the directory can be the shipped set: point <out-dir> at
`data/glyphs/<set-dir>/`, the path ui/src/glyphs.ts loads from (issue #229,
decision 0038). The set letter only names the contact sheet. Move the
contact sheet to docs/design/glyphs/ afterwards — it is not shipped.
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image

CREAM = np.array([0xFD, 0xF6, 0xE3], dtype=np.float32)
ROWS = [
    [f"dots-{i}" for i in range(1, 10)],
    [f"bamboo-{i}" for i in range(1, 10)],
    [f"char-{i}" for i in range(1, 10)],
    ["wind-east", "wind-south", "wind-west", "wind-north"],
    ["dragon-red", "dragon-green", "dragon-white"],
    ["season-spring", "season-summer", "season-fall", "season-winter"],
]
LABEL_MAX_H = 26  # px; label text bands are shorter than this
ROW_GAP = 4  # merge horizontal bands separated by fewer rows than this
PAD = 6


def bands(profile, min_gap):
    """Contiguous runs of truthy values, merging gaps shorter than min_gap."""
    idx = np.flatnonzero(profile)
    if idx.size == 0:
        return []
    runs = []
    start = prev = idx[0]
    for i in idx[1:]:
        if i - prev > min_gap:
            runs.append((start, prev + 1))
            start = i
        prev = i
    runs.append((start, prev + 1))
    return runs


def main(sheet, letter, out_dir):
    img = Image.open(sheet).convert("RGB")
    rgb = np.asarray(img, dtype=np.float32)
    dist = np.linalg.norm(rgb - CREAM, axis=2)
    mask = dist > 40
    # grey label text: low saturation, mid-dark; slate ink is also low-sat but
    # darker and taller, so the band-height test does the real separation
    row_bands = bands(mask.any(axis=1), ROW_GAP)
    # pair every tall band (glyphs) with the short band right after it (labels)
    pairs = []
    i = 0
    while i < len(row_bands):
        y0, y1 = row_bands[i]
        if y1 - y0 > LABEL_MAX_H:
            label = row_bands[i + 1] if i + 1 < len(row_bands) and row_bands[i + 1][1] - row_bands[i + 1][0] <= LABEL_MAX_H else None
            if label is None:
                # glyphs and labels touched: peel the thin band off the bottom
                sub = bands(mask[y0:y1].any(axis=1), 1)
                if len(sub) >= 2 and sub[-1][1] - sub[-1][0] <= LABEL_MAX_H:
                    label = (y0 + sub[-1][0], y0 + sub[-1][1])
                    y1 = y0 + sub[-1][0]
            pairs.append(((y0, y1), label))
            i += 2 if label and label[0] >= y1 and i + 1 < len(row_bands) and row_bands[i + 1] == label else 1
        else:
            i += 1
    if len(pairs) != len(ROWS):
        sys.exit(f"expected {len(ROWS)} glyph rows, found {len(pairs)}: {pairs}")

    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    alpha = np.clip((dist - 12) / 40, 0, 1)
    cut = []
    for ((y0, y1), label), names in zip(pairs, ROWS):
        if label is None:
            sys.exit(f"row {names[0]}: no label band found under it")
        # labels are evenly placed under their glyphs and never touch each
        # other, so their centres give cut points that glyph spacing cannot
        lcols = bands(mask[label[0]:label[1]].any(axis=0), 14)
        if len(lcols) != len(names):
            sys.exit(f"row {names[0]}: expected {len(names)} labels, found {len(lcols)}: {lcols}")
        centres = [(a + b) / 2 for a, b in lcols]
        edges = [0] + [int((centres[k] + centres[k + 1]) / 2) for k in range(len(centres) - 1)] + [mask.shape[1]]
        for k, name in enumerate(names):
            x0, x1 = edges[k], edges[k + 1]
            sub = mask[y0:y1, x0:x1]
            ys = np.flatnonzero(sub.any(axis=1))
            xs = np.flatnonzero(sub.any(axis=0))
            if ys.size == 0:
                sys.exit(f"{name}: empty cell between x={x0} and x={x1}")
            ty0, ty1 = y0 + ys[0], y0 + ys[-1] + 1
            tx0, tx1 = x0 + xs[0], x0 + xs[-1] + 1
            bx0, by0 = max(tx0 - PAD, 0), max(ty0 - PAD, 0)
            bx1, by1 = min(tx1 + PAD, mask.shape[1]), min(ty1 + PAD, mask.shape[0])
            tile = np.dstack([rgb[by0:by1, bx0:bx1], alpha[by0:by1, bx0:bx1] * 255]).astype(np.uint8)
            im = Image.fromarray(tile, "RGBA")
            fname = f"{name}.png"
            im.save(out / fname)
            cut.append((fname, im))
            print(f"{fname}: {im.width}x{im.height} at ({bx0},{by0})")

    # contact sheet on a neutral grey so the alpha edge is visible
    cell = 140
    cols_n = 9
    rows_n = (len(cut) + cols_n - 1) // cols_n
    sheet_img = Image.new("RGBA", (cols_n * cell, rows_n * (cell + 20)), (120, 120, 120, 255))
    for i, (fname, im) in enumerate(cut):
        fit = im.copy()
        fit.thumbnail((cell - 16, cell - 16))
        x = (i % cols_n) * cell + (cell - fit.width) // 2
        y = (i // cols_n) * (cell + 20) + (cell - fit.height) // 2
        sheet_img.alpha_composite(fit, (x, y))
    sheet_img.save(out / f"_contact-{letter}.png")
    print(f"wrote {len(cut)} glyphs and _contact-{letter}.png to {out}")


if __name__ == "__main__":
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    main(*sys.argv[1:])
