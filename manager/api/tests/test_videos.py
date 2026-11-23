"""Cutting a video into a new file (needs ffmpeg; skipped without it)."""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from app.media.cutting import CutMode, ffmpeg_command, output_suffix, safe_file_name
from tests.test_adjustments import adjustment_body

needs_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg is not installed")


def test_names_and_commands():
    assert safe_file_name("../my clip (1).mp4", ".mp4") == "my-clip-1.mp4"
    assert safe_file_name("barre", ".webm") == "barre.webm"
    assert output_suffix(CutMode.PRECISE, ".webm") == ".mp4" and output_suffix(CutMode.FAST, ".MOV") == ".mov"
    command = ffmpeg_command(Path("in.webm"), Path("out.mp4"), 1.5, 4.0, CutMode.PRECISE)
    assert command[command.index("-ss") + 1] == "1.500" and command[command.index("-t") + 1] == "2.500"
    assert "libx264" in command
    assert "copy" in ffmpeg_command(Path("in.mp4"), Path("out.mp4"), 0, 1, CutMode.FAST)


def duration_of(path: Path) -> float:
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", str(path)],
        capture_output=True,
        text=True,
        check=True,
    )
    return float(json.loads(probe.stdout)["format"]["duration"])


@pytest.fixture
def sample_video(tmp_path: Path) -> Path:
    video = tmp_path / "rehearsal.mp4"
    subprocess.run(
        [
            "ffmpeg",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc=size=160x120:rate=15:duration=6",
            "-pix_fmt",
            "yuv420p",
            str(video),
        ],
        check=True,
    )
    return video


@needs_ffmpeg
def test_cut_returns_the_part_and_carries_adjustments_over(make_client, sample_video: Path, tmp_path: Path):
    with make_client([]) as client:
        for seconds in (1.0, 3.0, 5.5):  # only 3.0 s is inside the cut
            client.put("/api/keypoint-adjustments", json={**adjustment_body(seconds), "media_key": "rehearsal.mp4|1"})
        with sample_video.open("rb") as video:
            response = client.post(
                "/api/videos/cut",
                files={"video": ("rehearsal.mp4", video, "video/mp4")},
                data={"start": "2", "end": "4.5", "media_key": "rehearsal.mp4|1"},
            )
        assert response.status_code == 200, response.text
        name = response.headers["x-file-name"]
        assert name == "rehearsal-cut-2.0s-4.5s.mp4" and response.headers["x-adjustments-copied"] == "1"
        result = tmp_path / name
        result.write_bytes(response.content)
        assert abs(duration_of(result) - 2.5) < 0.2

        copied = client.get("/api/keypoint-adjustments", params={"media_key": f"{name}|{len(response.content)}"}).json()
        assert [adjustment["source_time"] for adjustment in copied] == [1.0]


@needs_ffmpeg
def test_cut_rejects_bad_ranges_and_bad_files(make_client, sample_video: Path):
    with make_client([]) as client:
        with sample_video.open("rb") as video:
            too_short = client.post(
                "/api/videos/cut", files={"video": ("a.mp4", video)}, data={"start": "3", "end": "3.05"}
            )
        assert too_short.status_code == 422
        not_a_video = client.post(
            "/api/videos/cut", files={"video": ("a.mp4", b"not a video")}, data={"start": "0", "end": "1"}
        )
        assert not_a_video.status_code == 422 and "ffmpeg" in not_a_video.json()["detail"]


@needs_ffmpeg
def test_library_upload_play_frames_rename_cut_delete(make_client, sample_video: Path):
    with make_client([]) as client:
        with sample_video.open("rb") as video:
            uploaded = client.post(
                "/api/videos",
                files=[
                    ("files", ("rehearsal.mp4", video, "video/mp4")),
                    ("files", ("notes.mp4", b"not a video", "video/mp4")),
                ],
            ).json()
        assert len(uploaded["saved"]) == 1 and uploaded["errors"][0]["file"] == "notes.mp4"
        video = uploaded["saved"][0]
        assert abs(video["duration"] - 6) < 0.2 and (video["width"], video["height"]) == (160, 120)
        assert video["media_key"] == f"rehearsal.mp4|{sample_video.stat().st_size}"
        assert [listed["id"] for listed in client.get("/api/videos").json()] == [video["id"]]

        assert client.get(video["thumbnail_url"]).headers["content-type"] == "image/jpeg"
        part = client.get(video["url"], headers={"Range": "bytes=0-99"})
        assert part.status_code == 206 and len(part.content) == 100

        frames = client.get(f"/api/videos/{video['id']}/frames", params={"start": 1, "end": 3, "count": 4}).json()
        assert [frame["time"] for frame in frames] == [1.25, 1.75, 2.25, 2.75]
        assert frames[0]["image"].startswith("data:image/jpeg;base64,")

        renamed = client.patch(f"/api/videos/{video['id']}", json={"name": "class 1.mov", "notes": "barre"}).json()
        assert renamed["name"] == "class 1.mp4" and renamed["notes"] == "barre"  # the extension stays

        client.put("/api/keypoint-adjustments", json={**adjustment_body(2.5), "media_key": renamed["media_key"]})
        cut = client.post(f"/api/videos/{video['id']}/cut", json={"start": 2, "end": 4}).json()
        assert cut["source"] == "cut" and cut["parent_id"] == video["id"] and cut["adjustments_copied"] == 1
        assert abs(cut["duration"] - 2) < 0.2 and len(client.get("/api/videos").json()) == 2

        assert client.delete(f"/api/videos/{video['id']}").status_code == 204
        assert client.get(f"/api/videos/{video['id']}").status_code == 404
        assert [listed["id"] for listed in client.get("/api/videos").json()] == [cut["id"]]


@needs_ffmpeg
def test_cut_of_a_browser_video_can_be_kept_in_the_library(make_client, sample_video: Path):
    with make_client([]) as client, sample_video.open("rb") as video:
        response = client.post(
            "/api/videos/cut",
            files={"video": ("rehearsal.mp4", video, "video/mp4")},
            data={"start": "1", "end": "2", "save_to_library": "true"},
        )
        assert response.status_code == 200
        kept = client.get(f"/api/videos/{response.headers['x-video-id']}").json()
        assert kept["source"] == "cut" and kept["size"] == len(response.content)
