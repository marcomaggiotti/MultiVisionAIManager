"""Real-time comparison: the reference dancer (a video) and the student (the camera)
are tracked side by side, frame pair by frame pair, and their joint angles compared.

A student copying a video reacts a little late, so each student pose is compared with
the reference poses of the last ``max_delay`` seconds and the best match is kept
(the delay found is reported).
"""

from __future__ import annotations

import time
import uuid
from collections import deque
from dataclasses import dataclass, field

from app.ballet import evaluate_pose
from app.ballet.comparison import MirrorMode, PoseComparison, Tolerance, best_comparison
from app.ballet.dancer import select_main_dancer
from app.ballet.measurements import JointAngles
from app.live.adjustments import KeypointAdjustment, find_adjustment
from app.live.smoothing import KeypointSmoother

REFERENCE_HISTORY_SECONDS = 3.0
GOOD_MATCH_SCORE = 80.0  # a frame counts as "in step" from this score


@dataclass
class ComparisonSettings:
    good_degrees: float = 15.0
    fair_degrees: float = 30.0
    mirror: MirrorMode = MirrorMode.AUTO
    max_delay: float = 0.6  # seconds the student may lag behind the reference
    smoothing: float = 0.4
    score_smoothing: float = 0.7  # of the live match score (0 = jumpy, 0.9 = slow)

    @property
    def tolerance(self) -> Tolerance:
        return Tolerance(self.good_degrees, self.fair_degrees)


@dataclass
class TrackedDancer:
    """One side (reference or student): its smoother and what was found in the last frame."""

    smoother: KeypointSmoother
    dancer: dict | None = None
    angles: JointAngles | None = None
    movement: str | None = None

    def update(self, detection: dict | None) -> None:
        if not detection or not detection.get("keypoints"):
            self.smoother.reset()
            self.dancer, self.angles, self.movement = None, None, None
            return
        keypoints = self.smoother.update(detection["keypoints"], detection["box"])
        evaluation = evaluate_pose(keypoints)
        self.dancer = {"box": detection["box"], "confidence": detection["confidence"], "keypoints": keypoints}
        self.angles = evaluation.measurements.angles
        self.movement = evaluation.recognised.movement if evaluation.recognised else None

    def to_api(self) -> dict:
        return {
            "dancer": self.dancer,
            "angles": self.angles.as_dict() if self.angles else None,
            "movement": self.movement,
        }


@dataclass
class ScoreStatistics:
    frames_compared: int = 0
    score_total: float = 0.0
    frames_in_step: int = 0
    match_score: float | None = None  # smoothed, shown live
    best_score: float = 0.0
    part_problems: dict[str, int] = field(default_factory=dict)  # frames with a red part

    def add(self, comparison: PoseComparison, score_smoothing: float) -> None:
        score = comparison.score
        if score is None:
            return
        self.frames_compared += 1
        self.score_total += score
        self.frames_in_step += score >= GOOD_MATCH_SCORE
        self.best_score = max(self.best_score, score)
        previous = self.match_score
        self.match_score = score if previous is None else score_smoothing * previous + (1 - score_smoothing) * score
        for part, status in comparison.parts.items():
            if status == "bad":
                self.part_problems[part] = self.part_problems.get(part, 0) + 1

    def to_api(self) -> dict:
        compared = self.frames_compared
        return {
            "match_score": round(self.match_score, 1) if self.match_score is not None else None,
            "average_score": round(self.score_total / compared, 1) if compared else None,
            "best_score": round(self.best_score, 1),
            "in_step_share": round(self.frames_in_step / compared, 3) if compared else None,
            "frames_compared": compared,
            "part_problems": dict(sorted(self.part_problems.items(), key=lambda item: -item[1])),
        }


