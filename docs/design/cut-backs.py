#!/usr/bin/env python3
"""Cut labelled tile backs out of the generated back sheet (issue #229 slice 2).

Usage: cut-backs.py <sheet.jpg> <out-dir>

The sheet is one row of 8 tile backs on the Lantern felt (#14532d) with a
label under each. Cells are found by vertical projection of the non-felt
pixels; the tile within a cell is the bounding box of those pixels (for
back-bamboo-grove, whose ground *is* the felt, that box is the keyline's,
which is the tile edge anyway). Each tile is written at its native crop with
a rounded-rectangle alpha mask (radius 6/64 of the width, the tile's own) so
the felt corners of the JPEG never ship. Nothing is resampled here: the
renderer stretches the sprite to the tile rect (ui/src/render.ts), which is
what keeps the keyline on all four edges when the generated cell is not
exactly 64:84.

Names come from the brief's order (docs/design/cosmetics-prompts.md). The
first cell, back-jade, is the drawn default and is skipped. Point <out-dir>
at `data/backs/`, the path ui/src/backs.ts loads from. A contact sheet
`_contact-backs.png` is written to docs/design/backs/ (next to this script)
for a visual check; nothing but the backs goes into <out-dir>.
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

FELT = np.array([0x14, 0x53, 0x2D], dtype=np.float32)
NAMES = [
    "back-jade",  # the default: drawn, not shipped
    "back-night-sky",
    "back-blue-wave",
    "back-lacquer-lantern",
    "back-plum-branch",
    "back-koi",
    "back-bamboo-grove",
    "back-cloud-scroll",
]
ROW_GAP = 3
COL_GAP = 8
CORNER = 6 / 64


def bands(profile, min_gap):
    idx = np.flatnonzero(profile)
    if idx.size == 0:
        return []
    runs = []
    start = prev = idx[0]
    for i in idx[1:]:
        if i - prev > min_gap:
            runs.append((int(start), int(prev + 1)))
            start = i
        prev = i
    runs.append((int(start), int(prev + 1)))
    return runs


def main(sheet, out_dir):
    img = Image.open(sheet).convert("RGB")
    rgb = np.asarray(img, dtype=np.float32)
    mask = np.linalg.norm(rgb - FELT, axis=2) > 45
    rows = bands(mask.any(axis=1), ROW_GAP)
    if len(rows) < 2:
        sys.exit(f"expected a tile band and a label band, found {rows}")
    y0, y1 = rows[0]
    cols = bands(mask[y0:y1].any(axis=0), COL_GAP)
    if len(cols) != len(NAMES):
        sys.exit(f"expected {len(NAMES)} tiles, found {len(cols)}: {cols}")

    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    cut = []
    for (x0, x1), name in zip(cols, NAMES):
        sub = mask[y0:y1, x0:x1]
        ys = np.flatnonzero(sub.any(axis=1))
        ty0, ty1 = y0 + ys[0], y0 + ys[-1] + 1
        tile = img.crop((x0, ty0, x1, ty1)).convert("RGBA")
        w, h = tile.size
        r = round(w * CORNER)
        alpha = Image.new("L", (w, h), 0)
        ImageDraw.Draw(alpha).rounded_rectangle((0, 0, w - 1, h - 1), radius=r, fill=255)
        tile.putalpha(alpha)
        if name == NAMES[0]:
            print(f"{name}: {w}x{h} at ({x0},{ty0}) — default, not written")
            continue
        tile.save(out / f"{name}.png")
        cut.append((name, tile))
        print(f"{name}.png: {w}x{h} at ({x0},{ty0}) aspect {w / h:.3f} (tile is {64 / 84:.3f})")

    cell = 160
    sheet_img = Image.new("RGBA", (len(cut) * cell, cell + 60), (120, 120, 120, 255))
    for i, (name, tile) in enumerate(cut):
        fit = tile.copy()
        fit.thumbnail((cell - 16, cell - 16))
        sheet_img.alpha_composite(fit, (i * cell + (cell - fit.width) // 2, 8))
        ImageDraw.Draw(sheet_img).text((i * cell + 6, cell + 20), name, fill=(255, 255, 255, 255))
    contact_dir = Path(__file__).resolve().parent / "backs"
    contact_dir.mkdir(exist_ok=True)
    sheet_img.save(contact_dir / "_contact-backs.png")
    print(f"wrote {len(cut)} backs to {out} and _contact-backs.png to {contact_dir}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(*sys.argv[1:])
