from __future__ import annotations

import io
import json

import httpx
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app import pose
from app.config import Settings
from app.main import create_app

# A dancer facing right in arabesque: standing on the left leg, right leg extended behind.
ARABESQUE = [
    [115, 40, 0.9], [112, 37, 0.9], [118, 37, 0.9], [108, 38, 0.9], [120, 38, 0.3],
    [90, 60, 0.9], [110, 60, 0.9], [80, 80, 0.9], [125, 50, 0.9], [70, 100, 0.9], [140, 40, 0.9],
    [92, 120, 0.9], [108, 120, 0.9], [92, 160, 0.9], [70, 118, 0.9], [92, 200, 0.9], [30, 115, 0.9],
]  # fmt: skip
PLIE = [
    [100, 40, 0.9], [98, 37, 0.9], [102, 37, 0.9], [96, 38, 0.9], [104, 38, 0.9],
    [90, 60, 0.9], [110, 60, 0.9], [80, 80, 0.9], [120, 80, 0.9], [75, 100, 0.9], [125, 100, 0.9],
    [92, 120, 0.9], [108, 120, 0.9], [75, 150, 0.9], [125, 150, 0.9], [90, 180, 0.9], [110, 180, 0.9],
]  # fmt: skip


def jpg() -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (200, 220), (90, 90, 90)).save(buf, format="JPEG")
    return buf.getvalue()


def fake_modules(request: httpx.Request) -> httpx.Response:
    host, path = request.url.host, request.url.path
    if path == "/v1/info":
        if host == "vlm":
            return httpx.Response(503, json={"detail": "loading"})
        return httpx.Response(200, json={"name": host, "ui": "/ui/", "model": f"{host}-model"})
    if host == "yolo" and path == "/v1/detect":
        kps = ARABESQUE if fake_modules.calls % 2 == 0 else PLIE
        fake_modules.calls += 1
        return httpx.Response(200, json={
            "model": {"backend": "ultralytics", "weights": "yolo11n-pose.pt"}, "counts": {"person": 1},
            "detections": [{"label": "person", "class_id": 0, "confidence": 0.9,
                            "box": {"x1": 20, "y1": 30, "x2": 150, "y2": 205}, "keypoints": kps}],
        })  # fmt: skip
    if host == "clip" and path == "/v1/zero-shot":
        n = request.content.count(b'filename="crop')
        res = {"ranking": [{"label": "arabesque", "probability": 0.6}, {"label": "attitude", "probability": 0.2}],
               "sensitivity": {"agreement": 0.83}}  # fmt: skip
        return httpx.Response(200, json={"results": [res] * n})
    if host == "vlm" and path == "/v1/generate":
        assert b"pose cues" in request.content  # the perception context reaches the VLM
        return httpx.Response(200, json={"text": "This is an Arabesque, then a plie.", "latency_ms": 12})
    if host == "yolo" and path == "/ui/":
        return httpx.Response(200, text="<html>yolo</html>", headers={"content-type": "text/html"})
    if host == "yolo" and path == "/v1/lab/runtime":
        return httpx.Response(200, json={"method": request.method, "body": json.loads(request.content or b"{}")})
    if host == "yolo" and path == "/redirect":
        return httpx.Response(307, headers={"location": "http://yolo:8000/ui/"})
    return httpx.Response(404, json={"detail": "not found"})


fake_modules.calls = 0


@pytest.fixture
def client(tmp_path):
    settings = Settings(
        _env_file=None, data_dir=str(tmp_path),
        modules="yolo=http://yolo:8000,clip=http://clip:8000,vlm=http://vlm:8000",
    )  # fmt: skip
    with TestClient(create_app(settings, transport=httpx.MockTransport(fake_modules))) as c:
        yield c


def test_pose_cues_recognise_arabesque_and_plie():
    a = pose.analyse(ARABESQUE)
    assert a["angles"]["right_leg_elevation"] > 85 and a["angles"]["right_knee"] > 170
    assert any("arabesque" in c["steps"] for c in a["cues"])
    p = pose.analyse(PLIE)
    assert any("plié" in c["steps"] for c in p["cues"])
    m = pose.motion([{"keypoints": ARABESQUE, "pose": a}, {"keypoints": PLIE, "pose": p}])
    assert m["peak_leg_elevation_frame"] == 0 and m["transitions"][0]["mean_joint_motion"] > 0


def test_module_status(client):
    mods = {m["name"]: m for m in client.get("/api/modules").json()}
    assert mods["yolo"]["status"] == "online" and mods["yolo"]["ui"] == "/api/modules/yolo/ui/"
    assert mods["vlm"]["status"] == "offline"


def test_proxy_forwards_methods_bodies_and_redirects(client):
    assert client.get("/api/modules/yolo/ui/").text == "<html>yolo</html>"
    r = client.put("/api/modules/yolo/v1/lab/runtime", json={"iou_threshold": 0.5}).json()
    assert r == {"method": "PUT", "body": {"iou_threshold": 0.5}}
    redirect = client.get("/api/modules/yolo/redirect", follow_redirects=False)
    assert redirect.headers["location"] == "/api/modules/yolo/ui/"
    assert client.get("/api/modules/nope/x").status_code == 404


def test_analyze_sequence_fuses_evidence_and_is_saved(client):
    fake_modules.calls = 0
    files = [("images", (f"{i}.jpg", jpg(), "image/jpeg")) for i in range(2)]
    res = client.post("/api/analyze", files=files, data={"title": "class 1"})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["errors"] == []
    assert body["frames"][0]["dancer"]["pose"]["cues"]
    assert body["frames"][1]["clip"]["top"][0]["label"] == "arabesque"
    assert body["motion"]["peak_leg_elevation_frame"] == 0
    assert body["fused"][0]["step"] == "arabesque"
    assert "named by the VLM" in body["fused"][0]["evidence"]
    saved = client.get("/api/analyses").json()
    assert saved[0]["id"] == body["id"] and saved[0]["top"] == "arabesque" and saved[0]["frames"] == 2
    assert client.get(f"/api/analyses/{body['id']}").json()["vlm"]["text"].startswith("This is")
    assert client.get(f"/api/analyses/{body['id']}/frames/1").status_code == 200


def test_analyze_survives_a_missing_module(client):
    opts = {"vlm": {"enabled": False}, "clip": {"enabled": True}}
    body = client.post(
        "/api/analyze", files=[("images", ("a.jpg", jpg(), "image/jpeg"))],
        data={"options": json.dumps(opts), "save": "false"},
    ).json()  # fmt: skip
    assert body["vlm"] is None and "id" not in body and body["fused"]


def test_knowledge_endpoints(client):
    assert len(client.get("/api/ballet").json()["keypoints"]) == 17
    assert len(client.get("/api/architecture").json()["layers"]) == 7
