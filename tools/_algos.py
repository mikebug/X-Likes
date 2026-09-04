"""PCA, k-means and t-SNE on top of torch.

scikit-learn's compiled extensions are blocked by this machine's Application
Control policy, so the three things cluster.py needs are implemented here
against torch, whose DLLs do load. All of them run comfortably on CPU at the
~3.5k x 512 scale of this archive.
"""

import numpy as np
import torch


def pca(X, n_components, seed=0):
    """Project X onto its leading principal components."""
    t = torch.from_numpy(np.ascontiguousarray(X, dtype=np.float32))
    t = t - t.mean(dim=0, keepdim=True)
    q = min(n_components, min(t.shape) - 1)
    torch.manual_seed(seed)
    U, S, V = torch.pca_lowrank(t, q=q, niter=4)
    return (t @ V[:, :n_components]).numpy()


def kmeans(X, k, iters=120, restarts=6, seed=0):
    """Lloyd's algorithm with k-means++ seeding; returns (labels, centroids)."""
    t = torch.from_numpy(np.ascontiguousarray(X, dtype=np.float32))
    n = t.shape[0]
    g = torch.Generator().manual_seed(seed)
    best = None

    for r in range(restarts):
        centers = _kmeanspp(t, k, g)
        labels = None
        for _ in range(iters):
            d = torch.cdist(t, centers)
            new_labels = d.argmin(dim=1)
            if labels is not None and torch.equal(new_labels, labels):
                break
            labels = new_labels
            for c in range(k):
                members = t[labels == c]
                if len(members):
                    centers[c] = members.mean(dim=0)
                else:
                    centers[c] = t[torch.randint(n, (1,), generator=g)].squeeze(0)
        inertia = torch.cdist(t, centers).min(dim=1).values.pow(2).sum().item()
        if best is None or inertia < best[0]:
            best = (inertia, labels.numpy().copy(), centers.numpy().copy())
    return best[1], best[2]


def _kmeanspp(t, k, g):
    n = t.shape[0]
    idx = torch.randint(n, (1,), generator=g).item()
    centers = [t[idx]]
    d2 = torch.cdist(t, centers[0].unsqueeze(0)).squeeze(1).pow(2)
    for _ in range(1, k):
        probs = d2 / (d2.sum() + 1e-12)
        idx = torch.multinomial(probs, 1, generator=g).item()
        centers.append(t[idx])
        d2 = torch.minimum(d2, torch.cdist(t, centers[-1].unsqueeze(0)).squeeze(1).pow(2))
    return torch.stack(centers)


def _joint_probabilities(D, perplexity, tol=1e-5, steps=60):
    """Per-point Gaussian bandwidths matched to the target perplexity."""
    n = D.shape[0]
    P = torch.zeros_like(D)
    target = float(np.log(perplexity))
    for i in range(n):
        row = torch.cat([D[i, :i], D[i, i + 1:]])
        lo, hi = 0.0, float("inf")
        beta = 1.0
        for _ in range(steps):
            p = torch.exp(-row * beta)
            s = p.sum()
            if s <= 0:
                entropy, p_norm = 0.0, p
            else:
                p_norm = p / s
                entropy = float(torch.log(s) + beta * (row * p).sum() / s)
            if abs(entropy - target) < tol:
                break
            if entropy > target:
                lo = beta
                beta = beta * 2 if hi == float("inf") else (beta + hi) / 2
            else:
                hi = beta
                beta = beta / 2 if lo == 0.0 else (beta + lo) / 2
        P[i, :i] = p_norm[:i]
        P[i, i + 1:] = p_norm[i:]
    P = (P + P.t()) / (2 * n)
    return P.clamp_min(1e-12)


def tsne(X, perplexity=30.0, iters=750, lr=200.0, seed=0, log=None):
    """Barnes-Hut-free t-SNE. Exact O(N^2) is fine for a few thousand points."""
    t = torch.from_numpy(np.ascontiguousarray(X, dtype=np.float32))
    n = t.shape[0]
    D = torch.cdist(t, t).pow(2)
    P = _joint_probabilities(D, perplexity)

    torch.manual_seed(seed)
    Y = torch.randn(n, 2) * 1e-4
    dY = torch.zeros_like(Y)
    gains = torch.ones_like(Y)
    exaggeration, momentum = 12.0, 0.5

    for it in range(iters):
        if it == 250:
            exaggeration, momentum = 1.0, 0.8
        num = 1.0 / (1.0 + torch.cdist(Y, Y).pow(2))
        num.fill_diagonal_(0.0)
        Q = (num / num.sum()).clamp_min(1e-12)
        W = (P * exaggeration - Q) * num
        grad = 4.0 * ((torch.diag(W.sum(dim=1)) - W) @ Y)

        gains = torch.where((grad > 0) != (dY > 0), gains + 0.2, gains * 0.8)
        gains.clamp_min_(0.01)
        dY = momentum * dY - lr * gains * grad
        Y = Y + dY
        Y = Y - Y.mean(dim=0, keepdim=True)

        if log and (it + 1) % 100 == 0:
            kl = float((P * (P / Q).log()).sum())
            log("  t-SNE %d/%d  KL %.4f" % (it + 1, iters, kl))
    return Y.numpy()
