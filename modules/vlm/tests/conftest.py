from __future__ import annotations

import io

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.config import Settings
from app.engine import VLMEngine
from app.main import create_app


class FakeVLM(VLMEngine):
    model_id = "fake/vlm"

    def __init__(self):
        self.calls = []

    def generate(self, images, prompt, system=None, params=None, sequence=False):
        self.calls.append({"images": len(images), "prompt": prompt, "params": params, "sequence": sequence})
        text = "The dancer is in arabesque." if images else "No picture."
        return {"text": text, "prompt_tokens": 10, "image_tokens": 64 * len(images), "new_tokens": 6,
                "latency_ms": 5.0, "tokens_per_s": 1200.0, "steps": [], "params": params or {}}  # fmt: skip

    def tokenize(self, images, prompt, system=None, sequence=False):
        return {"total_tokens": 3 + 64 * len(images), "image_tokens": 64 * len(images), "pieces": []}

    def attention(self, images, prompt, answer=None, system=None, sequence=False):
        return {"answer": answer or "x", "layers": [{"image": 0.5, "prompt_text": 0.4, "answer": 0.1}]}

    def info(self):
        return {"model_id": self.model_id}


def png(color=(200, 30, 30)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (48, 48), color).save(buf, format="PNG")
    return buf.getvalue()


@pytest.fixture
def fake():
    return FakeVLM()


@pytest.fixture
def client(tmp_path, fake):
    settings = Settings(_env_file=None, data_dir=str(tmp_path), preload=False)
    with TestClient(create_app(settings, engine=fake)) as c:
        yield c
