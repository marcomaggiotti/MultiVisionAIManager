"""Dual-encoder engine: an image encoder and a text encoder that map into one
embedding space, compared by cosine similarity.

Works with Hugging Face CLIP and SigLIP checkpoints (and fine-tuned copies
saved by this module). Everything above this file talks to :class:`Encoder`,
so tests use a fake one.
"""

from __future__ import annotations

import threading
from abc import ABC, abstractmethod
from pathlib import Path

import numpy as np
from PIL import Image

CATALOG = [
    {"id": "openai/clip-vit-base-patch32", "family": "clip", "params_m": 151, "embed_dim": 512,
     "note": "fastest; 224 px, 32 px patches (49 image tokens)"},
    {"id": "openai/clip-vit-base-patch16", "family": "clip", "params_m": 150, "embed_dim": 512,
     "note": "finer 16 px patches (196 tokens): better on poses and small details"},
    {"id": "laion/CLIP-ViT-B-32-laion2B-s34B-b79K", "family": "clip", "params_m": 151,
     "embed_dim": 512, "note": "OpenCLIP trained on LAION-2B"},
    {"id": "openai/clip-vit-large-patch14", "family": "clip", "params_m": 428, "embed_dim": 768,
     "note": "most accurate CLIP, ~1 GB in fp16"},
    {"id": "google/siglip-base-patch16-224", "family": "siglip", "params_m": 203,
     "embed_dim": 768, "note": "sigmoid loss: independent per-label probabilities"},
    {"id": "google/siglip2-base-patch16-224", "family": "siglip", "params_m": 375,
     "embed_dim": 768, "note": "SigLIP 2, multilingual"},
]  # fmt: skip


def normalize(x: np.ndarray) -> np.ndarray:
    return x / np.clip(np.linalg.norm(x, axis=-1, keepdims=True), 1e-12, None)


class Encoder(ABC):
    model_id: str
    family: str = "clip"

    @abstractmethod
    def embed_images(self, images: list[Image.Image]) -> np.ndarray:
        """L2-normalised image embeddings, shape (n, d)."""

    @abstractmethod
    def embed_texts(self, texts: list[str]) -> np.ndarray:
        """L2-normalised text embeddings, shape (n, d)."""

    @abstractmethod
    def tokenize(self, texts: list[str]) -> list[dict]:
        """Tokens of each text as the text encoder sees them."""

    @property
    @abstractmethod
    def logit_scale(self) -> float:
        """Learned inverse temperature (CLIP initialises it to 1/0.07, it trains to ~100)."""

    @property
    def logit_bias(self) -> float:
        return 0.0

    @abstractmethod
    def info(self) -> dict:
        """Architecture of both towers."""


def _features(out):
    return out if hasattr(out, "shape") else out.pooler_output


def _count(module) -> int:
    return sum(p.numel() for p in module.parameters()) if module is not None else 0


