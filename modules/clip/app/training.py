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


def accuracy(true_labels, predicted_labels) -> float | None:
    if not true_labels:
        return None
    correct = sum(int(true == predicted) for true, predicted in zip(true_labels, predicted_labels, strict=True))
    return round(correct / len(true_labels), 4)


def zero_shot_predictions(encoder, embeddings: np.ndarray, classes: list[str], templates: list[str], descriptions=None):
    text = normalize(label_embeddings(encoder, classes, templates, descriptions).mean(axis=0))
    return (embeddings @ text.T).argmax(axis=1).tolist()


# --- linear probe -----------------------------------------------------------
DEFAULT_FEATURE_SCALE = 10.0  # unit vectors are tiny: scale them so the logits are not
DEFAULT_PROBE_TEMPLATE = "a photo of a ballet dancer doing a {}."
PROGRESS_REPORTS = 50


def balanced_class_weights(labels: list[int], class_count: int):
    """Inverse-frequency weights: a class with half the examples counts twice."""
    import torch

    counts = Counter(labels)
    return torch.tensor(
        [len(labels) / (class_count * max(1, counts.get(class_index, 0))) for class_index in range(class_count)]
    )


def train_linear_probe(job: Job, encoder, items: list[dict], embeddings: np.ndarray, config: dict, out: Path) -> dict:
    """A softmax classifier on the frozen image embeddings, compared with zero-shot."""
    import torch

    labelled_items = [(index, item["label"]) for index, item in enumerate(items) if item.get("label")]
    if len(labelled_items) < 4:
        raise ValueError("a linear probe needs at least 4 labelled images")
    classes = sorted({label for _, label in labelled_items})
    if len(classes) < 2:
        raise ValueError("a linear probe needs at least 2 classes")
    features = embeddings[[index for index, _ in labelled_items]].astype(np.float32)
    labels = [classes.index(label) for _, label in labelled_items]
    train_indexes, val_indexes = stratified_split(
        [classes[label] for label in labels], config.get("val_fraction", 0.25), config.get("seed", 0)
    )
    job.log(f"{len(classes)} classes, {len(train_indexes)} train / {len(val_indexes)} val images")

    feature_scale = config.get("feature_scale", DEFAULT_FEATURE_SCALE)
    train_features = torch.tensor(features[train_indexes]) * feature_scale
    train_labels = torch.tensor([labels[index] for index in train_indexes])
    val_features = torch.tensor(features[val_indexes]) * feature_scale if val_indexes else None
    val_labels = [labels[index] for index in val_indexes]

    classifier = torch.nn.Linear(features.shape[1], len(classes))
    class_weights = (
        balanced_class_weights(train_labels.tolist(), len(classes)) if config.get("balanced", True) else None
    )
    loss_function = torch.nn.CrossEntropyLoss(weight=class_weights, label_smoothing=config.get("label_smoothing", 0.0))
    optimizer = torch.optim.AdamW(
        classifier.parameters(), lr=config.get("lr", 1e-2), weight_decay=config.get("weight_decay", 1e-3)
    )

    def predict(batch) -> list[int]:
        with torch.no_grad():
            return classifier(batch).argmax(1).tolist()

    epochs = int(config.get("epochs", 200))
    report_every = max(1, epochs // PROGRESS_REPORTS)
    for epoch in range(1, epochs + 1):
        classifier.train()
        optimizer.zero_grad()
        loss = loss_function(classifier(train_features), train_labels)
        loss.backward()
        optimizer.step()
        if epoch % report_every == 0 or epoch == epochs:
            job.report(
                epoch=epoch,
                epochs=epochs,
                loss=round(loss.item(), 5),
                train_accuracy=accuracy(train_labels.tolist(), predict(train_features)),
                val_accuracy=accuracy(val_labels, predict(val_features)) if val_features is not None else None,
            )

    val_predictions = predict(val_features) if val_features is not None else []
    templates = config.get("templates") or [DEFAULT_PROBE_TEMPLATE]
    zero_shot_predictions_val = (
        zero_shot_predictions(encoder, features[val_indexes], classes, templates) if val_indexes else []
    )

    out.mkdir(parents=True, exist_ok=True)
    np.savez(
        out / "probe.npz",
        weight=classifier.weight.detach().numpy(),
        bias=classifier.bias.detach().numpy(),
        classes=np.array(classes),
        scale=np.array(feature_scale),
        model=np.array(encoder.model_id),
    )
    train_counts = Counter(train_labels.tolist())
    return {
        "probe": out.name,
        "classes": classes,
        "train_images": len(train_indexes),
        "val_images": len(val_indexes),
        "val_accuracy": accuracy(val_labels, val_predictions),
        "zero_shot_val_accuracy": accuracy(val_labels, zero_shot_predictions_val),
        "confusion": confusion(val_labels, val_predictions, len(classes)),
        "zero_shot_confusion": confusion(val_labels, zero_shot_predictions_val, len(classes)),
        "class_counts": {classes[label]: count for label, count in sorted(train_counts.items())},
    }


def load_probe(path: Path) -> dict:
    stored = np.load(path / "probe.npz", allow_pickle=False)
    return {key: stored[key] for key in stored.files}


def apply_probe(probe: dict, embeddings: np.ndarray) -> list[list[tuple[str, float]]]:
    """Class probabilities per image, most likely first (softmax of the probe's logits)."""
    logits = (embeddings * float(probe["scale"])) @ probe["weight"].T + probe["bias"]
    logits -= logits.max(axis=1, keepdims=True)  # numerical stability
    probabilities = np.exp(logits)
    probabilities /= probabilities.sum(axis=1, keepdims=True)
    classes = [str(name) for name in probe["classes"]]
    return [
        sorted(zip(classes, row.round(4).tolist(), strict=True), key=lambda pair: pair[1], reverse=True)
        for row in probabilities
    ]


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


def contrastive_finetune(job: Job, encoder: HFEncoder, items: list[dict], images, config: dict, out: Path) -> dict:
    import torch

    labelled = [i for i, it in enumerate(items) if it.get("label") or it.get("caption")]
    if len(labelled) < 4:
        raise ValueError("fine-tuning needs at least 4 images with a label or a caption")
    template = config.get("caption_template") or "a photo of a ballet dancer doing a {}."
    use_classes = all(items[i].get("label") for i in labelled) and not config.get("use_captions")
    classes = sorted({items[i]["label"] for i in labelled}) if use_classes else []
    text_of = [items[i]["caption"] or template.format(items[i]["label"]) for i in labelled]
    labels = [items[i].get("label") or f"#{k}" for k, i in enumerate(labelled)]
    train_idx, val_idx = stratified_split(labels, config.get("val_fraction", 0.2), config.get("seed", 0))
    templates = [template]

    def evaluate(enc) -> float | None:
        if not use_classes or not val_idx:
            return None
        embeddings = enc.embed_images([images[labelled[k]] for k in val_idx])
        pred = zero_shot_predictions(enc, embeddings, classes, templates)
        return accuracy([classes.index(labels[k]) for k in val_idx], pred)

    before = evaluate(encoder)
    job.log(f"zero-shot accuracy before: {before}")

    device = encoder.device
    model = copy.deepcopy(encoder.model).float().to(device)
    temperature = config.get("temperature") or {}
    learn_t = temperature.get("mode", "learnable") == "learnable"
    if temperature.get("value"):
        with torch.no_grad():
            model.logit_scale.fill_(math.log(1 / float(temperature["value"])))
    trainable = set_trainable(model, config.get("unfreeze", "last_n"), int(config.get("last_n", 2)), learn_t)
    job.log(f"trainable parameters: {trainable:,} ({config.get('unfreeze', 'last_n')})")
    params = [p for p in model.parameters() if p.requires_grad]
    optimizer = torch.optim.AdamW(
        params, lr=float(config.get("lr", 1e-5)), weight_decay=float(config.get("weight_decay", 0.1))
    )
    epochs, batch_size = int(config.get("epochs", 5)), int(config.get("batch_size", 16))
    beta = float((config.get("hard_negatives") or {}).get("beta", 0.0))
    processor = encoder.processor
    rng = random.Random(config.get("seed", 0))
    steps_total = epochs * math.ceil(len(train_idx) / batch_size)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=max(1, steps_total))

    def unit_vectors(model_output):
        # transformers 5 returns an output object, earlier versions a tensor
        features = model_output if hasattr(model_output, "shape") else model_output.pooler_output
        return torch.nn.functional.normalize(features, dim=-1)

    def encode_text(texts):
        tokens = processor(text=texts, padding=True, truncation=True, return_tensors="pt").to(device)
        text_inputs = {"input_ids": tokens["input_ids"]}
        if "attention_mask" in tokens and encoder.family != "siglip":
            text_inputs["attention_mask"] = tokens["attention_mask"]
        return unit_vectors(model.get_text_features(**text_inputs))

    def encode_images(images_batch):
        pixel_values = processor(images=images_batch, return_tensors="pt")["pixel_values"].to(device)
        return unit_vectors(model.get_image_features(pixel_values=pixel_values))

    step = 0
    for epoch in range(1, epochs + 1):
        model.train()
        order = train_idx[:]
        rng.shuffle(order)
        total = 0.0
        for b in range(0, len(order), batch_size):
            batch = order[b : b + batch_size]
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
            optimizer.zero_grad()
            loss.backward()
            optimizer.step()
            scheduler.step()
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
    (out / "finetune.json").write_text(json.dumps({"base": encoder.model_id, "config": config}, indent=2))
    return {
        "model": str(out),
        "zero_shot_accuracy_before": before,
        "zero_shot_accuracy_after": job.history[-1].get("val_accuracy") if job.history else None,
        "trainable_parameters": trainable,
        "train_images": len(train_idx),
        "val_images": len(val_idx),
        "mode": "class prompts" if use_classes else "captions",
    }
