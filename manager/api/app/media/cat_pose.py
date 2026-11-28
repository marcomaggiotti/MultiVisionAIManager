"""The dancer's pose as the cat follows it: steady keypoints and the way she faces.

``steady_track`` removes YOLO's jitter from the keypoints (a centred average, without lag, as
the whole video is known) and fills keypoints missed for a moment.

``facing_angles`` finds which way the dancer faces, frame by frame: the yaw, the turn about
her vertical axis (0: facing the camera, +90°: facing the right of the picture, ±180°: her
back to the camera). Her shoulders and hips look narrower as she turns (the cosine), and
her nose, ahead of her neck, or the one ear seen tells to which side (the sine); her face seen
(nose and both eyes) means she is not turned away, even when left and right come mirrored
(a mirrored webcam picture). The angle is
smoothed over time as a direction, so a pirouette turns continuously through the back.

``cat_track`` puts it together for a whole analysed video: what the studio's preview and the
exported video both draw the 3D cat from.
"""

from __future__ import annotations

import math

from app.media.video_comparison import VISIBLE

MAX_GAP_SECONDS = 0.5  # keypoints missed for less than this are filled in
SMOOTH_SECONDS = 0.05  # the keypoints' steadying: gaussian sigma, in seconds
TURN_SMOOTH_SECONDS = 0.1  # the facing angle's steadying
NOSE, LEFT_EYE, RIGHT_EYE, LEFT_EAR, RIGHT_EAR = 0, 1, 2, 3, 4
LEFT_SHOULDER, RIGHT_SHOULDER, LEFT_HIP, RIGHT_HIP = 5, 6, 11, 12
Keypoints = list[list[float]]  # [x, y, confidence] × 17


def steady_track(times: list[float], frames: list[Keypoints | None]) -> list[Keypoints | None]:
    """The keypoints of every analysed frame made steady for the cat (``None``: no dancer)."""
    count = len(times)
    track = [[[0.0, 0.0, 0.0] for _ in range(17)] for _ in range(count)]
    for k in range(17):
        xs = [points[k][0] if points else 0.0 for points in frames]
        ys = [points[k][1] if points else 0.0 for points in frames]
        confidences = [points[k][2] if points else 0.0 for points in frames]
        seen = [confidence >= VISIBLE for confidence in confidences]
        # keypoints missed for a moment: in a line between the frames around
        previous = -1
        for i in range(count):
            if not seen[i]:
                continue
            if previous >= 0 and i - previous > 1 and times[i] - times[previous] <= MAX_GAP_SECONDS:
                for j in range(previous + 1, i):
                    share = (times[j] - times[previous]) / (times[i] - times[previous])
                    xs[j] = xs[previous] + (xs[i] - xs[previous]) * share
                    ys[j] = ys[previous] + (ys[i] - ys[previous]) * share
                    confidences[j] = VISIBLE
                    seen[j] = True
            previous = i
        # the jitter: a gaussian average over the frames around (before and after)
        for i in range(count):
            if not seen[i]:
                continue
            neighbours = [i]
            j = i - 1
            while j >= 0 and seen[j] and times[i] - times[j] <= 3 * SMOOTH_SECONDS:
                neighbours.append(j)
                j -= 1
            j = i + 1
            while j < count and seen[j] and times[j] - times[i] <= 3 * SMOOTH_SECONDS:
                neighbours.append(j)
                j += 1
            weights = [math.exp(-0.5 * ((times[j] - times[i]) / SMOOTH_SECONDS) ** 2) for j in neighbours]
            total = sum(weights)
            track[i][k] = [
                sum(xs[j] * w for j, w in zip(neighbours, weights, strict=True)) / total,
                sum(ys[j] * w for j, w in zip(neighbours, weights, strict=True)) / total,
                max(VISIBLE, sum(confidences[j] * w for j, w in zip(neighbours, weights, strict=True)) / total),
            ]
    return [points if any(point[2] > 0 for point in points) else None for points in track]


def _percentile(values: list[float], share: float, default: float) -> float:
    if not values:
        return default
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, int(share * len(ordered)))]


def _torso(points: Keypoints) -> tuple[tuple[float, float], tuple[float, float], float] | None:
    """The neck (between the shoulders), the up direction in the picture and the torso length."""
    if not all(points[index][2] >= VISIBLE for index in (LEFT_SHOULDER, RIGHT_SHOULDER, LEFT_HIP, RIGHT_HIP)):
        return None
    neck = ((points[5][0] + points[6][0]) / 2, (points[5][1] + points[6][1]) / 2)
    hips = ((points[11][0] + points[12][0]) / 2, (points[11][1] + points[12][1]) / 2)
    length = math.dist(neck, hips)
    if length < 1:
        return None
    return neck, ((neck[0] - hips[0]) / length, (neck[1] - hips[1]) / length), length


