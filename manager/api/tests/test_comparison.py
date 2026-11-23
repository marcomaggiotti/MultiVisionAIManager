"""Comparing a student with a reference dancer: angles, mirror, delay, live score."""

from __future__ import annotations

import io
import struct

import httpx
from PIL import Image

from app.ballet.comparison import MirrorMode, Tolerance, best_comparison, compare_angles, joint_score, joint_status
from app.ballet.measurements import measure_joint_angles
from app.live.comparison import ComparisonSession, ComparisonSettings
from tests.test_manager import ARABESQUE, PLIE

LEFT_RIGHT_PAIRS = [(1, 2), (3, 4), (5, 6), (7, 8), (9, 10), (11, 12), (13, 14), (15, 16)]


def mirrored(keypoints: list[list[float]]) -> list[list[float]]:
    """The pose in a mirror: what the camera sees of a student copying it face to face."""
    swapped = [list(point) for point in keypoints]
    for left, right in LEFT_RIGHT_PAIRS:
        swapped[left], swapped[right] = list(keypoints[right]), list(keypoints[left])
    return [[200 - x, y, visibility] for x, y, visibility in swapped]


def detections(keypoints) -> dict:
    box = {"x1": 20, "y1": 30, "x2": 150, "y2": 205}
    people = [{"label": "person", "confidence": 0.9, "box": box, "keypoints": keypoints}] if keypoints else []
    return {"detections": people, "image": {"width": 200, "height": 220}}


def test_scores_and_statuses():
    tolerance = Tolerance(good=15, fair=30)
    assert [joint_status(d, tolerance) for d in (10, -20, 45)] == ["ok", "warn", "bad"]
    assert joint_score(15, tolerance) == 1.0 and joint_score(60, tolerance) == 0.0
    assert 0.4 < joint_score(-37.5, tolerance) < 0.6


def test_same_pose_matches_and_different_pose_gets_corrections():
    arabesque = measure_joint_angles(ARABESQUE)
    same = compare_angles(arabesque, arabesque)
    assert same.score == 100.0 and set(same.parts.values()) == {"ok"}

    versus_plie = compare_angles(arabesque, measure_joint_angles(PLIE))
    assert versus_plie.score < 60
    worst = versus_plie.corrections()[0]
    assert worst["status"] == "bad" and "reference" in worst["message"]
    assert versus_plie.parts["right_leg"] == "bad"  # the working leg is raised only in the arabesque


def test_mirror_mode_pairs_left_with_right():
    reference = measure_joint_angles(ARABESQUE)
    student = measure_joint_angles(mirrored(ARABESQUE))
    assert compare_angles(reference, student).score < 80
    automatic = best_comparison(reference, student, mode=MirrorMode.AUTO)
    assert automatic.mirrored and automatic.score == 100.0
    assert not best_comparison(reference, student, mode=MirrorMode.SAME_SIDE).mirrored


def test_a_student_who_lags_behind_still_matches():
    session = ComparisonSession(ComparisonSettings(smoothing=0.0, max_delay=0.6, mirror=MirrorMode.SAME_SIDE))
    reference_poses = [PLIE, PLIE, ARABESQUE, ARABESQUE, ARABESQUE]
    student_poses = [PLIE, PLIE, PLIE, PLIE, ARABESQUE]  # copies 0.4 s late
    results = [
        session.process(detections(reference), detections(student), reference_time=index * 0.2)
        for index, (reference, student) in enumerate(zip(reference_poses, student_poses, strict=True))
    ]
    late = results[3]  # the reference holds an arabesque, the student is still in plié
    assert late["comparison"]["score"] == 100.0 and late["comparison"]["delay_s"] == 0.4
    assert results[4]["comparison"]["delay_s"] == 0.0
    assert results[-1]["average_score"] == 100.0 and results[-1]["in_step_share"] == 1.0

    strict = ComparisonSession(ComparisonSettings(smoothing=0.0, max_delay=0.0, mirror=MirrorMode.SAME_SIDE))
    for index, (reference, student) in enumerate(zip(reference_poses, student_poses, strict=True)):
        result = strict.process(detections(reference), detections(student), reference_time=index * 0.2)
    assert strict.statistics.frames_compared == 5 and result["average_score"] < 100


def test_nobody_in_one_picture_gives_no_comparison():
    session = ComparisonSession()
    result = session.process(detections(ARABESQUE), detections(None), reference_time=0.0)
    assert result["comparison"] is None and result["student"]["dancer"] is None and result["match_score"] is None


def picture(shade: int) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (200, 220), (shade, shade, shade)).save(buffer, format="JPEG")
    return buffer.getvalue()


def pair(reference: bytes, student: bytes) -> bytes:
    return struct.pack(">I", len(reference)) + reference + student


def test_websocket_compares_pairs(make_client):
    reference_picture, student_picture = picture(40), picture(200)

    def yolo(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/health":
            return httpx.Response(200, json={"status": "ok"})
        is_reference = reference_picture in request.content  # the reference dances an arabesque, the student a plié
        return httpx.Response(200, json={**detections(ARABESQUE if is_reference else PLIE), "inference_ms": 5.0})

    with make_client([], handler=yolo) as client, client.websocket_connect("/api/compare/ws") as ws:
        assert ws.receive_json()["type"] == "hello"
        ws.send_json({"type": "config", "good_degrees": 10, "mirror": "same", "smoothing": 0})
        config = ws.receive_json()
        assert config["good_degrees"] == 10 and config["mirror"] == "same"
        ws.send_json({"type": "reference", "media_key": "class.mp4|99"})
        assert ws.receive_json()["adjustments"] == []

        ws.send_json({"type": "pair", "reference_time": 1.0})
        ws.send_bytes(pair(reference_picture, student_picture))
        result = ws.receive_json()
        assert result["type"] == "comparison" and result["reference"]["movement"] == "arabesque"
        assert result["student"]["movement"] == "plié" and result["comparison"]["parts"]["right_leg"] == "bad"
        assert result["match_score"] == result["comparison"]["score"] < 60

        ws.send_bytes(b"\x00\x00")
        assert ws.receive_json()["type"] == "error"
        ws.send_json({"type": "config", "mirror": "sideways"})
        assert "invalid setting" in ws.receive_json()["message"]
        ws.send_json({"type": "summary"})
        assert ws.receive_json()["frames_compared"] == 1
