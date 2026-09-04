"""Label every liked post with Claude vision, via the Batches API.

CLIP gives the map its geometry; this gives it words. Each post goes up as one
batch request carrying a 256px thumbnail plus whatever caption the tweet had,
and comes back as a category, a handful of topic tags, and a short caption.

Two passes:
  label       submit + collect  -> labels.json
  consolidate one extra call that merges synonymous tags into a canonical
              vocabulary        -> labels.json is rewritten with tags remapped

Batches run at 50% of standard pricing and usually finish well inside an hour.
The run is resumable: posts already present in labels.json are skipped.

Usage:
    python tools/label.py estimate                 # cost only, spends nothing
    python tools/label.py label --yes              # submit and wait
    python tools/label.py consolidate --yes
"""

import argparse
import base64
import io
import json
import os
import sys
import time

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from embed import picture_for, clean_text            # noqa: E402  (path set above)

LABELS = os.path.join(ROOT, "labels.json")
BATCH_STATE = os.path.join(ROOT, ".label_batches.json")

THUMB_PX = 256
# A ceiling, not a charge - output is billed by what is actually produced. Opus
# writes longer captions than Haiku and must never truncate mid-JSON.
MAX_TOKENS = 1024

# $ per million tokens, input / output, before the batch discount.
# output_config.effort exists only on the Opus/Sonnet 5 tier; Haiku 4.5 400s on it.
EFFORT_MODELS = {"claude-opus-5", "claude-sonnet-5"}

PRICING = {
    "claude-opus-5": (5.0, 25.0),
    "claude-sonnet-5": (2.0, 10.0),
    "claude-haiku-4-5": (1.0, 5.0),
}

CATEGORIES = [
    "art", "design", "photography", "3d", "animation", "games", "tech",
    "science", "engineering", "nature", "animals", "people", "humor",
    "music", "film", "food", "sports", "history", "politics", "other",
]

SYSTEM = (
    "You label posts from someone's personal archive of liked tweets so they "
    "can browse them by subject later.\n"
    "Judge the image first - most of these posts have little or no text, and "
    "the picture is the content. Use the caption only as supporting context.\n"
    "Tags must describe what the post is ABOUT, not how it looks: prefer "
    "'robotics', 'blender', 'brutalist-architecture' over 'blue', 'detailed', "
    "'high-quality'. Use lowercase, hyphenated, 1-3 words each.\n"
    "Give a post several tags when several genuinely apply - a robot rendered "
    "in Blender should carry both 'robotics' and '3d-render', because that is "
    "what makes it sit between those two groups.\n"
    "Give between 2 and 6 tags."
)

SCHEMA = {
    "type": "object",
    "properties": {
        "category": {"type": "string", "enum": CATEGORIES},
        # Structured outputs only accept minItems of 0 or 1, so the real
        # count ("2 to 6") is asked for in the system prompt instead.
        "tags": {
            "type": "array",
            "items": {"type": "string"},
            "minItems": 1,
        },
        "caption": {"type": "string"},
    },
    "required": ["category", "tags", "caption"],
    "additionalProperties": False,
}


def load_posts():
    with open(os.path.join(ROOT, "likes.json"), encoding="utf-8") as f:
        return json.load(f)


def load_labels():
    if os.path.exists(LABELS):
        with open(LABELS, encoding="utf-8") as f:
            return json.load(f)
    return {}


def save_labels(d):
    with open(LABELS, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False, indent=1)


def thumb_b64(post):
    """256px JPEG. Smaller images cost proportionally fewer input tokens."""
    path = picture_for(post)
    if not path:
        return None
    try:
        img = Image.open(path).convert("RGB")
    except Exception:
        return None
    img.thumbnail((THUMB_PX, THUMB_PX), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=80)
    return base64.standard_b64encode(buf.getvalue()).decode("ascii"), img.size


def output_config(model):
    cfg = {"format": {"type": "json_schema", "schema": SCHEMA}}
    if model in EFFORT_MODELS:
        cfg["effort"] = "low"
    return cfg


