"""What can be measured on one dancer from the keypoints: joint angles and the
geometric facts the recognition and feedback rules rely on."""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass

from app.ballet.keypoints import (
    Keypoint,
    RawKeypoint,
    angle_between,
    is_visible,
    joint_angle,
    midpoint,
    side_keypoint,
    vector,
    visible_point,
)

# The nose must be this far (share of body height) from the hips, horizontally, for
# the facing direction to be trusted (a dancer facing the camera has no "behind").
FACING_MIN_OFFSET = 0.03
# The working foot is "at the knee" (passé) closer than this share of body height.
FOOT_AT_KNEE_MAX_DISTANCE = 0.17
DOWNWARD = (0.0, 1.0)  # image y axis points down


@dataclass(frozen=True)
class JointAngles:
    """Angles in degrees; ``None`` when a keypoint needed is not visible.

    Knee and elbow: 180 = straight. Leg and arm elevation: angle from the body axis
    (0 = hanging down, 90 = horizontal, more = above). Torso tilt: from vertical.
    Leg spread: between the two legs, measured at the hips.
    """

    left_knee: float | None
    right_knee: float | None
    left_elbow: float | None
    right_elbow: float | None
    left_leg_elevation: float | None
    right_leg_elevation: float | None
    left_arm_elevation: float | None
    right_arm_elevation: float | None
    torso_tilt: float | None
    leg_spread: float | None

    def as_dict(self) -> dict[str, float | None]:
        return asdict(self)


@dataclass(frozen=True)
class LegRoles:
    """In one-leg movements the raised leg works and the other one supports."""

    working_side: str
    supporting_side: str
    working_leg_elevation: float
    supporting_leg_elevation: float
    working_knee_angle: float | None
    supporting_knee_angle: float | None


@dataclass(frozen=True)
class PoseMeasurements:
    angles: JointAngles
    visible_keypoints: int
    body_height: float | None  # shoulders to ankles, in pixels
    legs: LegRoles | None  # None when a leg is not visible
    working_leg_behind: bool | None  # None when the facing direction is unknown
    working_foot_at_supporting_knee: bool
    shoulder_tilt: float | None  # height difference / body height
    hip_tilt: float | None


def measure(keypoints: list[RawKeypoint]) -> PoseMeasurements:
    angles = measure_joint_angles(keypoints)
    body_height = _body_height(keypoints)
    legs = _leg_roles(angles)
    return PoseMeasurements(
        angles=angles,
        visible_keypoints=sum(is_visible(keypoint) for keypoint in keypoints),
        body_height=body_height,
        legs=legs,
        working_leg_behind=_working_leg_behind(keypoints, legs, body_height),
        working_foot_at_supporting_knee=_foot_at_supporting_knee(keypoints, legs, body_height),
        shoulder_tilt=_level_difference(keypoints, Keypoint.LEFT_SHOULDER, Keypoint.RIGHT_SHOULDER, body_height),
        hip_tilt=_level_difference(keypoints, Keypoint.LEFT_HIP, Keypoint.RIGHT_HIP, body_height),
    )


