"""Rename the CLIP clusters using Claude's labels. Local, free, re-runnable.

cluster.py names each group from the fixed concept vocabulary, which is only as
good as the phrases I guessed in advance. Once labels.json exists there is a
better source: the tags Claude actually wrote for the posts in each cluster.

Naming uses lift (how much more common a tag is inside the cluster than across
the whole archive) rather than raw frequency, so a cluster does not end up
called "art" just because half the archive is art.
"""

import json
import os
import sys
from collections import Counter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MIN_IN_CLUSTER = 3          # ignore tags that barely appear in the cluster


def main():
    gp = os.path.join(ROOT, "graph.json")
    lp = os.path.join(ROOT, "labels.json")
    for p in (gp, lp):
        if not os.path.exists(p):
            print("missing %s" % os.path.basename(p))
            return 1

    with open(gp, encoding="utf-8") as f:
        graph = json.load(f)
    with open(lp, encoding="utf-8") as f:
        labels = json.load(f)

    members = {}
    overall = Counter()
    total = 0
    for n in graph["nodes"]:
        lab = labels.get(n["id"])
        if not lab:
            continue
        members.setdefault(n["c"], []).append(lab)
        overall.update(set(lab["tags"]))
        total += 1
    if not total:
        print("labels.json and graph.json share no posts")
        return 1

    for cluster in graph["clusters"]:
        mine = members.get(cluster["id"], [])
        if not mine:
            continue
        local = Counter()
        cats = Counter()
        for lab in mine:
            local.update(set(lab["tags"]))
            cats[lab["category"]] += 1

        scored = []
        for tag, c in local.items():
            if c < MIN_IN_CLUSTER:
                continue
            lift = (c / len(mine)) / ((overall[tag] + 1) / total)
            scored.append((lift * c ** 0.5, tag, c))
        scored.sort(reverse=True)

        if scored:
            cluster["name"] = scored[0][1]
            cluster["tags"] = [t for _, t, _ in scored[:5]]
        cluster["category"] = cats.most_common(1)[0][0]
        cluster["labelled"] = len(mine)
        print("  %-26s %4d  %s" % (cluster["name"], cluster["size"],
                                   ", ".join(cluster["tags"][1:])))

    with open(gp, "w", encoding="utf-8") as f:
        json.dump(graph, f, separators=(",", ":"))
    print("\nrewrote cluster names in graph.json")


if __name__ == "__main__":
    sys.exit(main())
