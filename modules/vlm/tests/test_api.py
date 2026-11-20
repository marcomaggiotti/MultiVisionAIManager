from __future__ import annotations

import json
import time

from app import metrics
from app.engine import grid_for, image_runs
from tests.conftest import png


def wait(client, job_id):
    for _ in range(200):
        status = client.get(f"/v1/jobs/{job_id}").json()
        if status["status"] != "running":
            return status
        time.sleep(0.05)
    raise AssertionError("job did not finish")


def test_info_presets_ui(client):
    assert client.get("/v1/info").json()["name"] == "vlm"
    presets = client.get("/v1/presets").json()
    assert "identify_step" in presets["prompts"] and presets["decoding"]["max_new_tokens"] == 256
    assert client.get("/ui/").status_code == 200
    assert client.get("/v1/models").json()["catalog"][0]["id"].startswith("HuggingFaceTB/SmolVLM-256M")


def test_generate_with_a_sequence_and_params(client, fake):
    files = [("images", (f"{i}.png", png(), "image/png")) for i in range(3)]
    res = client.post(
        "/v1/generate",
        files=files,
        data={"prompt": "What step?", "sequence": "true", "params": json.dumps({"max_new_tokens": 20})},
    )
    assert res.status_code == 200 and res.json()["image_tokens"] == 192
    assert fake.calls[-1] == {"images": 3, "prompt": "What step?", "params": {"max_new_tokens": 20}, "sequence": True}
    bad = client.post("/v1/generate", data={"prompt": "x", "params": json.dumps({"tempreture": 1})})
    assert bad.status_code == 422


def test_compare_decoding_tokenize_attention(client):
    res = client.post(
        "/v1/compare-decoding",
        files=[("images", ("a.png", png(), "image/png"))],
        data={"prompt": "x", "configs": json.dumps([{"do_sample": False}, {"num_beams": 3}])},
    ).json()
    assert len(res) == 2 and res[1]["config"] == {"num_beams": 3}
    assert client.post("/v1/tokenize", data={"prompt": "x"}).json()["image_tokens"] == 0
    assert client.post("/v1/attention", data={"prompt": "x"}).json()["layers"][0]["image"] == 0.5


def test_dataset_and_evaluation_job(client):
    for step in ("arabesque", "plié"):
        res = client.post(
            "/v1/datasets/ballet-qa/items",
            files=[("images", ("a.png", png(), "image/png"))],
            data={"instruction": "What step is this?", "response": f"The dancer is in {step}."},
        )
        assert res.status_code == 201
    items = client.get("/v1/datasets/ballet-qa").json()["items"]
    assert len(items) == 2 and client.get(f"/v1/datasets/ballet-qa/images/{items[0]['images'][0]}").status_code == 200
    job = client.post("/v1/jobs", json={"kind": "evaluate", "dataset": "ballet-qa"}).json()
    status = wait(client, job["id"])
    assert status["status"] == "completed", status
    summary = status["result"]["summary"]
    assert summary["exact_match"] == 0.5 and summary["keyword_recall"] == 0.5
    assert client.post("/v1/jobs", json={"kind": "nope", "dataset": "ballet-qa"}).status_code == 422


def test_metrics():
    assert metrics.exact_match("The Arabesque!", "arabesque") == 1.0
    assert metrics.token_f1("dancer in arabesque", "a dancer in attitude") == 2 * (2 / 3 * 2 / 3) / (4 / 3)
    assert metrics.rouge_l("x b c d", "x c d") > 0.8
    assert metrics.contains("she does a grand jeté", "Grand jeté") == 1.0
    assert metrics.keyword_recall("plié then relevé", "plié, relevé and tendu", ["plié", "relevé", "tendu"]) == 2 / 3


def test_image_runs_and_grids():
    assert image_runs([False, True, True, False, True]) == [(1, 2), (4, 1)]
    assert grid_for(64) == (8, 8) and grid_for(12, (3, 4)) == (3, 4) and grid_for(10) is None
