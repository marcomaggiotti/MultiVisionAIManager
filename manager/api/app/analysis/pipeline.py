"""Run the modules on the pictures, in order, and assemble the analysis."""

from __future__ import annotations

import io
import json
import time
from dataclasses import dataclass

import httpx
from PIL import Image

from app.analysis.context import build_context
from app.analysis.fusion import fuse_evidence
from app.analysis.options import DEFAULT_VLM_SYSTEM_PROMPT, merge_options
from app.ballet import evaluate_pose
from app.ballet.dancer import select_main_dancer
from app.ballet.motion import DancerFrame, analyse_motion
from app.http_errors import describe_http_error

CROP_PADDING = 0.15  # share of the box added around the dancer for CLIP


@dataclass
class Picture:
    filename: str
    image: Image.Image


def to_jpeg(image: Image.Image, quality: int = 90) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", quality=quality)
    return buffer.getvalue()


def crop_around(image: Image.Image, box: dict | None, padding: float = CROP_PADDING) -> Image.Image:
    """The picture cropped to the box plus ``padding``; the whole picture without a box."""
    if not box:
        return image
    width, height = box["x2"] - box["x1"], box["y2"] - box["y1"]
    left = max(0, int(box["x1"] - padding * width))
    top = max(0, int(box["y1"] - padding * height))
    right = min(image.width, int(box["x2"] + padding * width))
    bottom = min(image.height, int(box["y2"] + padding * height))
    return image.crop((left, top, right, bottom)) if right > left and bottom > top else image


