"""Context & reasoning layer: orchestrates the modules on one picture or a
sequence of pictures and fuses their outputs.

    YOLO (pose)  ->  joint angles, ballet cues, motion between frames
    CLIP         ->  zero-shot ballet step on the dancer's crop
    VLM          ->  answer, given the pictures *and* the facts above
    fusion       ->  one ranked list of candidate steps, with the evidence
"""

from __future__ import annotations

import io
import json
import re
import time
import unicodedata

import httpx
from PIL import Image

from app import pose

STEPS = [
    "plié", "tendu", "relevé", "développé", "arabesque", "attitude", "pirouette", "grand jeté",
    "sissonne", "pas de bourrée", "port de bras", "fouetté", "passé", "grand battement",
    "assemblé", "révérence", "first position", "second position", "third position",
    "fourth position", "fifth position",
]  # fmt: skip

DEFAULTS = {
    "yolo": {"enabled": True, "confidence": 0.35},
    "clip": {"enabled": True, "labels": STEPS, "templates": None, "use_descriptions": True, "crop": True},
    "vlm": {
        "enabled": True,
        "prompt": "Which classical ballet step or position is shown, and how well is it executed?",
        "system": None,
        "max_new_tokens": 220,
        "use_context": True,
    },
}


REPORTED_ANGLES = {"left_knee", "right_knee", "left_leg_elevation", "right_leg_elevation", "leg_spread"}


def fold(text: str) -> str:
    """Lower case without accents: 'Plié' -> 'plie'."""
    return "".join(c for c in unicodedata.normalize("NFKD", text.lower()) if not unicodedata.combining(c))


def merge_options(options: dict | None) -> dict:
    merged = {k: dict(v) for k, v in DEFAULTS.items()}
    for key, value in (options or {}).items():
        if key in merged and isinstance(value, dict):
            merged[key].update({k: v for k, v in value.items() if v is not None})
    return merged


def jpeg(image: Image.Image, quality: int = 90) -> bytes:
    buf = io.BytesIO()
    image.save(buf, format="JPEG", quality=quality)
    return buf.getvalue()


def crop_person(image: Image.Image, det: dict | None, pad: float = 0.15) -> Image.Image:
    if not det:
        return image
    b = det["box"]
    w, h = b["x2"] - b["x1"], b["y2"] - b["y1"]
    box = (
        max(0, int(b["x1"] - pad * w)),
        max(0, int(b["y1"] - pad * h)),
        min(image.width, int(b["x2"] + pad * w)),
        min(image.height, int(b["y2"] + pad * h)),
    )
    return image.crop(box) if box[2] > box[0] and box[3] > box[1] else image


def context_text(frames: list[dict], motion: dict | None) -> str:
    """Facts from the perception layer, written for the VLM."""
    lines = []
    for f in frames:
        prefix = f"Picture {f['index'] + 1}: " if len(frames) > 1 else ""
        dancer = f.get("dancer")
        if f.get("people") is not None:
            lines.append(f"{prefix}{f['people']} person(s) detected.")
        if dancer and dancer.get("pose"):
            a = dancer["pose"]["angles"]
            parts = [
                f"{k.replace('_', ' ')} {v:.0f}°"
                for k, v in a.items()
                if v is not None
                and k in {"left_knee", "right_knee", "left_leg_elevation", "right_leg_elevation", "leg_spread"}
            ]
            if parts:
                lines.append(f"{prefix}measured pose angles: " + ", ".join(parts) + ".")
            hints = [c for c in dancer["pose"]["cues"] if c["steps"]]
            if hints:
                lines.append(
                    f"{prefix}pose cues: "
                    + "; ".join(f"{c['cue']} (suggests {', '.join(c['steps'])})" for c in hints)
                    + "."
                )
        if f.get("clip"):
            top = ", ".join(f"{r['label']} {r['probability']:.0%}" for r in f["clip"]["top"][:3])
            lines.append(f"{prefix}image-text similarity ranks: {top}.")
    if motion and motion.get("peak_leg_elevation") is not None and len(frames) > 1:
        lines.append(
            f"Across the sequence the highest leg elevation is {motion['peak_leg_elevation']:.0f}° "
            f"in picture {motion['peak_leg_elevation_frame'] + 1}."
        )
    return "\n".join(lines)


def fuse(frames: list[dict], vlm_text: str | None) -> list[dict]:
    """Combine the evidence into one ranking of candidate steps."""
    scores: dict[str, float] = {}
    evidence: dict[str, list[str]] = {}

    def add(step: str, value: float, why: str) -> None:
        key = step.lower()
        scores[key] = scores.get(key, 0.0) + value
        evidence.setdefault(key, []).append(why)

    n = max(1, len(frames))
    for f in frames:
        tag = f"picture {f['index'] + 1}" if len(frames) > 1 else "picture"
        if f.get("clip"):
            for r in f["clip"]["top"][:3]:
                add(r["label"], r["probability"] / n, f"CLIP {r['probability']:.0%} ({tag})")
        dancer = f.get("dancer")
        if dancer and dancer.get("pose"):
            for c in dancer["pose"]["cues"]:
                weight = {"medium": 0.3, "low": 0.15}.get(c["confidence"], 0.1) / n
                for step in c["steps"]:
                    add(step, weight, f"pose: {c['cue']} ({tag})")
    if vlm_text:
        folded = fold(vlm_text)
        for step in STEPS:
            if re.search(rf"\b{re.escape(fold(step))}\b", folded):
                add(step, 0.4, "named by the VLM")
    total = sum(scores.values()) or 1.0
    ranking = sorted(scores.items(), key=lambda kv: -kv[1])
    return [{"step": step, "score": round(score / total, 3), "evidence": evidence[step]} for step, score in ranking[:8]]


