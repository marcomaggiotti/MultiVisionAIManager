"""Real-time ballet pose recognition and body-part feedback from 17 COCO keypoints.

Everything is 2-D geometry on the camera picture: the dancer seen from the side or
from the front gives the most reliable angles. Recognition and feedback are rules
written from classical ballet technique (targets per pose), so every message can
be traced to a measured angle.
"""

from __future__ import annotations

import math

from app.pose import VISIBLE, analyse

# Body parts shown in the feedback map (and the keypoints that draw them).
PARTS = {
    "head": [0, 1, 2, 3, 4],
    "shoulders": [5, 6],
    "torso": [5, 6, 11, 12],
    "hips": [11, 12],
    "left_arm": [5, 7, 9],
    "right_arm": [6, 8, 10],
    "left_leg": [11, 13, 15],
    "right_leg": [12, 14, 16],
}

POSES = {
    "arabesque": {
        "family": "adagio",
        "description": "Standing on one straight leg, the other leg extended straight behind, arms long, chest lifted.",
        "targets": {"working knee": "≥ 170°", "working leg": "≥ 90° (arabesque height)", "supporting knee": "≥ 170°"},
    },
    "attitude": {
        "family": "adagio",
        "description": "Working leg raised behind (or in front) with the knee bent about 90-120°, "
        "knee at least as high as the foot.",
        "targets": {"working knee": "90-130°", "working leg": "≥ 80°", "supporting knee": "≥ 170°"},
    },
    "développé": {
        "family": "adagio",
        "description": "Working leg unfolds to the front or side through passé and holds high and straight.",
        "targets": {"working knee": "≥ 170°", "working leg": "≥ 80°", "supporting knee": "≥ 170°"},
    },
    "grand battement": {
        "family": "allegro",
        "description": "A straight leg thrown high and brought down with control.",
        "targets": {"working knee": "≥ 170°", "working leg": "≥ 110°"},
    },
    "passé": {
        "family": "turns",
        "description": "Working foot pointed at the supporting knee, knee turned out to the side "
        "(the shape of a pirouette).",
        "targets": {"working foot": "at the supporting knee", "supporting knee": "≥ 170°", "hips": "level"},
    },
    "grand jeté": {
        "family": "jumps",
        "description": "A big jump with the legs split front and back in the air.",
        "targets": {"leg split": "≥ 160° (ideal 180°)", "knees": "straight"},
    },
    "plié": {
        "family": "barre",
        "description": "Knees bend over the toes with turned-out legs, back straight, heels down "
        "(demi-plié) or released only at the bottom (grand plié).",
        "targets": {"knees": "bent evenly", "torso": "vertical (≤ 10°)"},
    },
    "second position": {
        "family": "positions",
        "description": "Feet turned out, apart about the length of one foot, weight centred.",
        "targets": {"knees": "straight", "torso": "vertical"},
    },
    "first / fifth position": {
        "family": "positions",
        "description": "Legs together and straight, turned out (heels together in first, feet crossed in fifth).",
        "targets": {"knees": "straight", "torso": "vertical"},
    },
}

FAMILIES = {
    "positions": ["first / fifth position", "second position"],
    "barre": ["plié"],
    "adagio": ["développé", "arabesque", "attitude"],
    "turns": ["passé"],
    "allegro": ["grand battement"],
    "jumps": ["grand jeté"],
}

MIN_CONFIDENCE = 0.35


def _pt(kps, i):
    x, y, v = kps[i]
    return (x, y) if v >= VISIBLE else None


def _clamp(v: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, v))


def features(kps: list[list[float]]) -> dict:
    """Angles plus the geometric facts the rules need."""
    a = analyse(kps)
    ang = a["angles"]
    body = a["body_height_px"]
    visible = sum(1 for k in kps if k[2] >= VISIBLE)
    le, re_ = ang.get("left_leg_elevation"), ang.get("right_leg_elevation")
    f = {"angles": ang, "body": body, "visible": visible, "cues": a["cues"]}
    if le is None or re_ is None:
        return f
    working = "left" if le >= re_ else "right"
    standing = "right" if working == "left" else "left"
    f.update(
        working=working,
        standing=standing,
        w_elev=max(le, re_),
        s_elev=min(le, re_),
        w_knee=ang.get(f"{working}_knee"),
        s_knee=ang.get(f"{standing}_knee"),
    )
    nose = _pt(kps, 0)
    lh, rh = _pt(kps, 11), _pt(kps, 12)
    hip = ((lh[0] + rh[0]) / 2, (lh[1] + rh[1]) / 2) if lh and rh else (lh or rh)
    ankle = _pt(kps, 15 if working == "left" else 16)
    behind = None
    if nose and hip and ankle and body and abs(nose[0] - hip[0]) > 0.03 * body:
        behind = (ankle[0] - hip[0]) * (nose[0] - hip[0]) < 0
    f["behind"] = behind
    s_knee_pt = _pt(kps, 13 if standing == "left" else 14)
    f["foot_at_knee"] = bool(body and s_knee_pt and ankle and math.dist(s_knee_pt, ankle) < 0.17 * body)
    ls, rs = _pt(kps, 5), _pt(kps, 6)
    if body:
        f["shoulder_tilt"] = abs(ls[1] - rs[1]) / body if ls and rs else None
        f["hip_tilt"] = abs(lh[1] - rh[1]) / body if lh and rh else None
    return f


