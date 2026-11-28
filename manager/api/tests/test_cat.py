"""The 3D cartoon cat: steady keypoints, the way the dancer faces, and the drawing."""

from __future__ import annotations

import math
import random

from PIL import Image

from app.media.cat import CatPose, draw_cat
from app.media.cat_pose import cat_track, facing_angles, steady_track

FPS = 15


def dancer(x: float, confidence: float = 0.9) -> list[list[float]]:
    """A standing dancer whose keypoints are all at ``x`` + their offset."""
    offsets = [(0, 0), (-5, -4), (5, -4), (-10, 0), (10, 0), (-30, 40), (30, 40), (-40, 90), (40, 90), (-45, 140),
               (45, 140), (-20, 140), (20, 140), (-22, 220), (22, 220), (-24, 300), (24, 300)]  # fmt: skip
    return [[x + dx, 100 + dy, confidence] for dx, dy in offsets]


def test_a_steady_movement_is_followed_without_lag_and_jitter_is_removed():
    times = [index / FPS for index in range(30)]
    moving = [dancer(200 + 60 * t) for t in times]  # 60 px a second, to the right
    track = steady_track(times, moving)
    assert all(abs(track[i][0][0] - moving[i][0][0]) < 1e-6 for i in range(3, 27))  # no lag
    random.seed(1)
    noisy = [[[x + random.uniform(-6, 6), y, c] for x, y, c in points] for points in moving]
    steadied = steady_track(times, noisy)
    error = lambda frames: sum(abs(f[0][0] - m[0][0]) for f, m in zip(frames[3:27], moving[3:27], strict=True))  # noqa: E731
    assert error(steadied) < 0.75 * error(noisy)


def test_keypoints_missed_for_a_moment_are_filled_and_long_absences_are_not():
    times = [index / FPS for index in range(30)]
    frames: list = [dancer(200) for _ in times]
    frames[10] = None  # the dancer not found in one frame
    for index in range(16, 30):  # the left wrist hidden for almost a second
        frames[index][9][2] = 0.1
    track = steady_track(times, frames)
    assert track[10] is not None and abs(track[10][0][0] - 200) < 1e-6
    assert track[20][9][2] == 0 and track[20][10][2] >= 0.5


# a dancer standing in first position, as joints in her own frame (left, up, forward), in torso lengths
BODY = [(0, 1.5, 0.18), (0.06, 1.55, 0.15), (-0.06, 1.55, 0.15), (0.15, 1.52, 0.0), (-0.15, 1.52, 0.0),
        (0.37, 1.0, 0), (-0.37, 1.0, 0), (0.55, 0.65, 0.1), (-0.55, 0.65, 0.1), (0.6, 0.35, 0.2), (-0.6, 0.35, 0.2),
        (0.2, 0, 0), (-0.2, 0, 0), (0.22, -0.9, 0.03), (-0.22, -0.9, 0.03),
        (0.22, -1.8, 0), (-0.22, -1.8, 0)]  # fmt: skip


def turned(yaw: float, size: float = 100.0, centre: tuple[float, float] = (200.0, 260.0)) -> list[list[float]]:
    """Her keypoints as YOLO sees them, turned by ``yaw``: the face hidden when her back is
    turned, an ear hidden behind the head."""
    left, forward = (math.cos(yaw), math.sin(yaw)), (math.sin(yaw), -math.cos(yaw))  # (x, z) of each direction
    points = []
    for index, (aside, above, ahead) in enumerate(BODY):
        x = left[0] * aside + forward[0] * ahead
        confidence = 0.9
        if index <= 2:
            confidence = 0.9 if math.cos(yaw) > -0.15 else 0.1
        elif index <= 4:
            confidence = 0.9 if left[1] * (1 if index == 3 else -1) < 0.35 else 0.1
        points.append([centre[0] + size * x, centre[1] - size * above, confidence])
    return points


def test_the_way_she_faces_follows_a_whole_turn():
    times = [index / FPS for index in range(60)]
    truth = [-math.pi + 2 * math.pi * t / 4 for t in times]  # a slow turn, 4 s
    yaw, shoulders, hips = facing_angles(times, [turned(angle) for angle in truth])
    assert abs(shoulders - 0.74) < 0.02 and abs(hips - 0.4) < 0.02
    errors = [abs((found - true + math.pi) % (2 * math.pi) - math.pi) for found, true in zip(yaw, truth, strict=True)]
    assert max(errors[3:-3]) < math.radians(20) and sum(errors) / len(errors) < math.radians(5)


def test_her_face_seen_means_she_faces_the_camera_even_with_left_and_right_mirrored():
    times = [index / FPS for index in range(10)]
    mirrored = turned(0)
    for left, right in ((1, 2), (3, 4), (5, 6), (7, 8), (9, 10), (11, 12), (13, 14), (15, 16)):
        mirrored[left], mirrored[right] = mirrored[right], mirrored[left]  # a mirrored webcam picture
    yaw, _, _ = facing_angles(times, [mirrored] * 10)
    assert all(abs(angle) < 0.2 for angle in yaw)  # not her back


def test_the_cat_track_of_an_analysis():
    sideways = turned(math.radians(90))
    frames = [{"index": i, "source_time": i / FPS, "dancer": {"keypoints": sideways}} for i in range(10)]
    frames[4]["dancer"] = None  # missed for a moment: filled
    track = cat_track({"frames": frames, "size": {"width": 400, "height": 520}})
    assert len(track["keypoints"]) == len(track["yaw"]) == 10 and track["keypoints"][4] is not None
    assert all(abs(angle - math.pi / 2) < 0.05 for angle in track["yaw"])  # facing the picture's right
    assert abs(track["size"] - 100) < 1 and track["image"] == {"width": 400, "height": 520}


def colours(picture: Image.Image) -> set[tuple[int, int, int]]:
    return {colour for _, colour in picture.convert("RGB").getcolors(picture.width * picture.height) or []}


def test_the_cat_shows_its_face_in_front_its_back_behind_and_its_profile_aside():
    def drawn(yaw_degrees: float) -> Image.Image:
        overlay = Image.new("RGBA", (400, 520), (0, 0, 0, 0))
        yaw = math.radians(yaw_degrees)
        draw_cat(overlay, CatPose(turned(yaw), yaw, 100.0), 1.0, {})
        return overlay

    def greens(picture: Image.Image) -> int:  # the eyes
        return sum(1 for r, g, b in colours(picture) if g > 150 and r < 140 and b < 120)

    front, side, back = drawn(0), drawn(90), drawn(180)
    assert greens(front) > 0 and greens(back) == 0  # the face is hidden behind the head
    width = lambda picture: picture.getbbox()[2] - picture.getbbox()[0]  # noqa: E731
    assert width(side) < width(front)  # the body seen from the side: narrower
    assert front.getbbox()[1] < 140 and front.getbbox()[3] > 420  # from above the head to the feet
    empty = Image.new("RGBA", (400, 520), (0, 0, 0, 0))
    no_torso = turned(0)
    no_torso[11][2] = 0
    draw_cat(empty, CatPose(no_torso, 0.0, 100.0), 1.0, {})
    assert empty.getbbox() is None
