"""Pose geometry for classical ballet, from YOLO's 17 COCO keypoints.

All of this is 2-D geometry on the picture: angles are as seen by the camera
(foreshortening changes them), so the cues are hints for the reasoning layer,
not measurements.
"""

from __future__ import annotations

import math

KEYPOINTS = [
    "nose", "left_eye", "right_eye", "left_ear", "right_ear",
    "left_shoulder", "right_shoulder", "left_elbow", "right_elbow",
    "left_wrist", "right_wrist", "left_hip", "right_hip",
    "left_knee", "right_knee", "left_ankle", "right_ankle",
]  # fmt: skip
K = {name: i for i, name in enumerate(KEYPOINTS)}
SKELETON = [
    (15, 13), (13, 11), (16, 14), (14, 12), (11, 12), (5, 11), (6, 12), (5, 6),
    (5, 7), (6, 8), (7, 9), (8, 10), (0, 1), (0, 2), (1, 3), (2, 4),
]  # fmt: skip
VISIBLE = 0.5

Point = tuple[float, float]


def _pt(kps, name) -> Point | None:
    x, y, v = kps[K[name]]
    return (x, y) if v >= VISIBLE else None


def _mid(a: Point | None, b: Point | None) -> Point | None:
    if a and b:
        return ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
    return a or b


def angle_at(a: Point | None, b: Point | None, c: Point | None) -> float | None:
    """Angle ABC in degrees (180 = straight)."""
    if not (a and b and c):
        return None
    v1, v2 = (a[0] - b[0], a[1] - b[1]), (c[0] - b[0], c[1] - b[1])
    n1, n2 = math.hypot(*v1), math.hypot(*v2)
    if n1 == 0 or n2 == 0:
        return None
    cos = max(-1.0, min(1.0, (v1[0] * v2[0] + v1[1] * v2[1]) / (n1 * n2)))
    return round(math.degrees(math.acos(cos)), 1)


def between(u: Point, v: Point) -> float | None:
    n1, n2 = math.hypot(*u), math.hypot(*v)
    if n1 == 0 or n2 == 0:
        return None
    cos = max(-1.0, min(1.0, (u[0] * v[0] + u[1] * v[1]) / (n1 * n2)))
    return round(math.degrees(math.acos(cos)), 1)


def analyse(kps: list[list[float]]) -> dict:
    """Joint angles and ballet cues for one person."""
    p = {name: _pt(kps, name) for name in KEYPOINTS}
    shoulders = _mid(p["left_shoulder"], p["right_shoulder"])
    hips = _mid(p["left_hip"], p["right_hip"])
    ankles = _mid(p["left_ankle"], p["right_ankle"])
    down = (hips[0] - shoulders[0], hips[1] - shoulders[1]) if shoulders and hips else (0.0, 1.0)
    body = math.dist(shoulders, ankles) if shoulders and ankles else None

    angles: dict[str, float | None] = {}
    legs = {}
    for side in ("left", "right"):
        hip, knee, ankle = p[f"{side}_hip"], p[f"{side}_knee"], p[f"{side}_ankle"]
        angles[f"{side}_knee"] = angle_at(hip, knee, ankle)
        angles[f"{side}_elbow"] = angle_at(p[f"{side}_shoulder"], p[f"{side}_elbow"], p[f"{side}_wrist"])
        # Leg elevation: 0 = along the body, 90 = horizontal (à la seconde height), >90 above.
        angles[f"{side}_leg_elevation"] = (
            between(down, (ankle[0] - hip[0], ankle[1] - hip[1])) if hip and ankle else None
        )
        shoulder, wrist = p[f"{side}_shoulder"], p[f"{side}_wrist"]
        angles[f"{side}_arm_elevation"] = (
            between(down, (wrist[0] - shoulder[0], wrist[1] - shoulder[1])) if shoulder and wrist else None
        )
        legs[side] = {"hip": hip, "knee": knee, "ankle": ankle}
    angles["torso_tilt"] = between(down, (0.0, 1.0)) if shoulders and hips else None
    l_a, r_a, l_h, r_h = p["left_ankle"], p["right_ankle"], p["left_hip"], p["right_hip"]
    hips_mid = _mid(l_h, r_h)
    angles["leg_spread"] = (
        between((l_a[0] - hips_mid[0], l_a[1] - hips_mid[1]), (r_a[0] - hips_mid[0], r_a[1] - hips_mid[1]))
        if l_a and r_a and hips_mid
        else None
    )
    return {
        "angles": angles,
        "body_height_px": round(body, 1) if body else None,
        "cues": cues(p, angles, body),
    }


