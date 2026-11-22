"""Evaluate one pose: measurements, recognised movement and technique feedback."""

from __future__ import annotations

from dataclasses import asdict, dataclass

from app.ballet.feedback import Correction, status_by_body_part, technique_feedback
from app.ballet.keypoints import RawKeypoint
from app.ballet.measurements import PoseMeasurements, measure
from app.ballet.recognition import MovementCandidate, best_movement, recognise_movements


@dataclass(frozen=True)
class PoseEvaluation:
    measurements: PoseMeasurements
    candidates: list[MovementCandidate]
    recognised: MovementCandidate | None
    corrections: list[Correction]
    body_part_status: dict[str, str]

    def to_api(self) -> dict:
        """The JSON shape of the live API (``step`` is the API's name for a movement)."""
        measurements = self.measurements
        return {
            "angles": measurements.angles.as_dict(),
            "working_side": measurements.legs.working_side if measurements.legs else None,
            "facing_away_leg_behind": measurements.working_leg_behind,
            "visible_keypoints": measurements.visible_keypoints,
            "body_height_px": measurements.body_height,
            "candidates": [_candidate_to_api(candidate) for candidate in self.candidates],
            "pose": _candidate_to_api(self.recognised) if self.recognised else None,
            "feedback": [asdict(correction) for correction in self.corrections],
            "parts": self.body_part_status,
        }


def _candidate_to_api(candidate: MovementCandidate) -> dict:
    return {"step": candidate.movement, "score": candidate.score, "family": candidate.family}


def evaluate_pose(keypoints: list[RawKeypoint]) -> PoseEvaluation:
    measurements = measure(keypoints)
    candidates = recognise_movements(measurements)
    recognised = best_movement(candidates)
    corrections = technique_feedback(recognised.movement if recognised else None, measurements)
    return PoseEvaluation(
        measurements=measurements,
        candidates=candidates,
        recognised=recognised,
        corrections=corrections,
        body_part_status=status_by_body_part(corrections),
    )
