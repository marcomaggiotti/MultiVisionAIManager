"""Hysteresis on the recognised movement, and counting of the movements performed."""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass


@dataclass(frozen=True)
class PerformedMovement:
    """A movement held from ``start`` to ``end`` (seconds since the session started)."""

    movement: str
    start: float
    end: float
    best_score: float

    def to_api(self) -> dict:
        return {"step": self.movement, "start": self.start, "end": self.end, "best_score": self.best_score}


class MovementTracker:
    """A movement starts, or ends, only after it is seen ``hold_frames`` frames in a row,
    so that one uncertain frame does not make the display flicker."""

    def __init__(self, hold_frames: int = 4) -> None:
        self.hold_frames = hold_frames
        self.current: str | None = None
        self.current_since: float | None = None
        self.counts: Counter[str] = Counter()
        self.performed: list[PerformedMovement] = []
        self._candidate: str | None = None
        self._candidate_frames = 0
        self._current_best_score = 0.0

    def update(self, movement: str | None, score: float, now: float) -> list[PerformedMovement]:
        """Feed this frame's movement (``None`` = no movement). Returns the movements
        that just ended."""
        if movement and movement == self.current:
            self._current_best_score = max(self._current_best_score, score)

        if movement == self._candidate:
            self._candidate_frames += 1
        else:
            self._candidate, self._candidate_frames = movement, 1

        ended = []
        if self._candidate != self.current and self._candidate_frames >= self.hold_frames:
            finished = self.finish_current(now)
            if finished:
                ended.append(finished)
            if self._candidate is not None:
                self.current, self.current_since = self._candidate, now
                self._current_best_score = 0.0
        return ended

    def finish_current(self, now: float) -> PerformedMovement | None:
        if self.current is None:
            return None
        finished = PerformedMovement(
            movement=self.current,
            start=round(self.current_since, 2),
            end=round(now, 2),
            best_score=round(self._current_best_score, 3),
        )
        self.performed.append(finished)
        self.counts[self.current] += 1
        self.current, self.current_since, self._current_best_score = None, None, 0.0
        return finished

    def held_seconds(self, now: float) -> float | None:
        return round(now - self.current_since, 2) if self.current_since is not None else None