def cues(p: dict, a: dict, body: float | None) -> list[dict]:
    """Rule-based hints about which ballet shape the pose resembles."""
    out: list[dict] = []
    le, re_ = a.get("left_leg_elevation"), a.get("right_leg_elevation")
    lk, rk = a.get("left_knee"), a.get("right_knee")
    if le is None or re_ is None:
        return [{"cue": "legs not fully visible", "steps": [], "confidence": "low"}]
    working = "left" if le > re_ else "right"
    standing = "right" if working == "left" else "left"
    w_elev, w_knee = max(le, re_), (lk if working == "left" else rk)
    s_knee = rk if working == "left" else lk

    # Facing direction from the nose relative to the hips: the working leg on the
    # opposite side is "behind" the dancer.
    nose, hip, ankle = p["nose"], _mid(p["left_hip"], p["right_hip"]), p[f"{working}_ankle"]
    behind = None
    if nose and hip and ankle and abs(nose[0] - hip[0]) > 0.03 * (body or 1):
        behind = (ankle[0] - hip[0]) * (nose[0] - hip[0]) < 0

    if w_elev >= 60 and (w_knee or 0) >= 155:
        if behind is True:
            out.append({"cue": f"{working} leg extended behind at {w_elev:.0f}°, straight",
                        "steps": ["arabesque"], "confidence": "medium"})  # fmt: skip
        elif behind is False:
            out.append({"cue": f"{working} leg extended in front/side at {w_elev:.0f}°, straight",
                        "steps": ["développé", "grand battement"], "confidence": "medium"})  # fmt: skip
        else:
            out.append({"cue": f"{working} leg raised to {w_elev:.0f}°, straight",
                        "steps": ["arabesque", "développé", "grand battement"], "confidence": "low"})  # fmt: skip
    elif w_elev >= 45 and w_knee is not None and 80 <= w_knee < 155:
        out.append({"cue": f"{working} leg raised to {w_elev:.0f}° with the knee bent at {w_knee:.0f}°",
                    "steps": ["attitude"] if behind is not False else ["attitude devant", "développé (passing)"],
                    "confidence": "medium" if behind is not None else "low"})  # fmt: skip

    s_knee_pt, w_ankle_pt = p[f"{standing}_knee"], p[f"{working}_ankle"]
    if body and s_knee_pt and w_ankle_pt and w_knee and w_knee < 120:
        if math.dist(s_knee_pt, w_ankle_pt) < 0.15 * body:
            out.append({"cue": f"{working} foot at the {standing} knee",
                        "steps": ["passé", "pirouette"], "confidence": "medium"})  # fmt: skip

    spread = a.get("leg_spread")
    if spread is not None and spread >= 140:
        out.append({"cue": f"legs split at {spread:.0f}°", "steps": ["grand jeté", "split"], "confidence": "medium"})
    if lk is not None and rk is not None and lk < 150 and rk < 150 and w_elev < 35:
        out.append({"cue": f"both knees bent ({lk:.0f}°, {rk:.0f}°), feet down",
                    "steps": ["plié"], "confidence": "medium"})  # fmt: skip
    if (lk or 0) >= 165 and (rk or 0) >= 165 and w_elev < 25:
        if spread is not None and spread >= 25:
            out.append({"cue": "both legs straight, feet apart",
                        "steps": ["second position", "tendu"], "confidence": "low"})  # fmt: skip
        else:
            out.append({"cue": "both legs straight, feet together",
                        "steps": ["first position", "fifth position", "relevé"], "confidence": "low"})  # fmt: skip
    la, ra = a.get("left_arm_elevation"), a.get("right_arm_elevation")
    if la is not None and ra is not None and la > 140 and ra > 140:
        out.append({"cue": "both arms overhead", "steps": ["fifth position of the arms"], "confidence": "medium"})
    if s_knee is not None and s_knee < 150 and w_elev >= 45:
        out.append({"cue": f"standing knee bent ({s_knee:.0f}°)", "steps": ["fondu", "landing"], "confidence": "low"})
    return out


def main_person(detections: list[dict]) -> dict | None:
    """The largest person with keypoints (the dancer in focus)."""
    people = [d for d in detections if d.get("keypoints") and d.get("label") == "person"]
    if not people:
        people = [d for d in detections if d.get("label") == "person"]
    if not people:
        return None
    return max(people, key=lambda d: (d["box"]["x2"] - d["box"]["x1"]) * (d["box"]["y2"] - d["box"]["y1"]))


def motion(frames: list[dict | None]) -> dict:
    """Movement across consecutive frames of the main dancer."""
    steps = []
    for i in range(1, len(frames)):
        a, b = frames[i - 1], frames[i]
        if not a or not b:
            steps.append(None)
            continue
        ka, kb = a["keypoints"], b["keypoints"]
        body = a["pose"].get("body_height_px") or b["pose"].get("body_height_px") or 1.0
        moves = [
            math.dist(ka[j][:2], kb[j][:2]) / body for j in range(17) if ka[j][2] >= VISIBLE and kb[j][2] >= VISIBLE
        ]
        deltas = {}
        for k, v in b["pose"]["angles"].items():
            u = a["pose"]["angles"].get(k)
            if u is not None and v is not None:
                deltas[k] = round(v - u, 1)
        steps.append({
            "from": i - 1, "to": i,
            "mean_joint_motion": round(sum(moves) / len(moves), 3) if moves else None,
            "angle_changes": dict(sorted(deltas.items(), key=lambda kv: -abs(kv[1]))[:5]),
        })  # fmt: skip

    series = {}
    for key in ("left_leg_elevation", "right_leg_elevation", "left_knee", "right_knee", "leg_spread",
                "left_arm_elevation", "right_arm_elevation"):  # fmt: skip
        series[key] = [f["pose"]["angles"].get(key) if f else None for f in frames]
    elev = [
        max((v for v in pair if v is not None), default=None)
        for pair in zip(series["left_leg_elevation"], series["right_leg_elevation"], strict=True)
    ]
    peak = max(range(len(elev)), key=lambda i: elev[i] or -1) if any(e is not None for e in elev) else None
    energy = [s["mean_joint_motion"] for s in steps if s and s["mean_joint_motion"] is not None]
    return {
        "transitions": steps,
        "series": series,
        "peak_leg_elevation_frame": peak,
        "peak_leg_elevation": elev[peak] if peak is not None else None,
        "total_motion": round(sum(energy), 3) if energy else None,
    }