class HFEncoder(Encoder):
    def __init__(self, model, processor, model_id: str, device: str, dtype) -> None:
        self.model = model
        self.processor = processor
        self.model_id = model_id
        self.device = device
        self.dtype = dtype
        self.family = "siglip" if "siglip" in model.config.model_type else "clip"
        self._lock = threading.Lock()

    @classmethod
    def load(cls, model_id: str, device: str | None = None, dtype: str = "float16") -> HFEncoder:
        import torch
        from transformers import AutoModel, AutoProcessor

        device = device or ("cuda" if torch.cuda.is_available() else "cpu")
        torch_dtype = getattr(torch, dtype) if device.startswith("cuda") else torch.float32
        model = AutoModel.from_pretrained(model_id, dtype=torch_dtype).to(device).eval()
        processor = AutoProcessor.from_pretrained(model_id)
        return cls(model, processor, model_id, device, torch_dtype)

    def _text_inputs(self, texts: list[str]):
        if self.family == "siglip":  # SigLIP was trained with max-length padding
            return self.processor(
                text=texts, padding="max_length", truncation=True, max_length=64,
                return_tensors="pt",
            )  # fmt: skip
        return self.processor(text=texts, padding=True, truncation=True, return_tensors="pt")

    def embed_images(self, images: list[Image.Image], batch_size: int = 32) -> np.ndarray:
        import torch

        out = []
        with self._lock, torch.inference_mode():
            for i in range(0, len(images), batch_size):
                inputs = self.processor(images=images[i : i + batch_size], return_tensors="pt")
                pixels = inputs["pixel_values"].to(self.device, self.dtype)
                out.append(_features(self.model.get_image_features(pixel_values=pixels)).float())
        return normalize(torch.cat(out).cpu().numpy()) if out else np.zeros((0, 1), np.float32)

    def embed_texts(self, texts: list[str], batch_size: int = 256) -> np.ndarray:
        import torch

        out = []
        with self._lock, torch.inference_mode():
            for i in range(0, len(texts), batch_size):
                inputs = self._text_inputs(texts[i : i + batch_size]).to(self.device)
                kwargs = {"input_ids": inputs["input_ids"]}
                if "attention_mask" in inputs and self.family != "siglip":
                    kwargs["attention_mask"] = inputs["attention_mask"]
                out.append(_features(self.model.get_text_features(**kwargs)).float())
        return normalize(torch.cat(out).cpu().numpy()) if out else np.zeros((0, 1), np.float32)

    def tokenize(self, texts: list[str]) -> list[dict]:
        tokenizer = self.processor.tokenizer
        limit = getattr(self.model.config.text_config, "max_position_embeddings", 77)
        result = []
        for text in texts:
            ids = tokenizer(text, truncation=False)["input_ids"]
            result.append(
                {
                    "text": text,
                    "ids": ids,
                    "tokens": tokenizer.convert_ids_to_tokens(ids),
                    "length": len(ids),
                    "max_length": limit,
                    "truncated": len(ids) > limit,
                }
            )
        return result

    @property
    def logit_scale(self) -> float:
        return float(self.model.logit_scale.exp().item())

    @property
    def logit_bias(self) -> float:
        bias = getattr(self.model, "logit_bias", None)
        return float(bias.item()) if bias is not None else 0.0

    def info(self) -> dict:
        cfg = self.model.config
        v, t = cfg.vision_config, cfg.text_config
        image_size = getattr(v, "image_size", 224)
        patch = getattr(v, "patch_size", 32)
        return {
            "model_id": self.model_id,
            "family": self.family,
            "device": str(self.device),
            "dtype": str(self.dtype).replace("torch.", ""),
            "embed_dim": getattr(cfg, "projection_dim", None) or getattr(v, "hidden_size", None),
            "logit_scale": round(self.logit_scale, 3),
            "temperature": round(1 / self.logit_scale, 5),
            "logit_bias": round(self.logit_bias, 3),
            "vision": {
                "type": "ViT",
                "image_size": image_size,
                "patch_size": patch,
                "tokens": (image_size // patch) ** 2 + (1 if self.family == "clip" else 0),
                "hidden_size": v.hidden_size,
                "layers": v.num_hidden_layers,
                "heads": v.num_attention_heads,
                "params_m": round(_count(getattr(self.model, "vision_model", None)) / 1e6, 1),
            },
            "text": {
                "type": "Transformer",
                "vocab_size": t.vocab_size,
                "max_length": getattr(t, "max_position_embeddings", None),
                "hidden_size": t.hidden_size,
                "layers": t.num_hidden_layers,
                "heads": t.num_attention_heads,
                "params_m": round(_count(getattr(self.model, "text_model", None)) / 1e6, 1),
            },
            "params_m": round(_count(self.model) / 1e6, 1),
            "loss": "sigmoid (pairwise)" if self.family == "siglip" else "softmax InfoNCE",
        }


def local_models(data_dir: Path) -> list[dict]:
    root = data_dir / "models"
    if not root.is_dir():
        return []
    return [
        {"id": str(p), "family": "fine-tuned", "note": "saved by a fine-tuning job"}
        for p in sorted(root.iterdir())
        if (p / "config.json").is_file()
    ]
