"""Find blocks of coloured ink (handwritten notes, arrows) in an image and give their boxes.

  python -E -P ink_boxes.py <image> <preview.png> [--ink r,g,b ...] [--tol 60] [--gap 25] [--min 80]

Without --ink it looks for ink that is clearly red or clearly blue (not grey, not amber).
Pixels of the ink colour are grouped: two pixels belong to one block when they are within --gap
pixels (a dilation). Prints each block as pixels and as 0-1 fractions {x, y, w, h}, and draws the
boxes, numbered, on a copy of the image for a person to check. Needs Pillow and NumPy. Reads the
image only; writes only the preview.
"""
import argparse
import json

import numpy as np
from PIL import Image, ImageDraw, ImageFilter


def mask_for(a, ink, tol):
    if ink:
        m = np.zeros(a.shape[:2], bool)
        for c in ink:
            m |= np.abs(a - np.array(c)).max(axis=2) <= tol
        return m
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    red = (r > 120) & (r - g > 60) & (r - b > 50) & (g < 120)
    blue = (b > 90) & (b - r > 40) & (b - g > 20)
    return red | blue


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("image")
    ap.add_argument("preview")
    ap.add_argument("--ink", nargs="*", default=[])
    ap.add_argument("--tol", type=int, default=60)
    ap.add_argument("--gap", type=int, default=25)
    ap.add_argument("--min", type=int, default=80, help="smallest block, in ink pixels")
    ap.add_argument("--within", default="", help="x0,y0,x1,y1: look only inside this pixel box (e.g. the note text, without its arrow)")
    a = ap.parse_args()
    im = Image.open(a.image).convert("RGB")
    W, H = im.size
    arr = np.asarray(im).astype(int)
    ink = [tuple(int(v) for v in c.split(",")) for c in a.ink]
    m = mask_for(arr, ink, a.tol)
    if a.within:
        x0, y0, x1, y1 = (int(v) for v in a.within.split(","))
        keep = np.zeros_like(m)
        keep[y0:y1 + 1, x0:x1 + 1] = True
        m &= keep
    grown = Image.fromarray((m * 255).astype("uint8")).filter(ImageFilter.MaxFilter(2 * (a.gap // 2) + 1))
    g = np.asarray(grown) > 0
    # connected components on the grown mask (4-neighbour flood fill, iterative)
    lab = np.zeros(g.shape, int)
    n = 0
    blocks = []
    for y0, x0 in zip(*np.nonzero(g)):
        if lab[y0, x0]:
            continue
        n += 1
        stack = [(y0, x0)]
        lab[y0, x0] = n
        ys, xs = [], []
        while stack:
            y, x = stack.pop()
            ys.append(y)
            xs.append(x)
            for yy, xx in ((y + 1, x), (y - 1, x), (y, x + 1), (y, x - 1)):
                if 0 <= yy < H and 0 <= xx < W and g[yy, xx] and not lab[yy, xx]:
                    lab[yy, xx] = n
                    stack.append((yy, xx))
        ys, xs = np.array(ys), np.array(xs)
        inner = m[ys, xs]
        if inner.sum() < a.min:
            continue
        ys, xs = ys[inner], xs[inner]
        x1, y1, x2, y2 = int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())
        blocks.append({"px": [x1, y1, x2, y2], "ink_pixels": int(inner.sum()),
                       "region": {"x": round(x1 / W, 4), "y": round(y1 / H, 4),
                                  "w": round((x2 - x1 + 1) / W, 4), "h": round((y2 - y1 + 1) / H, 4)}})
    blocks.sort(key=lambda b: (b["px"][1], b["px"][0]))
    prev = im.copy()
    d = ImageDraw.Draw(prev)
    for i, b in enumerate(blocks, 1):
        b["n"] = i
        d.rectangle(b["px"], outline=(0, 160, 0), width=3)
        d.text((b["px"][0], max(0, b["px"][1] - 12)), str(i), fill=(0, 120, 0))
    prev.save(a.preview)
    print(json.dumps({"file": a.image, "size": [W, H], "blocks": blocks}, indent=1))


if __name__ == "__main__":
    main()