class ComparisonSession:
    def __init__(self, settings: ComparisonSettings | None = None) -> None:
        self.id = time.strftime("cmp-%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:4]
        self.started_at = time.time()
        self.settings = settings or ComparisonSettings()
        self.frame_count = 0
        self.reference = TrackedDancer(KeypointSmoother(self.settings.smoothing))
        self.student = TrackedDancer(KeypointSmoother(self.settings.smoothing))
        self.statistics = ScoreStatistics()
        self.reference_media_key: str | None = None
        self.reference_adjustments: list[KeypointAdjustment] = []
        # (time in the reference video, its angles), to match a student who lags behind
        self._reference_history: deque[tuple[float, JointAngles]] = deque()

    def configure(self, **changes) -> None:
        for name, value in changes.items():
            if value is None or not hasattr(self.settings, name):
                continue
            current = getattr(self.settings, name)
            setattr(self.settings, name, MirrorMode(value) if isinstance(current, MirrorMode) else float(value))
        self.reference.smoother.weight = self.student.smoother.weight = self.settings.smoothing

    def use_reference(self, media_key: str | None, adjustments: list[KeypointAdjustment]) -> None:
        """The reference video, with its saved keypoint adjustments."""
        self.reference_media_key = media_key
        self.reference_adjustments = list(adjustments)
        self.restart()

    def restart(self) -> None:
        """Start the scoring again (e.g. the reference video starts over)."""
        self.statistics = ScoreStatistics()
        self._reference_history.clear()
        self.reference.smoother.reset()
        self.student.smoother.reset()

    def process(self, reference_response: dict, student_response: dict, reference_time: float | None) -> dict:
        """Update both dancers with the YOLO module's answers for one pair of frames."""
        self.frame_count += 1
        adjustment = find_adjustment(self.reference_adjustments, reference_time)
        reference_detection = (
            adjustment.as_detection(reference_response.get("image"))
            if adjustment
            else select_main_dancer(reference_response.get("detections", []))
        )
        self.reference.update(reference_detection)
        self.student.update(select_main_dancer(student_response.get("detections", [])))

        comparison, delay = self._compare(reference_time)
        if comparison:
            self.statistics.add(comparison, self.settings.score_smoothing)
        return {
            "frame": self.frame_count,
            "t": round(time.time() - self.started_at, 3),
            "reference_time": reference_time,
            "reference": {**self.reference.to_api(), "adjusted": adjustment is not None},
            "student": self.student.to_api(),
            "comparison": {**comparison.to_api(), "delay_s": delay} if comparison else None,
            **self.statistics.to_api(),
        }

    def _compare(self, reference_time: float | None) -> tuple[PoseComparison | None, float | None]:
        reference_angles, student_angles = self.reference.angles, self.student.angles
        if reference_angles is not None and reference_time is not None:
            self._remember(reference_time, reference_angles)
        if student_angles is None or reference_angles is None:
            return None, None
        candidates = [(reference_time, reference_angles)]
        if reference_time is not None:
            earliest = reference_time - self.settings.max_delay
            candidates = [(moment, angles) for moment, angles in self._reference_history if moment >= earliest]
        tolerance, mode = self.settings.tolerance, self.settings.mirror
        scored = [(best_comparison(angles, student_angles, tolerance, mode), moment) for moment, angles in candidates]
        # the best match; on a tie, the most recent reference pose
        comparison, moment = max(reversed(scored), key=lambda pair: pair[0].score or 0)
        delay = round(reference_time - moment, 2) if reference_time is not None and moment is not None else None
        return comparison, delay

    def _remember(self, reference_time: float, angles: JointAngles) -> None:
        history = self._reference_history
        if history and reference_time < history[-1][0]:
            history.clear()  # the reference video went back (seek or loop)
        history.append((reference_time, angles))
        while history and history[0][0] < reference_time - REFERENCE_HISTORY_SECONDS:
            history.popleft()

    def summary(self) -> dict:
        return {
            "id": self.id,
            "reference": self.reference_media_key,
            "duration_s": round(time.time() - self.started_at, 1),
            "frames": self.frame_count,
            **self.statistics.to_api(),
        }
