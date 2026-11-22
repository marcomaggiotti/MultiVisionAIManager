"""Similarity, zero-shot classification, prompt sensitivity, embedding geometry."""

from __future__ import annotations

import numpy as np

from app.engine import Encoder, normalize


def softmax(x: np.ndarray, axis: int = -1) -> np.ndarray:
    z = x - x.max(axis=axis, keepdims=True)
    e = np.exp(z)
    return e / e.sum(axis=axis, keepdims=True)


def sigmoid(x: np.ndarray) -> np.ndarray:
    return 1 / (1 + np.exp(-x))


def scale_for(encoder: Encoder, temperature: float | None) -> float:
    """Logit scale = 1 / temperature. Defaults to the model's learned value."""
    return encoder.logit_scale if not temperature else 1.0 / temperature


def similarity(encoder: Encoder, image_emb: np.ndarray, texts: list[str], temperature: float | None) -> dict:
    text_emb = encoder.embed_texts(texts)
    cos = image_emb @ text_emb.T
    scale = scale_for(encoder, temperature)
    logits = cos * scale
    return {
        "texts": texts,
        "cosine": cos.round(4).tolist(),
        "logit_scale": round(scale, 3),
        "temperature": round(1 / scale, 5),
        # For each image: which text fits best (image -> text retrieval).
        "image_to_text": softmax(logits, axis=1).round(4).tolist(),
        # For each text: which image fits best (text -> image retrieval).
        "text_to_image": softmax(logits, axis=0).T.round(4).tolist(),
    }


def label_embeddings(
    encoder: Encoder, labels: list[str], templates: list[str], descriptions: dict | None = None
) -> np.ndarray:
    """Embeddings of every (template, label) prompt: shape (T, L, d)."""
    names = [(descriptions or {}).get(label, label) for label in labels]
    prompts = [t.format(n) if "{}" in t else f"{t} {n}" for t in templates for n in names]
    embeddings = encoder.embed_texts(prompts)
    return embeddings.reshape(len(templates), len(labels), -1)


def zero_shot(
    encoder: Encoder,
    image_emb: np.ndarray,
    labels: list[str],
    templates: list[str],
    *,
    temperature: float | None = None,
    mode: str = "auto",
    descriptions: dict | None = None,
) -> dict:
    """Zero-shot classification with prompt ensembling (mean of the template
    embeddings, re-normalised) plus a per-template prompt-sensitivity report."""
    templates = templates or ["{}"]
    per_template = label_embeddings(encoder, labels, templates, descriptions)  # (T, L, d)
    ensemble = normalize(per_template.mean(axis=0))  # (L, d)
    scale = scale_for(encoder, temperature)
    if mode == "auto":
        mode = "sigmoid" if encoder.family == "siglip" else "softmax"

    def probs(cos: np.ndarray) -> np.ndarray:
        logits = cos * scale
        if mode == "sigmoid":
            return sigmoid(logits + encoder.logit_bias)
        return softmax(logits, axis=-1)

    cos_ens = image_emb @ ensemble.T  # (N, L)
    p_ens = probs(cos_ens)
    cos_t = np.einsum("nd,tld->ntl", image_emb, per_template)  # (N, T, L)
    p_t = probs(cos_t)

    results = []
    for i in range(len(image_emb)):
        order = np.argsort(-p_ens[i])
        top = int(order[0])
        tops = p_t[i].argmax(axis=-1)
        results.append(
            {
                "ranking": [
                    {"label": labels[j], "probability": round(float(p_ens[i, j]), 4),
                     "cosine": round(float(cos_ens[i, j]), 4)}
                    for j in order
                ],
                "top": labels[top],
                "sensitivity": {
                    # Share of templates that agree with the ensemble's answer.
                    "agreement": round(float((tops == top).mean()), 3),
                    # Spread of the top label's probability across templates.
                    "top_probability_std": round(float(p_t[i, :, top].std()), 4),
                    "per_template": [
                        {"template": templates[k], "top": labels[int(tops[k])],
                         "probability": round(float(p_t[i, k, tops[k]]), 4),
                         "probabilities": p_t[i, k].round(4).tolist()}
                        for k in range(len(templates))
                    ],
                },
            }
        )  # fmt: skip
    return {
        "labels": labels,
        "templates": templates,
        "mode": mode,
        "logit_scale": round(scale, 3),
        "results": results,
    }


def projection(image_emb: np.ndarray, text_emb: np.ndarray, method: str = "pca") -> dict:
    """2-D map of both modalities, plus the "modality gap" between them.

    CLIP's image and text embeddings occupy two separate cones of the sphere
    (Liang et al., 2022): matching pairs are close *relative* to others, but
    every image is closer to every other image than to any text.
    """
    both = np.concatenate([image_emb, text_emb]) if len(text_emb) else image_emb
    if len(both) < 2:
        return {"images": [], "texts": [], "explained_variance": [], "modality_gap": None}
    centred = both - both.mean(axis=0)
    _, s, vt = np.linalg.svd(centred, full_matrices=False)
    coords = centred @ vt[:2].T
    var = (s**2) / max(1e-12, (s**2).sum())
    img_c, txt_c = coords[: len(image_emb)], coords[len(image_emb) :]
    gap = None
    if len(image_emb) and len(text_emb):
        gap = {
            "centroid_distance": round(float(np.linalg.norm(image_emb.mean(0) - text_emb.mean(0))), 4),
            "mean_image_image_cosine": round(float(_mean_off_diagonal(image_emb @ image_emb.T)), 4),
            "mean_text_text_cosine": round(float(_mean_off_diagonal(text_emb @ text_emb.T)), 4),
            "mean_image_text_cosine": round(float((image_emb @ text_emb.T).mean()), 4),
        }
    return {
        "images": img_c.round(4).tolist(),
        "texts": txt_c.round(4).tolist(),
        "explained_variance": var[:2].round(4).tolist(),
        "modality_gap": gap,
    }


def _mean_off_diagonal(matrix: np.ndarray) -> float:
    """Mean similarity between different items (the diagonal is each item with itself)."""
    size = len(matrix)
    if size < 2:
        return float("nan")
    return (matrix.sum() - np.trace(matrix)) / (size * size - size)
