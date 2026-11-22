"""Compare a student's pose with a reference dancer's, joint angle by joint angle.

Each joint angle (knees, elbows, leg and arm elevation, torso tilt, leg spread) of the
student is compared with the same angle of the reference:

* within ``Tolerance.good`` degrees the joint is green (``ok``),
* within ``Tolerance.fair`` it is yellow (``warn``),
* beyond, red (``bad``).

The joint scores 1 up to ``good`` and falls linearly to 0 at twice ``fair``; the match
score is the weighted mean of the joints visible on both dancers, in percent.

A student following a video usually faces it like a mirror: their left arm copies the
reference's right arm. ``MirrorMode.AUTO`` keeps whichever side pairing matches better.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, fields, replace
from enum import StrEnum

from app.ballet.measurements import JointAngles


class MirrorMode(StrEnum):
    SAME_SIDE = "same"  # student's left = reference's left
    MIRRORED = "mirrored"  # student's left = reference's right
    AUTO = "auto"  # whichever matches better


@dataclass(frozen=True)
class Tolerance:
    good: float = 15.0  # degrees
    fair: float = 30.0


@dataclass(frozen=True)
class JointRule:
    label: str
    part: str  # body part, as in the live feedback
    weight: float
    advice_when_lower: str  # the student's angle is smaller than the reference's
    advice_when_higher: str


DEFAULT_TOLERANCE = Tolerance()

JOINT_RULES: dict[str, JointRule] = {
    "left_knee": JointRule("Left knee", "left_leg", 1.2, "straighten the left knee", "bend the left knee more"),
    "right_knee": JointRule("Right knee", "right_leg", 1.2, "straighten the right knee", "bend the right knee more"),
    "left_leg_elevation": JointRule("Left leg", "left_leg", 1.5, "lift the left leg higher", "lower the left leg"),
    "right_leg_elevation": JointRule("Right leg", "right_leg", 1.5, "lift the right leg higher", "lower the right leg"),
    "left_elbow": JointRule(
        "Left elbow", "left_arm", 0.8, "round (bend) the left arm less", "round (bend) the left arm more"
    ),
    "right_elbow": JointRule(
        "Right elbow", "right_arm", 0.8, "round (bend) the right arm less", "round (bend) the right arm more"
    ),
    "left_arm_elevation": JointRule("Left arm", "left_arm", 1.0, "raise the left arm", "lower the left arm"),
    "right_arm_elevation": JointRule("Right arm", "right_arm", 1.0, "raise the right arm", "lower the right arm"),
    "torso_tilt": JointRule("Torso", "torso", 1.2, "lean the torso more", "bring the torso more upright"),
    "leg_spread": JointRule("Legs apart", "hips", 1.0, "open the legs wider", "bring the legs closer"),
}
STATUS_ORDER = {"ok": 0, "warn": 1, "bad": 2}


def joint_status(difference: float, tolerance: Tolerance) -> str:
    gap = abs(difference)
    if gap <= tolerance.good:
        return "ok"
    return "warn" if gap <= tolerance.fair else "bad"


def joint_score(difference: float, tolerance: Tolerance) -> float:
    """1 within the good tolerance, then linearly down to 0 at twice the fair one."""
    gap = abs(difference)
    if gap <= tolerance.good:
        return 1.0
    zero_at = 2 * tolerance.fair
    return max(0.0, 1 - (gap - tolerance.good) / (zero_at - tolerance.good))


def mirror(angles: JointAngles) -> JointAngles:
    """The same pose seen in a mirror: left and right swapped."""
    swapped = {}
    for field in fields(angles):
        name = field.name
        if name.startswith("left_"):
            swapped[name] = getattr(angles, "right_" + name.removeprefix("left_"))
        elif name.startswith("right_"):
            swapped[name] = getattr(angles, "left_" + name.removeprefix("right_"))
    return replace(angles, **swapped)


@dataclass(frozen=True)
class JointComparison:
    joint: str
    label: str
    part: str
    reference: float
    student: float
    difference: float  # student - reference, degrees
    status: str
    score: float  # 0-1

    @property
    def advice(self) -> str:
        rule = JOINT_RULES[self.joint]
        return rule.advice_when_lower if self.difference < 0 else rule.advice_when_higher


@dataclass(frozen=True)
class PoseComparison:
    joints: list[JointComparison]
    mirrored: bool

    @property
    def score(self) -> float | None:
        """Match in percent (None when no joint is visible on both dancers)."""
        total_weight = sum(JOINT_RULES[joint.joint].weight for joint in self.joints)
        if not total_weight:
            return None
        weighted = sum(JOINT_RULES[joint.joint].weight * joint.score for joint in self.joints)
        return round(100 * weighted / total_weight, 1)

    @property
    def parts(self) -> dict[str, str]:
        """The worst joint status of each body part."""
        status: dict[str, str] = {}
        for joint in self.joints:
            if STATUS_ORDER[joint.status] >= STATUS_ORDER.get(status.get(joint.part, "ok"), 0):
                status[joint.part] = joint.status
        return status

    def corrections(self) -> list[dict]:
        """What to change, the biggest differences first."""
        wrong = sorted(
            (joint for joint in self.joints if joint.status != "ok"), key=lambda joint: -abs(joint.difference)
        )
        return [
            {
                "joint": joint.joint,
                "part": joint.part,
                "status": joint.status,
                "message": f"{joint.advice.capitalize()} (you {joint.student:.0f}°, reference {joint.reference:.0f}°)",
            }
            for joint in wrong
        ]

    def to_api(self) -> dict:
        return {
            "score": self.score,
            "mirrored": self.mirrored,
            "joints": [{**asdict(joint), "advice": joint.advice} for joint in self.joints],
            "parts": self.parts,
            "corrections": self.corrections(),
        }


def compare_angles(
    reference: JointAngles, student: JointAngles, tolerance: Tolerance = DEFAULT_TOLERANCE, mirrored: bool = False
) -> PoseComparison:
    """Compare every angle measured on both dancers (``mirrored``: left with right)."""
    target = mirror(reference) if mirrored else reference
    joints = []
    for joint, rule in JOINT_RULES.items():
        reference_angle, student_angle = getattr(target, joint), getattr(student, joint)
        if reference_angle is None or student_angle is None:
            continue
        difference = round(student_angle - reference_angle, 1)
        joints.append(
            JointComparison(
                joint=joint,
                label=rule.label,
                part=rule.part,
                reference=round(reference_angle, 1),
                student=round(student_angle, 1),
                difference=difference,
                status=joint_status(difference, tolerance),
                score=round(joint_score(difference, tolerance), 3),
            )
        )
    return PoseComparison(joints, mirrored)


def best_comparison(
    reference: JointAngles,
    student: JointAngles,
    tolerance: Tolerance = DEFAULT_TOLERANCE,
    mode: MirrorMode = MirrorMode.AUTO,
) -> PoseComparison:
    if mode is not MirrorMode.AUTO:
        return compare_angles(reference, student, tolerance, mirrored=mode is MirrorMode.MIRRORED)
    same_side = compare_angles(reference, student, tolerance)
    mirrored = compare_angles(reference, student, tolerance, mirrored=True)
    return mirrored if (mirrored.score or 0) > (same_side.score or 0) else same_side
