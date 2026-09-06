#!/usr/bin/env python3
"""Cut labelled avatar frames out of the generated frame sheet (issue #229 slice 3).

Usage: cut-frames.py <sheet.jpg> <out-dir>

The sheet is two rows of four cells, each a frame drawn around an empty cream
disc on the Lantern felt (#14532d), with a label under each; the page around
the cells came out white. Cells are found by the white gutters between them
(cells are the column and row runs that are not mostly white; the label
bands are white with grey text and so read as gutters). Each cell is cropped to the bounding box of its
non-green, non-white pixels, the felt and the page white are keyed to alpha, and the result is
quantised to 64 colours. The cream disc stays: it is the disc the avatar
emoji sits on, so a framed avatar reads as a badge (ui/index.html
`.avatar-glyph.framed`). Nothing is resampled here; the CSS fits the image
to the 44 px badge.

Names come from the brief's order (docs/design/cosmetics-prompts.md). The first
cell, frame-none, is the drawn default and is skipped. Point <out-dir> at
`data/frames/`, the path ui/src/frames.ts loads from; a contact sheet goes to
docs/design/frames/ next to this script.
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

FELT = np.array([0x14, 0x53, 0x2D], dtype=np.float32)
WHITE = np.array([255, 255, 255], dtype=np.float32)
NAMES = [
    ["frame-none", "frame-gold-ring", "frame-jade-square", "frame-vermilion-double"],
    ["frame-lantern", "frame-plum", "frame-wave", "frame-dragon"],
]


def runs(mask, gap):
    idx = np.flatnonzero(mask)
    out = []
    start = prev = idx[0]
    for i in idx[1:]:
        if i - prev > gap:
            out.append((int(start), int(prev + 1)))
            start = i
        prev = i
    out.append((int(start), int(prev + 1)))
    return out


def main(sheet, out_dir):
    img = Image.open(sheet).convert("RGB")
    rgb = np.asarray(img, dtype=np.float32)
    green = np.linalg.norm(rgb - FELT, axis=2) < 45
    white = np.linalg.norm(rgb - WHITE, axis=2) < 30
    # The page between cells is white; a cell is a run of columns (rows) that
    # are mostly not white. Label bands under each row are white with grey
    # text, so they read as gutters too.
    def cells(not_white, min_size):
        return [r for r in runs(not_white, 2) if r[1] - r[0] >= min_size]

    cols = cells(white.mean(axis=0) < 0.6, 100)
    rows = cells(white.mean(axis=1) < 0.6, 100)
    if len(cols) != 4 or len(rows) != 2:
        sys.exit(f"expected a 4 x 2 grid, found cols {cols} rows {rows}")
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    cut = []
    for (y0, y1), names in zip(rows, NAMES):
        for (x0, x1), name in zip(cols, names):
            if name == NAMES[0][0]:
                continue
            cell_green, cell_white = green[y0:y1, x0:x1], white[y0:y1, x0:x1]
            art = ~cell_green & ~cell_white
            ys, xs = np.flatnonzero(art.any(axis=1)), np.flatnonzero(art.any(axis=0))
            bx0, by0, bx1, by1 = x0 + xs[0], y0 + ys[0], x0 + xs[-1] + 1, y0 + ys[-1] + 1
            tile = img.crop((bx0, by0, bx1, by1)).convert("RGBA")
            px = np.asarray(tile, dtype=np.float32)[..., :3]
            # Key both grounds: the felt inside the cell and the page white a
            # non-circular frame (the jade square) leaves in its corners. The
            # white key is tight — the cream disc (#fdf6e3) is only ~30 from
            # white and must stay opaque.
            felt_alpha = np.clip((np.linalg.norm(px - FELT, axis=2) - 20) / 40, 0, 1)
            white_alpha = np.clip((np.linalg.norm(px - WHITE, axis=2) - 8) / 14, 0, 1)
            alpha = np.minimum(felt_alpha, white_alpha) * 255
            tile.putalpha(Image.fromarray(alpha.astype(np.uint8)))
            tile.quantize(64, method=Image.Quantize.FASTOCTREE).save(out / f"{name}.png", optimize=True)
            cut.append((name, tile))
            print(f"{name}.png: {tile.width}x{tile.height} at ({bx0},{by0})")
    cell = 160
    contact = Image.new("RGBA", (len(cut) * cell, cell + 40), (120, 120, 120, 255))
    for i, (name, tile) in enumerate(cut):
        fit = tile.copy()
        fit.thumbnail((cell - 16, cell - 16))
        contact.alpha_composite(fit, (i * cell + (cell - fit.width) // 2, 8))
        ImageDraw.Draw(contact).text((i * cell + 6, cell + 12), name, fill=(255, 255, 255, 255))
    contact_dir = Path(__file__).resolve().parent / "frames"
    contact_dir.mkdir(exist_ok=True)
    contact.save(contact_dir / "_contact-frames.png")
    print(f"wrote {len(cut)} frames to {out} and _contact-frames.png to {contact_dir}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(*sys.argv[1:])
