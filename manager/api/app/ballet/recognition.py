"""Which ballet movement does the pose look like? One scoring rule per movement.

Each rule returns a score from 0 (not at all) to 1 (textbook shape) built from soft
ramps on the measured angles, so that a pose close to a threshold still scores a
little instead of flipping between movements.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

from app.ballet.measurements import PoseMeasurements
from app.ballet.movements import MOVEMENTS

MIN_CONFIDENCE = 0.35  # below this, no movement is recognised (a transition)
MIN_CANDIDATE_SCORE = 0.05
MAX_CANDIDATES = 5

# How much a movement still counts when the facing direction disagrees or is unknown.
BEHIND_WEIGHT = {True: 1.0, None: 0.55, False: 0.15}
IN_FRONT_WEIGHT = {False: 1.0, None: 0.5, True: 0.15}


@dataclass(frozen=True)
class MovementCandidate:
    movement: str
    score: float
    family: str


def ramp(value: float, start: float, end: float) -> float:
    """0 at ``start``, 1 at ``end``, linear in between (works for falling ramps too)."""
    return max(0.0, min(1.0, (value - start) / (end - start)))


def closeness(value: float, ideal: float, tolerance: float) -> float:
    """1 at ``ideal``, 0 at ``ideal ± tolerance``."""
    return max(0.0, 1 - abs(value - ideal) / tolerance)


def _score_arabesque(pose: PoseMeasurements) -> float:
    legs = pose.legs
    return (
        ramp(legs.working_leg_elevation, 40, 85)
        * ramp(legs.working_knee_angle or 0, 140, 170)
        * BEHIND_WEIGHT[pose.working_leg_behind]
        * (0.6 + 0.4 * ramp(legs.supporting_knee_angle or 0, 140, 170))
    )


def _score_attitude(pose: PoseMeasurements) -> float:
    legs = pose.legs
    return (
        ramp(legs.working_leg_elevation, 40, 85)
        * closeness(legs.working_knee_angle or 0, ideal=110, tolerance=50)
        * (1.0 if pose.working_leg_behind is not False else 0.6)
    )


def _score_developpe(pose: PoseMeasurements) -> float:
    legs = pose.legs
    return (
        ramp(legs.working_leg_elevation, 40, 85)
        * ramp(legs.working_knee_angle or 0, 140, 170)
        * IN_FRONT_WEIGHT[pose.working_leg_behind]
        * ramp(legs.working_leg_elevation, 140, 100)  # very high legs are grands battements
    )


def _score_grand_battement(pose: PoseMeasurements) -> float:
    legs = pose.legs
    return (
        ramp(legs.working_leg_elevation, 95, 125)
        * ramp(legs.working_knee_angle or 0, 140, 170)
        * IN_FRONT_WEIGHT[pose.working_leg_behind]
    )


def _score_passe(pose: PoseMeasurements) -> float:
    legs = pose.legs
    if not pose.working_foot_at_supporting_knee:
        return 0.0
    return ramp(legs.working_knee_angle or 0, 120, 80) * (0.5 + 0.5 * ramp(legs.supporting_knee_angle or 0, 140, 170))


def _score_grand_jete(pose: PoseMeasurements) -> float:
    return ramp(pose.angles.leg_spread or 0, 120, 165) * ramp(pose.legs.working_knee_angle or 0, 140, 170)


def _score_plie(pose: PoseMeasurements) -> float:
    left_knee, right_knee = pose.angles.left_knee or 0, pose.angles.right_knee or 0
    return (
        ramp(max(left_knee, right_knee), 160, 130)
        * ramp(pose.legs.working_leg_elevation, 40, 20)
        * closeness(left_knee, ideal=right_knee, tolerance=40)
    )


def _both_legs_straight_and_down(pose: PoseMeasurements) -> float:
    straighter_knee = min(pose.angles.left_knee or 0, pose.angles.right_knee or 0)
    return ramp(straighter_knee, 155, 170)


def _score_second_position(pose: PoseMeasurements) -> float:
    return (
        _both_legs_straight_and_down(pose)
        * ramp(pose.legs.working_leg_elevation, 25, 15)
        * ramp(pose.angles.leg_spread or 0, 15, 30)
    )


def _score_first_or_fifth_position(pose: PoseMeasurements) -> float:
    return (
        _both_legs_straight_and_down(pose)
        * ramp(pose.legs.working_leg_elevation, 20, 10)
        * ramp(pose.angles.leg_spread or 0, 25, 10)
    )


SCORING_RULES: dict[str, Callable[[PoseMeasurements], float]] = {
    "arabesque": _score_arabesque,
    "attitude": _score_attitude,
    "développé": _score_developpe,
    "grand battement": _score_grand_battement,
    "passé": _score_passe,
    "grand jeté": _score_grand_jete,
    "plié": _score_plie,
    "second position": _score_second_position,
    "first / fifth position": _score_first_or_fifth_position,
}


def recognise_movements(pose: PoseMeasurements) -> list[MovementCandidate]:
    """Candidate movements, best first. Empty when the legs are not visible."""
    if pose.legs is None:
        return []
    scored = [
        MovementCandidate(name, round(rule(pose), 3), MOVEMENTS[name].family) for name, rule in SCORING_RULES.items()
    ]
    scored = [candidate for candidate in scored if candidate.score > MIN_CANDIDATE_SCORE]
    scored.sort(key=lambda candidate: candidate.score, reverse=True)
    return scored[:MAX_CANDIDATES]


def best_movement(candidates: list[MovementCandidate]) -> MovementCandidate | None:
    """The recognised movement, if the best candidate is confident enough."""
    if candidates and candidates[0].score >= MIN_CONFIDENCE:
        return candidates[0]
    return None
