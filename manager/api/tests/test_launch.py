"""The manager launches modules: Docker containers and local processes."""

from __future__ import annotations

import json
import socket
import struct
import sys
import time

import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.launchers import demux
from app.main import create_app


class FakeDocker:
    """Docker Engine API for one Compose project, plus the modules' web services
    (which answer only while their container runs)."""

    def __init__(self):
        self.running = {"yolo": False, "clip": True}
        self.calls = []

    def docker(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        self.calls.append((request.method, path))
        if path == "/containers/json":
            labels = json.loads(request.url.params["filters"])["label"]
            service = labels[1].split("=")[1]
            assert labels[0] == "com.docker.compose.project=multivision"
            if service not in self.running:
                return httpx.Response(200, json=[])
            state = "running" if self.running[service] else "exited"
            return httpx.Response(200, json=[{"Id": f"id-{service}", "State": state}])
        service = path.split("/")[2].removeprefix("id-")
        if path.endswith("/start"):
            self.running[service] = True
            return httpx.Response(204)
        if path.endswith("/stop"):
            self.running[service] = False
            return httpx.Response(204)
        if path.endswith("/logs"):
            line = b"Uvicorn running\n"
            return httpx.Response(200, content=struct.pack(">BxxxL", 1, len(line)) + line)
        return httpx.Response(404)

    def modules(self, request: httpx.Request) -> httpx.Response:
        host = request.url.host
        if not self.running.get(host):
            raise httpx.ConnectError("connection refused")
        if request.url.path == "/v1/info":
            return httpx.Response(200, json={"name": host, "ui": "/ui/"})
        return httpx.Response(200, json={"status": "ok", "path": request.url.path})


@pytest.fixture
def docker_setup(tmp_path):
    registry = tmp_path / "modules.json"
    registry.write_text(json.dumps({"modules": [
        {"name": "yolo", "url": "http://yolo:8000", "launcher": {"type": "docker", "service": "yolo"},
         "repository": "https://github.com/marcomaggiotti/detect_image_engine", "start_timeout": 10},
        {"name": "clip", "url": "http://clip:8000", "launcher": {"type": "docker", "service": "clip"},
         "autostart": False},
        {"name": "vlm", "url": "http://vlm:8000", "launcher": {"type": "docker", "service": "vlm"}},
    ]}))  # fmt: skip
    fake = FakeDocker()
    settings = Settings(_env_file=None, data_dir=str(tmp_path), registry=str(registry))
    app = create_app(
        settings, transport=httpx.MockTransport(fake.modules), docker_transport=httpx.MockTransport(fake.docker)
    )
    with TestClient(app) as client:
        yield client, fake


def test_status_start_stop_and_logs(docker_setup):
    client, fake = docker_setup
    mods = {m["name"]: m for m in client.get("/api/modules").json()}
    assert mods["yolo"]["status"] == "offline" and mods["yolo"]["process"] == "stopped"
    assert mods["yolo"]["can_launch"] and mods["yolo"]["repository"].endswith("detect_image_engine")
    assert mods["clip"]["status"] == "online" and mods["vlm"]["process"] == "missing"

    started = client.post("/api/manage/yolo/start?wait=true").json()
    assert started["status"] == "online" and started["process"] == "running"
    assert client.get("/api/manage/yolo/logs").json()["logs"] == "Uvicorn running\n"
    stopped = client.post("/api/manage/yolo/stop").json()
    assert stopped["status"] == "offline" and fake.running["yolo"] is False
    missing = client.post("/api/manage/vlm/start?wait=true")
    assert missing.status_code == 409 and "docker compose create vlm" in missing.json()["detail"]


def test_module_is_launched_when_it_is_needed(docker_setup):
    client, fake = docker_setup
    r = client.get("/api/modules/yolo/v1/model")  # through the proxy: yolo is stopped
    assert r.status_code == 200 and r.json()["path"] == "/v1/model"
    assert ("POST", "/containers/id-yolo/start") in fake.calls
    fake.running["clip"] = False  # autostart off: the manager does not launch it
    assert client.get("/api/modules/clip/v1/info").status_code == 503
    assert client.post("/api/manage/clip/start?wait=true").status_code == 200  # but it can, on request


def test_demux_plain_and_framed():
    assert demux(b"plain text") == "plain text"
    assert demux(struct.pack(">BxxxL", 2, 3) + b"err" + struct.pack(">BxxxL", 1, 2) + b"ok") == "errok"


SERVER = """
import http.server, json, sys
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = json.dumps({"status": "ok", "name": "toy", "ui": "/ui/"}).encode()
        self.send_response(200); self.send_header("content-type", "application/json"); self.end_headers()
        self.wfile.write(body)
    def log_message(self, *a): print("request", self.path, flush=True)
print("toy module up", flush=True)
http.server.HTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
"""


def test_process_launcher_runs_a_local_module(tmp_path):
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    (tmp_path / "toy.py").write_text(SERVER)
    registry = tmp_path / "modules.json"
    registry.write_text(json.dumps({"modules": [{
        "name": "toy", "url": f"http://127.0.0.1:{port}", "start_timeout": 20,
        "launcher": {"type": "process", "command": [sys.executable, "toy.py", str(port)], "cwd": "."},
    }]}))  # fmt: skip
    settings = Settings(_env_file=None, data_dir=str(tmp_path / "data"), registry=str(registry))
    with TestClient(create_app(settings)) as client:
        assert client.get("/api/modules/toy").json()["process"] == "stopped"
        started = client.post("/api/manage/toy/start?wait=true").json()
        assert started["status"] == "online" and started["launcher"] == "process"
        assert client.get("/api/modules/toy/v1/info").json()["name"] == "toy"
        time.sleep(0.2)
        assert "toy module up" in client.get("/api/manage/toy/logs").json()["logs"]
        assert client.post("/api/manage/toy/stop").json()["process"] == "stopped"
