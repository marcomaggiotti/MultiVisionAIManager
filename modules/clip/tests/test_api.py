from __future__ import annotations

import time

import numpy as np

from app.analysis import projection
from app.training import hard_negative_loss, stratified_split
from tests.conftest import png


def files(*colors):
    return [("images", (f"{i}.png", png(c), "image/png")) for i, c in enumerate(colors)]


def test_info_presets_ui(client):
    assert client.get("/v1/info").json()["name"] == "clip"
    assert "arabesque" in client.get("/v1/presets").json()["ballet_steps"]
    assert client.get("/ui/").status_code == 200
    assert client.get("/v1/models").json()["active"] == "fake/clip"


def test_similarity_matrix_and_temperature(client):
    body = client.post(
        "/v1/similarity",
        files=files((255, 0, 0), (0, 0, 255)),
        data={"texts": "red\nblue\ngreen", "temperature": "0.5"},
    ).json()
    assert np.array(body["cosine"]).shape == (2, 3)
    assert body["logit_scale"] == 2.0
    assert abs(sum(body["image_to_text"][0]) - 1) < 1e-3
    assert np.array(body["text_to_image"]).shape == (3, 2)


def test_zero_shot_defaults_to_ballet_with_sensitivity(client):
    body = client.post("/v1/zero-shot", files=files((10, 200, 10))).json()
    r = body["results"][0]
    assert len(r["ranking"]) == 16 and abs(sum(x["probability"] for x in r["ranking"]) - 1) < 1e-3
    assert 0 <= r["sensitivity"]["agreement"] <= 1
    assert len(r["sensitivity"]["per_template"]) == len(body["templates"])
    sig = client.post("/v1/zero-shot", files=files((10, 200, 10)), data={"labels": "a,b", "mode": "sigmoid"}).json()
    assert sig["mode"] == "sigmoid"


def test_gallery_search_projection_evaluate(client):
    for label, color in (("arabesque", (250, 10, 10)), ("plié", (10, 10, 250))):
        for k in range(3):
            client.post(
                "/v1/galleries/studio/images", files=files((color[0] - k, color[1], color[2])), data={"label": label}
            )
    listing = client.get("/v1/galleries").json()
    assert listing[0]["items"] == 6 and listing[0]["labels"] == ["arabesque", "plié"]
    found = client.post(
        "/v1/galleries/studio/search", files={"image": ("q.png", png((250, 10, 10)), "image/png")}, data={"k": 3}
    ).json()
    assert all(r["label"] == "arabesque" for r in found["results"])
    assert client.post("/v1/galleries/studio/search", data={"text": "a dancer"}).status_code == 200
    proj = client.post("/v1/galleries/studio/projection", json={}).json()
    assert len(proj["images"]) == 6 and len(proj["texts"]) == 2 and proj["modality_gap"]
    ev = client.post("/v1/galleries/studio/evaluate", json={"templates": ["{}", "a {}"]}).json()
    assert len(ev["per_template"]) == 2 and ev["images"] == 6


def test_linear_probe_job_and_classify(client):
    for label, color in (("arabesque", (250, 10, 10)), ("plié", (10, 10, 250))):
        for k in range(6):
            client.post(
                "/v1/galleries/studio/images",
                files=files((color[0] - 5 * k, color[1] + 3 * k, color[2])),
                data={"label": label},
            )
    job = client.post(
        "/v1/jobs", json={"kind": "linear_probe", "gallery": "studio", "name": "p1", "epochs": 100}
    ).json()
    for _ in range(100):
        status = client.get(f"/v1/jobs/{job['id']}").json()
        if status["status"] != "running":
            break
        time.sleep(0.05)
    assert status["status"] == "completed", status
    assert status["result"]["val_accuracy"] == 1.0
    assert client.get("/v1/probes").json()[0]["classes"] == ["arabesque", "plié"]
    out = client.post("/v1/probes/p1/classify", files=files((240, 20, 10))).json()
    assert out["results"][0][0]["label"] == "arabesque"


def test_helpers():
    train, val = stratified_split(["a"] * 4 + ["b"] * 4, 0.25, 0)
    assert len(val) == 2 and len(train) == 6
    p = projection(np.eye(4)[:2], np.eye(4)[2:])
    assert p["modality_gap"]["centroid_distance"] > 0


def test_hard_negative_loss_matches_cross_entropy_at_beta_zero():
    import torch

    logits = torch.tensor([[2.0, 1.0, 0.5], [0.1, 0.3, 2.0]])
    t = torch.tensor([0, 2])
    ce = torch.nn.functional.cross_entropy(logits, t)
    assert torch.allclose(hard_negative_loss(logits, t, 0.0), ce, atol=1e-6)
    assert hard_negative_loss(logits, t, 2.0) > ce  # hard negatives weigh more
