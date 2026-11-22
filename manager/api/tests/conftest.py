"""Shared fixtures: a manager whose YOLO module answers a scripted sequence of poses."""

from __future__ import annotations

import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app


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
