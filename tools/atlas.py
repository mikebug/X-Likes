"""Pack every thumbnail into one texture atlas for the WebGL map.

The GPU cannot hold 3,325 separate textures, and the browser should not make
3,325 requests to draw one screen. A single 4096x4096 sheet of 64px tiles holds
4,096 posts, so the whole archive is one texture, one draw call, and one file.

64px is deliberately small: on the map a post is usually 10-40px across, and
anything larger is served by the full thumbnail loaded on demand. What matters
here is that *everything* can be on screen at once.

Writes media/atlas/atlas0.jpg and media/atlas/atlas.json.
"""

import json
import os
import sys

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
THUMBS = os.path.join(ROOT, "media", "thumbs")
OUT = os.path.join(ROOT, "media", "atlas")

TILE = 64
SHEET = 4096
COLS = SHEET // TILE            # 64 tiles across
PER_SHEET = COLS * COLS         # 4096 tiles per sheet


def square(img):
    """Centre-crop to a square before scaling: the map draws circles, so the
    edges of a wide image are never visible anyway."""
    w, h = img.size
    side = min(w, h)
    left = (w - side) // 2
    top = (h - side) // 2
    return img.crop((left, top, left + side, top + side)) \
              .resize((TILE, TILE), Image.LANCZOS)


def main():
    if not os.path.isdir(THUMBS):
        print("no media/thumbs - run tools/fetch_thumbs.py first")
        return 1
    os.makedirs(OUT, exist_ok=True)

    names = sorted(n for n in os.listdir(THUMBS) if n.endswith(".jpg"))
    print("%d thumbnails -> %d tile(s) of %dpx" %
          (len(names), len(names), TILE))

    index = {}
    sheets = []
    sheet = None
    written = 0

    for i, name in enumerate(names):
        slot = i % PER_SHEET
        if slot == 0:
            if sheet is not None:
                sheets.append(save(sheet, len(sheets)))
            sheet = Image.new("RGB", (SHEET, SHEET), (14, 18, 26))
        try:
            with Image.open(os.path.join(THUMBS, name)) as im:
                tile = square(im.convert("RGB"))
        except Exception:
            continue
        col, row = slot % COLS, slot // COLS
        sheet.paste(tile, (col * TILE, row * TILE))
        index[name.split("_", 1)[0]] = [len(sheets), col, row]
        written += 1
        if written % 500 == 0:
            print("  packed %d" % written, flush=True)

    if sheet is not None:
        sheets.append(save(sheet, len(sheets)))

    meta = {"tile": TILE, "sheet": SHEET, "cols": COLS,
            "sheets": sheets, "index": index}
    with open(os.path.join(OUT, "atlas.json"), "w") as f:
        json.dump(meta, f, separators=(",", ":"))

    total = sum(os.path.getsize(os.path.join(OUT, s)) for s in sheets)
    print("\npacked %d posts into %d sheet(s), %.1f MB total" %
          (written, len(sheets), total / 1e6))


def save(sheet, n):
    name = "atlas%d.jpg" % n
    sheet.save(os.path.join(OUT, name), format="JPEG", quality=88,
               optimize=True, subsampling=1)
    return name


if __name__ == "__main__":
    sys.exit(main())
