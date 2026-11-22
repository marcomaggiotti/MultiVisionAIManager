"""Technique feedback per body part, against the targets of the recognised movement.

Every correction names the body part, a status (ok / warn / bad), a message for the
dancer, the measured value and the target, so each message can be traced back to a
measured angle.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Literal

from app.ballet.measurements import PoseMeasurements
from app.ballet.movements import BODY_PARTS

Status = Literal["ok", "warn", "bad"]
SEVERITY: dict[str, int] = {"ok": 0, "warn": 1, "bad": 2}

MIN_VISIBLE_KEYPOINTS = 11
STRAIGHT_KNEE = 170
SLIGHTLY_BENT_KNEE = 158
UPRIGHT_TORSO_MAX_TILT = 10
LEANING_TORSO_MAX_TILT = 20
ARABESQUE_MAX_TILT = 35
MAX_SHOULDER_TILT = 0.06  # share of body height
MAX_HIP_TILT = 0.07
EVEN_PLIE_MAX_DIFFERENCE = 12
GRAND_PLIE_KNEE = 100
SPLIT_GOOD, SPLIT_ACCEPTABLE = 160, 140
ATTITUDE_KNEE_RANGE = (85, 135)
ATTITUDE_MIN_ELEVATION = 75
ARMS_OVERHEAD_ELEVATION = 140
TARGET_LEG_HEIGHT = {"arabesque": 90, "développé": 90, "grand battement": 110}
HIPS_CHECKED_FOR = {"passé", "plié", "second position", "first / fifth position", "développé"}


@dataclass(frozen=True)
class Correction:
    part: str
    status: Status
    message: str
    value: float | None = None
    target: str | None = None


def knee_straightness(part: str, knee_angle: float | None, which_knee: str) -> list[Correction]:
    if knee_angle is None:
        return []
    target = f"≥ {STRAIGHT_KNEE}°"
    if knee_angle >= STRAIGHT_KNEE:
        return [Correction(part, "ok", f"{which_knee} knee straight", round(knee_angle), target)]
    if knee_angle >= SLIGHTLY_BENT_KNEE:
        message = f"{which_knee} knee slightly bent ({knee_angle:.0f}°): pull up and stretch"
        return [Correction(part, "warn", message, round(knee_angle), target)]
    message = f"{which_knee} knee bent ({knee_angle:.0f}°): straighten it"
    return [Correction(part, "bad", message, round(knee_angle), target)]


# --- rules per movement ---------------------------------------------------------------
def _extension_rules(movement: str, pose: PoseMeasurements) -> list[Correction]:
    """Arabesque, développé, grand battement: two straight legs, the working one high."""
    legs = pose.legs
    working_leg, supporting_leg = f"{legs.working_side}_leg", f"{legs.supporting_side}_leg"
    corrections = knee_straightness(working_leg, legs.working_knee_angle, "Working")
    corrections += knee_straightness(supporting_leg, legs.supporting_knee_angle, "Supporting")

    target_height = TARGET_LEG_HEIGHT[movement]
    elevation = legs.working_leg_elevation
    if elevation >= target_height - 5:
        corrections.append(
            Correction(working_leg, "ok", f"Working leg at {elevation:.0f}°", round(elevation), f"≥ {target_height}°")
        )
    else:
        status: Status = "warn" if elevation >= target_height - 25 else "bad"
        message = f"Lift the working leg higher ({elevation:.0f}°, aim for {target_height}°)"
        corrections.append(Correction(working_leg, status, message, round(elevation), f"≥ {target_height}°"))

    tilt = pose.angles.torso_tilt
    if movement == "arabesque" and tilt is not None:
        if tilt > ARABESQUE_MAX_TILT:
            message = f"Chest dropping forward ({tilt:.0f}°): lift the back"
            corrections.append(Correction("torso", "warn", message, round(tilt), f"≤ {ARABESQUE_MAX_TILT}°"))
        else:
            corrections.append(Correction("torso", "ok", "Back lifted", round(tilt), f"≤ {ARABESQUE_MAX_TILT}°"))
    return corrections


def _attitude_rules(movement: str, pose: PoseMeasurements) -> list[Correction]:
    legs = pose.legs
    working_leg = f"{legs.working_side}_leg"
    corrections = knee_straightness(f"{legs.supporting_side}_leg", legs.supporting_knee_angle, "Supporting")
    knee = legs.working_knee_angle
    if knee is not None:
        low, high = ATTITUDE_KNEE_RANGE
        if low <= knee <= high:
            corrections.append(Correction(working_leg, "ok", f"Attitude knee at {knee:.0f}°", round(knee), "90-130°"))
        else:
            message = f"Attitude knee at {knee:.0f}°: aim for a rounded 90-120°"
            corrections.append(Correction(working_leg, "warn", message, round(knee), "90-130°"))
    if legs.working_leg_elevation < ATTITUDE_MIN_ELEVATION:
        message = f"Raise the knee: thigh at {legs.working_leg_elevation:.0f}°"
        corrections.append(Correction(working_leg, "warn", message, round(legs.working_leg_elevation), "≥ 80°"))
    return corrections


def _passe_rules(movement: str, pose: PoseMeasurements) -> list[Correction]:
    legs = pose.legs
    corrections = knee_straightness(f"{legs.supporting_side}_leg", legs.supporting_knee_angle, "Supporting")
    corrections.append(
        Correction(f"{legs.working_side}_leg", "ok", "Working foot at the supporting knee", None, "at the knee")
    )
    return corrections


def _grand_jete_rules(movement: str, pose: PoseMeasurements) -> list[Correction]:
    legs = pose.legs
    working_leg = f"{legs.working_side}_leg"
    corrections = []
    split = pose.angles.leg_spread
    if split is not None:
        status: Status = "ok" if split >= SPLIT_GOOD else "warn" if split >= SPLIT_ACCEPTABLE else "bad"
        message = f"Split {split:.0f}°" + ("" if status == "ok" else ": open the legs further")
        corrections.append(Correction(working_leg, status, message, round(split), f"≥ {SPLIT_GOOD}°"))
    return corrections + knee_straightness(working_leg, legs.working_knee_angle, "Front/back")


def _plie_rules(movement: str, pose: PoseMeasurements) -> list[Correction]:
    left_knee, right_knee = pose.angles.left_knee, pose.angles.right_knee
    if left_knee is None or right_knee is None:
        return []
    difference = abs(left_knee - right_knee)
    depth = "grand plié" if max(left_knee, right_knee) < GRAND_PLIE_KNEE else "demi-plié"
    even = difference <= EVEN_PLIE_MAX_DIFFERENCE
    message = f"{depth}: knees {left_knee:.0f}° / {right_knee:.0f}°" + ("" if even else ": bend both knees evenly")
    return [
        Correction(
            "hips", "ok" if even else "warn", message, round(difference), f"≤ {EVEN_PLIE_MAX_DIFFERENCE}° difference"
        )
    ]


def _position_rules(movement: str, pose: PoseMeasurements) -> list[Correction]:
    return knee_straightness("left_leg", pose.angles.left_knee, "Left") + knee_straightness(
        "right_leg", pose.angles.right_knee, "Right"
    )


MOVEMENT_RULES: dict[str, Callable[[str, PoseMeasurements], list[Correction]]] = {
    "arabesque": _extension_rules,
    "développé": _extension_rules,
    "grand battement": _extension_rules,
    "attitude": _attitude_rules,
    "passé": _passe_rules,
    "grand jeté": _grand_jete_rules,
    "plié": _plie_rules,
    "second position": _position_rules,
    "first / fifth position": _position_rules,
}


# --- posture, whatever the movement -----------------------------------------------------
def _posture_rules(movement: str | None, pose: PoseMeasurements) -> list[Correction]:
    corrections = []
    tilt = pose.angles.torso_tilt
    if movement not in {"arabesque", "grand jeté"} and tilt is not None:
        target = f"≤ {UPRIGHT_TORSO_MAX_TILT}°"
        if tilt <= UPRIGHT_TORSO_MAX_TILT:
            corrections.append(Correction("torso", "ok", "Torso vertical", round(tilt), target))
        else:
            status: Status = "warn" if tilt <= LEANING_TORSO_MAX_TILT else "bad"
            message = f"Torso leaning {tilt:.0f}°: stand tall over the hips"
            corrections.append(Correction("torso", status, message, round(tilt), target))

    if pose.shoulder_tilt is not None:
        percent = round(pose.shoulder_tilt * 100, 1)
        if pose.shoulder_tilt > MAX_SHOULDER_TILT:
            corrections.append(
                Correction("shoulders", "warn", "Shoulders uneven: keep them level and down", percent, "level")
            )
        else:
            corrections.append(Correction("shoulders", "ok", "Shoulders level", percent, "level"))

    if pose.hip_tilt is not None and movement in HIPS_CHECKED_FOR:
        percent = round(pose.hip_tilt * 100, 1)
        if pose.hip_tilt > MAX_HIP_TILT:
            message = "Hips uneven: square them and keep the working hip down"
            corrections.append(Correction("hips", "warn", message, percent, "level"))
        else:
            corrections.append(Correction("hips", "ok", "Hips level", percent, "level"))

    left_arm, right_arm = pose.angles.left_arm_elevation, pose.angles.right_arm_elevation
    if left_arm is not None and right_arm is not None and min(left_arm, right_arm) > ARMS_OVERHEAD_ELEVATION:
        corrections.append(Correction("left_arm", "ok", "Arms in fifth position en haut"))
    return corrections


def technique_feedback(movement: str | None, pose: PoseMeasurements) -> list[Correction]:
    """Corrections for the recognised movement (or general posture when there is none)."""
    if pose.visible_keypoints < MIN_VISIBLE_KEYPOINTS or pose.legs is None:
        return [Correction("torso", "warn", "Step back so the whole body (head to feet) is in the picture")]
    movement_rule = MOVEMENT_RULES.get(movement) if movement else None
    corrections = movement_rule(movement, pose) if movement_rule else []
    return corrections + _posture_rules(movement, pose)


def status_by_body_part(corrections: list[Correction]) -> dict[str, str]:
    """The worst status per body part; ``"none"`` for parts that were not checked."""
    statuses = {part: "none" for part in BODY_PARTS}
    for correction in corrections:
        current = statuses.get(correction.part, "none")
        if current == "none" or SEVERITY[correction.status] > SEVERITY[current]:
            statuses[correction.part] = correction.status
    return statuses
