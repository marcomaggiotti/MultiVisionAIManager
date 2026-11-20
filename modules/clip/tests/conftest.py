from __future__ import annotations

import hashlib
import io

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.config import Settings
from app.engine import Encoder, normalize
from app.main import create_app


class FakeEncoder(Encoder):
    """Deterministic embeddings: an image's mean colour, a text's hash."""

    model_id = "fake/clip"
    family = "clip"
    dim = 8

    def embed_images(self, images):
        rows = []
        for im in images:
            r, g, b = np.asarray(im.resize((4, 4))).reshape(-1, 3).mean(0) / 255
            rows.append([r, g, b, 1 - r, 1 - g, 1 - b, 0.1, 0.1])
        return normalize(np.array(rows, dtype=np.float32))

    def embed_texts(self, texts):
        rows = []
        for t in texts:
            h = hashlib.sha256(t.encode()).digest()
            rows.append([b / 255 for b in h[: self.dim]])
        return normalize(np.array(rows, dtype=np.float32))

    def tokenize(self, texts):
        return [{"text": t, "tokens": t.split(), "ids": list(range(len(t.split()))), "length": len(t.split()),
                 "max_length": 77, "truncated": False} for t in texts]  # fmt: skip

    @property
    def logit_scale(self):
        return 100.0

    def info(self):
        return {"model_id": self.model_id, "family": self.family, "embed_dim": self.dim}


def png(color=(200, 30, 30), size=(32, 32)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, format="PNG")
    return buf.getvalue()


@pytest.fixture
def client(tmp_path):
    settings = Settings(_env_file=None, data_dir=str(tmp_path), preload=False)
    with TestClient(create_app(settings, encoder=FakeEncoder())) as c:
        yield c