class AnalysisRun:
    """One analysis: the frames being filled in, timings and module errors."""

    def __init__(self, client: httpx.AsyncClient, module_urls: dict[str, str], pictures: list[Picture], options: dict):
        self.client = client
        self.module_urls = module_urls
        self.pictures = pictures
        self.options = options
        self.frames = [
            {"index": index, "file": picture.filename, "width": picture.image.width, "height": picture.image.height}
            for index, picture in enumerate(pictures)
        ]
        self.errors: list[dict] = []
        self.timings: dict[str, float] = {}

    def wants(self, module: str) -> bool:
        return self.options[module]["enabled"] and module in self.module_urls

    def record_error(self, module: str, error: Exception, frame_index: int | None = None) -> None:
        entry = {"module": module, "error": describe_http_error(error)}
        if frame_index is not None:
            entry["frame"] = frame_index
        self.errors.append(entry)

    # --- stage 1: pose ----------------------------------------------------------------
    async def detect_poses(self) -> None:
        for frame, picture in zip(self.frames, self.pictures, strict=True):
            try:
                response = await self.client.post(
                    f"{self.module_urls['yolo']}/v1/detect",
                    params={"classes": "person", "confidence": self.options["yolo"]["confidence"]},
                    files={"image": (picture.filename, to_jpeg(picture.image), "image/jpeg")},
                )
                response.raise_for_status()
                detection = response.json()
            except (httpx.HTTPError, ValueError) as error:
                self.record_error("yolo", error, frame["index"])
                continue
            frame["detections"] = detection["detections"]
            frame["people"] = detection["counts"].get("person", 0)
            frame["yolo_model"] = detection["model"]
            dancer = select_main_dancer(detection["detections"])
            if dancer:
                frame["dancer"] = {"box": dancer["box"], "confidence": dancer["confidence"]}
                if dancer.get("keypoints"):
                    frame["dancer"]["keypoints"] = dancer["keypoints"]
                    frame["dancer"]["evaluation"] = evaluate_pose(dancer["keypoints"]).to_api()

    def motion(self) -> dict | None:
        dancer_frames = []
        for frame in self.frames:
            evaluation = (frame.get("dancer") or {}).get("evaluation")
            dancer_frames.append(
                DancerFrame(frame["dancer"]["keypoints"], evaluation["angles"], evaluation["body_height_px"])
                if evaluation
                else None
            )
        if len(self.frames) < 2 or not any(dancer_frames):
            return None
        return analyse_motion(dancer_frames)

    # --- stage 2: CLIP ----------------------------------------------------------------
    async def rank_movements_with_clip(self) -> None:
        clip_options = self.options["clip"]
        crops = [
            crop_around(picture.image, (frame.get("dancer") or {}).get("box") if clip_options["crop"] else None)
            for frame, picture in zip(self.frames, self.pictures, strict=True)
        ]
        form = {
            "labels": json.dumps(clip_options["labels"]),
            "use_descriptions": str(clip_options["use_descriptions"]).lower(),
        }
        if clip_options.get("templates"):
            form["templates"] = json.dumps(clip_options["templates"])
        try:
            response = await self.client.post(
                f"{self.module_urls['clip']}/v1/zero-shot",
                data=form,
                files=[
                    ("images", (f"crop{index}.jpg", to_jpeg(crop), "image/jpeg")) for index, crop in enumerate(crops)
                ],
            )
            response.raise_for_status()
            for frame, result in zip(self.frames, response.json()["results"], strict=True):
                frame["clip"] = {"top": result["ranking"][:5], "agreement": result["sensitivity"]["agreement"]}
        except (httpx.HTTPError, ValueError, KeyError) as error:
            self.record_error("clip", error)

    # --- stage 3: VLM -----------------------------------------------------------------
    async def ask_vlm(self, motion: dict | None) -> dict | None:
        vlm_options = self.options["vlm"]
        context = build_context(self.frames, motion) if vlm_options["use_context"] else ""
        prompt = vlm_options["prompt"]
        if context:
            prompt = (
                "Measurements from a pose estimator and an image-text model (they can be wrong; "
                f"trust the picture first):\n{context}\n\n{prompt}"
            )
        form = {
            "prompt": prompt,
            "system": vlm_options.get("system") or DEFAULT_VLM_SYSTEM_PROMPT,
            "sequence": str(len(self.pictures) > 1).lower(),
            "params": json.dumps({"max_new_tokens": int(vlm_options["max_new_tokens"])}),
        }
        try:
            response = await self.client.post(
                f"{self.module_urls['vlm']}/v1/generate",
                data=form,
                files=[
                    ("images", (f"picture{index}.jpg", to_jpeg(picture.image), "image/jpeg"))
                    for index, picture in enumerate(self.pictures)
                ],
            )
            response.raise_for_status()
            answer = response.json()
        except (httpx.HTTPError, ValueError) as error:
            self.record_error("vlm", error)
            return None
        return {
            "text": answer["text"],
            "prompt": prompt,
            "model": answer.get("model"),
            "latency_ms": answer.get("latency_ms"),
            "image_tokens": answer.get("image_tokens"),
        }

    async def timed(self, name: str, stage):
        started = time.perf_counter()
        result = await stage
        self.timings[f"{name}_ms"] = round((time.perf_counter() - started) * 1000, 1)
        return result


async def run_analysis(
    client: httpx.AsyncClient,
    module_urls: dict[str, str],
    pictures: list[Picture],
    requested_options: dict | None = None,
    earlier_errors: list[dict] | None = None,
) -> dict:
    """``module_urls`` lists the modules that are up; ``earlier_errors`` the problems so far
    (e.g. a module that could not be launched)."""
    started = time.perf_counter()
    run = AnalysisRun(client, module_urls, pictures, merge_options(requested_options))
    run.errors.extend(earlier_errors or [])
    if run.wants("yolo"):
        await run.timed("yolo", run.detect_poses())
    motion = run.motion()
    if run.wants("clip"):
        await run.timed("clip", run.rank_movements_with_clip())
    vlm = await run.timed("vlm", run.ask_vlm(motion)) if run.wants("vlm") else None
    run.timings["total_ms"] = round((time.perf_counter() - started) * 1000, 1)
    return {
        "frames": run.frames,
        "motion": motion,
        "vlm": vlm,
        "fused": fuse_evidence(run.frames, vlm["text"] if vlm else None),
        "errors": run.errors,
        "timings": run.timings,
        "options": run.options,
    }
