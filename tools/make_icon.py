"""Render icon.ico from the same design as likes-viewer/favicon.svg.

A .lnk shortcut cannot use an SVG, so the app icon is generated here instead of
being committed as an opaque binary. Drawn at 8x and downsampled, which is the
cheapest way to get antialiased circles out of PIL.

    python tools/make_icon.py
"""

import os

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "icon.ico")

S = 8                      # supersampling factor
BASE = 64                  # the favicon.svg viewBox
BG = (10, 14, 20, 255)
EDGE = (43, 58, 82, 255)

# (cx, cy, r, colour) - matches favicon.svg
DOTS = [
    (21, 21, 8.5, (110, 168, 254, 255)),
    (43, 27, 6.0, (102, 217, 160, 255)),
    (25, 42, 7.0, (225, 115, 196, 255)),
    (45, 45, 5.0, (227, 196, 113, 255)),
]
LINKS = [(0, 1), (0, 2), (1, 3), (2, 3)]


def render(px):
    n = px * S
    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    k = n / BASE

    radius = int(14 * k)
    d.rounded_rectangle([0, 0, n - 1, n - 1], radius=radius, fill=BG)

    for a, b in LINKS:
        d.line([DOTS[a][0] * k, DOTS[a][1] * k, DOTS[b][0] * k, DOTS[b][1] * k],
               fill=EDGE, width=max(1, int(1.5 * k)))

    for cx, cy, r, colour in DOTS:
        d.ellipse([(cx - r) * k, (cy - r) * k, (cx + r) * k, (cy + r) * k],
                  fill=colour)

    return img.resize((px, px), Image.LANCZOS)


def main():
    sizes = [256, 128, 64, 48, 32, 16]
    frames = [render(s) for s in sizes]
    frames[0].save(OUT, format="ICO",
                   sizes=[(s, s) for s in sizes], append_images=frames[1:])
    print("wrote %s (%d sizes, %.1f KB)"
          % (OUT, len(sizes), os.path.getsize(OUT) / 1024))


if __name__ == "__main__":
    main()
