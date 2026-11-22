"""Instruction tuning with LoRA, and evaluation runs.

Instruction tuning teaches the model to answer *your* instructions in *your*
style - e.g. naming ballet steps and giving technique feedback. LoRA trains
small low-rank matrices next to the attention projections of the language
model (optionally the vision encoder too); the base weights stay frozen, so a
few MB of adapter is enough and a 4-bit base model (QLoRA) fits small GPUs.

The loss is computed on the response tokens only: prompt, images and
template tokens are masked with -100.
"""

from __future__ import annotations

import json
import math
import random
import time
from pathlib import Path

from app import metrics
from app.ballet import PROMPTS  # noqa: F401 - re-exported for the UI
from app.engine import HFVLM, _group, build_messages
from app.jobs import Job

VOCABULARY = [
    "plié", "tendu", "relevé", "développé", "arabesque", "attitude", "pirouette", "grand jeté",
    "sissonne", "pas de bourrée", "port de bras", "fouetté", "passé", "grand battement",
    "assemblé", "first position", "second position", "third position", "fourth position",
    "fifth position", "turnout", "demi-pointe", "pointe", "croisé", "effacé", "écarté",
]  # fmt: skip


def lora_targets(model, names: list[str], scope: str) -> list[str]:
    """Full module names of the projections to adapt."""
    targets = []
    for full, _ in model.named_modules():
        if full.rsplit(".", 1)[-1] not in names:
            continue
        group = _group(full + ".")
        if group == "language" or (scope == "language+vision" and group == "vision"):
            targets.append(full)
    if not targets:
        raise ValueError(f"no modules named {names} found for scope {scope!r}")
    return targets


IGNORED_LABEL = -100  # PyTorch's cross-entropy skips this target


def masked_example(engine: HFVLM, images, instruction, response, system=None):
    """Model inputs with labels on the response tokens only."""
    prompt = engine.inputs(build_messages(images, instruction, system), add_generation_prompt=True)
    full = engine.inputs(build_messages(images, instruction, system, response), add_generation_prompt=False)
    labels = full["input_ids"].clone()
    prompt_length = prompt["input_ids"].shape[1]
    labels[:, :prompt_length] = IGNORED_LABEL
    pad_token_id = getattr(engine.tokenizer, "pad_token_id", None)
    if pad_token_id is not None:
        labels[labels == pad_token_id] = IGNORED_LABEL
    full["labels"] = labels
    return full


