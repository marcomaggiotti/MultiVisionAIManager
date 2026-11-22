"""Keypoint adjustments: saved per media and time, applied when the media is analysed again."""

from __future__ import annotations

from app.live.adjustments import KeypointAdjustment, box_around, find_adjustment, match_tolerance
from tests.test_manager import ARABESQUE, PLIE, jpg

MEDIA = "rehearsal.mp4|1234567"


def adjustment_body(source_time: float, keypoints=ARABESQUE) -> dict:
    return {"media_key": MEDIA, "source_time": source_time, "keypoints": keypoints}


def test_find_adjustment_uses_the_closest_within_tolerance():
    adjustments = [
        KeypointAdjustment(MEDIA, 1.0, ARABESQUE, box_around(ARABESQUE)),
        KeypointAdjustment(MEDIA, 2.0, PLIE, {}),
    ]
    assert find_adjustment(adjustments, 1.03).source_time == 1.0
    assert find_adjustment(adjustments, 1.5) is None
    assert find_adjustment(adjustments, None) is None
    # at 5 fps (0.2 s between frames) the closest frame may be 0.1 s away
    assert match_tolerance(0.2) == 0.1 and match_tolerance(None) == 0.05 and match_tolerance(2.0) == 0.25
    assert find_adjustment(adjustments, 1.09, match_tolerance(0.2)).source_time == 1.0
    box = box_around(ARABESQUE)
    assert box["x1"] < 30 and box["x2"] > 140  # spans the extended leg


def test_evaluate_and_save_list_delete(make_client):
    with make_client([]) as client:
        assert client.post("/api/ballet/evaluate", json={"keypoints": ARABESQUE}).json()["pose"]["step"] == "arabesque"
        assert client.post("/api/ballet/evaluate", json={"keypoints": ARABESQUE[:16]}).status_code == 422

        saved = client.put("/api/keypoint-adjustments", json=adjustment_body(1.0)).json()
        assert saved["evaluation"]["pose"]["step"] == "arabesque" and saved["adjustment"]["box"]["x2"] > 0
        client.put("/api/keypoint-adjustments", json=adjustment_body(1.0, PLIE))  # replaces the first one
        listed = client.get("/api/keypoint-adjustments", params={"media_key": MEDIA}).json()
        assert len(listed) == 1 and listed[0]["keypoints"][13] == [75.0, 150.0, 0.9]

        assert (
            client.delete("/api/keypoint-adjustments", params={"media_key": MEDIA, "source_time": 1.0}).status_code
            == 204
        )
        assert client.get("/api/keypoint-adjustments", params={"media_key": MEDIA}).json() == []
        assert (
            client.delete("/api/keypoint-adjustments", params={"media_key": MEDIA, "source_time": 1.0}).status_code
            == 404
        )


def test_live_session_uses_saved_and_new_adjustments(make_client):
    # The model always sees a plié; the user corrected the moments at 1.0 s and 3.0 s to an arabesque.
    with make_client([PLIE] * 10) as client:
        client.put("/api/keypoint-adjustments", json=adjustment_body(1.0))
        with client.websocket_connect("/api/live/ws") as ws:
            ws.receive_json()  # hello
            ws.send_json({"type": "config", "smoothing": 0.0})  # the scripted poses jump: no blending
            ws.receive_json()
            ws.send_json({"type": "media", "media_key": MEDIA})
            assert ws.receive_json()["adjustments"] == [1.0]

            def frame_at(seconds: float) -> dict:
                ws.send_json({"type": "frame", "source_time": seconds})
                ws.send_bytes(jpg())
                return ws.receive_json()

            near = frame_at(1.02)
            assert (
                near["adjusted"] and near["evaluation"]["pose"]["step"] == "arabesque" and near["source_time"] == 1.02
            )
            far = frame_at(1.5)
            assert not far["adjusted"] and far["evaluation"]["pose"]["step"] == "plié"

            client.put("/api/keypoint-adjustments", json=adjustment_body(3.0))  # saved during the session
            assert frame_at(3.01)["adjusted"]


def test_adjustment_follows_the_analysis_resolution():
    adjustment = KeypointAdjustment(MEDIA, 1.0, ARABESQUE, box_around(ARABESQUE), {"width": 200, "height": 220})
    doubled = adjustment.as_detection({"width": 400, "height": 440})
    assert doubled["keypoints"][0][:2] == [ARABESQUE[0][0] * 2, ARABESQUE[0][1] * 2]
    assert doubled["box"]["x2"] == round(adjustment.box["x2"] * 2, 1)
    assert adjustment.as_detection(None)["keypoints"] == ARABESQUE  # unknown size: as saved
