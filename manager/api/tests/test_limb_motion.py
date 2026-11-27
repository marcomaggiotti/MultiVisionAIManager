"""Which limb moves, and when, from the analysed keypoints of a video."""

from __future__ import annotations

import math
import random

from app.ballet.limb_motion import analyse_limbs, group_moments, limb_speeds
from tests.test_videos import needs_ffmpeg, sample_video  # noqa: F401 - fixture

FPS = 15
STANDING = {  # a dancer standing, facing the camera (pixels)
    0: (330, 70), 1: (326, 65), 2: (334, 65), 3: (321, 68), 4: (339, 68),
    5: (308, 110), 6: (352, 110), 7: (290, 160), 8: (370, 160), 9: (285, 210), 10: (375, 210),
    11: (316, 220), 12: (344, 220), 13: (316, 320), 14: (344, 320), 15: (316, 420), 16: (344, 420),
}  # fmt: skip


def pose(t: float) -> dict[int, tuple[float, float]]:
    """2-3 s: the right leg rises to the side (90°), 4-5 s it comes down; 6-7 s: the whole dancer travels 120 px."""
    points = dict(STANDING)
    lift = min(1.0, max(0.0, t - 2.0)) if t < 4 else max(0.0, 1.0 - (t - 4.0))  # up 2-3 s, down 4-5 s
    angle = math.radians(90 * lift)
    hip = STANDING[12]
    for index, length in ((14, 100), (16, 200)):
        points[index] = (hip[0] + math.sin(angle) * length, hip[1] + math.cos(angle) * length)
    shift = 120 * min(1.0, max(0.0, t - 6.0))  # travelling 6-7 s
    return {index: (x + shift, y) for index, (x, y) in points.items()}


def frames(seconds: float = 8.0, jitter: float = 2.5, hidden: range = range(0)) -> list[dict]:
    random.seed(7)
    result = []
    for index in range(int(seconds * FPS)):
        t = round(index / FPS, 3)
        keypoints = [[x + random.gauss(0, jitter), y + random.gauss(0, jitter), 0.95] for x, y in pose(t).values()]
        if index in hidden:
            keypoints = [[x, y, 0.1] for x, y, _ in keypoints]  # the dancer is not seen
        result.append({"index": index, "source_time": t, "dancer": {"keypoints": keypoints},
                       "current": {"step": "à la seconde" if 2.5 <= t < 4.5 else None}})  # fmt: skip
    return result


def spans(result: dict, limb: str) -> list[tuple[float, float]]:
    return [(movement["start"], movement["end"]) for movement in result["movements"] if movement["limb"] == limb]


def test_the_right_leg_and_the_whole_body_are_found_not_the_still_limbs():
    result = analyse_limbs({"frames": frames(), "fps": FPS})
    (up_start, up_end), (down_start, down_end) = spans(result, "right_leg")
    assert 1.7 <= up_start <= 2.1 and 2.9 <= up_end <= 3.3  # raised from 2 to 3 s
    assert 3.7 <= down_start <= 4.1 and 4.9 <= down_end <= 5.3  # lowered from 4 to 5 s
    [(travel_start, travel_end)] = spans(result, "body")
    assert 5.8 <= travel_start <= 6.2 and 6.8 <= travel_end <= 7.2
    # travelling moves every point in the picture, but no limb relative to the body
    for still in ("left_arm", "right_arm", "left_leg", "head", "torso"):
        assert spans(result, still) == [], still
    raised = next(movement for movement in result["movements"] if movement["limb"] == "right_leg")
    assert raised["movement"] == "à la seconde" and raised["peak"] > 1.0
    assert [moment["limbs"] for moment in result["moments"]] == [["right_leg"], ["right_leg"], ["body"]]
    assert len(result["times"]) == len(result["speeds"]["right_leg"]) == 120


def test_limbs_not_seen_have_no_speed():
    speeds = limb_speeds(frames(hidden=range(30, 45)), FPS)
    assert all(value is None for value in speeds["right_leg"][30:45])
    assert speeds["right_leg"][60] is not None


def test_moments_group_limbs_moving_together():
    from app.ballet.limb_motion import LimbMovement

    together = [
        LimbMovement("right_leg", 2.0, 3.0, 1.5, 1.2, "arabesque"),
        LimbMovement("left_arm", 2.2, 3.4, 0.9, 0.7, None),
        LimbMovement("head", 6.0, 6.5, 0.5, 0.4, None),
    ]
    moments = group_moments(together)
    assert [(moment["start"], moment["end"], moment["limbs"]) for moment in moments] == [
        (2.0, 3.4, ["right_leg", "left_arm"]), (6.0, 6.5, ["head"]),
    ]  # fmt: skip
    assert moments[0]["movement"] == "arabesque"


@needs_ffmpeg
def test_the_api_reads_the_stored_analysis(make_client, sample_video):  # noqa: F811
    from tests.test_manager import ARABESQUE
    from tests.test_video_analysis import wait_until_analysed

    with make_client([ARABESQUE] * 200, analyse_videos=True) as client:
        with sample_video.open("rb") as file:
            [added] = client.post("/api/videos", files={"files": ("class.mp4", file, "video/mp4")}).json()["saved"]
        url = f"/api/videos/{added['id']}/limb-movements"
        assert wait_until_analysed(client, added["id"])["analysis"]["status"] == "done"
        result = client.get(url, params={"threshold": 0.5}).json()
        assert result["threshold"] == 0.5 and result["movements"] == []  # the same pose all along: nothing moves
        assert [limb["id"] for limb in result["limbs"]][:4] == ["left_arm", "right_arm", "left_leg", "right_leg"]
        assert len(result["times"]) == len(result["speeds"]["left_arm"]) > 80
