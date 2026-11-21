"""Contrastive fine-tuning on a tiny random CLIP (no download)."""

from __future__ import annotations

import time

import numpy as np
import pytest

torch = pytest.importorskip("torch")
transformers = pytest.importorskip("transformers")


class TinyProcessor:
    def __call__(self, text=None, images=None, return_tensors="pt", **_):
        out = {}
        if images is not None:
            out["pixel_values"] = torch.stack(
                [
                    torch.tensor(np.asarray(im.resize((32, 32))), dtype=torch.float32).permute(2, 0, 1) / 255
                    for im in images
                ]
            )
        if text is not None:
            seqs = [[1] + [3 + sum(map(ord, w)) % 90 for w in t.split()][:10] + [2] for t in text]
            n = max(map(len, seqs))
            out["input_ids"] = torch.tensor([s + [0] * (n - len(s)) for s in seqs])
            out["attention_mask"] = torch.tensor([[1] * len(s) + [0] * (n - len(s)) for s in seqs])
        return transformers.BatchEncoding(out)

    def save_pretrained(self, path):
        pass


def tiny_encoder():
    from app.engine import HFEncoder

    cfg = transformers.CLIPConfig(
        text_config=dict(hidden_size=32, intermediate_size=64, num_hidden_layers=2, num_attention_heads=2,
                         vocab_size=100, max_position_embeddings=16, eos_token_id=2, bos_token_id=1),
        vision_config=dict(hidden_size=32, intermediate_size=64, num_hidden_layers=2, num_attention_heads=2,
                           image_size=32, patch_size=8),
        projection_dim=16,
    )  # fmt: skip
    return HFEncoder(transformers.CLIPModel(cfg).eval(), TinyProcessor(), "tiny/clip", "cpu", torch.float32)


def test_contrastive_job_trains_and_saves(tmp_path):
    from fastapi.testclient import TestClient

    from app.config import Settings
    from app.main import create_app
    from tests.conftest import png

    enc = tiny_encoder()
    assert enc.info()["vision"]["tokens"] == 17
    settings = Settings(_env_file=None, data_dir=str(tmp_path), preload=False)
    with TestClient(create_app(settings, encoder=enc)) as client:
        for label, color in (("arabesque", (250, 10, 10)), ("plié", (10, 10, 250))):
            for k in range(5):
                client.post(
                    "/v1/galleries/s/images",
                    files=[("images", ("a.png", png((color[0] - 9 * k, 40, color[2])), "image/png"))],
                    data={"label": label},
                )
        job = client.post("/v1/jobs", json={
            "kind": "contrastive", "gallery": "s", "name": "tuned", "epochs": 2, "batch_size": 4, "lr": 1e-3,
            "unfreeze": "last_n", "last_n": 1, "hard_negatives": {"beta": 1.0},
            "temperature": {"mode": "fixed", "value": 0.05}}).json()  # fmt: skip
        for _ in range(300):
            status = client.get(f"/v1/jobs/{job['id']}").json()
            if status["status"] != "running":
                break
            time.sleep(0.05)
        assert status["status"] == "completed", status
        assert len(status["history"]) == 2 and status["history"][-1]["temperature"] == pytest.approx(0.05, rel=1e-3)
        assert (tmp_path / "models" / "tuned" / "config.json").exists()
        assert client.get("/v1/models").json()["local"][0]["id"].endswith("tuned")
