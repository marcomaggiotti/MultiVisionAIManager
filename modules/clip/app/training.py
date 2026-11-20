"""Adapting CLIP to a domain (e.g. classical ballet).

* **Linear probe** - the encoders stay frozen; a softmax classifier is
  trained on the image embeddings. Cheap, robust, needs few examples, and is
  the standard way to measure how good a representation is.
* **Contrastive fine-tuning** - some encoder layers are updated with the
  CLIP objective on (image, text) pairs from your data, so the embedding space
  itself moves towards your domain (domain adaptation). Options: which layers
  to unfreeze, a fixed or learnable temperature, and hard-negative weighting
  (Robinson et al., 2021): negatives that are close to the anchor - e.g.
  "attitude" for an "arabesque" - weigh more in the loss.
"""

from __future__ import annotations

import copy
import json
import math
import random
from collections import Counter
from pathlib import Path

import numpy as np

from app.analysis import label_embeddings
from app.engine import HFEncoder, normalize
from app.jobs import Job


def stratified_split(labels: list[str], val_fraction: float, seed: int) -> tuple[list, list]:
    by_label: dict[str, list[int]] = {}
    for i, label in enumerate(labels):
        by_label.setdefault(label, []).append(i)
    rng = random.Random(seed)
    train, val = [], []
    for idx in by_label.values():
        rng.shuffle(idx)
        n_val = int(round(len(idx) * val_fraction)) if len(idx) > 1 else 0
        val += idx[:n_val]
        train += idx[n_val:]
    return sorted(train), sorted(val)


def confusion(y_true: list[int], y_pred: list[int], n: int) -> list[list[int]]:
    m = [[0] * n for _ in range(n)]
    for t, p in zip(y_true, y_pred, strict=True):
        m[t][p] += 1
    return m


def accuracy(y_true, y_pred) -> float | None:
    return round(sum(int(a == b) for a, b in zip(y_true, y_pred, strict=True)) / len(y_true), 4) if y_true else None


def zero_shot_predictions(encoder, emb: np.ndarray, classes: list[str], templates: list[str], descriptions=None):
    text = normalize(label_embeddings(encoder, classes, templates, descriptions).mean(axis=0))
    return (emb @ text.T).argmax(axis=1).tolist()