async def run(
    client: httpx.AsyncClient,
    modules: dict[str, str],
    uploads: list[tuple[str, bytes, Image.Image]],
    options: dict | None = None,
    errors: list[dict] | None = None,
) -> dict:
    """``modules``: name -> URL of the modules that are up; ``errors``: problems so far
    (e.g. a module that could not be launched)."""
    opts = merge_options(options)
    started = time.perf_counter()
    timings: dict[str, float] = {}
    errors = list(errors or [])
    frames = [{"index": i, "file": name, "width": im.width, "height": im.height}
              for i, (name, _, im) in enumerate(uploads)]  # fmt: skip

    # 1. perception: YOLO pose
    if opts["yolo"]["enabled"] and "yolo" in modules:
        t = time.perf_counter()
        for f, (name, _, image) in zip(frames, uploads, strict=True):
            try:
                r = await client.post(
                    f"{modules['yolo']}/v1/detect",
                    params={"classes": "person", "confidence": opts["yolo"]["confidence"]},
                    files={"image": (name, jpeg(image), "image/jpeg")},
                )
                r.raise_for_status()
                body = r.json()
            except (httpx.HTTPError, ValueError) as exc:
                errors.append({"module": "yolo", "frame": f["index"], "error": _msg(exc)})
                continue
            f["detections"] = body["detections"]
            f["people"] = body["counts"].get("person", 0)
            f["yolo_model"] = body["model"]
            dancer = pose.main_person(body["detections"])
            if dancer:
                f["dancer"] = {"box": dancer["box"], "confidence": dancer["confidence"]}
                if dancer.get("keypoints"):
                    f["dancer"]["keypoints"] = dancer["keypoints"]
                    f["dancer"]["pose"] = pose.analyse(dancer["keypoints"])
        timings["yolo_ms"] = round((time.perf_counter() - t) * 1000, 1)

    # 2. motion across the sequence
    motion = None
    if len(frames) > 1 and any(f.get("dancer", {}).get("pose") for f in frames):
        motion = pose.motion([f["dancer"] if f.get("dancer", {}).get("pose") else None for f in frames])

    # 3. CLIP zero-shot on the dancer
    if opts["clip"]["enabled"] and "clip" in modules:
        t = time.perf_counter()
        crops = [
            crop_person(im, f.get("dancer") if opts["clip"]["crop"] else None)
            for f, (_, _, im) in zip(frames, uploads, strict=True)
        ]
        data = {
            "labels": json.dumps(opts["clip"]["labels"]),
            "use_descriptions": str(opts["clip"]["use_descriptions"]).lower(),
        }
        if opts["clip"].get("templates"):
            data["templates"] = json.dumps(opts["clip"]["templates"])
        try:
            r = await client.post(
                f"{modules['clip']}/v1/zero-shot",
                data=data,
                files=[("images", (f"crop{i}.jpg", jpeg(c), "image/jpeg")) for i, c in enumerate(crops)],
            )
            r.raise_for_status()
            for f, res in zip(frames, r.json()["results"], strict=True):
                f["clip"] = {"top": res["ranking"][:5], "agreement": res["sensitivity"]["agreement"]}
        except (httpx.HTTPError, ValueError, KeyError) as exc:
            errors.append({"module": "clip", "error": _msg(exc)})
        timings["clip_ms"] = round((time.perf_counter() - t) * 1000, 1)

    # 4. VLM with the perception context
    vlm = None
    if opts["vlm"]["enabled"] and "vlm" in modules:
        t = time.perf_counter()
        context = context_text(frames, motion) if opts["vlm"]["use_context"] else ""
        prompt = opts["vlm"]["prompt"]
        if context:
            prompt = (
                "Measurements from a pose estimator and an image-text model (they can be wrong; "
                f"trust the picture first):\n{context}\n\n{prompt}"
            )
        data = {
            "prompt": prompt,
            "sequence": str(len(frames) > 1).lower(),
            "params": json.dumps({"max_new_tokens": int(opts["vlm"]["max_new_tokens"])}),
        }
        if opts["vlm"].get("system"):
            data["system"] = opts["vlm"]["system"]
        else:
            data["system"] = (
                "You are an expert classical ballet teacher. Use ballet terminology and explain it plainly."
            )
        try:
            r = await client.post(
                f"{modules['vlm']}/v1/generate",
                data=data,
                files=[("images", (f"f{i}.jpg", jpeg(im), "image/jpeg")) for i, (_, _, im) in enumerate(uploads)],
            )
            r.raise_for_status()
            body = r.json()
            vlm = {"text": body["text"], "prompt": prompt, "model": body.get("model"),
                   "latency_ms": body.get("latency_ms"), "image_tokens": body.get("image_tokens")}  # fmt: skip
        except (httpx.HTTPError, ValueError, KeyError) as exc:
            errors.append({"module": "vlm", "error": _msg(exc)})
        timings["vlm_ms"] = round((time.perf_counter() - t) * 1000, 1)

    timings["total_ms"] = round((time.perf_counter() - started) * 1000, 1)
    return {
        "frames": frames,
        "motion": motion,
        "vlm": vlm,
        "fused": fuse(frames, vlm["text"] if vlm else None),
        "errors": errors,
        "timings": timings,
        "options": opts,
    }


def _msg(exc: Exception) -> str:
    if isinstance(exc, httpx.HTTPStatusError):
        try:
            return f"{exc.response.status_code}: {exc.response.json().get('detail')}"
        except ValueError:
            return f"{exc.response.status_code}: {exc.response.text[:200]}"
    return f"{type(exc).__name__}: {exc}"