def measure_joint_angles(keypoints: list[RawKeypoint]) -> JointAngles:
    def point(keypoint: Keypoint):
        return visible_point(keypoints, keypoint)

    shoulders = midpoint(point(Keypoint.LEFT_SHOULDER), point(Keypoint.RIGHT_SHOULDER))
    hips = midpoint(point(Keypoint.LEFT_HIP), point(Keypoint.RIGHT_HIP))
    body_axis = vector(shoulders, hips) if shoulders and hips else DOWNWARD

    def limb_elevation(side: str, root_joint: str, end_joint: str) -> float | None:
        root, end = point(side_keypoint(side, root_joint)), point(side_keypoint(side, end_joint))
        return angle_between(body_axis, vector(root, end)) if root and end else None

    def bend(side: str, outer: str, joint: str, inner: str) -> float | None:
        return joint_angle(
            point(side_keypoint(side, outer)),
            point(side_keypoint(side, joint)),
            point(side_keypoint(side, inner)),
        )

    left_ankle, right_ankle = point(Keypoint.LEFT_ANKLE), point(Keypoint.RIGHT_ANKLE)
    leg_spread = (
        angle_between(vector(hips, left_ankle), vector(hips, right_ankle))
        if left_ankle and right_ankle and hips
        else None
    )
    return JointAngles(
        left_knee=bend("left", "hip", "knee", "ankle"),
        right_knee=bend("right", "hip", "knee", "ankle"),
        left_elbow=bend("left", "shoulder", "elbow", "wrist"),
        right_elbow=bend("right", "shoulder", "elbow", "wrist"),
        left_leg_elevation=limb_elevation("left", "hip", "ankle"),
        right_leg_elevation=limb_elevation("right", "hip", "ankle"),
        left_arm_elevation=limb_elevation("left", "shoulder", "wrist"),
        right_arm_elevation=limb_elevation("right", "shoulder", "wrist"),
        torso_tilt=angle_between(body_axis, DOWNWARD) if shoulders and hips else None,
        leg_spread=leg_spread,
    )


def _body_height(keypoints: list[RawKeypoint]) -> float | None:
    shoulders = midpoint(
        visible_point(keypoints, Keypoint.LEFT_SHOULDER), visible_point(keypoints, Keypoint.RIGHT_SHOULDER)
    )
    ankles = midpoint(visible_point(keypoints, Keypoint.LEFT_ANKLE), visible_point(keypoints, Keypoint.RIGHT_ANKLE))
    return round(math.dist(shoulders, ankles), 1) if shoulders and ankles else None


def _leg_roles(angles: JointAngles) -> LegRoles | None:
    left, right = angles.left_leg_elevation, angles.right_leg_elevation
    if left is None or right is None:
        return None
    working, supporting = ("left", "right") if left >= right else ("right", "left")
    return LegRoles(
        working_side=working,
        supporting_side=supporting,
        working_leg_elevation=max(left, right),
        supporting_leg_elevation=min(left, right),
        working_knee_angle=getattr(angles, f"{working}_knee"),
        supporting_knee_angle=getattr(angles, f"{supporting}_knee"),
    )


def _working_leg_behind(keypoints: list[RawKeypoint], legs: LegRoles | None, body_height: float | None) -> bool | None:
    """Is the working foot on the opposite side of the hips from the nose (= behind)?"""
    if legs is None or not body_height:
        return None
    nose = visible_point(keypoints, Keypoint.NOSE)
    hips = midpoint(visible_point(keypoints, Keypoint.LEFT_HIP), visible_point(keypoints, Keypoint.RIGHT_HIP))
    ankle = visible_point(keypoints, side_keypoint(legs.working_side, "ankle"))
    if not (nose and hips and ankle) or abs(nose[0] - hips[0]) <= FACING_MIN_OFFSET * body_height:
        return None
    return (ankle[0] - hips[0]) * (nose[0] - hips[0]) < 0


def _foot_at_supporting_knee(keypoints: list[RawKeypoint], legs: LegRoles | None, body_height: float | None) -> bool:
    if legs is None or not body_height:
        return False
    supporting_knee = visible_point(keypoints, side_keypoint(legs.supporting_side, "knee"))
    working_ankle = visible_point(keypoints, side_keypoint(legs.working_side, "ankle"))
    if not (supporting_knee and working_ankle):
        return False
    return math.dist(supporting_knee, working_ankle) < FOOT_AT_KNEE_MAX_DISTANCE * body_height


def _level_difference(
    keypoints: list[RawKeypoint], left: Keypoint, right: Keypoint, body_height: float | None
) -> float | None:
    """Vertical difference between a left/right pair, as a share of body height."""
    left_point, right_point = visible_point(keypoints, left), visible_point(keypoints, right)
    if not (left_point and right_point and body_height):
        return None
    return abs(left_point[1] - right_point[1]) / body_height
