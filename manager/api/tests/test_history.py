"""History of the modules' use: tabs (through the proxy), Analysis, VLM tools, agents."""

from __future__ import annotations

import io
import json

import pytest
from PIL import Image

import app.history.store as history_store
from tests.test_agents_and_flows import MODULES, Modules
from tests.test_manager import ARABESQUE, jpg


def picture() -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (200, 220), (90, 90, 90)).save(buffer, format="JPEG")
    return buffer.getvalue()


def entries(client, **filters) -> list[dict]:
    return client.get("/api/history", params=filters).json()["items"]


def test_module_tab_calls_through_the_proxy_are_recorded(make_client):
    with make_client([ARABESQUE, ARABESQUE]) as client:
        assert client.get("/api/modules/yolo/v1/model").status_code == 200  # GET: not recorded
        response = client.post(
            "/api/modules/yolo/v1/detect",
            params={"classes": "person", "confidence": "0.4"},
            files={"image": ("dancer.jpg", picture(), "image/jpeg")},
            headers={"Referer": "http://manager:3000/yolo"},
        )
        assert response.status_code == 200 and response.json()["detections"]  # the answer is still forwarded
        [entry] = entries(client)
        assert entry["module"] == "yolo" and entry["action"] == "/v1/detect" and entry["source"] == "YOLO tab"
        assert entry["summary"].startswith("1 detection(s): person ×1 · 1 with keypoints") and entry["ok"]
        detail = client.get(f"/api/history/{entry['id']}").json()
        assert detail["request"]["query"] == {"classes": "person", "confidence": "0.4"}
        assert detail["request"]["files"][0]["name"] == "dancer.jpg"
        assert detail["response"]["detections"][0]["keypoints"][0] == ARABESQUE[0]
        assert client.get(entry["picture_url"]).headers["content-type"] == "image/jpeg"


def test_analysis_vlm_tools_and_agents_are_recorded_with_their_source(make_client):
    modules = Modules()
    with make_client([], handler=modules, modules=MODULES) as client:
        client.post("/api/analyze", files=[("images", ("a.jpg", jpg(), "image/jpeg"))],
                    data={"options": json.dumps({"vlm": {"enabled": False}}), "save": "false"})  # fmt: skip
        ask = {"prompts": [{"name": "A", "text": "Describe the dance."}]}
        client.post(
            "/api/vlm/ask", data={"request": json.dumps(ask)}, files=[("images", ("a.jpg", picture(), "image/jpeg"))]
        )
        agent = {"goal": "What is it?", "tools": ["evaluate_ballet_pose"], "max_steps": 2}
        client.post(
            "/api/agents/run",
            data={"request": json.dumps(agent)},
            files=[("images", ("a.jpg", picture(), "image/jpeg"))],
        )

        sources = {(entry["source"], entry["module"]) for entry in entries(client)}
        assert {
            ("Analysis", "yolo"),
            ("Analysis", "clip"),
            ("VLM tools", "vlm"),
            ("Agent", "vlm"),
            ("Agent", "yolo"),
        } <= sources
        vlm_tools = entries(client, source="VLM tools")[0]
        assert vlm_tools["summary"].startswith("VLM: Describe the dance") and vlm_tools["request"]["pictures"] == 1
        assert entries(client, source="Analysis", module="clip")[0]["summary"] == "arabesque 0.71"

        stats = client.get("/api/history/stats").json()
        assert stats["modules"]["vlm"]["calls"] >= 3 and stats["sources"]["Agent"] >= 3
        assert [entry["source"] for entry in entries(client, q="Describe")] == ["VLM tools"]


def test_errors_delete_clear_and_the_size_limit(make_client, monkeypatch):
    monkeypatch.setattr(history_store, "MAX_ENTRIES", 3)
    with make_client([ARABESQUE] * 5) as client:
        for _ in range(5):
            client.post("/api/modules/yolo/v1/detect", files={"image": ("a.jpg", picture(), "image/jpeg")})
        kept = entries(client)
        assert len(kept) == 3 and client.get("/api/history").json()["total"] == 3

        assert client.delete(f"/api/history/{kept[0]['id']}").status_code == 204
        assert client.get(f"/api/history/{kept[0]['id']}").status_code == 404
        assert client.delete("/api/history", params={"module": "yolo"}).json() == {"deleted": 2}
        assert entries(client) == []


@pytest.mark.parametrize(
    "referer,source", [("http://h/clip?x=1", "CLIP tab"), (None, "API"), ("http://h/", "Live studio")]
)
def test_sources_from_the_page(referer, source):
    from app.history.recorder import source_from_referer

    assert source_from_referer(referer) == source
