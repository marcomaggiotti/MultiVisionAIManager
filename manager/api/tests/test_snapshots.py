"""The snapshot library: saved from the live studio, listed, read back, annotated, deleted."""

from __future__ import annotations

import io
import json

from PIL import Image


def picture(fmt: str = "JPEG") -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (120, 90), (200, 80, 40)).save(buffer, format=fmt)
    return buffer.getvalue()


def test_snapshot_library(make_client):
    with make_client([]) as client:
        info = {"name": "ballet-arabesque-0-04-4.jpg", "media_key": "class.mp4|1234", "source_time": 4.4,
                "movement": "arabesque", "corrections": ["Straighten the supporting knee"]}  # fmt: skip
        saved = client.post("/api/snapshots", files={"image": ("a.jpg", picture())}, data={"info": json.dumps(info)})
        assert saved.status_code == 201
        snapshot = saved.json()
        assert (
            snapshot["video_name"] == "class.mp4" and snapshot["width"] == 120 and snapshot["movement"] == "arabesque"
        )
        png = client.post("/api/snapshots", files={"image": ("b.png", picture("PNG"))}).json()  # stored as JPEG
        assert [item["id"] for item in client.get("/api/snapshots").json()] == [png["id"], snapshot["id"]]

        image = client.get(snapshot["url"])
        assert image.headers["content-type"] == "image/jpeg" and image.content == picture()
        assert client.get(png["url"]).content[:2] == b"\xff\xd8"
        assert (
            client.patch(f"/api/snapshots/{snapshot['id']}", json={"notes": "good line"}).json()["notes"] == "good line"
        )

        assert client.post("/api/snapshots", files={"image": ("x.jpg", b"not a picture")}).status_code == 422
        assert client.delete(f"/api/snapshots/{snapshot['id']}").status_code == 204
        assert client.get(f"/api/snapshots/{snapshot['id']}").status_code == 404
