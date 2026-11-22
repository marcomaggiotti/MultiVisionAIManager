"""Turn corrections that persist over several frames into comments for the dancer."""

from __future__ import annotations

from collections import Counter
from dataclasses import asdict

from app.ballet.feedback import Correction

MIN_SECONDS_BETWEEN_REPEATS = 4.0


def correction_topic(message: str) -> str:
    """The stable part of a message: ``"Supporting knee bent (153°): ..."`` ->
    ``"Supporting knee bent"`` (values change every frame, the topic does not)."""
    return message.split(" (")[0].split(":")[0]


class CorrectionLog:
    def __init__(self, persist_frames: int = 4) -> None:
        self.persist_frames = persist_frames
        self.comments: list[dict] = []
        self._frames_by_topic: Counter[str] = Counter()
        self._last_comment_at: dict[str, float] = {}

    def update(self, corrections: list[Correction], now: float, movement: str | None) -> list[dict]:
        """Record this frame's corrections; returns the comments created now."""
        problems = [correction for correction in corrections if correction.status != "ok"]
        active_topics = {correction_topic(correction.message) for correction in problems}
        for topic in list(self._frames_by_topic):
            if topic not in active_topics:
                del self._frames_by_topic[topic]

        new_comments = []
        for correction in problems:
            topic = correction_topic(correction.message)
            self._frames_by_topic[topic] += 1
            persisted = self._frames_by_topic[topic] >= self.persist_frames
            recently_said = now - self._last_comment_at.get(topic, float("-inf")) <= MIN_SECONDS_BETWEEN_REPEATS
            if persisted and not recently_said:
                self._last_comment_at[topic] = now
                comment = {"t": round(now, 2), "pose": movement, **asdict(correction)}
                self.comments.append(comment)
                new_comments.append(comment)
        return new_comments
