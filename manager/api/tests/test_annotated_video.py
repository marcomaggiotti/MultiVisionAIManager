"""Captions of the movements (proposed, edited) and the annotated video added to the library."""

from __future__ import annotations

import json
import subprocess
import time

from app.media.annotated_video import active_captions, caption_text
from tests.test_manager import ARABESQUE
from tests.test_video_analysis import wait_until_analysed
from tests.test_video_extras import make_video, needs_ffmpeg, upload


def test_proposed_texts_and_when_captions_show():
    assert caption_text(["right_leg"]) == "Right leg moves"
    assert caption_text(["right_arm", "left_leg"]) == "Right arm and left leg move"
    assert caption_text(["right_leg", "left_leg", "body"]) == "Right leg, left leg and whole body move"
    assert caption_text(["right_arm", "left_arm", "head", "body"]) == "Whole body: right arm, left arm, head…"
    captions = [{"start": 5.0, "end": 7.0, "text": "Arabesque"}]
    assert active_captions(captions, 2.9, 2.0) == []  # more than 2 s before
    assert active_captions(captions, 3.0, 2.0) == captions  # 2 s before: announced
    assert active_captions(captions, 7.0, 2.0) == captions and active_captions(captions, 7.1, 2.0) == []


@needs_ffmpeg
def test_captions_are_edited_and_the_annotated_video_is_made(make_client, tmp_path):
    with make_client([ARABESQUE] * 100, analyse_videos=True) as client:
        video = upload(client, make_video(tmp_path / "class.mp4", sound=True))
        assert wait_until_analysed(client, video["id"])["analysis"]["status"] == "done"
        url = f"/api/videos/{video['id']}/captions"
        proposed = client.get(url).json()
        assert proposed["saved"] is False and proposed["anticipation"] == 2.0 and proposed["captions"] == []

        track = {"anticipation": 1.5, "threshold": 0.3, "captions": [
            {"start": 1.0, "end": 2.0, "text": "Lift the right leg", "limbs": ["right_leg"]},
            {"start": 0.2, "end": 0.6, "text": "  ", "limbs": []},  # emptied: removed
        ]}  # fmt: skip
        saved = client.put(url, json=track).json()
        assert saved["saved"] and [caption["text"] for caption in saved["captions"]] == ["Lift the right leg"]
        assert client.get(url).json()["anticipation"] == 1.5  # the saved track is used from now on

        job = client.post(f"/api/videos/{video['id']}/annotated-video", json=saved).json()
        deadline = time.monotonic() + 60
        while job["status"] == "running" and time.monotonic() < deadline:
            time.sleep(0.1)
            job = client.get(f"/api/render-jobs/{job['id']}").json()
        assert job["status"] == "done", job
        made = job["video"]
        assert (
            made["source"] == "annotated" and made["parent_id"] == video["id"] and made["name"] == "class-annotated.mp4"
        )
        listed = {item["id"]: item for item in client.get("/api/videos").json()}
        assert listed[made["id"]]["analysis"] is None  # made from the analysis: not analysed again
        path = client.app.state.library.file_path(made["id"])
        probe = ["ffprobe", "-v", "error", "-show_entries", "stream=codec_type", "-of", "json", str(path)]
        streams = subprocess.run(probe, capture_output=True, text=True, check=True).stdout
        assert sorted(stream["codec_type"] for stream in json.loads(streams)["streams"]) == ["audio", "video"]

        # the cartoon cat in the dancer's place
        job = client.post(
            f"/api/videos/{video['id']}/annotated-video", json={**saved, "character": "cat", "hide_dancer": True}
        ).json()
        deadline = time.monotonic() + 60
        while job["status"] == "running" and time.monotonic() < deadline:
            time.sleep(0.1)
            job = client.get(f"/api/render-jobs/{job['id']}").json()
        assert job["status"] == "done", job
        assert job["video"]["name"] == "class-cat.mp4" and job["video"]["source"] == "annotated"

        assert client.delete(url).status_code == 204
        assert client.get(url).json()["saved"] is False
