"""Movement of the main dancer across a sequence of pictures."""

from __future__ import annotations

import math
from dataclasses import dataclass

from app.ballet.keypoints import RawKeypoint, is_visible

TRACKED_ANGLES = [
    "left_leg_elevation", "right_leg_elevation", "left_knee", "right_knee", "leg_spread",
    "left_arm_elevation", "right_arm_elevation",
]  # fmt: skip
LARGEST_ANGLE_CHANGES = 5


@dataclass(frozen=True)
class DancerFrame:
    """What the motion analysis needs from one picture."""

    keypoints: list[RawKeypoint]
    angles: dict[str, float | None]
    body_height: float | None


def mean_joint_displacement(
    previous: list[RawKeypoint], current: list[RawKeypoint], body_height: float, decimals: int = 3
) -> float | None:
    """Mean distance moved by the joints visible in both frames, in body heights."""
    distances = [
        math.dist(before[:2], after[:2]) / body_height
        for before, after in zip(previous, current, strict=True)
        if is_visible(before) and is_visible(after)
    ]
    return round(sum(distances) / len(distances), decimals) if distances else None


def largest_angle_changes(previous: dict, current: dict) -> dict[str, float]:
    changes = {
        name: round(current[name] - previous[name], 1)
        for name in current
        if current.get(name) is not None and previous.get(name) is not None
    }
    ordered = sorted(changes.items(), key=lambda item: abs(item[1]), reverse=True)
    return dict(ordered[:LARGEST_ANGLE_CHANGES])


def analyse_motion(frames: list[DancerFrame | None]) -> dict:
    """Transitions between consecutive frames, angle curves and the peak leg height.

    ``None`` stands for a picture where no dancer was measured.
    """
    transitions = []
    for index in range(1, len(frames)):
        previous, current = frames[index - 1], frames[index]
        if previous is None or current is None:
            transitions.append(None)
            continue
        body_height = previous.body_height or current.body_height or 1.0
        transitions.append(
            {
                "from": index - 1,
                "to": index,
                "mean_joint_motion": mean_joint_displacement(previous.keypoints, current.keypoints, body_height),
                "angle_changes": largest_angle_changes(previous.angles, current.angles),
            }
        )

    series = {name: [frame.angles.get(name) if frame else None for frame in frames] for name in TRACKED_ANGLES}
    working_leg_heights = [
        max((value for value in pair if value is not None), default=None)
        for pair in zip(series["left_leg_elevation"], series["right_leg_elevation"], strict=True)
    ]
    measured = [index for index, height in enumerate(working_leg_heights) if height is not None]
    peak_index = max(measured, key=lambda index: working_leg_heights[index]) if measured else None
    displacements = [
        transition["mean_joint_motion"]
        for transition in transitions
        if transition and transition["mean_joint_motion"] is not None
    ]
    return {
        "transitions": transitions,
        "series": series,
        "peak_leg_elevation_frame": peak_index,
        "peak_leg_elevation": working_leg_heights[peak_index] if peak_index is not None else None,
        "total_motion": round(sum(displacements), 3) if displacements else None,
    }
