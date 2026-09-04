"""Turn CLIP vectors into the structure the viewer draws.

Produces, in graph.json:
  * a 2D t-SNE position per post, so related posts land near each other;
  * k-means clusters, each named from the concept vocabulary below;
  * up to TOP_K nearest neighbours per post as weighted edges - similarity is
    continuous, so a post that is both art *and* robots sits closer to, and
    links more strongly to, other art-robot posts than to plain art;
  * per-post concept tags for filtering ("show me art AND robots").

Concept scores are z-scored per concept across the whole archive before being
compared. Without that, broad concepts like "art" outscore specific ones on
every single post and the tags all come out identical.
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import numpy as np
import torch
import open_clip

from _algos import kmeans, pca, tsne

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODEL_NAME = "ViT-B-32"
PRETRAINED = "laion2b_s34b_b79k"

N_CLUSTERS = 24
TOP_K = 6              # neighbour candidates per post, before the edge cut
NN_K = 8               # neighbours kept per post for "more like this"
EDGE_PERCENTILE = 55   # keep the strongest edges above this percentile
TAGS_PER_POST = 4
TAG_Z_FLOOR = 0.8      # a tag must be this many SD above its own average

TEMPLATES = ["a photo of {}", "an image of {}", "{}"]

CONCEPTS = [
    # art & craft
    "digital art", "an oil painting", "a pencil sketch", "concept art",
    "pixel art", "a 3d render", "a blender render", "character design",
    "an anime illustration", "a comic panel", "graphic design", "typography",
    "a logo", "a poster design", "an abstract pattern", "generative art",
    "a sculpture", "ceramics and pottery", "textile and embroidery",
    "an architectural rendering", "interior design", "industrial design",
    "a user interface design", "a website layout", "a data visualization",
    # subjects
    "a robot", "a mech suit", "a spaceship", "a futuristic city", "a cyborg",
    "an alien creature", "a dragon", "a monster", "a fantasy landscape",
    "a castle", "a forest", "a mountain landscape", "the ocean", "a desert",
    "outer space", "a galaxy", "a planet", "the moon", "a nebula",
    "a cat", "a dog", "a bird", "an insect", "a fish", "a horse",
    "a wild animal", "a flower", "a tree", "a mushroom",
    "a portrait of a person", "a crowd of people", "a child", "a soldier",
    "an athlete", "a musician", "a dancer", "a chef cooking",
    # tech & science
    "a computer screen with code", "a terminal window", "a circuit board",
    "a server rack", "a smartphone", "a vintage computer", "a keyboard",
    "a scientific diagram", "a mathematical equation", "a chemistry lab",
    "a microscope image", "a medical scan", "an engineering blueprint",
    "a machine in a factory", "a 3d printer", "an electric vehicle",
    "a rocket launch", "a satellite", "a telescope image",
    "artificial intelligence", "a neural network diagram", "a video game screenshot",
    "a game development screenshot", "virtual reality",
    # vehicles & objects
    "a car", "a motorcycle", "an airplane", "a train", "a boat",
    "a weapon", "a tool", "a watch", "furniture", "a building",
    "food on a plate", "a drink", "clothing and fashion", "shoes",
    # internet culture
    "a meme", "a funny image", "a reaction image", "a screenshot of a tweet",
    "a screenshot of a chat conversation", "a text post", "a news headline",
    "an infographic", "a chart or graph", "a map", "a table of data",
    "a book cover", "a movie still", "a film poster", "a music album cover",
    "a sports photograph", "a historical photograph", "a black and white photo",
    "a documentary photograph", "a street photograph", "a nature photograph",
    "an aerial drone photograph", "a macro photograph", "a night photograph",
    # style / mood
    "a minimalist composition", "a highly detailed illustration",
    "a retro aesthetic", "a cyberpunk scene", "a solarpunk scene",
    "a horror scene", "a cozy scene", "a surreal image", "an optical illusion",
    "a physics simulation", "a mathematical visualization", "a fractal",
    "an animation frame", "a motion graphic", "a time lapse",
]


def encode_concepts(model, tokenizer):
    """One averaged, normalised vector per concept across the templates."""
    out = []
    for c in CONCEPTS:
        prompts = [t.format(c) for t in TEMPLATES]
        with torch.no_grad():
            f = model.encode_text(tokenizer(prompts))
            f = f / f.norm(dim=-1, keepdim=True)
            f = f.mean(dim=0)
            f = f / f.norm()
        out.append(f.numpy())
    return np.stack(out).astype(np.float32)


def short(concept):
    """Vocabulary phrases are prompt-shaped; tags should be short."""
    s = concept
    for prefix in ("a photo of ", "an image of ", "a ", "an ", "the "):
        if s.startswith(prefix):
            s = s[len(prefix):]
            break
    return s


def main():
    torch.set_num_threads(max(1, (os.cpu_count() or 8) - 1))
    vecs = np.load(os.path.join(ROOT, "embeddings.npy"))
    with open(os.path.join(ROOT, "embed_index.json"), encoding="utf-8") as f:
        index = json.load(f)
    with open(os.path.join(ROOT, "likes.json"), encoding="utf-8") as f:
        posts = json.load(f)

    usable = np.array(index["has_image"]) | np.array(index["has_text"])
    keep = np.where(usable)[0]
    V = vecs[keep]
    print("%d embedded posts of %d" % (len(keep), len(posts)))

    print("scoring %d concepts ..." % len(CONCEPTS), flush=True)
    model, _, _ = open_clip.create_model_and_transforms(
        MODEL_NAME, pretrained=PRETRAINED)
    tokenizer = open_clip.get_tokenizer(MODEL_NAME)
    model.eval()
    C = encode_concepts(model, tokenizer)

    S = V @ C.T                                   # posts x concepts
    Z = (S - S.mean(axis=0)) / (S.std(axis=0) + 1e-6)

    tags = []
    for row in Z:
        order = np.argsort(-row)[:TAGS_PER_POST]
        tags.append([[short(CONCEPTS[j]), round(float(row[j]), 2)]
                     for j in order if row[j] >= TAG_Z_FLOOR])

    print("clustering into %d groups ..." % N_CLUSTERS, flush=True)
    labels, _ = kmeans(V, N_CLUSTERS, restarts=6, seed=0)

    clusters = []
    for c in range(N_CLUSTERS):
        members = np.where(labels == c)[0]
        if len(members) == 0:
            clusters.append({"id": c, "name": "empty", "size": 0, "tags": []})
            continue
        mean_z = Z[members].mean(axis=0)
        top = np.argsort(-mean_z)[:4]
        names = [short(CONCEPTS[j]) for j in top]
        clusters.append({
            "id": c,
            "name": names[0],
            "tags": names,
            "size": int(len(members)),
        })
        print("  %-28s %4d  (%s)" % (names[0], len(members), ", ".join(names[1:])))

    print("laying out with t-SNE ...", flush=True)
    reduced = pca(V, 50)
    xy = tsne(reduced, perplexity=30.0, iters=750,
              log=lambda m: print(m, flush=True))
    xy = (xy - xy.mean(axis=0)) / (np.abs(xy).max() + 1e-9)   # roughly -1..1

    print("building the neighbour graph ...", flush=True)
    edges = []
    # Kept per post and never thresholded: the edge list below is pruned at a
    # percentile, so many posts keep no edges at all and would have nothing to
    # show under "more like this".
    neighbours = [[] for _ in range(len(V))]
    block = 512
    K = max(TOP_K, NN_K)
    for s in range(0, len(V), block):
        sim = V[s:s + block] @ V.T
        for r in range(sim.shape[0]):
            i = s + r
            sim[r, i] = -1.0
            cand = np.argpartition(-sim[r], K)[:K]
            cand = cand[np.argsort(-sim[r][cand])]          # strongest first
            neighbours[i] = [[int(j), round(float(sim[r, j]), 3)]
                             for j in cand[:NN_K]]
            for j in cand[:TOP_K]:
                if j > i:
                    edges.append((int(i), int(j), float(sim[r, j])))
                elif j < i:
                    edges.append((int(j), int(i), float(sim[r, j])))
    seen = {}
    for a, b, w in edges:
        k = (a, b)
        if w > seen.get(k, -1):
            seen[k] = w
    weights = np.array(list(seen.values()))
    cut = float(np.percentile(weights, EDGE_PERCENTILE))
    edges = [{"s": a, "t": b, "w": round(w, 3)}
             for (a, b), w in seen.items() if w >= cut]
    print("  %d candidate pairs -> %d edges (cut %.3f)" %
          (len(seen), len(edges), cut))

    nodes = []
    for n, i in enumerate(keep):
        p = posts[i]
        nodes.append({
            "i": n,
            "id": p["id"],
            "x": round(float(xy[n, 0]), 4),
            "y": round(float(xy[n, 1]), 4),
            "c": int(labels[n]),
            "tags": [t[0] for t in tags[n]],
            "nn": neighbours[n],
        })

    out = {
        "model": index["model"],
        "clusters": clusters,
        "nodes": nodes,
        "edges": edges,
        "unembedded": [posts[i]["id"] for i in range(len(posts)) if not usable[i]],
    }
    with open(os.path.join(ROOT, "graph.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, separators=(",", ":"))
    size = os.path.getsize(os.path.join(ROOT, "graph.json")) / 1e6
    print("\nwrote graph.json (%.1f MB)" % size)


if __name__ == "__main__":
    sys.exit(main())
