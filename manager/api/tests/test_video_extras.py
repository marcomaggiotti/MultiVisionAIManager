"""Notes on a video's moments, and its sound: extracted and cleaned by the audio module."""

from __future__ import annotations

import json
import shutil
import subprocess
import time
from pathlib import Path

import httpx
import pytest

import app.media.video_audio as video_audio
from tests.conftest import Scripted

needs_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg is not installed")
MODULES = "yolo=http://yolo:8000,audio=http://audio:10000"


def make_video(path: Path, sound: bool) -> Path:
    command = ["ffmpeg", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=160x120:rate=15:duration=3"]
    if sound:
        command += ["-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-c:a", "aac", "-shortest"]
    subprocess.run([*command, "-pix_fmt", "yuv420p", str(path)], check=True)
    return path


class AudioModule:
    """The audio cleaning service: jobs that finish after one poll."""

    def __init__(self, agent_plan: dict):
        self.agent_plan = agent_plan
        self.created: list[dict] = []  # the form fields of each job
        self.polls: dict[str, int] = {}

    def __call__(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/health":
            return httpx.Response(200, json={"status": "ok"})
        if path == "/jobs" and request.method == "POST":
            body = request.content.decode(errors="replace")
            fields = {name: body.split(f'name="{name}"\r\n\r\n')[1].split("\r\n")[0]
                      for name in ("goal", "agent", "plan", "title") if f'name="{name}"' in body}  # fmt: skip
            assert "fLaC" in body  # the extracted FLAC is uploaded
            job_id = f"job{len(self.created) + 1}"
            self.created.append(fields)
            return httpx.Response(202, json={"id": job_id, "status": "queued", "status_url": f"/jobs/{job_id}"})
        job_id = path.split("/")[2]
        if path.endswith("/audio"):
            return httpx.Response(200, content=b"fLaC cleaned " + job_id.encode())
        if path.endswith("/spectrogram"):
            return httpx.Response(200, content=b"\x89PNG spectrogram")
        self.polls[job_id] = self.polls.get(job_id, 0) + 1
        if self.polls[job_id] == 1:
            return httpx.Response(200, json={"id": job_id, "status": "processing", "stage": "deciding"})
        fields = self.created[int(job_id[3:]) - 1]
        plan = json.loads(fields["plan"]) if "plan" in fields else self.agent_plan
        return httpx.Response(200, json={
            "id": job_id, "status": "completed", "stage": None, "notes": [f"{job_id} cleaned"],
            "analysis": {"snr_db": 12.0}, "result": {"snr_db": 30.0},
            "decision": {"agent": "heuristic", "goal": fields["goal"], "plan": plan, "reasoning": ["noise found"]},
        })  # fmt: skip


def handler(audio: AudioModule):
    yolo = Scripted([])
    return lambda request: audio(request) if request.url.host == "audio" else yolo(request)


def upload(client, path: Path) -> dict:
    with path.open("rb") as file:
        return client.post("/api/videos", files={"files": (path.name, file, "video/mp4")}).json()["saved"][0]


def wait_cleaned(client, video_id: str) -> dict:
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        audio = client.get(f"/api/videos/{video_id}/audio").json()
        if audio["state"]["status"] in ("done", "failed"):
            return audio
        time.sleep(0.02)
    raise AssertionError(audio)


@needs_ffmpeg
def test_notes_on_the_moments_of_a_video(make_client, tmp_path):
    with make_client([]) as client:
        video = upload(client, make_video(tmp_path / "class.mp4", sound=False))
        url = f"/api/videos/{video['id']}/notes"
        client.put(url, json={"source_time": 2.0, "text": "Plié: knees over the toes"})
        client.put(url, json={"source_time": 0.4667, "text": "  Teacher starts  "})
        assert [(note["source_time"], note["text"]) for note in client.get(url).json()] == [
            (0.467, "Teacher starts"), (2.0, "Plié: knees over the toes"),
        ]  # fmt: skip
        client.put(url, json={"source_time": 2.0, "text": "Plié: heels down"})  # replaced
        assert client.put(url, json={"source_time": 0.4667, "text": ""}).json() == {"note": None}  # removed
        assert [note["text"] for note in client.get(url).json()] == ["Plié: heels down"]
        client.delete(f"/api/videos/{video['id']}")
        assert client.app.state.video_notes.list(video["id"]) == []


@needs_ffmpeg
def test_the_sound_is_extracted_and_cleaned_keeping_its_timing(make_client, tmp_path, monkeypatch):
    monkeypatch.setattr(video_audio, "POLL_SECONDS", 0.01)
    module = AudioModule(agent_plan={"denoise": True, "denoise_db": 10, "remove_silence": True})
    with make_client([], handler=handler(module), modules=MODULES) as client:
        video = upload(client, make_video(tmp_path / "class.mp4", sound=True))
        base = f"/api/videos/{video['id']}/audio"
        assert client.get(base).json() == {"state": None, "original": None, "cleaned": None}
        extracted = client.post(f"{base}/extract").json()
        original = client.get(extracted["original"])
        assert original.headers["content-type"] == "audio/flac" and original.content[:4] == b"fLaC"

        client.post(f"{base}/clean", json={"goal": "podcast"})
        audio = wait_cleaned(client, video["id"])
        assert audio["state"]["status"] == "done", audio["state"]["error"]
        # the agent shortened pauses: its plan ran again without that step
        assert [job.get("agent") for job in module.created] == ["auto", None]
        assert json.loads(module.created[1]["plan"]) == {"denoise": True, "denoise_db": 10, "remove_silence": False}
        report = audio["state"]["report"]
        assert report["decision"]["plan"]["remove_silence"] is False and report["job_id"] == "job2"
        assert any("stays in time with the video" in note for note in report["notes"])
        assert report["analysis"] == {"snr_db": 12.0} and report["result"] == {"snr_db": 30.0}
        assert client.get(audio["cleaned"]).content == b"fLaC cleaned job2"
        assert client.get(f"{base}/spectrogram?version=original").content.startswith(b"\x89PNG")

        # a manual plan skips the agent, and never shortens pauses
        client.post(f"{base}/clean", json={"mode": "manual", "plan": {"dehum_hz": 50, "highpass_hz": 80}})
        assert wait_cleaned(client, video["id"])["state"]["status"] == "done"
        manual = json.loads(module.created[2]["plan"])
        assert manual["dehum_hz"] == 50 and manual["remove_silence"] is False and "agent" not in module.created[2]


@needs_ffmpeg
def test_a_video_without_sound(make_client, tmp_path):
    with make_client([]) as client:
        video = upload(client, make_video(tmp_path / "silent.mp4", sound=False))
        response = client.post(f"/api/videos/{video['id']}/audio/extract")
        assert response.status_code == 422 and "no sound" in response.json()["detail"]
        assert client.post(f"/api/videos/{video['id']}/audio/clean", json={"mode": "manual"}).status_code == 422