def _across(points: Keypoints, left: int, right: int, side: tuple[float, float], length: float) -> float:
    """How far the left point is to the dancer's left of the right one, in torso lengths."""
    return ((points[left][0] - points[right][0]) * side[0] + (points[left][1] - points[right][1]) * side[1]) / length


def facing_angles(times: list[float], track: list[Keypoints | None]) -> tuple[list[float | None], float, float]:
    """The yaw of every frame (radians, ``None`` without a torso), and the shoulder and hip
    widths facing the camera (in torso lengths)."""
    measures: list[tuple[float, float, float, bool] | None] = []
    for points in track:
        torso = _torso(points) if points else None
        if torso is None:
            measures.append(None)
            continue
        neck, up, length = torso
        side = (-up[1], up[0])  # the picture's "left of the dancer facing the camera" direction
        shoulders = _across(points, LEFT_SHOULDER, RIGHT_SHOULDER, side, length)
        hips = _across(points, LEFT_HIP, RIGHT_HIP, side, length)
        # to which side she faces: the nose ahead of the neck, else the one ear seen
        if points[NOSE][2] >= VISIBLE:
            ahead = ((points[NOSE][0] - neck[0]) * side[0] + (points[NOSE][1] - neck[1]) * side[1]) / length
            evidence = max(-1.0, min(1.0, ahead / 0.22))
        else:
            left_ear, right_ear = points[LEFT_EAR][2] >= VISIBLE, points[RIGHT_EAR][2] >= VISIBLE
            evidence = -0.6 if left_ear and not right_ear else 0.6 if right_ear and not left_ear else 0.0
        face = all(points[index][2] >= VISIBLE for index in (NOSE, LEFT_EYE, RIGHT_EYE))
        measures.append((shoulders, hips, evidence, face))
    seen = [measure for measure in measures if measure]
    shoulder_width = max(0.25, _percentile([abs(m[0]) for m in seen], 0.9, 0.7))
    hip_width = max(0.15, _percentile([abs(m[1]) for m in seen], 0.9, 0.45))

    angles: list[float | None] = []
    sign = 1.0
    for measure in measures:
        if measure is None:
            angles.append(None)
            continue
        shoulders, hips, evidence, face = measure
        cosine = max(-1.0, min(1.0, (shoulders / shoulder_width + hips / hip_width) / 2))
        if face:  # her nose and both eyes seen: she cannot have her back to the camera (left and right mirrored)
            cosine = abs(cosine)
        if abs(evidence) > 0.15:
            sign = 1.0 if evidence > 0 else -1.0  # else: the same side as before (her back, or facing)
        angles.append(sign * math.acos(cosine))

    # smoothed as a direction (cos, sin): no jump between +180° and -180°
    smooth: list[float | None] = []
    for i, angle in enumerate(angles):
        if angle is None:
            smooth.append(None)
            continue
        x = y = 0.0
        first, last = i, i  # the frames within 3 sigmas (times are sorted)
        while first > 0 and times[i] - times[first - 1] <= 3 * TURN_SMOOTH_SECONDS:
            first -= 1
        while last < len(times) - 1 and times[last + 1] - times[i] <= 3 * TURN_SMOOTH_SECONDS:
            last += 1
        for j in range(first, last + 1):
            if angles[j] is None:
                continue
            weight = math.exp(-0.5 * ((times[j] - times[i]) / TURN_SMOOTH_SECONDS) ** 2)
            x += math.cos(angles[j]) * weight
            y += math.sin(angles[j]) * weight
        smooth.append(math.atan2(y, x))
    return smooth, shoulder_width, hip_width


def cat_track(analysis: dict) -> dict:
    """What the cat is drawn from, for every analysed frame: the steady keypoints, the yaw,
    and the sizes that stay the same all along (torso length in pixels, widths in torso lengths)."""
    frames = analysis["frames"]
    times = [frame["source_time"] for frame in frames]
    track = steady_track(times, [(frame.get("dancer") or {}).get("keypoints") for frame in frames])
    yaw, shoulder_width, hip_width = facing_angles(times, track)
    lengths = [torso[2] for torso in (_torso(points) for points in track if points) if torso]
    return {
        "times": times,
        "keypoints": [
            [[round(x, 2), round(y, 2), round(c, 3)] for x, y, c in points] if points else None for points in track
        ],
        "yaw": [round(angle, 4) if angle is not None else None for angle in yaw],
        "size": round(_percentile(lengths, 0.8, 100.0), 2),
        "shoulder_width": round(shoulder_width, 3),
        "hip_width": round(hip_width, 3),
        "image": analysis.get("size"),
    }