def lora_finetune(job: Job, base: HFVLM, store, dataset: str, config: dict, out: Path, settings) -> dict:
    import torch
    from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training

    items = [i for i in store.items(dataset) if i.get("response")]
    if len(items) < 2:
        raise ValueError("instruction tuning needs at least 2 examples with a response")
    quant = config.get("quantization", base.quantization)
    job.log(f"loading a training copy of {base.model_id} ({quant})")
    model, processor, device, dtype = HFVLM.load_parts(
        base.model_id, base.device, config.get("dtype", settings.dtype), quant, "sdpa"
    )
    engine = HFVLM(model, processor, base.model_id, device, dtype, quant)
    if quant in {"4bit", "8bit"}:
        model = prepare_model_for_kbit_training(
            model, use_gradient_checkpointing=config.get("gradient_checkpointing", True)
        )
    elif config.get("gradient_checkpointing"):
        model.gradient_checkpointing_enable()
        model.enable_input_require_grads()

    targets = lora_targets(model, config.get("target_modules") or ["q_proj", "k_proj", "v_proj", "o_proj"],
                           config.get("scope", "language"))  # fmt: skip
    connector = [
        n for n, _ in model.named_modules() if n.rsplit(".", 1)[-1] in {"connector", "multi_modal_projector", "merger"}
    ]
    lora = LoraConfig(
        r=int(config.get("r", 16)),
        lora_alpha=int(config.get("alpha", 32)),
        lora_dropout=float(config.get("dropout", 0.05)),
        target_modules=targets,
        modules_to_save=connector[:1] if config.get("train_connector") else None,
        task_type="CAUSAL_LM",
    )
    model = get_peft_model(model, lora)
    trainable = sum(p.numel() for p in model.parameters() if p.requires_grad)
    total = sum(p.numel() for p in model.parameters())
    job.log(f"LoRA on {len(targets)} modules: {trainable:,} trainable of {total:,} parameters")
    engine.model = model

    rng = random.Random(config.get("seed", 0))
    rng.shuffle(items)
    n_val = int(round(len(items) * float(config.get("val_fraction", 0.2)))) if len(items) >= 5 else 0
    val, train = items[:n_val], items[n_val:]
    epochs, accum = int(config.get("epochs", 3)), int(config.get("grad_accum", 4))
    params = [p for p in model.parameters() if p.requires_grad]
    optimizer = torch.optim.AdamW(
        params, lr=float(config.get("lr", 2e-4)), weight_decay=float(config.get("weight_decay", 0.0))
    )
    steps = max(1, math.ceil(len(train) * epochs / accum))
    warmup = int(steps * float(config.get("warmup_ratio", 0.05)))
    scheduler = torch.optim.lr_scheduler.LambdaLR(
        optimizer,
        lambda s: min(1.0, (s + 1) / max(1, warmup)) * max(0.0, 1 - s / steps) if warmup else max(0.0, 1 - s / steps),
    )

    def example(item):
        return masked_example(
            engine, store.load(dataset, item), item["instruction"], item["response"], item.get("system")
        )

    def val_loss():
        if not val:
            return None
        model.eval()
        total_loss = 0.0
        with torch.no_grad():
            for item in val:
                total_loss += float(model(**example(item)).loss)
        model.train()
        return round(total_loss / len(val), 5)

    start = time.time()
    model.train()
    step = 0
    for epoch in range(1, epochs + 1):
        rng.shuffle(train)
        running = 0.0
        for k, item in enumerate(train, 1):
            loss = model(**example(item)).loss / accum
            loss.backward()
            running += float(loss.detach()) * accum
            if k % accum == 0 or k == len(train):
                torch.nn.utils.clip_grad_norm_(params, float(config.get("max_grad_norm", 1.0)))
                optimizer.step()
                scheduler.step()
                optimizer.zero_grad()
                step += 1
            if job.cancelled.is_set():
                raise InterruptedError
        vl = val_loss()
        job.report(epoch=epoch, epochs=epochs, loss=round(running / len(train), 5), val_loss=vl,
                   lr=scheduler.get_last_lr()[0], elapsed_s=round(time.time() - start, 1))  # fmt: skip
        job.log(f"epoch {epoch}: train loss {running / len(train):.4f}, val loss {vl}")

    out.mkdir(parents=True, exist_ok=True)
    model.save_pretrained(out)
    result = {
        "adapter": out.name,
        "train_examples": len(train),
        "val_examples": len(val),
        "trainable_parameters": trainable,
        "final_val_loss": job.history[-1]["val_loss"] if job.history else None,
        "seconds": round(time.time() - start, 1),
    }
    (out / "lab.json").write_text(json.dumps({"base": base.model_id, "config": config, "result": result}, indent=2))
    engine.model = None  # release the training copy
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    return result


def evaluate(job: Job, engine, store, dataset: str, config: dict) -> dict:
    items = [i for i in store.items(dataset) if i.get("response")]
    if not items:
        raise ValueError("evaluation needs examples with a reference response")
    limit = int(config.get("limit") or len(items))
    params = config.get("params") or {"max_new_tokens": 128}
    rows = []
    for k, item in enumerate(items[:limit], 1):
        images = store.load(dataset, item)
        out = engine.generate(images, item["instruction"], config.get("system") or item.get("system"), params,
                              sequence=len(images) > 1)  # fmt: skip
        row = {
            "id": item["id"],
            "instruction": item["instruction"],
            "reference": item["response"],
            "prediction": out["text"],
            "latency_ms": out["latency_ms"],
            "new_tokens": out["new_tokens"],
            **metrics.score(out["text"], item["response"], VOCABULARY),
        }
        rows.append(row)
        job.report(done=k, total=min(limit, len(items)), **metrics.aggregate(rows))
    return {
        "model": engine.model_id,
        "adapter": engine.adapter,
        "examples": len(rows),
        "summary": metrics.aggregate(rows),
        "rows": rows,
    }
