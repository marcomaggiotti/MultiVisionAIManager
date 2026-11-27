"""Captions of a library video's movements, and the annotated video made from them.

The captions are proposed from the limbs YOLO sees moving (``limb_motion``), one per
moment, and can be rewritten or removed; the edited track is saved with the video. Each
caption appears ``anticipation`` seconds before its movement starts (2 s by default), so
the viewer is told what comes next, and stays until it ends.

The annotated video is the analysed pictures with the skeleton (the moving limbs lit up in
their colour) and the captions at the bottom of the picture, encoded as an MP4 with the
video's own sound, and added to the library. The captions are shown like karaoke: a
two-line band always readable, the words lighting up from when the caption appears to the
end of its movement, the text scrolling up so the current word stays in view.
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
from app.media.cat import draw_cat, hide_dancer
from app.media.video_comparison import VISIBLE, _font, draw_skeleton

SCHEMA = "CREATE TABLE IF NOT EXISTS video_captions (video_id TEXT PRIMARY KEY, data TEXT, updated REAL)"
DEFAULT_ANTICIPATION = 2.0
ANNOTATED_ORIGIN = "annotated"
LIMB_LABELS = {limb.id: limb.label for limb in LIMBS}
STILL_COLOR = (220, 226, 240, 140)
SUNG_COLOR, WORD_COLOR, BAND_COLOR = "#ffd23f", "#ffffff", (6, 9, 18, 225)
BAND_LINES = 2
SCROLL_SECONDS = 0.35  # how long the band takes to scroll up one line
MIN_SUNG_SECONDS = 0.5


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


def caption_progress(caption: dict, seconds: float, anticipation: float) -> float:
    """How far the caption has been "sung": 0 when it appears, 1 when its movement ends
    (the same as the studio's preview, ``manager/web/src/live/Karaoke.tsx``)."""
    shown_from = caption["start"] - anticipation
    return min(1.0, max(0.0, (seconds - shown_from) / max(MIN_SUNG_SECONDS, caption["end"] - shown_from)))


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
def _karaoke_words(captions: list[dict], seconds: float, anticipation: float) -> list[dict]:
    """Every word shown, with when it appeared (its caption) and when it is sung."""
    words = []
    for number, caption in enumerate(captions):
        parts = caption["text"].split()
        shown_from = caption["start"] - anticipation
        duration = max(MIN_SUNG_SECONDS, caption["end"] - shown_from)
        sung = int(caption_progress(caption, seconds, anticipation) * len(parts))
        for position, word in enumerate(parts):
            words.append({
                "word": word,
                "caption": number,
                "shown_from": shown_from,
                "sung_at": shown_from + (position + 1) / len(parts) * duration,
                "sung": position < sung,
            })  # fmt: skip
    return words


def _karaoke_lines(draw: ImageDraw.ImageDraw, words: list[dict], font, width: float) -> list[list[int]]:
    """The words wrapped into lines (indices); each caption starts on a new line."""
    lines: list[list[int]] = []
    line: list[int] = []
    for index, word in enumerate(words):
        candidate = " ".join(words[i]["word"] for i in [*line, index])
        new_caption = line and words[line[0]]["caption"] != word["caption"]
        if line and (new_caption or draw.textlength(candidate, font=font) > width):
            lines.append(line)
            line = []
        line.append(index)
    return [*lines, line] if line else lines


def karaoke_scroll(words: list[dict], lines: list[list[int]], seconds: float) -> tuple[int, float]:
    """The current word (the first not yet sung) and how many lines the band has scrolled:
    the current word's line comes to the top (smoothly, in ``SCROLL_SECONDS``), except that
    the band stops at the last lines so it stays full."""
    current = next((index for index, word in enumerate(words) if not word["sung"]), len(words) - 1)
    line = next(number for number, indices in enumerate(lines) if current in indices)
    top = min(line, max(0, len(lines) - BAND_LINES))
    if top == 0:
        return current, 0.0
    first = lines[top][0]
    reached = max([words[first]["shown_from"], *(word["sung_at"] for word in words[:first])])
    return current, top - 1 + min(1.0, max(0.0, (seconds - reached) / SCROLL_SECONDS))


def draw_karaoke(overlay: Image.Image, captions: list[dict], seconds: float, anticipation: float) -> None:
    """The captions at the bottom of the picture, as a karaoke band (see the module docstring)."""
    words = _karaoke_words(captions, seconds, anticipation)
    if not words:
        return
    side = max(overlay.size)
    font = _font(max(16, side // 26))
    size = getattr(font, "size", 16)
    margin, padding = max(8, side // 60), max(6, size // 3)
    line_height = int(size * 1.4)
    band = Image.new("RGBA", (overlay.size[0] - 2 * margin, BAND_LINES * line_height + 2 * padding), (0, 0, 0, 0))
    ImageDraw.Draw(band).rounded_rectangle([0, 0, band.size[0] - 1, band.size[1] - 1], radius=margin, fill=BAND_COLOR)
    text_layer = Image.new("RGBA", band.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(text_layer)
    lines = _karaoke_lines(draw, words, font, band.size[0] - 2 * padding)
    current, scroll = karaoke_scroll(words, lines, seconds)
    space = draw.textlength(" ", font=font)
    outline = max(1, size // 14)
    for number in range(int(scroll), min(len(lines), int(scroll) + BAND_LINES + 1)):
        y = padding + (number - scroll) * line_height + (line_height - size) / 2
        texts = [words[index]["word"] for index in lines[number]]
        x = (band.size[0] - draw.textlength(" ".join(texts), font=font)) / 2
        for index, text in zip(lines[number], texts, strict=True):
            color = SUNG_COLOR if words[index]["sung"] else WORD_COLOR
            draw.text((x, y), text, fill=color, font=font, stroke_width=outline, stroke_fill="#000000")
            length = draw.textlength(text, font=font)
            if index == current:  # underline the word to sing now
                draw.line([(x, y + size * 1.12), (x + length, y + size * 1.12)], fill=SUNG_COLOR, width=outline + 1)
            x += length + space
    # the lines scrolling in and out are cut at the band's padding
    draw.rectangle([0, 0, band.size[0], padding // 2], fill=(0, 0, 0, 0))
    draw.rectangle([0, band.size[1] - padding // 2, band.size[0], band.size[1]], fill=(0, 0, 0, 0))
    band.alpha_composite(text_layer)
    overlay.alpha_composite(band, (margin, overlay.size[1] - band.size[1] - margin))


def draw_annotated_frame(
    picture: bytes,
    frame: dict,
    moving: list[str],
    captions: list[dict],
    seconds: float,
    character: str = "skeleton",
    hide: bool = False,
    anticipation: float = DEFAULT_ANTICIPATION,
) -> bytes:
    """One frame: the skeleton (moving limbs in their colour) or the cartoon cat in the dancer's
    place (``hide``: the dancer blurred out behind it), and the captions as karaoke at the bottom."""
    image = Image.open(io.BytesIO(picture)).convert("RGB")
    overlay = Image.new("RGBA", image.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    side = max(image.size)
    keypoints = (frame.get("dancer") or {}).get("keypoints")
    if keypoints and character == "cat":
        if hide:
            hide_dancer(image, keypoints)
        draw_cat(draw, keypoints, seconds, {limb.id: limb.color for limb in LIMBS if limb.id in moving})
    elif keypoints:
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
    draw_karaoke(overlay, captions, seconds, anticipation)
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
    character: str = "skeleton",
    hide: bool = False,
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
            annotated = await asyncio.to_thread(
                draw_annotated_frame, picture, frame, moving, shown, seconds, character, hide, anticipation
            )
            process.stdin.write(annotated)
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
