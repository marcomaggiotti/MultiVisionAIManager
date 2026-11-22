"""Keypoint adjustments: the user's corrected position of a dancer's keypoints at one
moment of a video (or in one picture).

They are stored per media (``media_key``: a file's name and size) and per time inside
it (``source_time``, seconds; 0 for a picture). When the same media is analysed again,
a frame close enough to an adjusted moment uses the adjusted keypoints instead of the
model's, so recognition, counting and feedback follow the correction.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass

from app.ballet.keypoints import VISIBILITY_THRESHOLD, Keypoint

# Frames of a replayed video are not sampled at exactly the same times: an adjustment
# applies to a frame within half the gap between frames (so to the closest one), at
# least this distance and at most MAX_MATCH_TOLERANCE_SECONDS.
MATCH_TOLERANCE_SECONDS = 0.05
MAX_MATCH_TOLERANCE_SECONDS = 0.25
BOX_PADDING = 0.08  # share of the keypoints' extent added around them
KEYPOINT_COUNT = len(Keypoint)


@dataclass(frozen=True)
class KeypointAdjustment:
    media_key: str
    source_time: float
    keypoints: list[list[float]]  # 17 x [x, y, visibility]
    box: dict  # x1, y1, x2, y2
    # Size of the picture the keypoints were placed on ({"width", "height"}), so they can
    # be rescaled when the media is analysed at another resolution.
    image: dict | None = None

    def as_dict(self) -> dict:
        return asdict(self)

    def as_detection(self, image: dict | None = None) -> dict:
        """The adjustment as a YOLO person detection, in the pixels of ``image``."""
        scale_x, scale_y = self._scale_to(image)
        keypoints = [[round(x * scale_x, 1), round(y * scale_y, 1), visibility] for x, y, visibility in self.keypoints]
        box = {
            "x1": round(self.box["x1"] * scale_x, 1),
            "y1": round(self.box["y1"] * scale_y, 1),
            "x2": round(self.box["x2"] * scale_x, 1),
            "y2": round(self.box["y2"] * scale_y, 1),
        }
        return {"label": "person", "class_id": 0, "confidence": 1.0, "box": box, "keypoints": keypoints}

    def _scale_to(self, image: dict | None) -> tuple[float, float]:
        if not (self.image and image and self.image.get("width") and self.image.get("height")):
            return 1.0, 1.0
        return image["width"] / self.image["width"], image["height"] / self.image["height"]


def box_around(keypoints: list[list[float]]) -> dict:
    """A box around the visible keypoints (all of them if none is visible)."""
    visible = [point for point in keypoints if point[2] >= VISIBILITY_THRESHOLD] or keypoints
    xs, ys = [point[0] for point in visible], [point[1] for point in visible]
    pad_x = (max(xs) - min(xs)) * BOX_PADDING
    pad_y = (max(ys) - min(ys)) * BOX_PADDING
    return {
        "x1": round(max(0.0, min(xs) - pad_x), 1),
        "y1": round(max(0.0, min(ys) - pad_y), 1),
        "x2": round(max(xs) + pad_x, 1),
        "y2": round(max(ys) + pad_y, 1),
    }


def match_tolerance(frame_gap: float | None) -> float:
    """How far from a saved moment a frame may be, given the time since the previous frame."""
    if not frame_gap or frame_gap <= 0:
        return MATCH_TOLERANCE_SECONDS
    return min(MAX_MATCH_TOLERANCE_SECONDS, max(MATCH_TOLERANCE_SECONDS, frame_gap / 2))


def find_adjustment(
    adjustments: list[KeypointAdjustment], source_time: float | None, tolerance: float = MATCH_TOLERANCE_SECONDS
) -> KeypointAdjustment | None:
    """The adjustment closest to ``source_time``, if within ``tolerance``."""
    if source_time is None or not adjustments:
        return None
    closest = min(adjustments, key=lambda adjustment: abs(adjustment.source_time - source_time))
    return closest if abs(closest.source_time - source_time) <= tolerance else None
