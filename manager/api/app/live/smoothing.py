"""Exponential smoothing of keypoints between consecutive frames."""

from __future__ import annotations

from app.ballet.keypoints import RawKeypoint, is_visible

# Below this box overlap the person is treated as new (another dancer, a cut).
SAME_PERSON_MIN_IOU = 0.3


def box_iou(first: dict, second: dict) -> float:
    overlap_width = min(first["x2"], second["x2"]) - max(first["x1"], second["x1"])
    overlap_height = min(first["y2"], second["y2"]) - max(first["y1"], second["y1"])
    if overlap_width <= 0 or overlap_height <= 0:
        return 0.0
    intersection = overlap_width * overlap_height
    first_area = (first["x2"] - first["x1"]) * (first["y2"] - first["y1"])
    second_area = (second["x2"] - second["x1"]) * (second["y2"] - second["y1"])
    return intersection / (first_area + second_area - intersection)


class KeypointSmoother:
    """``smoothed = weight * previous + (1 - weight) * new`` for each visible keypoint.

    ``weight`` 0 gives the raw keypoints, 0.9 very smooth (but slower to follow).
    """

    def __init__(self, weight: float = 0.5) -> None:
        self.weight = weight
        self._smoothed: list[list[float]] | None = None
        self._previous_box: dict | None = None

    def reset(self) -> None:
        self._smoothed, self._previous_box = None, None

    def update(self, keypoints: list[RawKeypoint], box: dict) -> list[list[float]]:
        same_person = self._previous_box is not None and box_iou(self._previous_box, box) >= SAME_PERSON_MIN_IOU
        if self._smoothed is None or not same_person:
            self._smoothed = [list(keypoint) for keypoint in keypoints]
        else:
            for index, new in enumerate(keypoints):
                previous = self._smoothed[index]
                if is_visible(new) and is_visible(previous):
                    self._smoothed[index] = [
                        self.weight * previous[0] + (1 - self.weight) * new[0],
                        self.weight * previous[1] + (1 - self.weight) * new[1],
                        new[2],
                    ]
                else:
                    self._smoothed[index] = list(new)
        self._previous_box = box
        return [[round(x, 1), round(y, 1), round(visibility, 3)] for x, y, visibility in self._smoothed]
