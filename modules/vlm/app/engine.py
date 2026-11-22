"""Vision-language model engine on Hugging Face transformers.

Most small VLMs use *early fusion*: an image encoder (a ViT such as SigLIP)
turns the picture into patch features, a connector (MLP / pixel-shuffle
projector / patch merger) maps them into the language model's embedding space,
and they are inserted into the token sequence as "image tokens". The language
model then attends to them with ordinary self-attention. Some models (Llama
3.2 Vision) instead add gated **cross-attention** layers to the language model.
"""

from __future__ import annotations

import math
import threading
import time
from abc import ABC, abstractmethod
from pathlib import Path

from PIL import Image

CATALOG = [
    {"id": "HuggingFaceTB/SmolVLM-256M-Instruct", "params_b": 0.26, "vram_gb": 1.0,
     "vision": "SigLIP-B/16 (93M)", "fusion": "pixel-shuffle projector",
     "note": "smallest; start here"},
    {"id": "HuggingFaceTB/SmolVLM-500M-Instruct", "params_b": 0.5, "vram_gb": 1.8,
     "vision": "SigLIP-B/16 (93M)", "fusion": "pixel-shuffle projector", "note": ""},
    {"id": "llava-hf/llava-onevision-qwen2-0.5b-ov-hf", "params_b": 0.9, "vram_gb": 2.5,
     "vision": "SigLIP-SO400M", "fusion": "MLP projector (LLaVA)", "note": "multi-image"},
    {"id": "OpenGVLab/InternVL3-1B-hf", "params_b": 1.0, "vram_gb": 2.5,
     "vision": "InternViT-300M", "fusion": "MLP projector", "note": ""},
    {"id": "Qwen/Qwen2-VL-2B-Instruct", "params_b": 2.2, "vram_gb": 5.0,
     "vision": "ViT-600M, dynamic resolution", "fusion": "patch merger MLP",
     "note": "strong detail; 4bit fits 4 GB"},
    {"id": "HuggingFaceTB/SmolVLM2-2.2B-Instruct", "params_b": 2.2, "vram_gb": 5.0,
     "vision": "SigLIP-SO400M", "fusion": "pixel-shuffle projector", "note": "video-trained"},
    {"id": "Qwen/Qwen2.5-VL-3B-Instruct", "params_b": 3.8, "vram_gb": 8.0,
     "vision": "ViT-670M, window attention", "fusion": "patch merger MLP",
     "note": "best of the list; use 4bit under 8 GB"},
]  # fmt: skip

DEFAULT_PARAMS = {
    "max_new_tokens": 256,
    "do_sample": False,
    "temperature": 0.7,
    "top_p": 0.9,
    "top_k": 50,
    "num_beams": 1,
    "repetition_penalty": 1.05,
    "no_repeat_ngram_size": 0,
    "length_penalty": 1.0,
    "seed": 0,
    "return_scores": False,
}


# Options set for the token-score inspection, not chosen by the user.
INTERNAL_GENERATE_OPTIONS = {"output_logits", "return_dict_in_generate"}


class EngineError(ValueError):
    pass


class VLMEngine(ABC):
    model_id: str
    adapter: str | None = None

    @abstractmethod
    def generate(self, images, prompt, system=None, params=None, sequence=False) -> dict: ...

    @abstractmethod
    def tokenize(self, images, prompt, system=None, sequence=False) -> dict: ...

    @abstractmethod
    def attention(self, images, prompt, answer=None, system=None, sequence=False) -> dict: ...

    @abstractmethod
    def info(self) -> dict: ...


def build_messages(images, prompt, system=None, sequence=False, answer=None) -> list[dict]:
    content: list[dict] = []
    for i, image in enumerate(images):
        if sequence and len(images) > 1:
            content.append({"type": "text", "text": f"Picture {i + 1}:"})
        content.append({"type": "image", "image": image})
    content.append({"type": "text", "text": prompt})
    messages = []
    if system:
        messages.append({"role": "system", "content": [{"type": "text", "text": system}]})
    messages.append({"role": "user", "content": content})
    if answer is not None:
        messages.append({"role": "assistant", "content": [{"type": "text", "text": answer}]})
    return messages


