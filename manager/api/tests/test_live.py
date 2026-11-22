"""Real-time ballet feedback: recognition, feedback rules, sessions over WebSocket."""

from __future__ import annotations

import copy

import httpx
import pytest
from fastapi.testclient import TestClient

from app import ballet
from app.ballet import evaluate_pose
from app.config import Settings
from app.main import create_app
from tests.test_manager import ARABESQUE, PLIE, jpg

# Arabesque with a bent supporting (left) knee: the knee moves forward.
BENT_ARABESQUE = copy.deepcopy(ARABESQUE)
BENT_ARABESQUE[13] = [104, 160, 0.9]
BENT_ARABESQUE[15] = [92, 200, 0.9]


def test_recognition_and_feedback():
    a = evaluate_pose(ARABESQUE).to_api()
    assert a["pose"]["step"] == "arabesque" and a["working_side"] == "right"
    assert all(i["status"] == "ok" for i in a["feedback"])
    b = evaluate_pose(BENT_ARABESQUE).to_api()
    bad = [i for i in b["feedback"] if i["status"] != "ok"]
    assert b["pose"]["step"] == "arabesque"
    assert any(i["part"] == "left_leg" and "Supporting knee" in i["message"] for i in bad)
    assert b["parts"]["left_leg"] in {"warn", "bad"}
    p = evaluate_pose(PLIE).to_api()
    assert p["pose"]["step"] == "plié" and "demi-plié" in p["feedback"][0]["message"]
    hidden = [[0, 0, 0.1]] * 17
    hidden_evaluation = evaluate_pose(hidden)
    assert hidden_evaluation.recognised is None
    assert "whole body" in hidden_evaluation.corrections[0].message
    vocab = ballet.vocabulary()
    assert set(vocab["families"]["adagio"]) <= set(vocab["poses"])


class Scripted:
    """YOLO module answering a scripted sequence of poses."""

    def __init__(self, script):
        self.script = list(script)

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if request.url.path == "/health":
            return httpx.Response(200, json={"status": "ok"})
        kps = self.script.pop(0) if self.script else None
        box = {"x1": 20, "y1": 30, "x2": 150, "y2": 205}
        dets = (
            [] if kps is None else [{"label": "person", "class_id": 0, "confidence": 0.9, "box": box, "keypoints": kps}]
        )
        return httpx.Response(200, json={
            "model": {"weights": "yolo11n-pose.pt"}, "image": {"width": 200, "height": 220},
            "counts": {"person": len(dets)}, "detections": dets, "inference_ms": 8.0,
        })  # fmt: skip


@pytest.fixture
def make_client(tmp_path):
    def make(script):
        settings = Settings(_env_file=None, data_dir=str(tmp_path), modules="yolo=http://yolo:8000")
        return TestClient(create_app(settings, transport=httpx.MockTransport(Scripted(script))))

    return make


def test_websocket_session_counts_poses_and_logs_corrections(make_client):
    script = [ARABESQUE] * 6 + [BENT_ARABESQUE] * 6 + [PLIE] * 6 + [None] * 5
    with make_client(script) as client, client.websocket_connect("/api/live/ws") as ws:
        hello = ws.receive_json()
        assert hello["type"] == "hello"
        ws.send_json({"type": "config", "hold": 3, "smoothing": 0.0})
        assert ws.receive_json()["hold"] == 3
        results = []
        for _ in script:
            ws.send_bytes(jpg())
            results.append(ws.receive_json())
        assert all(r["type"] == "frame" for r in results)
        assert results[0]["current"]["step"] is None  # not held long enough yet
        assert results[3]["current"]["step"] == "arabesque"
        assert results[16]["current"]["step"] == "plié"
        events = [e["step"] for r in results for e in r["new_events"]]
        assert events == ["arabesque", "plié"]
        assert results[-1]["counts"] == {"arabesque": 1, "plié": 1}
        comments = [c for r in results for c in r["new_comments"]]
        assert any("Supporting knee" in c["message"] for c in comments)
        assert results[2]["evaluation"]["pose"]["step"] == "arabesque"
        assert results[-1]["dancer"] is None and results[-1]["latency_ms"]["yolo"] == 8.0
        ws.send_json({"type": "summary"})
        summary = ws.receive_json()
        assert summary["type"] == "summary" and summary["frames"] == len(script)


def test_http_frame_and_saved_sessions(make_client):
    with make_client([ARABESQUE, ARABESQUE]) as client:
        first = client.post("/api/live/frame", files={"image": ("f.jpg", jpg(), "image/jpeg")}).json()
        second = client.post(
            f"/api/live/frame?session_id={first['session']}", files={"image": ("f.jpg", jpg(), "image/jpeg")}
        ).json()
        assert second["session"] == first["session"] and second["frame"] == 2
        saved = client.post("/api/live/sessions", json={"title": "barre", "frames": 2, "duration_s": 1.5,
                                                         "counts": {"plié": 3}, "events": []}).json()  # fmt: skip
        listing = client.get("/api/live/sessions").json()
        assert listing[0]["id"] == saved["id"] and listing[0]["counts"] == {"plié": 3}
        assert client.get(f"/api/live/sessions/{saved['id']}").json()["title"] == "barre"
        assert "arabesque" in client.get("/api/ballet/vocabulary").json()["poses"]
        assert client.patch(f"/api/live/sessions/{saved['id']}", json={"title": "barre 2"}).status_code == 200
        assert client.get("/api/live/sessions").json()[0]["title"] == "barre 2"
        assert client.delete(f"/api/live/sessions/{saved['id']}").status_code == 204
        assert client.get("/api/live/sessions").json() == []
        assert client.delete(f"/api/live/sessions/{saved['id']}").status_code == 404
