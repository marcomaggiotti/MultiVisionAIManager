"""The cartoon cat: steady keypoints, the far side, and the drawing."""

from __future__ import annotations

import random

from PIL import Image

from app.media.cat import draw_cat, far_side, steady_track

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


def test_the_far_side_is_the_ear_seen_less():
    points = dancer(200)
    assert far_side(points) is None
    points[3][2] = 0.2  # the left ear hidden: she shows her right side
    assert far_side(points) == "left"


def test_the_cat_is_drawn_on_the_keypoints():
    overlay = Image.new("RGBA", (400, 500), (0, 0, 0, 0))
    draw_cat(overlay, dancer(200), 1.0, {"right_leg": "#ff6b6b"})
    box = overlay.getbbox()
    assert box and box[0] < 160 and box[2] > 240 and box[1] < 100 and box[3] > 400  # around the dancer
    empty = Image.new("RGBA", (400, 500), (0, 0, 0, 0))
    no_torso = dancer(200)
    no_torso[11][2] = 0
    draw_cat(empty, no_torso, 1.0, {})
    assert empty.getbbox() is None
