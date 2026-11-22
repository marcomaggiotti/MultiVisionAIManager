"""The 17 COCO keypoints predicted by YOLO pose models, and point helpers."""

from __future__ import annotations

import math
from enum import IntEnum

Point = tuple[float, float]
# One keypoint as returned by the YOLO module: [x, y, visibility 0-1].
RawKeypoint = list[float]

VISIBILITY_THRESHOLD = 0.5


class Keypoint(IntEnum):
    NOSE = 0
    LEFT_EYE = 1
    RIGHT_EYE = 2
    LEFT_EAR = 3
    RIGHT_EAR = 4
    LEFT_SHOULDER = 5
    RIGHT_SHOULDER = 6
    LEFT_ELBOW = 7
    RIGHT_ELBOW = 8
    LEFT_WRIST = 9
    RIGHT_WRIST = 10
    LEFT_HIP = 11
    RIGHT_HIP = 12
    LEFT_KNEE = 13
    RIGHT_KNEE = 14
    LEFT_ANKLE = 15
    RIGHT_ANKLE = 16


KEYPOINT_NAMES = [keypoint.name.lower() for keypoint in Keypoint]

# Pairs of keypoints joined by a bone.
SKELETON = [
    (Keypoint.LEFT_ANKLE, Keypoint.LEFT_KNEE), (Keypoint.LEFT_KNEE, Keypoint.LEFT_HIP),
    (Keypoint.RIGHT_ANKLE, Keypoint.RIGHT_KNEE), (Keypoint.RIGHT_KNEE, Keypoint.RIGHT_HIP),
    (Keypoint.LEFT_HIP, Keypoint.RIGHT_HIP), (Keypoint.LEFT_SHOULDER, Keypoint.LEFT_HIP),
    (Keypoint.RIGHT_SHOULDER, Keypoint.RIGHT_HIP), (Keypoint.LEFT_SHOULDER, Keypoint.RIGHT_SHOULDER),
    (Keypoint.LEFT_SHOULDER, Keypoint.LEFT_ELBOW), (Keypoint.RIGHT_SHOULDER, Keypoint.RIGHT_ELBOW),
    (Keypoint.LEFT_ELBOW, Keypoint.LEFT_WRIST), (Keypoint.RIGHT_ELBOW, Keypoint.RIGHT_WRIST),
    (Keypoint.NOSE, Keypoint.LEFT_EYE), (Keypoint.NOSE, Keypoint.RIGHT_EYE),
    (Keypoint.LEFT_EYE, Keypoint.LEFT_EAR), (Keypoint.RIGHT_EYE, Keypoint.RIGHT_EAR),
]  # fmt: skip


def side_keypoint(side: str, joint: str) -> Keypoint:
    """``side_keypoint("left", "knee")`` -> ``Keypoint.LEFT_KNEE``."""
    return Keypoint[f"{side}_{joint}".upper()]


def visible_point(keypoints: list[RawKeypoint], keypoint: Keypoint) -> Point | None:
    """The keypoint's (x, y) when the model is confident enough that it is visible."""
    x, y, visibility = keypoints[keypoint]
    return (x, y) if visibility >= VISIBILITY_THRESHOLD else None


def is_visible(raw_keypoint: RawKeypoint) -> bool:
    return raw_keypoint[2] >= VISIBILITY_THRESHOLD


def midpoint(first: Point | None, second: Point | None) -> Point | None:
    """The middle of two points, or the only one available."""
    if first and second:
        return ((first[0] + second[0]) / 2, (first[1] + second[1]) / 2)
    return first or second


def angle_between(first: Point, second: Point) -> float | None:
    """Angle in degrees between two vectors (0 = same direction, 180 = opposite)."""
    first_length, second_length = math.hypot(*first), math.hypot(*second)
    if first_length == 0 or second_length == 0:
        return None
    cosine = (first[0] * second[0] + first[1] * second[1]) / (first_length * second_length)
    return round(math.degrees(math.acos(max(-1.0, min(1.0, cosine)))), 1)


def joint_angle(outer_a: Point | None, joint: Point | None, outer_b: Point | None) -> float | None:
    """Angle at ``joint`` between the two limbs (180 = straight), e.g. hip-knee-ankle."""
    if not (outer_a and joint and outer_b):
        return None
    return angle_between(
        (outer_a[0] - joint[0], outer_a[1] - joint[1]),
        (outer_b[0] - joint[0], outer_b[1] - joint[1]),
    )


def vector(start: Point, end: Point) -> Point:
    return (end[0] - start[0], end[1] - start[1])
