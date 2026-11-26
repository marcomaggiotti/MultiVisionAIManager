"""Library videos are analysed by the manager when they are added (needs ffmpeg)."""

from __future__ import annotations

import pathlib
import time

import pytest

from app.media.video_analysis import frame_rate, scaled_size, split_jpegs
from tests.test_manager import ARABESQUE
from tests.test_videos import adjustment_body, needs_ffmpeg, sample_video  # noqa: F401 - fixture

FIRST_POSITION_LIKE = ARABESQUE


def wait_until_analysed(client, video_id: str, timeout: float = 60) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        video = client.get(f"/api/videos/{video_id}").json()
        if video["analysis"] and video["analysis"]["status"] in ("done", "failed"):
            return video
        time.sleep(0.05)
    raise AssertionError(f"not analysed in time: {video['analysis']}")


def test_helpers():
    assert frame_rate(10, 15) == 15 and frame_rate(600, 15) == pytest.approx(2.5)  # at most 1500 frames
    assert scaled_size(1920, 1080) == (640, 360) and scaled_size(478, 850) == (360, 640)
    assert scaled_size(160, 120) == (160, 120)
    buffer = bytearray(b"junk\xff\xd8one\xff\xd9\xff\xd8two\xff\xd9\xff\xd8thr")
    assert split_jpegs(buffer) == [b"\xff\xd8one\xff\xd9", b"\xff\xd8two\xff\xd9"] and buffer == b"\xff\xd8thr"


@needs_ffmpeg
def test_an_added_video_is_analysed_saved_and_kept_up_to_date(make_client, sample_video):  # noqa: F811
    with make_client([FIRST_POSITION_LIKE] * 400, analyse_videos=True) as client:
        with sample_video.open("rb") as file:
            [added] = client.post("/api/videos", files={"files": ("rehearsal.mp4", file, "video/mp4")}).json()["saved"]
        assert added["analysis"]["status"] in ("queued", "running")
        assert client.get(f"/api/videos/{added['id']}/analysis").status_code == 404  # not ready yet

        video = wait_until_analysed(client, added["id"])
        assert video["analysis"]["status"] == "done", video["analysis"]
        analysis = client.get(f"/api/videos/{added['id']}/analysis").json()
        frames = analysis["frames"]
        assert analysis["fps"] == 15 and 85 <= len(frames) <= 91  # 6 s at 15 frames per second
        assert [frame["t"] for frame in frames[:3]] == [0.0, 0.067, 0.133]  # video time, not the wall clock
        assert frames[0]["source_time"] == 0.0 and frames[0]["dancer"]["keypoints"]
        assert frames[0]["evaluation"]["pose"] and analysis["counts"]
        assert video["keypoint_frames"] == len(frames) and video["analysis"]["frames"] == len(frames)
        run = analysis["run"]
        picture = client.get(f"/api/videos/{added['id']}/analysis/frames/{run}/3.jpg")
        assert picture.headers["content-type"] == "image/jpeg" and picture.content[:2] == b"\xff\xd8"
        # the pictures are in the picture database, not in files
        pictures = client.app.state.pictures
        assert pictures.name == "database" and pictures.get(f"frames/{added['id']}/{run}/3.jpg") == picture.content
        assert not list(pathlib.Path(client.app.state.settings.data_dir).glob("analyses/*"))
        assert any(session["id"] == f"analysis-{added['id']}" for session in client.get("/api/live/sessions").json())

        # a keypoint correction replaces the analysed frame and its track; removing it restores the model's
        moment = frames[30]["source_time"]
        body = {**adjustment_body(moment), "media_key": video["media_key"]}
        assert client.put("/api/keypoint-adjustments", json=body).status_code == 200
        corrected = client.get(f"/api/videos/{added['id']}/analysis").json()["frames"][30]
        assert corrected["adjusted"] and corrected["dancer"]["keypoints"] == body["keypoints"]
        track = client.get(f"/api/videos/{added['id']}/keypoints", params={"start": moment, "end": moment}).json()
        assert track["frames"][0]["adjusted"] and track["frames"][0]["keypoints"] == body["keypoints"]
        client.delete("/api/keypoint-adjustments", params={"media_key": video["media_key"], "source_time": moment})
        restored = client.get(f"/api/videos/{added['id']}/analysis").json()["frames"][30]
        assert not restored["adjusted"] and restored["dancer"] == frames[30]["dancer"]

        # renamed: the keypoints follow the video
        renamed = client.patch(f"/api/videos/{added['id']}", json={"name": "class"}).json()
        assert renamed["name"] == "class.mp4" and renamed["keypoint_frames"] == len(frames)

        # analysed again with other settings
        again = client.post(f"/api/videos/{added['id']}/analysis", json={"fps": 5}).json()
        assert again["analysis"]["status"] == "queued" and again["analysis"]["settings"]["fps"] == 5
        assert wait_until_analysed(client, added["id"])["analysis"]["frames"] in range(29, 32)
        new_run = client.get(f"/api/videos/{added['id']}/analysis").json()["run"]
        assert (
            new_run != run and client.get(f"/api/videos/{added['id']}/analysis/frames/{run}/3.jpg").status_code == 404
        )
        assert {key.split("/")[2] for key in pictures.keys(f"frames/{added['id']}/")} == {new_run}  # old pictures gone

        assert client.delete(f"/api/videos/{added['id']}").status_code == 204
        assert client.get(f"/api/videos/{added['id']}/analysis/frames/{new_run}/0.jpg").status_code == 404
        assert (
            list(pictures.keys(f"frames/{added['id']}/")) == [] and pictures.get(f"analyses/{added['id']}.json") is None
        )