def classify(f: dict) -> list[dict]:
    """Candidate ballet poses with a 0-1 score, best first."""
    if "w_elev" not in f:
        return []
    ang = f["angles"]
    w_elev, w_knee, s_knee = f["w_elev"], f.get("w_knee") or 0, f.get("s_knee") or 0
    lk, rk = ang.get("left_knee") or 0, ang.get("right_knee") or 0
    spread = ang.get("leg_spread") or 0
    behind = f.get("behind")
    raised = _clamp((w_elev - 40) / 45)
    straight_w = _clamp((w_knee - 140) / 30)
    straight_s = _clamp((s_knee - 140) / 30)
    side = {True: 1.0, None: 0.55, False: 0.15}
    front = {False: 1.0, None: 0.5, True: 0.15}
    scores = {
        "arabesque": raised * straight_w * side[behind] * (0.6 + 0.4 * straight_s),
        "attitude": raised * _clamp(1 - abs(w_knee - 110) / 50) * (1.0 if behind is not False else 0.6),
        "développé": raised * straight_w * front[behind] * _clamp(1 - (w_elev - 100) / 40),
        "grand battement": _clamp((w_elev - 95) / 30) * straight_w * front[behind],
        "passé": (1.0 if f.get("foot_at_knee") else 0.0) * _clamp((120 - w_knee) / 40) * (0.5 + 0.5 * straight_s),
        "grand jeté": _clamp((spread - 120) / 45) * straight_w,
        "plié": _clamp((160 - max(lk, rk)) / 30) * _clamp((40 - w_elev) / 20) * _clamp(1 - abs(lk - rk) / 40),
        "second position": _clamp((min(lk, rk) - 155) / 15) * _clamp((25 - w_elev) / 10) * _clamp((spread - 15) / 15),
        "first / fifth position": _clamp((min(lk, rk) - 155) / 15)
        * _clamp((20 - w_elev) / 10)
        * _clamp((25 - spread) / 15),
    }
    ranked = sorted(scores.items(), key=lambda kv: -kv[1])
    return [{"step": s, "score": round(v, 3), "family": POSES[s]["family"]} for s, v in ranked if v > 0.05][:5]


def _item(part, status, message, value=None, target=None):
    return {"part": part, "status": status, "message": message, "value": value, "target": target}


