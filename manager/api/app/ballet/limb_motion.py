"""Which limb moves, and when: from the keypoints of every analysed frame of a video.

Each limb is measured relative to the body, so a dancer crossing the floor does not
"move" every limb: arms and head relative to the shoulders' centre, legs relative to the
hips' centre, the torso (bending, tilting) as the shoulders relative to the hips. The whole
body moving in the picture (travelling, jumping, going down in a plié) is its own part.
Speeds are in torso lengths per second, so they do not depend on how far the dancer is
from the camera. YOLO keypoints jitter by a few pixels from frame to frame: positions are
smoothed first and the speed is measured over a span of frames (not from one frame to the
next), and a limb's speed is the one of its fastest point (a knee bending moves the knee,
not the ankle).

A limb *moves* while its (smoothed) speed is above the threshold for long enough; close
stretches are merged. Movements of several limbs that overlap form a *moment* (e.g. the
right leg and the left arm together), which is what the studio plays, from a little before.
"""

from __future__ import annotations

import math
from collections import Counter
from dataclasses import asdict, dataclass

from app.ballet.keypoints import VISIBILITY_THRESHOLD, Keypoint

Point = tuple[float, float]


@dataclass(frozen=True)
class Limb:
    id: str
    label: str
    color: str
    points: tuple[int, ...]  # the keypoints that move with it
    reference: str  # "shoulders", "hips" or "picture"
    bones: tuple[tuple[int, int], ...]  # drawn in its colour


K = Keypoint
LIMBS = (
    Limb("left_arm", "Left arm", "#4f8cff", (K.LEFT_ELBOW, K.LEFT_WRIST), "shoulders",
         ((K.LEFT_SHOULDER, K.LEFT_ELBOW), (K.LEFT_ELBOW, K.LEFT_WRIST))),
    Limb("right_arm", "Right arm", "#a78bfa", (K.RIGHT_ELBOW, K.RIGHT_WRIST), "shoulders",
         ((K.RIGHT_SHOULDER, K.RIGHT_ELBOW), (K.RIGHT_ELBOW, K.RIGHT_WRIST))),
    Limb("left_leg", "Left leg", "#3ddc84", (K.LEFT_KNEE, K.LEFT_ANKLE), "hips",
         ((K.LEFT_HIP, K.LEFT_KNEE), (K.LEFT_KNEE, K.LEFT_ANKLE))),
    Limb("right_leg", "Right leg", "#ff9f5a", (K.RIGHT_KNEE, K.RIGHT_ANKLE), "hips",
         ((K.RIGHT_HIP, K.RIGHT_KNEE), (K.RIGHT_KNEE, K.RIGHT_ANKLE))),
    Limb("head", "Head", "#5ee3e8", (K.NOSE,), "shoulders",
         ((K.NOSE, K.LEFT_EYE), (K.NOSE, K.RIGHT_EYE), (K.LEFT_EYE, K.LEFT_EAR), (K.RIGHT_EYE, K.RIGHT_EAR))),
    Limb("torso", "Torso", "#ffd23f", (K.LEFT_SHOULDER, K.RIGHT_SHOULDER), "hips",
         ((K.LEFT_SHOULDER, K.RIGHT_SHOULDER), (K.LEFT_SHOULDER, K.LEFT_HIP), (K.RIGHT_SHOULDER, K.RIGHT_HIP),
          (K.LEFT_HIP, K.RIGHT_HIP))),
    Limb("body", "Whole body", "#ff7ac6", (K.LEFT_HIP, K.RIGHT_HIP), "picture", ()),
)  # fmt: skip

DEFAULT_THRESHOLD = 0.3  # torso lengths per second (a still limb, with YOLO jitter: < 0.15)
DEFAULT_MIN_DURATION = 0.3  # seconds
MERGE_GAP = 0.4  # seconds: two stretches of one limb closer than this are one movement
MOMENT_GAP = 0.3  # seconds: movements of different limbs closer than this are one moment
SMOOTHING_SECONDS = 0.33  # positions are averaged over this
SPAN_SECONDS = 0.4  # speeds are measured over this


@dataclass(frozen=True)
class LimbMovement:
    limb: str
    start: float
    end: float
    peak: float  # torso lengths per second
    mean: float
    movement: str | None  # the ballet movement recognised meanwhile (most frames)

    def to_api(self) -> dict:
        return asdict(self)


def _visible(keypoints: list, index: int) -> Point | None:
    point = keypoints[index]
    return (point[0], point[1]) if point[2] >= VISIBILITY_THRESHOLD else None


def _centre(keypoints: list, first: int, second: int) -> Point | None:
    a, b = _visible(keypoints, first), _visible(keypoints, second)
    return ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2) if a and b else None


def _body(keypoints: list | None) -> dict | None:
    """The references of one frame: shoulders' and hips' centres, and the torso length."""
    if not keypoints:
        return None
    shoulders = _centre(keypoints, K.LEFT_SHOULDER, K.RIGHT_SHOULDER)
    hips = _centre(keypoints, K.LEFT_HIP, K.RIGHT_HIP)
    if not shoulders or not hips or math.dist(shoulders, hips) < 1:
        return None
    return {"shoulders": shoulders, "hips": hips, "picture": (0.0, 0.0), "torso": math.dist(shoulders, hips)}


def _relative(keypoints: list, body: dict, limb: Limb) -> list[Point] | None:
    origin = body[limb.reference]
    points = []
    for index in limb.points:
        point = _visible(keypoints, index)
        if point is None:
            return None
        points.append((point[0] - origin[0], point[1] - origin[1]))
    return points


