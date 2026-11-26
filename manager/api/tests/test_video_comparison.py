"""Comparing analysed library videos: a reference and performances (needs ffmpeg)."""

from __future__ import annotations

import time

import pytest

from app.media.video_comparison import align, choose_roles, torso
from tests.test_manager import ARABESQUE
from tests.test_video_analysis import wait_until_analysed
from tests.test_videos import needs_ffmpeg, sample_video  # noqa: F401 - fixture


def test_a_skeleton_is_moved_and_scaled_onto_another_torso():
    small = [[x / 2 + 300, y / 2 + 100, v] for x, y, v in ARABESQUE]  # same pose, half size, elsewhere
    aligned = align(small, ARABESQUE)
    for (x, y, _), (ax, ay, _) in zip(ARABESQUE, aligned, strict=True):
        assert ax == pytest.approx(x, abs=0.2) and ay == pytest.approx(y, abs=0.2)
    hidden = [list(point) for point in ARABESQUE]
    hidden[11][2] = 0.1  # a hip not seen: no torso, no overlay
    assert torso(hidden) is None and align(hidden, ARABESQUE) is None


def test_roles_reference_and_newest_performance():
    class Video:
        def __init__(self, video_id, created):
            self.id, self.created = video_id, created

    first, second, third = Video("a", 1), Video("b", 2), Video("c", 3)
    assert [video.id for video in choose_roles([third, first, second], None)] == ["a", "c"]  # oldest, newest
    assert [video.id for video in choose_roles([third, first, second], "b")] == ["b", "c"]
    assert [video.id for video in choose_roles([third, first], "c")] == ["c", "a"]  # the reference is never the base


@needs_ffmpeg
def test_compare_two_analysed_videos_and_make_the_comparison_video(make_client, sample_video):  # noqa: F811
    with make_client([ARABESQUE] * 400, analyse_videos=True) as client:
        ids = []
        for name in ("lesson.mp4", "my-try.mp4"):
            with sample_video.open("rb") as file:
                ids.append(
                    client.post("/api/videos", files={"files": (name, file, "video/mp4")}).json()["saved"][0]["id"]
                )
            assert wait_until_analysed(client, ids[-1])["analysis"]["status"] == "done"
            time.sleep(0.01)
        lesson, attempt = ids

        preview = client.post("/api/video-comparisons/preview", json={"video_ids": [attempt, lesson]}).json()
        assert preview["reference"] == lesson and preview["base"] == attempt  # oldest = reference, newest = base
        roles = {video["id"]: video["role"] for video in preview["videos"]}
        assert roles == {attempt: "base", lesson: "reference"}
        frame = preview["frames"][10]
        overlay = [value for point in frame["overlays"][lesson] for value in point]
        assert overlay == pytest.approx(
            [value for point in frame["keypoints"] for value in point], abs=0.2
        )  # same place
        assert frame["scores"][attempt] == 100 and preview["mean_scores"][attempt] == 100

        shifted = client.post(
            "/api/video-comparisons/preview", json={"video_ids": [attempt, lesson], "offsets": {lesson: 2.0}}
        ).json()
        assert shifted["frames"][-1]["overlays"][lesson] is None  # 2 s later: the lesson has ended

        job = client.post("/api/video-comparisons/render", json={"video_ids": [attempt, lesson]}).json()
        deadline = time.monotonic() + 60
        while job["status"] == "running" and time.monotonic() < deadline:
            time.sleep(0.1)
            job = client.get(f"/api/video-comparisons/jobs/{job['id']}").json()
        assert job["status"] == "done", job
        made = job["video"]
        assert made["source"] == "comparison" and made["parent_id"] == attempt
        assert made["name"] == "comparison-my-try-vs-lesson.mp4" and abs(made["duration"] - 6) < 0.3
        listed = {video["id"]: video for video in client.get("/api/videos").json()}
        assert listed[made["id"]]["analysis"] is None  # a comparison is not analysed again
        assert client.get(made["url"]).content[4:8] == b"ftyp"

        too_few = client.post("/api/video-comparisons/preview", json={"video_ids": [attempt, attempt]})
        assert too_few.status_code == 422 and "at least two" in too_few.json()["detail"]