# --- linear probe -----------------------------------------------------------
def train_linear_probe(job: Job, encoder, items: list[dict], emb: np.ndarray, cfg: dict, out: Path) -> dict:
    import torch

    labelled = [(i, it["label"]) for i, it in enumerate(items) if it.get("label")]
    if len(labelled) < 4:
        raise ValueError("a linear probe needs at least 4 labelled images")
    classes = sorted({label for _, label in labelled})
    if len(classes) < 2:
        raise ValueError("a linear probe needs at least 2 classes")
    X = emb[[i for i, _ in labelled]].astype(np.float32)
    y = [classes.index(label) for _, label in labelled]
    train_idx, val_idx = stratified_split([classes[c] for c in y], cfg.get("val_fraction", 0.25), cfg.get("seed", 0))
    job.log(f"{len(classes)} classes, {len(train_idx)} train / {len(val_idx)} val images")

    Xt = torch.tensor(X[train_idx])
    yt = torch.tensor([y[i] for i in train_idx])
    head = torch.nn.Linear(X.shape[1], len(classes))
    counts = Counter(yt.tolist())
    weight = None
    if cfg.get("balanced", True):  # class imbalance: inverse-frequency weights
        weight = torch.tensor([len(yt) / (len(classes) * max(1, counts.get(c, 0))) for c in range(len(classes))])
    opt = torch.optim.AdamW(head.parameters(), lr=cfg.get("lr", 1e-2), weight_decay=cfg.get("weight_decay", 1e-3))
    loss_fn = torch.nn.CrossEntropyLoss(weight=weight, label_smoothing=cfg.get("label_smoothing", 0.0))
    epochs = int(cfg.get("epochs", 200))
    Xv = torch.tensor(X[val_idx]) if val_idx else None
    for epoch in range(1, epochs + 1):
        head.train()
        opt.zero_grad()
        loss = loss_fn(head(Xt * cfg.get("feature_scale", 10.0)), yt)
        loss.backward()
        opt.step()
        if epoch % max(1, epochs // 50) == 0 or epoch == epochs:
            with torch.no_grad():
                train_acc = (head(Xt * cfg.get("feature_scale", 10.0)).argmax(1) == yt).float().mean().item()
                val_acc = None
                if Xv is not None:
                    pv = head(Xv * cfg.get("feature_scale", 10.0)).argmax(1).tolist()
                    val_acc = accuracy([y[i] for i in val_idx], pv)
            job.report(epoch=epoch, epochs=epochs, loss=round(loss.item(), 5),
                       train_accuracy=round(train_acc, 4), val_accuracy=val_acc)  # fmt: skip

    with torch.no_grad():
        pred_val = head(Xv * cfg.get("feature_scale", 10.0)).argmax(1).tolist() if Xv is not None else []
    y_val = [y[i] for i in val_idx]
    templates = cfg.get("templates") or ["a photo of a ballet dancer doing a {}."]
    zs = zero_shot_predictions(encoder, X[val_idx], classes, templates) if val_idx else []

    out.mkdir(parents=True, exist_ok=True)
    np.savez(
        out / "probe.npz",
        weight=head.weight.detach().numpy(), bias=head.bias.detach().numpy(),
        classes=np.array(classes), scale=np.array(cfg.get("feature_scale", 10.0)),
        model=np.array(encoder.model_id),
    )  # fmt: skip
    return {
        "probe": out.name,
        "classes": classes,
        "train_images": len(train_idx),
        "val_images": len(val_idx),
        "val_accuracy": accuracy(y_val, pred_val),
        "zero_shot_val_accuracy": accuracy(y_val, zs),
        "confusion": confusion(y_val, pred_val, len(classes)),
        "zero_shot_confusion": confusion(y_val, zs, len(classes)),
        "class_counts": {classes[c]: n for c, n in sorted(counts.items())},
    }


def load_probe(path: Path) -> dict:
    data = np.load(path / "probe.npz", allow_pickle=False)
    return {k: data[k] for k in data.files}


def apply_probe(probe: dict, emb: np.ndarray) -> list[list[tuple[str, float]]]:
    logits = (emb * float(probe["scale"])) @ probe["weight"].T + probe["bias"]
    logits -= logits.max(axis=1, keepdims=True)
    p = np.exp(logits)
    p /= p.sum(axis=1, keepdims=True)
    classes = [str(c) for c in probe["classes"]]
    return [sorted(zip(classes, row.round(4).tolist(), strict=True), key=lambda x: -x[1]) for row in p]


# --- contrastive fine-tuning ---------------------------------------------------
def set_trainable(model, strategy: str, last_n: int, learn_temperature: bool) -> int:
    for p in model.parameters():
        p.requires_grad = False
    modules = []
    for name in ("visual_projection", "text_projection"):
        if getattr(model, name, None) is not None:
            modules.append(getattr(model, name))
    vision, text = getattr(model, "vision_model", None), getattr(model, "text_model", None)
    if strategy == "full":
        modules = [model]
    elif strategy in {"last_n", "vision", "text"}:
        towers = {"last_n": [vision, text], "vision": [vision], "text": [text]}[strategy]
        for tower in towers:
            if tower is None:
                continue
            layers = tower.encoder.layers
            modules += list(layers[-last_n:] if strategy == "last_n" else layers)
            for norm in ("post_layernorm", "final_layer_norm", "head"):
                if getattr(tower, norm, None) is not None:
                    modules.append(getattr(tower, norm))
    elif strategy != "projections":
        raise ValueError(f"unknown unfreeze strategy {strategy!r}")
    for m in modules:
        for p in m.parameters():
            p.requires_grad = True
    model.logit_scale.requires_grad = learn_temperature
    return sum(p.numel() for p in model.parameters() if p.requires_grad)


def hard_negative_loss(logits, targets, beta: float):
    """InfoNCE where each negative j is weighted by exp(beta * logit_j), normalised
    so the weights average 1 (beta = 0 gives the usual cross-entropy)."""
    import torch

    n, c = logits.shape
    pos = logits.gather(1, targets[:, None]).squeeze(1)
    mask = torch.ones_like(logits, dtype=torch.bool)
    mask[torch.arange(n), targets] = False
    neg = logits.masked_fill(~mask, float("-inf"))
    if beta > 0:
        w = torch.softmax((beta * neg.detach()).masked_fill(~mask, float("-inf")), dim=1) * (c - 1)
        neg_term = torch.logsumexp(neg + torch.log(w.clamp_min(1e-12)), dim=1)
    else:
        neg_term = torch.logsumexp(neg, dim=1)
    return (torch.logaddexp(pos, neg_term) - pos).mean()


def contrastive_finetune(job: Job, encoder: HFEncoder, items: list[dict], images, cfg: dict, out: Path) -> dict:
    import torch

    labelled = [i for i, it in enumerate(items) if it.get("label") or it.get("caption")]
    if len(labelled) < 4:
        raise ValueError("fine-tuning needs at least 4 images with a label or a caption")
    template = cfg.get("caption_template") or "a photo of a ballet dancer doing a {}."
    use_classes = all(items[i].get("label") for i in labelled) and not cfg.get("use_captions")
    classes = sorted({items[i]["label"] for i in labelled}) if use_classes else []
    text_of = [items[i]["caption"] or template.format(items[i]["label"]) for i in labelled]
    labels = [items[i].get("label") or f"#{k}" for k, i in enumerate(labelled)]
    train_idx, val_idx = stratified_split(labels, cfg.get("val_fraction", 0.2), cfg.get("seed", 0))
    templates = [template]

    def evaluate(enc) -> float | None:
        if not use_classes or not val_idx:
            return None
        emb = enc.embed_images([images[labelled[k]] for k in val_idx])
        pred = zero_shot_predictions(enc, emb, classes, templates)
        return accuracy([classes.index(labels[k]) for k in val_idx], pred)

    before = evaluate(encoder)
    job.log(f"zero-shot accuracy before: {before}")

    device = encoder.device
    model = copy.deepcopy(encoder.model).float().to(device)
    temperature = cfg.get("temperature") or {}
    learn_t = temperature.get("mode", "learnable") == "learnable"
    if temperature.get("value"):
        with torch.no_grad():
            model.logit_scale.fill_(math.log(1 / float(temperature["value"])))
    trainable = set_trainable(model, cfg.get("unfreeze", "last_n"), int(cfg.get("last_n", 2)), learn_t)
    job.log(f"trainable parameters: {trainable:,} ({cfg.get('unfreeze', 'last_n')})")
    params = [p for p in model.parameters() if p.requires_grad]
    opt = torch.optim.AdamW(params, lr=float(cfg.get("lr", 1e-5)), weight_decay=float(cfg.get("weight_decay", 0.1)))
    epochs, bs = int(cfg.get("epochs", 5)), int(cfg.get("batch_size", 16))
    beta = float((cfg.get("hard_negatives") or {}).get("beta", 0.0))
    processor = encoder.processor
    rng = random.Random(cfg.get("seed", 0))
    steps_total = epochs * math.ceil(len(train_idx) / bs)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=max(1, steps_total))

    def encode_text(texts):
        enc = processor(text=texts, padding=True, truncation=True, return_tensors="pt").to(device)
        kwargs = {"input_ids": enc["input_ids"]}
        if "attention_mask" in enc and encoder.family != "siglip":
            kwargs["attention_mask"] = enc["attention_mask"]
        f = model.get_text_features(**kwargs)
        return torch.nn.functional.normalize(f if hasattr(f, "shape") else f.pooler_output, dim=-1)

    def encode_images(ims):
        px = processor(images=ims, return_tensors="pt")["pixel_values"].to(device)
        f = model.get_image_features(pixel_values=px)
        return torch.nn.functional.normalize(f if hasattr(f, "shape") else f.pooler_output, dim=-1)

    step = 0
    for epoch in range(1, epochs + 1):
        model.train()
        order = train_idx[:]
        rng.shuffle(order)
        total = 0.0
        for b in range(0, len(order), bs):
            batch = order[b : b + bs]
            img = encode_images([images[labelled[k]] for k in batch])
            scale = model.logit_scale.exp().clamp(max=100)
            if use_classes:
                # Every class prompt is a candidate: the other classes are the negatives.
                txt = encode_text([template.format(c) for c in classes])
                targets = torch.tensor([classes.index(labels[k]) for k in batch], device=device)
                loss = hard_negative_loss(scale * img @ txt.T, targets, beta)
            else:
                # Captions: the usual symmetric in-batch InfoNCE.
                txt = encode_text([text_of[k] for k in batch])
                logits = scale * img @ txt.T
                targets = torch.arange(len(batch), device=device)
                loss = (hard_negative_loss(logits, targets, beta) + hard_negative_loss(logits.T, targets, beta)) / 2
            opt.zero_grad()
            loss.backward()
            opt.step()
            sched.step()
            step += 1
            total += loss.item() * len(batch)
        tuned = HFEncoder(model.eval(), processor, encoder.model_id, device, torch.float32)
        val = evaluate(tuned)
        job.report(epoch=epoch, epochs=epochs, loss=round(total / len(order), 5), val_accuracy=val,
                   temperature=round(1 / float(model.logit_scale.exp()), 5))  # fmt: skip
        job.log(f"epoch {epoch}: loss {total / len(order):.4f}, val accuracy {val}")

    out.mkdir(parents=True, exist_ok=True)
    model.save_pretrained(out)
    processor.save_pretrained(out)
    (out / "finetune.json").write_text(json.dumps({"base": encoder.model_id, "config": cfg}, indent=2))
    return {
        "model": str(out),
        "zero_shot_accuracy_before": before,
        "zero_shot_accuracy_after": job.history[-1].get("val_accuracy") if job.history else None,
        "trainable_parameters": trainable,
        "train_images": len(train_idx),
        "val_images": len(val_idx),
        "mode": "class prompts" if use_classes else "captions",
    }
