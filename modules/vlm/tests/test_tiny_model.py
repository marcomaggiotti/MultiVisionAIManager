"""Real transformers code paths on a tiny random SmolVLM: generation, tokenization,
attention and a LoRA instruction-tuning job."""

from __future__ import annotations

import pytest

torch = pytest.importorskip("torch")
pytest.importorskip("peft")

from fastapi.testclient import TestClient  # noqa: E402

from app.config import Settings  # noqa: E402
from app.engine import HFVLM  # noqa: E402
from app.main import create_app  # noqa: E402
from tests.conftest import png  # noqa: E402
from tests.test_api import wait  # noqa: E402
from tests.tiny import tiny_smolvlm  # noqa: E402


@pytest.fixture
def tiny_client(tmp_path, monkeypatch):
    def load_parts(model_id, device=None, dtype="bfloat16", quantization="none", attn="eager"):
        model, processor = tiny_smolvlm()
        return model, processor, "cpu", torch.float32

    monkeypatch.setattr(HFVLM, "load_parts", staticmethod(load_parts))
    engine = HFVLM.load("tiny/smolvlm")
    settings = Settings(_env_file=None, data_dir=str(tmp_path), preload=False)
    with TestClient(create_app(settings, engine=engine)) as c:
        yield c


def test_inspection_endpoints(tiny_client):
    img = [("images", ("a.png", png(), "image/png"))]
    info = tiny_client.get("/v1/model").json()
    assert info["connector"] == "Idefics3Connector" and info["vision_encoder"]["patch_size"] == 8
    tok = tiny_client.post("/v1/tokenize", files=img, data={"prompt": "describe the pose"}).json()
    assert tok["image_tokens"] == 20 and any(p["kind"] == "image" for p in tok["pieces"])
    gen = tiny_client.post(
        "/v1/generate", files=img, data={"prompt": "describe", "params": '{"max_new_tokens": 4, "return_scores": true}'}
    ).json()
    assert gen["new_tokens"] <= 4 and len(gen["steps"]) == gen["new_tokens"]
    att = tiny_client.post("/v1/attention", files=img, data={"prompt": "describe", "answer": "a dancer"}).json()
    assert len(att["layers"]) == 2 and att["image_blocks"][0]["grid"] == [2, 2]
    assert len(att["heads_image_attention"][0]) == 2


def test_lora_job_and_adapter(tiny_client):
    for step in ("arabesque", "plié", "arabesque", "plié", "arabesque"):
        tiny_client.post(
            "/v1/datasets/qa/items",
            files=[("images", ("a.png", png(), "image/png"))],
            data={"instruction": "what step is this ?", "response": f"a dancer in {step} ."},
        )
    job = tiny_client.post(
        "/v1/jobs",
        json={
            "kind": "lora",
            "dataset": "qa",
            "name": "ballet-lora",
            "epochs": 2,
            "r": 4,
            "alpha": 8,
            "grad_accum": 2,
            "lr": 1e-3,
        },  # fmt: skip
    ).json()
    status = wait(tiny_client, job["id"])
    assert status["status"] == "completed", status.get("error")
    assert len(status["history"]) == 2 and status["result"]["val_examples"] == 1
    assert tiny_client.get("/v1/models").json()["adapters"][0]["name"] == "ballet-lora"
    assert tiny_client.put("/v1/adapter", json={"name": "ballet-lora"}).json() == {"adapter": "ballet-lora"}
    out = tiny_client.post("/v1/generate", data={"prompt": "what step is this ?", "params": '{"max_new_tokens": 3}'})
    assert out.status_code == 200 and out.json()["adapter"] == "ballet-lora"
    assert tiny_client.put("/v1/adapter", json={"name": None}).json() == {"adapter": None}
