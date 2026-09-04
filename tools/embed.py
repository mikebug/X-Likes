"""Embed every liked post with CLIP so posts can be compared by content.

Images and text land in the same vector space, which is what makes "art" and
"art + robots" comparable at all: similarity is a number, not a tag match. For
a post with both a picture and a caption the two vectors are blended, weighted
toward the image because that is where the content actually is (the median
caption in this archive is 33 characters).

Writes embeddings.npy (float32, N x 512, L2-normalised) and embed_index.json.
"""

import json
import os
import re
import sys

import numpy as np
import torch
from PIL import Image

import open_clip

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MEDIA = os.path.join(ROOT, "media")
THUMBS = os.path.join(MEDIA, "thumbs")

MODEL_NAME = "ViT-B-32"
PRETRAINED = "laion2b_s34b_b79k"
BATCH = 64
IMAGE_WEIGHT = 0.75


def media_id(url):
    m = re.search(r"/media/([A-Za-z0-9_-]+)", url)
    return m.group(1) if m else None


def image_ext(url):
    m = re.search(r"[?&]format=(\w+)", url)
    if m:
        return m.group(1)
    m = re.search(r"/media/[A-Za-z0-9_-]+\.(\w+)", url)
    return m.group(1) if m else "jpg"


def picture_for(post):
    """Best on-disk still for a post: thumbnail first, full-res as fallback."""
    if post.get("video"):
        p = os.path.join(THUMBS, post["id"] + "_v.jpg")
        if os.path.exists(p):
            return p
        p = os.path.join(MEDIA, post["id"] + "_poster.jpg")
        return p if os.path.exists(p) else None
    imgs = post.get("images") or []
    if not imgs:
        return None
    mid = media_id(imgs[0])
    if not mid:
        return None
    p = os.path.join(THUMBS, "%s_%s.jpg" % (post["id"], mid))
    if os.path.exists(p):
        return p
    p = os.path.join(MEDIA, "%s_%s.%s" % (post["id"], mid, image_ext(imgs[0])))
    return p if os.path.exists(p) else None


def clean_text(post):
    t = (post.get("text") or "").strip()
    t = re.sub(r"https?://\S+", "", t)
    t = re.sub(r"\s+", " ", t).strip()
    return t


def main():
    torch.set_num_threads(max(1, (os.cpu_count() or 8) - 1))
    with open(os.path.join(ROOT, "likes.json"), encoding="utf-8") as f:
        posts = json.load(f)

    print("loading %s / %s ..." % (MODEL_NAME, PRETRAINED), flush=True)
    model, _, preprocess = open_clip.create_model_and_transforms(
        MODEL_NAME, pretrained=PRETRAINED)
    tokenizer = open_clip.get_tokenizer(MODEL_NAME)
    model.eval()

    dim = model.text_projection.shape[1] if hasattr(model, "text_projection") else 512
    vecs = np.zeros((len(posts), dim), dtype=np.float32)
    have_image = np.zeros(len(posts), dtype=bool)
    have_text = np.zeros(len(posts), dtype=bool)

    # ---- images ---------------------------------------------------------
    pending, pending_idx = [], []
    done = 0

    def flush_images():
        nonlocal done
        if not pending:
            return
        with torch.no_grad():
            feats = model.encode_image(torch.stack(pending))
            feats = feats / feats.norm(dim=-1, keepdim=True)
        for j, i in enumerate(pending_idx):
            vecs[i] = feats[j].numpy()
            have_image[i] = True
        done += len(pending)
        print("  images %d" % done, flush=True)
        pending.clear()
        pending_idx.clear()

    for i, p in enumerate(posts):
        path = picture_for(p)
        if not path:
            continue
        try:
            img = Image.open(path).convert("RGB")
        except Exception:
            continue
        pending.append(preprocess(img))
        pending_idx.append(i)
        if len(pending) >= BATCH:
            flush_images()
    flush_images()

    # ---- text -----------------------------------------------------------
    texts = [clean_text(p) for p in posts]
    idx = [i for i, t in enumerate(texts) if len(t) >= 8]
    print("encoding text for %d posts" % len(idx), flush=True)
    tvecs = np.zeros((len(posts), dim), dtype=np.float32)
    for s in range(0, len(idx), 256):
        chunk = idx[s:s + 256]
        with torch.no_grad():
            feats = model.encode_text(tokenizer([texts[i] for i in chunk]))
            feats = feats / feats.norm(dim=-1, keepdim=True)
        for j, i in enumerate(chunk):
            tvecs[i] = feats[j].numpy()
            have_text[i] = True

    # ---- blend ----------------------------------------------------------
    for i in range(len(posts)):
        if have_image[i] and have_text[i]:
            v = IMAGE_WEIGHT * vecs[i] + (1.0 - IMAGE_WEIGHT) * tvecs[i]
        elif have_image[i]:
            v = vecs[i]
        elif have_text[i]:
            v = tvecs[i]
        else:
            continue
        n = np.linalg.norm(v)
        vecs[i] = v / n if n else v

    usable = have_image | have_text
    np.save(os.path.join(ROOT, "embeddings.npy"), vecs)
    with open(os.path.join(ROOT, "embed_index.json"), "w", encoding="utf-8") as f:
        json.dump({
            "model": "%s/%s" % (MODEL_NAME, PRETRAINED),
            "dim": int(dim),
            "ids": [p["id"] for p in posts],
            "has_image": have_image.tolist(),
            "has_text": have_text.tolist(),
        }, f)

    print("\n%d posts embedded (%d from image, %d from text, %d unusable)" % (
        int(usable.sum()), int(have_image.sum()), int(have_text.sum()),
        int((~usable).sum())))


if __name__ == "__main__":
    sys.exit(main())