def image_runs(mask: list[bool]) -> list[tuple[int, int]]:
    """(start, length) of each contiguous block of image tokens."""
    runs, start = [], None
    for i, m in enumerate(mask + [False]):
        if m and start is None:
            start = i
        elif not m and start is not None:
            runs.append((start, i - start))
            start = None
    return runs


def grid_for(length: int, hint: tuple[int, int] | None = None) -> tuple[int, int] | None:
    if hint and hint[0] * hint[1] == length:
        return hint
    side = int(math.isqrt(length))
    return (side, side) if side * side == length else None


CONNECTOR_NAME_PARTS = ("connector", "multi_modal_projector", "merger", "mlp1", "modality_projection")
VISION_NAME_PARTS = ("vision_model", "vision_tower", "visual.", "vision_encoder")


def _group(name: str) -> str:
    """Which part of a VLM a parameter or module belongs to: vision, connector or language."""
    lowered = name.lower()
    if any(part in lowered for part in CONNECTOR_NAME_PARTS):
        return "connector"
    if any(part in lowered for part in VISION_NAME_PARTS):
        return "vision"
    return "language"


class HFVLM(VLMEngine):
    def __init__(self, model, processor, model_id, device, dtype, quantization="none") -> None:
        self.model = model
        self.processor = processor
        self.model_id = model_id
        self.device = device
        self.dtype = dtype
        self.quantization = quantization
        self.adapter = None
        self._lock = threading.Lock()

    # --- loading -----------------------------------------------------------
    @staticmethod
    def load_parts(model_id, device=None, dtype="bfloat16", quantization="none", attn="eager"):
        import torch
        from transformers import AutoModelForImageTextToText, AutoProcessor

        device = device or ("cuda" if torch.cuda.is_available() else "cpu")
        on_gpu = device.startswith("cuda")
        torch_dtype = getattr(torch, dtype) if on_gpu else torch.float32
        kwargs = {"dtype": torch_dtype, "attn_implementation": attn}
        if quantization in {"4bit", "8bit"}:
            if not on_gpu:
                raise EngineError("4bit/8bit quantization needs a CUDA GPU")
            from transformers import BitsAndBytesConfig

            kwargs["quantization_config"] = BitsAndBytesConfig(
                load_in_4bit=quantization == "4bit",
                load_in_8bit=quantization == "8bit",
                bnb_4bit_compute_dtype=torch_dtype,
                bnb_4bit_quant_type="nf4",
            )
            kwargs["device_map"] = {"": device}
        model = AutoModelForImageTextToText.from_pretrained(model_id, **kwargs)
        if "device_map" not in kwargs:
            model = model.to(device)
        processor = AutoProcessor.from_pretrained(model_id)
        return model.eval(), processor, device, torch_dtype

    @classmethod
    def load(cls, model_id, device=None, dtype="bfloat16", quantization="none", attn="eager") -> HFVLM:
        model, processor, device, torch_dtype = cls.load_parts(model_id, device, dtype, quantization, attn)
        return cls(model, processor, model_id, device, torch_dtype, quantization)

    # --- helpers -------------------------------------------------------------
    @property
    def tokenizer(self):
        return getattr(self.processor, "tokenizer", self.processor)

    @property
    def image_token_id(self) -> int | None:
        config = self.model.config
        for attr in ("image_token_id", "image_token_index"):
            if isinstance(getattr(config, attr, None), int):
                return getattr(config, attr)
        token = getattr(self.processor, "image_token", None)
        if token:
            return self.tokenizer.convert_tokens_to_ids(token)
        return None

    def inputs(self, messages, add_generation_prompt=True):
        inputs = self.processor.apply_chat_template(
            messages,
            add_generation_prompt=add_generation_prompt,
            tokenize=True,
            return_dict=True,
            return_tensors="pt",
        )
        inputs = inputs.to(self.model.device)
        if "pixel_values" in inputs and inputs["pixel_values"].is_floating_point():
            inputs["pixel_values"] = inputs["pixel_values"].to(self.model.dtype)
        return inputs

    def _image_mask(self, ids) -> list[bool]:
        token = self.image_token_id
        return [int(t) == token for t in ids] if token is not None else [False] * len(ids)

    # --- generation ------------------------------------------------------------
    def generate(self, images, prompt, system=None, params=None, sequence=False) -> dict:
        import torch

        decoding = {**DEFAULT_PARAMS, **(params or {})}
        generation_options = {
            "max_new_tokens": int(decoding["max_new_tokens"]),
            "do_sample": bool(decoding["do_sample"]),
            "num_beams": int(decoding["num_beams"]),
            "repetition_penalty": float(decoding["repetition_penalty"]),
        }
        if generation_options["do_sample"]:
            generation_options.update(
                temperature=float(decoding["temperature"]), top_p=float(decoding["top_p"]), top_k=int(decoding["top_k"])
            )
        if int(decoding["no_repeat_ngram_size"]) > 0:
            generation_options["no_repeat_ngram_size"] = int(decoding["no_repeat_ngram_size"])
        if generation_options["num_beams"] > 1:
            generation_options["length_penalty"] = float(decoding["length_penalty"])
        return_token_scores = bool(decoding["return_scores"]) and generation_options["num_beams"] == 1
        if return_token_scores:
            generation_options.update(output_logits=True, return_dict_in_generate=True)

        with self._lock, torch.inference_mode():
            inputs = self.inputs(build_messages(images, prompt, system, sequence))
            n_in = inputs["input_ids"].shape[1]
            torch.manual_seed(int(decoding["seed"]))
            start = time.perf_counter()
            out = self.model.generate(**inputs, **generation_options)
            elapsed = time.perf_counter() - start
            seqs = out.sequences if return_token_scores else out
            new = seqs[0, n_in:]
            text = self.processor.decode(new, skip_special_tokens=True).strip()
            steps = []
            if return_token_scores:
                for i, logits in enumerate(out.logits):
                    probs = torch.softmax(logits[0].float(), dim=-1)
                    top = torch.topk(probs, 5)
                    chosen = int(new[i])
                    steps.append(
                        {
                            "token": self.tokenizer.decode([chosen]),
                            "probability": round(float(probs[chosen]), 4),
                            "entropy": round(float(-(probs * probs.clamp_min(1e-12).log()).sum()), 3),
                            "alternatives": [
                                {"token": self.tokenizer.decode([int(t)]), "probability": round(float(v), 4)}
                                for v, t in zip(top.values, top.indices, strict=True)
                            ],
                        }
                    )
        n_new = int(new.shape[0])
        return {
            "text": text,
            "prompt_tokens": n_in,
            "image_tokens": sum(self._image_mask(inputs["input_ids"][0].tolist())),
            "new_tokens": n_new,
            "latency_ms": round(elapsed * 1000, 1),
            "tokens_per_s": round(n_new / elapsed, 1) if elapsed > 0 else None,
            "params": {key: value for key, value in generation_options.items() if key not in INTERNAL_GENERATE_OPTIONS},
            "steps": steps,
            "model": self.model_id,
            "adapter": self.adapter,
        }

    # --- tokenization ------------------------------------------------------------
    def tokenize(self, images, prompt, system=None, sequence=False) -> dict:
        messages = build_messages(images, prompt, system, sequence)
        text = self.processor.apply_chat_template(messages, add_generation_prompt=True, tokenize=False)
        with self._lock:
            inputs = self.inputs(messages)
        ids = inputs["input_ids"][0].tolist()
        mask = self._image_mask(ids)
        pieces: list[dict] = []
        for i, t in enumerate(ids):
            if mask[i] and pieces and pieces[-1]["kind"] == "image":
                pieces[-1]["count"] += 1
                continue
            special = t in set(self.tokenizer.all_special_ids)
            pieces.append(
                {
                    "id": t,
                    "token": self.tokenizer.convert_ids_to_tokens(t),
                    "kind": "image" if mask[i] else ("special" if special else "text"),
                    "count": 1,
                }
            )
        extra = {}
        if "image_grid_thw" in inputs:
            extra["image_grid_thw"] = inputs["image_grid_thw"].tolist()
        if "pixel_values" in inputs:
            extra["pixel_values_shape"] = list(inputs["pixel_values"].shape)
        return {
            "templated_prompt": text,
            "total_tokens": len(ids),
            "image_tokens": sum(mask),
            "text_tokens": len(ids) - sum(mask),
            "pieces": pieces,
            "tokenizer": {
                "class": type(self.tokenizer).__name__,
                "vocab_size": len(self.tokenizer),
                "special_tokens": {k: str(v) for k, v in self.tokenizer.special_tokens_map.items()},
                "image_token_id": self.image_token_id,
            },
            **extra,
        }

    # --- attention inspection -------------------------------------------------------
    def attention(self, images, prompt, answer=None, system=None, sequence=False) -> dict:
        import torch

        if answer is None:
            answer = self.generate(images, prompt, system, {"max_new_tokens": 48}, sequence)["text"]
        impl = getattr(self.model.config, "_attn_implementation", "eager")
        if impl != "eager":
            try:
                self.model.set_attn_implementation("eager")
            except Exception as error:  # noqa: BLE001
                raise EngineError(
                    f"attention weights need eager attention (model uses {impl}); "
                    "reload the model with attn_implementation=eager"
                ) from error
        with self._lock, torch.inference_mode():
            prompt_inputs = self.inputs(build_messages(images, prompt, system, sequence))
            n_prompt = prompt_inputs["input_ids"].shape[1]
            inputs = self.inputs(build_messages(images, prompt, system, sequence, answer), add_generation_prompt=False)
            out = self.model(**inputs, output_attentions=True)
        if impl != "eager":
            try:
                self.model.set_attn_implementation(impl)
            except Exception:  # noqa: BLE001
                pass
        attentions = [a for a in (out.attentions or []) if a is not None]
        if not attentions:
            raise EngineError("this model did not return attention weights")
        ids = inputs["input_ids"][0].tolist()
        mask = torch.tensor(self._image_mask(ids), device=attentions[0].device)
        seq = len(ids)
        queries = list(range(min(n_prompt, seq - 1), seq))  # the answer tokens
        text_mask = ~mask
        text_mask[n_prompt:] = False
        per_layer, heads, heat = [], [], torch.zeros(seq, device=mask.device)
        for layer in attentions:
            a = layer[0].float()[:, queries, :]  # heads x answer x keys
            per_head_img = a[:, :, mask].sum(-1).mean(-1)  # heads
            mean = a.mean(0).mean(0)  # keys
            heat += mean
            per_layer.append(
                {
                    "image": round(float(mean[mask].sum()), 4),
                    "prompt_text": round(float(mean[text_mask].sum()), 4),
                    "answer": round(float(mean[n_prompt:].sum()), 4),
                }
            )
            heads.append([round(float(v), 4) for v in per_head_img])
        heat /= len(attentions)
        img_heat = heat[mask].tolist()
        runs = image_runs(mask.tolist())
        hint = None
        if "image_grid_thw" in inputs:
            t, h, w = inputs["image_grid_thw"][0].tolist()
            merge = getattr(getattr(self.model.config, "vision_config", None), "spatial_merge_size", 2)
            hint = (h // merge, w // merge)
        blocks, offset = [], 0
        for start, length in runs:
            values = img_heat[offset : offset + length]
            offset += length
            # Min-max scaled within the block, so that the contrast shows where
            # attention concentrates (uniform attention stays a flat mid tone).
            lo, hi = (min(values), max(values)) if values else (0.0, 0.0)
            spread = hi - lo
            heat_values = [round((v - lo) / spread, 4) if spread > 1e-9 else 0.5 for v in values]
            blocks.append(
                {
                    "start": start,
                    "length": length,
                    "grid": grid_for(length, hint),
                    "raw_sum": round(sum(values), 5),
                    "heat": heat_values,
                }
            )
        text_scores = [(position, float(heat[position])) for position in range(n_prompt) if not bool(mask[position])]
        text_scores.sort(key=lambda scored: scored[1], reverse=True)
        return {
            "answer": answer,
            "layers": per_layer,
            "heads_image_attention": heads,
            "image_blocks": blocks,
            # Single image: the last block is the whole picture for tiling models
            # (SmolVLM's global view) and the only block for the others.
            "overlay_block": len(blocks) - 1 if len(images) == 1 and blocks else (0 if blocks else None),
            "top_text_tokens": [
                {"token": self.tokenizer.decode([ids[position]]), "weight": round(weight, 4)}
                for position, weight in text_scores[:15]
            ],
            "prompt_tokens": n_prompt,
            "answer_tokens": len(queries),
        }

    # --- architecture ------------------------------------------------------------------
    def info(self) -> dict:
        config = self.model.config
        vision = getattr(config, "vision_config", None)
        text = getattr(config, "text_config", None) or config
        groups = {"vision": 0, "connector": 0, "language": 0}
        for name, p in self.model.named_parameters():
            groups[_group(name)] += p.numel()
        connector = next(
            (
                type(m).__name__
                for n, m in self.model.named_modules()
                if n.rsplit(".", 1)[-1] in {"connector", "multi_modal_projector", "merger", "mlp1"}
            ),
            None,
        )
        cross = "mllama" in config.model_type or bool(getattr(text, "cross_attention_layers", None))
        return {
            "model_id": self.model_id,
            "architecture": type(self.model).__name__,
            "model_type": config.model_type,
            "device": str(self.model.device),
            "dtype": str(self.model.dtype).replace("torch.", ""),
            "quantization": self.quantization,
            "attn_implementation": getattr(config, "_attn_implementation", None),
            "adapter": self.adapter,
            "fusion": "cross-attention layers in the language model" if cross
            else "early fusion: projected image tokens in the language model's sequence",
            "params_m": {k: round(v / 1e6, 1) for k, v in groups.items()},
            "vision_encoder": None if vision is None else {
                "type": getattr(vision, "model_type", None),
                "image_size": getattr(vision, "image_size", None),
                "patch_size": getattr(vision, "patch_size", None),
                "hidden_size": getattr(vision, "hidden_size", None),
                "layers": getattr(vision, "num_hidden_layers", None) or getattr(vision, "depth", None),
                "heads": getattr(vision, "num_attention_heads", None) or getattr(vision, "num_heads", None),
            },
            "connector": connector,
            "language_model": {
                "type": getattr(text, "model_type", None),
                "hidden_size": getattr(text, "hidden_size", None),
                "layers": getattr(text, "num_hidden_layers", None),
                "heads": getattr(text, "num_attention_heads", None),
                "kv_heads": getattr(text, "num_key_value_heads", None),
                "vocab_size": getattr(text, "vocab_size", None),
                "max_positions": getattr(text, "max_position_embeddings", None),
            },
            "image_token_id": self.image_token_id,
        }  # fmt: skip


def local_adapters(data_dir: Path) -> list[dict]:
    root = data_dir / "adapters"
    if not root.is_dir():
        return []
    import json

    out = []
    for p in sorted(root.iterdir()):
        if (p / "adapter_config.json").exists():
            meta = {}
            if (p / "lab.json").exists():
                meta = json.loads((p / "lab.json").read_text())
            out.append({"name": p.name, "base": meta.get("base"), "result": meta.get("result")})
    return out


def open_images(paths: list[Path]) -> list[Image.Image]:
    result = []
    for p in paths:
        with Image.open(p) as im:
            result.append(im.convert("RGB"))
    return result
