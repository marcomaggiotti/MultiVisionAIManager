"""Real-time sessions: frames arrive one by one (camera, video or pictures), the
manager runs YOLO pose on each, smooths the dancer's keypoints, recognises the
ballet pose with hysteresis, counts the poses performed and logs corrections.

The client sends the next frame when it gets the answer for the previous one, so
the frame rate adapts to the speed of the GPU (no queue builds up).
"""

from __future__ import annotations

import math
import time
import uuid
from collections import Counter

import httpx

from app import ballet, pose


def _iou(a: dict, b: dict) -> float:
    w = min(a["x2"], b["x2"]) - max(a["x1"], b["x1"])
    h = min(a["y2"], b["y2"]) - max(a["y1"], b["y1"])
    if w <= 0 or h <= 0:
        return 0.0
    inter = w * h
    return inter / ((a["x2"] - a["x1"]) * (a["y2"] - a["y1"]) + (b["x2"] - b["x1"]) * (b["y2"] - b["y1"]) - inter)


class LiveSession:
    def __init__(self, smoothing: float = 0.5, hold: int = 4, confidence: float = 0.35) -> None:
        self.id = time.strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:4]
        self.started = time.time()
        self.smoothing = smoothing  # 0 = raw keypoints, 0.9 = very smooth
        self.hold = hold  # frames a pose must persist to be recognised
        self.confidence = confidence
        self.frames = 0
        self.prev_box: dict | None = None
        self.kps: list[list[float]] | None = None
        self.prev_raw: list[list[float]] | None = None
        self.candidate: str | None = None
        self.candidate_frames = 0
        self.current: str | None = None
        self.current_since: float | None = None
        self.current_best: float = 0.0
        self.counts: Counter = Counter()
        self.events: list[dict] = []
        self.comments: list[dict] = []
        self.issue_frames: Counter = Counter()
        self.last_comment: dict[str, float] = {}

    def configure(self, **settings) -> None:
        for key in ("smoothing", "hold", "confidence"):
            if settings.get(key) is not None:
                setattr(self, key, type(getattr(self, key))(settings[key]))

    def _smooth(self, det: dict) -> list[list[float]]:
        raw = det["keypoints"]
        if self.kps is None or self.prev_box is None or _iou(self.prev_box, det["box"]) < 0.3:
            self.kps = [list(k) for k in raw]  # new dancer or a jump cut: no smoothing
        else:
            a = self.smoothing
            for i, (x, y, v) in enumerate(raw):
                if v >= pose.VISIBLE and self.kps[i][2] >= pose.VISIBLE:
                    self.kps[i] = [a * self.kps[i][0] + (1 - a) * x, a * self.kps[i][1] + (1 - a) * y, v]
                else:
                    self.kps[i] = [x, y, v]
        self.prev_box = det["box"]
        return [[round(x, 1), round(y, 1), round(v, 3)] for x, y, v in self.kps]

    def _motion(self, raw: list[list[float]], body: float | None) -> float | None:
        prev, self.prev_raw = self.prev_raw, raw
        if prev is None or not body:
            return None
        moves = [
            math.dist(a[:2], b[:2]) / body
            for a, b in zip(prev, raw, strict=True)
            if a[2] >= pose.VISIBLE and b[2] >= pose.VISIBLE
        ]
        return round(sum(moves) / len(moves), 4) if moves else None

    def _close_current(self, t: float) -> dict | None:
        if self.current is None:
            return None
        event = {
            "step": self.current,
            "start": round(self.current_since - self.started, 2),
            "end": round(t - self.started, 2),
            "best_score": round(self.current_best, 3),
        }
        self.events.append(event)
        self.counts[self.current] += 1
        self.current, self.current_since, self.current_best = None, None, 0.0
        return event

    def update(self, yolo: dict) -> dict:
        """Process YOLO's answer for one frame."""
        t = time.time()
        self.frames += 1
        dancer = pose.main_person(yolo.get("detections", []))
        result: dict = {
            "frame": self.frames,
            "t": round(t - self.started, 3),
            "people": yolo.get("counts", {}).get("person", 0),
            "dancer": None,
            "evaluation": None,
            "motion": None,
            "new_events": [],
            "new_comments": [],
        }
        step = None
        if dancer and dancer.get("keypoints"):
            kps = self._smooth(dancer)
            ev = ballet.evaluate(kps)
            result["dancer"] = {"box": dancer["box"], "confidence": dancer["confidence"], "keypoints": kps}
            result["evaluation"] = ev
            result["motion"] = self._motion(dancer["keypoints"], ev["body_height_px"])
            best = ev["candidates"][0] if ev["candidates"] else None
            step = best["step"] if best and best["score"] >= self.confidence else None
            if step and step == self.current:
                self.current_best = max(self.current_best, best["score"])
            self._comments(ev["feedback"], t, result)
        else:
            self.kps, self.prev_box, self.prev_raw = None, None, None

        # Hysteresis: a pose must be seen `hold` frames in a row to start or end.
        if step == self.candidate:
            self.candidate_frames += 1
        else:
            self.candidate, self.candidate_frames = step, 1
        if self.candidate != self.current and self.candidate_frames >= self.hold:
            closed = self._close_current(t)
            if closed:
                result["new_events"].append(closed)
            if self.candidate is not None:
                self.current, self.current_since = self.candidate, t
                self.current_best = 0.0
        result["current"] = {
            "step": self.current,
            "since": round(self.current_since - self.started, 2) if self.current_since else None,
            "held_s": round(t - self.current_since, 2) if self.current_since else None,
        }
        result["counts"] = dict(self.counts)
        return result

    def _comments(self, items: list[dict], t: float, result: dict) -> None:
        """A correction becomes a comment when it persists (and not more than every 4 s)."""
        active = {it["message"].split(" (")[0].split(":")[0] for it in items if it["status"] != "ok"}
        for key in list(self.issue_frames):
            if key not in active:
                del self.issue_frames[key]
        for it in items:
            if it["status"] == "ok":
                continue
            key = it["message"].split(" (")[0].split(":")[0]
            self.issue_frames[key] += 1
            if self.issue_frames[key] >= self.hold and t - self.last_comment.get(key, 0) > 4:
                self.last_comment[key] = t
                comment = {"t": round(t - self.started, 2), "pose": self.current, **it}
                self.comments.append(comment)
                result["new_comments"].append(comment)

    def summary(self) -> dict:
        self._close_current(time.time()) if self.current else None
        return {
            "id": self.id,
            "started": self.started,
            "duration_s": round(time.time() - self.started, 1),
            "frames": self.frames,
            "counts": dict(self.counts),
            "events": self.events,
            "comments": self.comments[-200:],
        }


async def process_frame(
    client: httpx.AsyncClient, yolo_url: str, session: LiveSession, jpeg: bytes, confidence: float = 0.3
) -> dict:
    start = time.perf_counter()
    r = await client.post(
        f"{yolo_url}/v1/detect",
        params={"classes": "person", "confidence": confidence},
        files={"image": ("frame.jpg", jpeg, "image/jpeg")},
    )
    r.raise_for_status()
    yolo = r.json()
    result = session.update(yolo)
    result["image"] = yolo.get("image")
    result["latency_ms"] = {
        "yolo": yolo.get("inference_ms"),
        "total": round((time.perf_counter() - start) * 1000, 1),
    }
    result["model"] = yolo.get("model", {}).get("weights")
    return result
