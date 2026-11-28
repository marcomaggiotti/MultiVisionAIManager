"""Everything the databases hold about one analysed frame, table by table."""

from __future__ import annotations

from tests.test_manager import ARABESQUE
from tests.test_video_analysis import wait_until_analysed
from tests.test_video_extras import make_video, needs_ffmpeg, upload


@needs_ffmpeg
def test_the_frame_record_lists_every_table_with_the_frame_rows(make_client, tmp_path):
    with make_client([ARABESQUE] * 100, analyse_videos=True) as client:
        video = upload(client, make_video(tmp_path / "class.mp4", sound=False))
        assert wait_until_analysed(client, video["id"])["analysis"]["status"] == "done"
        frames = client.get(f"/api/videos/{video['id']}/keypoints").json()["frames"]
        time = frames[5]["source_time"]
        client.put(f"/api/videos/{video['id']}/notes", json={"source_time": time, "text": "Shoulders down"})
        client.put(f"/api/videos/{video['id']}/captions", json={"allowed_limbs": ["right_leg"], "captions": [
            {"start": time + 1, "end": time + 2, "text": "Lift the right leg", "limbs": ["right_leg"]},  # announced now
            {"start": time + 5, "end": time + 6, "text": "Later", "limbs": ["right_leg"]},
        ]})  # fmt: skip

        record = client.get(f"/api/videos/{video['id']}/frame-record", params={"t": time + 0.01}).json()
        assert record["seconds"] == time and record["picture_url"].endswith(f"/{record['index']}.jpg")
        assert client.get(record["picture_url"]).headers["content-type"] == "image/jpeg"
        tables: dict = {}
        for section in record["sections"]:  # "videos" twice: the video, then the related videos
            tables.setdefault(section["table"], section)
        assert record["sections"][-1]["table"] == "videos" and record["sections"][-1]["rows"] == []
        assert {"videos", "video_analyses", "pictures", "pictures › analysis document", "video_keypoints",
                "keypoint_adjustments", "video_notes", "video_captions", "limb movement", "snapshots",
                "video_audio"} <= set(tables)  # fmt: skip
        assert tables["videos"]["database"] == "manager.sqlite3" and tables["videos"]["rows"][0]["name"] == "class.mp4"
        assert tables["video_analyses"]["rows"][0]["status"] == "done"
        pictures = tables["pictures"]
        assert pictures["database"] == "pictures.sqlite3"
        assert sorted(row["content_type"] for row in pictures["rows"]) == ["application/json", "image/jpeg"]
        assert all("data" not in row and row["data_bytes"] > 0 for row in pictures["rows"])  # bytes: size only
        [entry] = tables["pictures › analysis document"]["rows"]
        assert entry["source_time"] == time and len(entry["dancer"]["keypoints"]) == 17
        [keypoints] = tables["video_keypoints"]["rows"]
        assert keypoints["media_key"] == video["media_key"] and len(keypoints["keypoints"]) == 17  # JSON decoded
        assert "media_key = 'class.mp4|" in tables["video_keypoints"]["query"]
        assert tables["keypoint_adjustments"]["rows"] == []
        assert [note["text"] for note in tables["video_notes"]["rows"]] == ["Shoulders down"]
        [track] = tables["video_captions"]["rows"]
        assert track["data"]["captions_in_track"] == 2 and track["data"]["allowed_limbs"] == ["right_leg"]
        assert [caption["text"] for caption in track["data"]["captions"]] == ["Lift the right leg"]  # shown now
        limbs = {row["limb"]: row for row in tables["limb movement"]["rows"]}
        assert tables["limb movement"]["database"] == "computed" and limbs["right_leg"]["moving"] is False
        assert client.get("/api/videos/nope/frame-record", params={"t": 1}).status_code == 404