def _smooth_points(series: list[list[Point] | None], window: int) -> list[list[Point] | None]:
    """Each frame's points averaged with its neighbours' (frames where the limb is seen)."""
    half = window // 2
    smoothed: list[list[Point] | None] = []
    for index, points in enumerate(series):
        near = [other for other in series[max(0, index - half) : index + half + 1] if other is not None]
        if points is None or not near:
            smoothed.append(None)
            continue
        smoothed.append([
            (sum(other[point][0] for other in near) / len(near), sum(other[point][1] for other in near) / len(near))
            for point in range(len(points))
        ])  # fmt: skip
    return smoothed


def limb_speeds(frames: list[dict], fps: float) -> dict[str, list[float | None]]:
    """Each limb's speed at each frame (torso lengths per second); None when it is not seen."""
    keypoints = [(frame.get("dancer") or {}).get("keypoints") for frame in frames]
    bodies = [_body(points) for points in keypoints]
    times = [frame["source_time"] for frame in frames]
    window = max(1, round(SMOOTHING_SECONDS * fps)) | 1  # odd, centred
    reach = max(1, round(SPAN_SECONDS * fps / 2))  # the speed at i: from i - reach to i + reach
    speeds = {}
    for limb in LIMBS:
        relative = [
            _relative(points, body, limb) if points and body else None
            for points, body in zip(keypoints, bodies, strict=True)
        ]
        smoothed = _smooth_points(relative, window)
        values: list[float | None] = []
        for index in range(len(frames)):
            first, last = max(0, index - reach), min(len(frames) - 1, index + reach)
            before, after = smoothed[first], smoothed[last]
            elapsed = times[last] - times[first]
            if smoothed[index] is None or before is None or after is None or elapsed <= 0:
                values.append(None)
                continue
            torso = (bodies[first]["torso"] + bodies[last]["torso"]) / 2
            moved = max(math.dist(a, b) for a, b in zip(before, after, strict=True))
            values.append(round(moved / torso / elapsed, 3))
        speeds[limb.id] = values
    return speeds


def find_movements(
    frames: list[dict],
    speeds: dict[str, list[float | None]],
    threshold: float = DEFAULT_THRESHOLD,
    min_duration: float = DEFAULT_MIN_DURATION,
) -> list[LimbMovement]:
    """The stretches of time each limb moves (above ``threshold`` for at least ``min_duration``)."""
    times = [frame["source_time"] for frame in frames]
    movements = []
    for limb in LIMBS:
        runs: list[list[int]] = []
        for index, speed in enumerate(speeds[limb.id]):
            if speed is None or speed < threshold:
                continue
            if runs and times[index] - times[runs[-1][1]] <= MERGE_GAP:
                runs[-1][1] = index
            else:
                runs.append([index, index])
        for first, last in runs:
            start, end = times[max(0, first - 1)], times[last]  # it starts moving on the frame before
            if end - start < min_duration:
                continue
            values = [speed for speed in speeds[limb.id][first : last + 1] if speed is not None]
            steps = [((frame.get("current") or {}).get("step")) for frame in frames[first : last + 1]]
            named = Counter(step for step in steps if step)
            movements.append(LimbMovement(
                limb.id, round(start, 3), round(end, 3), round(max(values), 2), round(sum(values) / len(values), 2),
                named.most_common(1)[0][0] if named else None,
            ))  # fmt: skip
    return sorted(movements, key=lambda movement: (movement.start, movement.limb))


def group_moments(movements: list[LimbMovement]) -> list[dict]:
    """Movements that overlap (or nearly) form one moment: its time span and its limbs, the fastest first."""
    moments: list[dict] = []
    for movement in sorted(movements, key=lambda item: item.start):
        if moments and movement.start <= moments[-1]["end"] + MOMENT_GAP:
            moment = moments[-1]
            moment["end"] = max(moment["end"], movement.end)
            moment["movements"].append(movement)
        else:
            moments.append({"start": movement.start, "end": movement.end, "movements": [movement]})
    result = []
    for moment in moments:
        ordered = sorted(moment["movements"], key=lambda item: -item.peak)
        named = Counter(item.movement for item in ordered if item.movement)
        result.append({
            "start": moment["start"], "end": moment["end"], "limbs": list(dict.fromkeys(item.limb for item in ordered)),
            "peak": ordered[0].peak, "movement": named.most_common(1)[0][0] if named else None,
        })  # fmt: skip
    return result


def analyse_limbs(
    analysis: dict,
    threshold: float = DEFAULT_THRESHOLD,
    min_duration: float = DEFAULT_MIN_DURATION,
    allowed: list[str] | None = None,
) -> dict:
    """Everything the studio needs: the limbs, every frame's speeds, the movements and the moments.
    ``allowed``: the limbs the moments are made of (the others' movements are still listed)."""
    frames = analysis["frames"]
    speeds = limb_speeds(frames, analysis["fps"])
    movements = find_movements(frames, speeds, threshold, min_duration)
    in_moments = [movement for movement in movements if allowed is None or movement.limb in allowed]
    return {
        "fps": analysis["fps"],
        "threshold": threshold,
        "min_duration": min_duration,
        "limbs": [{"id": limb.id, "label": limb.label, "color": limb.color, "bones": limb.bones} for limb in LIMBS],
        "times": [frame["source_time"] for frame in frames],
        "speeds": speeds,
        "movements": [movement.to_api() for movement in movements],
        "moments": [{**moment} for moment in group_moments(in_moments)],
    }
