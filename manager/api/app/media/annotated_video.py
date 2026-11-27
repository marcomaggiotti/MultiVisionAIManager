"""Captions of a library video's movements, and the annotated video made from them.

The captions are proposed from the limbs YOLO sees moving (``limb_motion``), one per
moment, and can be rewritten or removed; the edited track is saved with the video. Each
caption appears ``anticipation`` seconds before its movement starts (2 s by default), so
the viewer is told what comes next, and stays until it ends.

The annotated video is the analysed pictures with the skeleton (the moving limbs lit up in
their colour) and the captions at the bottom of the picture, encoded as an MP4 with the
video's own sound, and added to the library.
"""

from __future__ import annotations

import asyncio
import io
import json
import sqlite3
import time
from collections.abc import Callable
from pathlib import Path

from PIL import Image, ImageDraw

from app.ballet.limb_motion import LIMBS
from app.media import ffmpeg
from app.media.video_comparison import VISIBLE, _font, draw_skeleton

SCHEMA = "CREATE TABLE IF NOT EXISTS video_captions (video_id TEXT PRIMARY KEY, data TEXT, updated REAL)"
DEFAULT_ANTICIPATION = 2.0
ANNOTATED_ORIGIN = "annotated"
LIMB_LABELS = {limb.id: limb.label for limb in LIMBS}
STILL_COLOR = (220, 226, 240, 140)


def caption_text(limbs: list[str]) -> str:
    """The text proposed for a moment: the limbs that move (fastest first)."""
    labels = [LIMB_LABELS.get(limb, limb) for limb in limbs]
    if len(labels) >= 4:
        return "Whole body: " + ", ".join(label.lower() for label in labels[:3]) + "…"
    if len(labels) == 1:
        return f"{labels[0]} moves"
    names = [labels[0]] + [label.lower() for label in labels[1:]]
    return ", ".join(names[:-1]) + f" and {names[-1]} move"


def proposed_captions(moments: list[dict]) -> list[dict]:
    return [
        {
            "start": moment["start"],
            "end": moment["end"],
            "text": caption_text(moment["limbs"]),
            "limbs": moment["limbs"],
        }
        for moment in moments
    ]


def active_captions(captions: list[dict], seconds: float, anticipation: float) -> list[dict]:
    """The captions shown at ``seconds``: from ``anticipation`` before their movement to its end."""
    return [caption for caption in captions if caption["start"] - anticipation <= seconds <= caption["end"]]


class CaptionStore:
    def __init__(self, database_path: Path) -> None:
        self.database_path = database_path
        with sqlite3.connect(database_path) as connection:
            connection.execute(SCHEMA)

    def get(self, video_id: str) -> dict | None:
        with sqlite3.connect(self.database_path) as connection:
            row = connection.execute("SELECT data FROM video_captions WHERE video_id = ?", (video_id,)).fetchone()
        return json.loads(row[0]) if row else None

    def save(self, video_id: str, track: dict) -> dict:
        with sqlite3.connect(self.database_path) as connection:
            connection.execute(
                "INSERT OR REPLACE INTO video_captions VALUES (?, ?, ?)", (video_id, json.dumps(track), time.time())
            )
        return track

    def delete(self, video_id: str) -> None:
        with sqlite3.connect(self.database_path) as connection:
            connection.execute("DELETE FROM video_captions WHERE video_id = ?", (video_id,))


# --- drawing --------------------------------------------------------------------------
def _wrap(draw: ImageDraw.ImageDraw, text: str, font, width: float) -> list[str]:
    lines, line = [], ""
    for word in text.split():
        candidate = f"{line} {word}".strip()
        if line and draw.textlength(candidate, font=font) > width:
            lines.append(line)
            line = word
        else:
            line = candidate
    return [*lines, line] if line else lines


def draw_annotated_frame(picture: bytes, frame: dict, moving: list[str], captions: list[dict], seconds: float) -> bytes:
    """One frame: the skeleton (moving limbs in their colour) and the captions at the bottom."""
    image = Image.open(io.BytesIO(picture)).convert("RGB")
    overlay = Image.new("RGBA", image.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    side = max(image.size)
    keypoints = (frame.get("dancer") or {}).get("keypoints")
    if keypoints:
        draw_skeleton(draw, keypoints, STILL_COLOR, max(1, side // 260), joints=False)
        for limb in LIMBS:
            if limb.id not in moving:
                continue
            width = max(4, side // 80)
            for a, b in limb.bones:
                if keypoints[a][2] >= VISIBLE and keypoints[b][2] >= VISIBLE:
                    draw.line(
                        [(keypoints[a][0], keypoints[a][1]), (keypoints[b][0], keypoints[b][1])],
                        fill=limb.color,
                        width=width,
                    )
            if limb.id == "body":
                seen = [point for point in keypoints if point[2] >= VISIBLE]
                if seen:
                    xs, ys = [point[0] for point in seen], [point[1] for point in seen]
                    draw.rectangle(
                        [min(xs) - 12, min(ys) - 12, max(xs) + 12, max(ys) + 12],
                        outline=limb.color,
                        width=max(2, side // 260),
                    )
    # the captions, at the bottom of the picture
    font = _font(max(14, side // 30))
    margin = max(8, side // 60)
    lines = [line for caption in captions for line in _wrap(draw, caption["text"], font, image.size[0] - 4 * margin)]
    if lines:
        line_height = int(font.size * 1.3) if hasattr(font, "size") else 18
        height = line_height * len(lines) + margin
        top = image.size[1] - height - margin
        draw.rounded_rectangle(
            [margin, top, image.size[0] - margin, top + height], radius=margin, fill=(8, 12, 22, 190)
        )
        for number, line in enumerate(lines):
            width = draw.textlength(line, font=font)
            draw.text(
                ((image.size[0] - width) / 2, top + margin / 2 + number * line_height), line, fill="#ffffff", font=font
            )
    image = Image.alpha_composite(image.convert("RGBA"), overlay).convert("RGB")
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", quality=88)
    return buffer.getvalue()


async def render_annotated_video(
    analysis: dict,
    limbs: dict,
    captions: list[dict],
    anticipation: float,
    frame_picture: Callable[[int], bytes | None],
    video_file: Path,
    target: Path,
    progress: Callable[[float], None],
) -> None:
    """Every analysed frame annotated, encoded as H.264 with the video's own sound (if any)."""
    ffmpeg.require_ffmpeg()
    process = await asyncio.create_subprocess_exec(
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-f", "image2pipe", "-framerate", f"{analysis['fps']:.4f}", "-c:v", "mjpeg", "-i", "-",
        "-i", str(video_file), "-map", "0:v", "-map", "1:a?", "-c:a", "aac", "-shortest",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2",
        "-movflags", "+faststart", str(target),
        stdin=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )  # fmt: skip
    frames = analysis["frames"]
    threshold = limbs["threshold"]
    try:
        for position, frame in enumerate(frames):
            picture = frame_picture(frame["index"])
            if picture is None:
                continue
            seconds = frame["source_time"]
            moving = [limb for limb, values in limbs["speeds"].items() if (values[position] or 0) >= threshold]
            shown = active_captions(captions, seconds, anticipation)
            process.stdin.write(await asyncio.to_thread(draw_annotated_frame, picture, frame, moving, shown, seconds))
            await process.stdin.drain()
            progress((position + 1) / len(frames))
        process.stdin.close()
        errors = await process.stderr.read()
        if await process.wait() != 0:
            raise ffmpeg.VideoError(
                f"ffmpeg could not encode the annotated video: {errors.decode(errors='replace')[-300:]}"
            )
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()
