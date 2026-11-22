"""One real-time session: frames in, smoothed pose, movement and corrections out."""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass

from app.ballet import evaluate_pose
from app.ballet.dancer import select_main_dancer
from app.ballet.motion import mean_joint_displacement
from app.live.adjustments import KeypointAdjustment, find_adjustment, match_tolerance
from app.live.corrections import CorrectionLog
from app.live.smoothing import KeypointSmoother
from app.live.tracking import MovementTracker

MAX_SAVED_COMMENTS = 200


@dataclass
class LiveSettings:
    smoothing: float = 0.5  # 0 = raw keypoints, 0.9 = very smooth
    hold: int = 4  # frames a movement (or a correction) must persist
    confidence: float = 0.35  # minimum score to recognise a movement


class LiveSession:
    def __init__(self, settings: LiveSettings | None = None) -> None:
        self.id = time.strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:4]
        self.started_at = time.time()
        self.settings = settings or LiveSettings()
        self.frame_count = 0
        self.smoother = KeypointSmoother(self.settings.smoothing)
        self.tracker = MovementTracker(self.settings.hold)
        self.correction_log = CorrectionLog(self.settings.hold)
        self._previous_raw_keypoints: list | None = None
        self.media_key: str | None = None
        self.adjustments: list[KeypointAdjustment] = []
        self._previous_source_time: float | None = None

    def configure(
        self, smoothing: float | None = None, hold: int | None = None, confidence: float | None = None
    ) -> None:
        if smoothing is not None:
            self.settings.smoothing = self.smoother.weight = float(smoothing)
        if hold is not None:
            self.settings.hold = self.tracker.hold_frames = self.correction_log.persist_frames = int(hold)
        if confidence is not None:
            self.settings.confidence = float(confidence)

    def use_media(self, media_key: str | None, adjustments: list[KeypointAdjustment]) -> None:
        """The video (or pictures) being analysed, with its saved keypoint adjustments."""
        self.media_key = media_key
        self.adjustments = list(adjustments)
        self._previous_source_time = None

    def add_adjustment(self, adjustment: KeypointAdjustment) -> None:
        self.adjustments = [
            existing for existing in self.adjustments if abs(existing.source_time - adjustment.source_time) > 1e-3
        ] + [adjustment]

    def remove_adjustment(self, source_time: float) -> None:
        self.adjustments = [existing for existing in self.adjustments if abs(existing.source_time - source_time) > 1e-3]

    def elapsed(self) -> float:
        return time.time() - self.started_at

    def process_detections(self, yolo_response: dict, source_time: float | None = None) -> dict:
        """Update the session with the YOLO module's answer for one frame.

        ``source_time`` is the frame's time inside the video: a saved keypoint
        adjustment at that moment replaces the model's keypoints.
        """
        now = self.elapsed()
        self.frame_count += 1
        result: dict = {
            "frame": self.frame_count,
            "t": round(now, 3),
            "people": yolo_response.get("counts", {}).get("person", 0),
            "dancer": None,
            "evaluation": None,
            "motion": None,
            "new_events": [],
            "new_comments": [],
            "source_time": source_time,
            "adjusted": False,
        }
        recognised_movement, recognition_score = None, 0.0
        adjustment = find_adjustment(self.adjustments, source_time, match_tolerance(self._frame_gap(source_time)))
        if adjustment:
            dancer = adjustment.as_detection(yolo_response.get("image"))
            self.smoother.reset()  # the adjusted keypoints are used exactly as saved
            result["adjusted"] = True
            result["people"] = max(result["people"], 1)
        else:
            dancer = select_main_dancer(yolo_response.get("detections", []))
        if dancer and dancer.get("keypoints"):
            keypoints = self.smoother.update(dancer["keypoints"], dancer["box"])
            evaluation = evaluate_pose(keypoints)
            result["dancer"] = {"box": dancer["box"], "confidence": dancer["confidence"], "keypoints": keypoints}
            result["evaluation"] = evaluation.to_api()
            result["motion"] = self._motion_since_previous_frame(
                dancer["keypoints"], evaluation.measurements.body_height
            )
            best = evaluation.candidates[0] if evaluation.candidates else None
            if best and best.score >= self.settings.confidence:
                recognised_movement, recognition_score = best.movement, best.score
            result["new_comments"] = self.correction_log.update(evaluation.corrections, now, self.tracker.current)
        else:
            self.smoother.reset()
            self._previous_raw_keypoints = None

        ended = self.tracker.update(recognised_movement, recognition_score, now)
        result["new_events"] = [movement.to_api() for movement in ended]
        result["current"] = {
            "step": self.tracker.current,
            "since": round(self.tracker.current_since, 2) if self.tracker.current_since is not None else None,
            "held_s": self.tracker.held_seconds(now),
        }
        result["counts"] = dict(self.tracker.counts)
        return result

    def _frame_gap(self, source_time: float | None) -> float | None:
        """Seconds of video since the previous frame (None when unknown)."""
        previous, self._previous_source_time = self._previous_source_time, source_time
        if previous is None or source_time is None:
            return None
        return source_time - previous

    def _motion_since_previous_frame(self, raw_keypoints: list, body_height: float | None) -> float | None:
        previous, self._previous_raw_keypoints = self._previous_raw_keypoints, raw_keypoints
        if previous is None or not body_height:
            return None
        displacement = mean_joint_displacement(previous, raw_keypoints, body_height, decimals=4)
        return displacement

    def summary(self) -> dict:
        """The session so far (the movement being held is closed first)."""
        self.tracker.finish_current(self.elapsed())
        return {
            "id": self.id,
            "started": self.started_at,
            "duration_s": round(self.elapsed(), 1),
            "frames": self.frame_count,
            "counts": dict(self.tracker.counts),
            "events": [movement.to_api() for movement in self.tracker.performed],
            "comments": self.correction_log.comments[-MAX_SAVED_COMMENTS:],
        }
