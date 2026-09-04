"""Download a small thumbnail for every post in likes.json.

X's CDN already serves resized variants, so this needs no image library and no
ffmpeg: still images come from `?name=small`, and videos come from the poster
URL the scraper recorded. Output is media/thumbs/<postid>_<mediaid>.jpg for
images and media/thumbs/<postid>_v.jpg for videos, which is what the viewer and
the embedding pass both read.
"""

import json
import os
import re
import sys
import threading
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
THUMBS = os.path.join(ROOT, "media", "thumbs")
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " \
     "(KHTML, like Gecko) Chrome/126.0 Safari/537.36"

lock = threading.Lock()
counts = {"ok": 0, "skip": 0, "fail": 0}
failures = []


def media_id(url):
    m = re.search(r"/media/([A-Za-z0-9_-]+)", url)
    return m.group(1) if m else None


def image_ext(url):
    m = re.search(r"[?&]format=(\w+)", url)
    if m:
        return m.group(1)
    m = re.search(r"/media/[A-Za-z0-9_-]+\.(\w+)", url)
    return m.group(1) if m else "jpg"


def targets(post):
    """(destination filename, [candidate urls]) for one post, or None."""
    if post.get("video"):
        poster = (post["video"] or {}).get("poster")
        if not poster:
            return None
        base = poster.split("?")[0]
        return post["id"] + "_v.jpg", [base + "?format=jpg&name=small",
                                       base + ":small",
                                       base]
    imgs = post.get("images") or []
    if not imgs:
        return None
    mid = media_id(imgs[0])
    if not mid:
        return None
    ext = image_ext(imgs[0])
    stem = "https://pbs.twimg.com/media/" + mid
    return "%s_%s.jpg" % (post["id"], mid), [
        stem + "?format=%s&name=small" % ext,
        stem + "?format=jpg&name=small",
        stem + "." + ext + ":small",
    ]


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA,
                                               "Referer": "https://x.com/"})
    with urllib.request.urlopen(req, timeout=25) as r:
        return r.read()


def fetch(post):
    t = targets(post)
    if not t:
        return
    name, urls = t
    dest = os.path.join(THUMBS, name)
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        with lock:
            counts["skip"] += 1
        return
    for url in urls:
        try:
            data = get(url)
        except (urllib.error.URLError, OSError):
            continue
        if len(data) < 512:          # error placeholder, not a real image
            continue
        tmp = dest + ".part"
        with open(tmp, "wb") as f:
            f.write(data)
        os.replace(tmp, dest)
        with lock:
            counts["ok"] += 1
            done = counts["ok"] + counts["skip"] + counts["fail"]
            if done % 200 == 0:
                print("  %d ok / %d skipped / %d failed" %
                      (counts["ok"], counts["skip"], counts["fail"]), flush=True)
        return
    with lock:
        counts["fail"] += 1
        failures.append(post["id"])


def main():
    os.makedirs(THUMBS, exist_ok=True)
    with open(os.path.join(ROOT, "likes.json"), encoding="utf-8") as f:
        posts = json.load(f)
    wanted = [p for p in posts if targets(p)]
    print("%d posts, %d with fetchable media" % (len(posts), len(wanted)))

    with ThreadPoolExecutor(max_workers=16) as pool:
        list(pool.map(fetch, wanted))

    print("\ndownloaded %d, already had %d, failed %d" %
          (counts["ok"], counts["skip"], counts["fail"]))
    if failures:
        with open(os.path.join(THUMBS, "failed.txt"), "w") as f:
            f.write("\n".join(failures))
        print("failed ids written to media/thumbs/failed.txt")
    write_dims()

    # Marker the viewer probes to decide whether thumbs/ is usable.
    with open(os.path.join(THUMBS, ".ok"), "w") as f:
        f.write("ok\n")


def write_dims():
    """Record each thumbnail's pixel size, keyed by post id.

    The grid reserves the exact aspect ratio before an image arrives, which is
    the whole cause of its layout shift. Reads what is on disk rather than what
    was just downloaded, so a partial re-run still produces a complete file.
    """
    try:
        from PIL import Image
    except ImportError:
        print("Pillow not installed - skipping dims.json "
              "(the grid will fall back to square placeholders)")
        return
    dims = {}
    for name in os.listdir(THUMBS):
        if not name.endswith(".jpg"):
            continue
        post_id = name.split("_", 1)[0]
        try:
            with Image.open(os.path.join(THUMBS, name)) as im:
                dims[post_id] = list(im.size)
        except Exception:
            continue
    with open(os.path.join(THUMBS, "dims.json"), "w") as f:
        json.dump(dims, f, separators=(",", ":"))
    print("wrote dims.json for %d thumbnails" % len(dims))


if __name__ == "__main__":
    sys.exit(main())