def feedback(f: dict, step: str | None) -> list[dict]:
    """Corrections per body part for the recognised pose (or general posture)."""
    out: list[dict] = []
    if f["visible"] < 11 or "w_elev" not in f:
        return [_item("torso", "warn", "Step back so the whole body (head to feet) is in the picture")]
    ang = f["angles"]
    working, standing = f["working"], f["standing"]
    w_leg, s_leg = f"{working}_leg", f"{standing}_leg"
    w_knee, s_knee, w_elev = f.get("w_knee"), f.get("s_knee"), f["w_elev"]
    tilt = ang.get("torso_tilt")

    def knee_straight(part, value, who):
        if value is None:
            return
        if value >= 170:
            out.append(_item(part, "ok", f"{who} knee straight", round(value), "≥ 170°"))
        elif value >= 158:
            out.append(
                _item(
                    part,
                    "warn",
                    f"{who} knee slightly bent ({value:.0f}°): pull up and stretch",
                    round(value),
                    "≥ 170°",
                )
            )
        else:
            out.append(_item(part, "bad", f"{who} knee bent ({value:.0f}°): straighten it", round(value), "≥ 170°"))

    if step in {"arabesque", "développé", "grand battement"}:
        knee_straight(w_leg, w_knee, "Working")
        knee_straight(s_leg, s_knee, "Supporting")
        goal = 110 if step == "grand battement" else 90
        if w_elev >= goal - 5:
            out.append(_item(w_leg, "ok", f"Working leg at {w_elev:.0f}°", round(w_elev), f"≥ {goal}°"))
        else:
            out.append(
                _item(
                    w_leg,
                    "warn" if w_elev >= goal - 25 else "bad",
                    f"Lift the working leg higher ({w_elev:.0f}°, aim for {goal}°)",
                    round(w_elev),
                    f"≥ {goal}°",
                )
            )
        if step == "arabesque" and tilt is not None:
            if tilt > 35:
                msg = f"Chest dropping forward ({tilt:.0f}°): lift the back"
                out.append(_item("torso", "warn", msg, round(tilt), "≤ 35°"))
            else:
                out.append(_item("torso", "ok", "Back lifted", round(tilt), "≤ 35°"))
    elif step == "attitude":
        knee_straight(s_leg, s_knee, "Supporting")
        if w_knee is not None:
            ok = 85 <= w_knee <= 135
            out.append(
                _item(
                    w_leg,
                    "ok" if ok else "warn",
                    f"Attitude knee at {w_knee:.0f}°" + ("" if ok else ": aim for a rounded 90-120°"),
                    round(w_knee),
                    "90-130°",
                )
            )
        if w_elev < 75:
            out.append(_item(w_leg, "warn", f"Raise the knee: thigh at {w_elev:.0f}°", round(w_elev), "≥ 80°"))
    elif step == "passé":
        knee_straight(s_leg, s_knee, "Supporting")
        out.append(_item(w_leg, "ok", "Working foot at the supporting knee", None, "at the knee"))
    elif step == "grand jeté":
        spread = ang.get("leg_spread")
        if spread is not None:
            status = "ok" if spread >= 160 else "warn" if spread >= 140 else "bad"
            out.append(
                _item(
                    w_leg,
                    status,
                    f"Split {spread:.0f}°" + ("" if status == "ok" else ": open the legs further"),
                    round(spread),
                    "≥ 160°",
                )
            )
        knee_straight(w_leg, w_knee, "Front/back")
    elif step == "plié":
        lk, rk = ang.get("left_knee"), ang.get("right_knee")
        if lk is not None and rk is not None:
            diff = abs(lk - rk)
            depth = "grand plié" if max(lk, rk) < 100 else "demi-plié"
            out.append(
                _item(
                    "hips",
                    "ok" if diff <= 12 else "warn",
                    f"{depth}: knees {lk:.0f}° / {rk:.0f}°" + ("" if diff <= 12 else ": bend both knees evenly"),
                    round(diff),
                    "≤ 12° difference",
                )
            )
    elif step in {"second position", "first / fifth position"}:
        knee_straight("left_leg", ang.get("left_knee"), "Left")
        knee_straight("right_leg", ang.get("right_knee"), "Right")

    # Posture, whatever the pose
    if step not in {"arabesque", "grand jeté"} and tilt is not None:
        if tilt <= 10:
            out.append(_item("torso", "ok", "Torso vertical", round(tilt), "≤ 10°"))
        else:
            out.append(
                _item(
                    "torso",
                    "warn" if tilt <= 20 else "bad",
                    f"Torso leaning {tilt:.0f}°: stand tall over the hips",
                    round(tilt),
                    "≤ 10°",
                )
            )
    st, ht = f.get("shoulder_tilt"), f.get("hip_tilt")
    if st is not None:
        if st > 0.06:
            out.append(
                _item("shoulders", "warn", "Shoulders uneven: keep them level and down", round(st * 100, 1), "level")
            )
        else:
            out.append(_item("shoulders", "ok", "Shoulders level", round(st * 100, 1), "level"))
    if ht is not None and step in {"passé", "plié", "second position", "first / fifth position", "développé"}:
        if ht > 0.07:
            out.append(
                _item(
                    "hips",
                    "warn",
                    "Hips uneven: square them and keep the working hip down",
                    round(ht * 100, 1),
                    "level",
                )
            )
        else:
            out.append(_item("hips", "ok", "Hips level", round(ht * 100, 1), "level"))
    la, ra = ang.get("left_arm_elevation"), ang.get("right_arm_elevation")
    if la is not None and ra is not None and la > 140 and ra > 140:
        out.append(_item("left_arm", "ok", "Arms in fifth position en haut", None, None))
    return out


def part_status(items: list[dict]) -> dict[str, str]:
    """Worst status per body part ('ok' when nothing is wrong)."""
    rank = {"ok": 0, "warn": 1, "bad": 2}
    status = {p: "none" for p in PARTS}
    for it in items:
        cur = status.get(it["part"], "none")
        if cur == "none" or rank[it["status"]] > rank[cur]:
            status[it["part"]] = it["status"]
    return status


def evaluate(kps: list[list[float]]) -> dict:
    """One frame: angles, recognised pose candidates and feedback for the best one."""
    f = features(kps)
    candidates = classify(f)
    best = candidates[0] if candidates and candidates[0]["score"] >= MIN_CONFIDENCE else None
    items = feedback(f, best["step"] if best else None)
    return {
        "angles": {k: (round(v, 1) if v is not None else None) for k, v in f["angles"].items()},
        "working_side": f.get("working"),
        "facing_away_leg_behind": f.get("behind"),
        "visible_keypoints": f["visible"],
        "body_height_px": f["body"],
        "candidates": candidates,
        "pose": best,
        "feedback": items,
        "parts": part_status(items),
    }


def vocabulary() -> dict:
    return {"poses": POSES, "families": FAMILIES, "parts": list(PARTS), "min_confidence": MIN_CONFIDENCE}