def message_params(post, model):
    """The body of one labelling request, shared by the smoke test and batch."""
    content = []
    got = thumb_b64(post)
    if got:
        b64, _ = got
        content.append({
            "type": "image",
            "source": {"type": "base64", "media_type": "image/jpeg", "data": b64},
        })
    text = clean_text(post)
    kind = "video" if post.get("video") else ("image" if post.get("images") else "text")
    prompt = "Post by @%s (%s post)." % (post.get("handle") or "unknown", kind)
    if kind == "video":
        prompt += " The image is a still frame from the video."
    prompt += "\nCaption: " + (text if text else "(none)")
    content.append({"type": "text", "text": prompt})

    return {
        "model": model,
        "max_tokens": MAX_TOKENS,
        "system": SYSTEM,
        "messages": [{"role": "user", "content": content}],
        "output_config": output_config(model),
    }


def build_request(post, Request, Params, model):
    return Request(custom_id=post["id"], params=Params(**message_params(post, model)))


def estimate(posts, model):
    """Token/cost projection from the actual bytes we would send."""
    sizes, texts = [], []
    sample = posts[:: max(1, len(posts) // 150)][:150]
    for p in sample:
        got = thumb_b64(p)
        if got:
            sizes.append(got[1])
        texts.append(len(clean_text(p)))
    if sizes:
        avg_px = sum(w * h for w, h in sizes) / len(sizes)
        img_tokens = avg_px / 750.0
    else:
        img_tokens = 0.0
    sys_tokens = len(SYSTEM) / 3.6 + 120          # schema + scaffolding
    txt_tokens = (sum(texts) / max(1, len(texts))) / 3.6 + 30
    per_in = img_tokens + sys_tokens + txt_tokens
    per_out = 80.0

    n = len(posts)
    print("%d posts to label" % n)
    print("  ~%d input tokens each (%d image + %d prompt), ~%d output"
          % (per_in, img_tokens, sys_tokens + txt_tokens, per_out))
    print("\n  %-18s %10s %10s" % ("model", "standard", "batched"))
    for m, (pi, po) in PRICING.items():
        cost = (n * per_in / 1e6) * pi + (n * per_out / 1e6) * po
        mark = " <- selected" if m == model else ""
        print("  %-18s %9.2f$ %9.2f$%s" % (m, cost, cost / 2, mark))
    print("\nBatched pricing applies; this script always uses the Batches API.")


def submit(posts, model, chunk=20000):
    import anthropic
    from anthropic.types.message_create_params import MessageCreateParamsNonStreaming as Params
    from anthropic.types.messages.batch_create_params import Request

    client = anthropic.Anthropic()
    ids = []
    for s in range(0, len(posts), chunk):
        batch_posts = posts[s:s + chunk]
        reqs = [build_request(p, Request, Params, model) for p in batch_posts]
        b = client.messages.batches.create(requests=reqs)
        ids.append(b.id)
        print("submitted %s  (%d requests)" % (b.id, len(reqs)))
    with open(BATCH_STATE, "w") as f:
        json.dump({"model": model, "batches": ids}, f)
    return client, ids


def collect(client, ids, labels):
    ok = err = 0
    for bid in ids:
        while True:
            b = client.messages.batches.retrieve(bid)
            if b.processing_status == "ended":
                break
            c = b.request_counts
            print("  %s %s - %d processing, %d done" %
                  (bid, b.processing_status, c.processing, c.succeeded), flush=True)
            time.sleep(30)

        for result in client.messages.batches.results(bid):
            if result.result.type != "succeeded":
                err += 1
                continue
            msg = result.result.message
            text = next((blk.text for blk in msg.content if blk.type == "text"), None)
            if not text:
                err += 1
                continue
            try:
                data = json.loads(text)
            except ValueError:
                err += 1
                continue
            labels[result.custom_id] = {
                "category": data.get("category", "other"),
                "tags": [t.strip().lower() for t in data.get("tags", []) if t.strip()],
                "caption": data.get("caption", ""),
            }
            ok += 1
        save_labels(labels)
        print("  %s collected (%d ok, %d failed so far)" % (bid, ok, err))
    return ok, err


def cmd_test(args):
    """One live request per media kind, to validate the shape before the batch."""
    import anthropic
    posts = load_posts()
    picks, want = [], ["images", "video"]
    for key in want:
        for p in posts:
            if p.get(key) and p not in picks:
                picks.append(p)
                break
    client = anthropic.Anthropic()
    for p in picks:
        resp = client.messages.create(**message_params(p, args.model))
        text = next((b.text for b in resp.content if b.type == "text"), "")
        print("@%-18s %s" % (p.get("handle"), text))
        print("   stop=%s  %d in / %d out tokens"
              % (resp.stop_reason, resp.usage.input_tokens, resp.usage.output_tokens))


def cmd_cancel(args):
    """Cancel whatever batch is recorded as in flight."""
    import anthropic
    if not os.path.exists(BATCH_STATE):
        print("no batch in flight")
        return
    with open(BATCH_STATE) as f:
        st = json.load(f)
    client = anthropic.Anthropic()
    for bid in st["batches"]:
        b = client.messages.batches.cancel(bid)
        r = b.request_counts
        print("%s -> %s (%d succeeded before cancel)" %
              (bid, b.processing_status, r.succeeded))
    os.remove(BATCH_STATE)


def cmd_label(args):
    posts = load_posts()
    labels = load_labels()
    todo = posts if args.force else [p for p in posts if p["id"] not in labels]
    if not todo:
        print("all %d posts already labelled" % len(posts))
        return
    estimate(todo, args.model)
    if not args.yes:
        print("\nnothing submitted. re-run with --yes to spend.")
        return
    client, ids = submit(todo, args.model)
    ok, err = collect(client, ids, labels)
    print("\nlabelled %d posts, %d failed -> labels.json" % (ok, err))


def cmd_resume(args):
    import anthropic
    if not os.path.exists(BATCH_STATE):
        print("no batch in flight")
        return
    with open(BATCH_STATE) as f:
        st = json.load(f)
    labels = load_labels()
    ok, err = collect(anthropic.Anthropic(), st["batches"], labels)
    print("\ncollected %d, failed %d" % (ok, err))


def cmd_consolidate(args):
    """One call that folds near-duplicate tags into a canonical vocabulary."""
    import anthropic
    labels = load_labels()
    if not labels:
        print("run `label` first")
        return
    counts = {}
    for v in labels.values():
        for t in v["tags"]:
            counts[t] = counts.get(t, 0) + 1
    ordered = sorted(counts.items(), key=lambda kv: -kv[1])
    print("%d distinct tags across %d posts" % (len(ordered), len(labels)))
    if not args.yes:
        print("re-run with --yes to spend (one request, a few cents).")
        return

    listing = "\n".join("%s (%d)" % (t, c) for t, c in ordered)
    client = anthropic.Anthropic()
    resp = client.messages.create(
        model=args.model,
        max_tokens=16000,
        system=("You tidy a tag vocabulary produced by labelling images one at "
                "a time. Merge synonyms, plurals and near-duplicates onto a "
                "single canonical tag; keep distinctions that a person "
                "browsing their own archive would actually want to filter on. "
                "Never merge two tags that describe different subjects."),
        messages=[{"role": "user", "content":
                   "Tags with their post counts:\n\n" + listing +
                   "\n\nReturn a mapping from every tag above to its canonical "
                   "form. A tag that needs no change maps to itself."}],
        output_config={"format": {"type": "json_schema", "schema": {
            "type": "object",
            "properties": {"mapping": {
                "type": "object",
                "additionalProperties": {"type": "string"},
            }},
            "required": ["mapping"],
            "additionalProperties": False,
        }}},
    )
    text = next(b.text for b in resp.content if b.type == "text")
    mapping = json.loads(text)["mapping"]

    merged = 0
    for v in labels.values():
        out = []
        for t in v["tags"]:
            c = mapping.get(t, t)
            if c != t:
                merged += 1
            if c not in out:
                out.append(c)
        v["tags"] = out
    save_labels(labels)
    after = len({t for v in labels.values() for t in v["tags"]})
    print("rewrote %d tag uses; vocabulary %d -> %d" %
          (merged, len(ordered), after))


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("command",
                    choices=["estimate", "test", "label", "resume", "cancel",
                             "consolidate"])
    ap.add_argument("--model", default="claude-opus-5", choices=sorted(PRICING))
    ap.add_argument("--yes", action="store_true", help="actually spend money")
    ap.add_argument("--force", action="store_true",
                    help="relabel posts that already have labels")
    args = ap.parse_args()

    if args.command == "estimate":
        posts = load_posts()
        labels = load_labels()
        estimate([p for p in posts if p["id"] not in labels], args.model)
    elif args.command == "test":
        cmd_test(args)
    elif args.command == "label":
        cmd_label(args)
    elif args.command == "resume":
        cmd_resume(args)
    elif args.command == "cancel":
        cmd_cancel(args)
    else:
        cmd_consolidate(args)


if __name__ == "__main__":
    sys.exit(main())
