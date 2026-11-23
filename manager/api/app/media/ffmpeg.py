"""Thin async wrappers around ffmpeg and ffprobe."""

from __future__ import annotations

import asyncio
import io
import json
import shutil
from dataclasses import dataclass
from pathlib import Path

from PIL import Image

ERROR_LINES_SHOWN = 3
FRAME_JPEG_QUALITY = 88


class VideoError(Exception):
    """The video cannot be read or processed."""


class FfmpegMissingError(VideoError):
    """ffmpeg is not installed where the manager runs."""


@dataclass(frozen=True)
class VideoInfo:
    duration: float
    width: int
    height: int


def require_ffmpeg() -> None:
    if shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None:
        raise FfmpegMissingError("ffmpeg is not installed where the manager runs (the Docker image includes it)")


async def run(command: list[str]) -> bytes:
    """Run ffmpeg or ffprobe; its standard output, or VideoError with the last error lines."""
    require_ffmpeg()
    process = await asyncio.create_subprocess_exec(
        *command, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
    )
    output, errors = await process.communicate()
    if process.returncode != 0:
        details = " ".join(errors.decode(errors="replace").strip().splitlines()[-ERROR_LINES_SHOWN:])
        raise VideoError(f"{command[0]} could not process this video: {details or 'unknown error'}")
    return output


async def probe(path: Path) -> VideoInfo:
    output = await run([
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=width,height:format=duration", "-of", "json", str(path),
    ])  # fmt: skip
    data = json.loads(output or b"{}")
    streams = data.get("streams") or []
    duration = float((data.get("format") or {}).get("duration") or 0)
    if not streams or duration <= 0:
        raise VideoError("no video stream found (is it a video file?)")
    return VideoInfo(duration=round(duration, 3), width=int(streams[0]["width"]), height=int(streams[0]["height"]))


async def frame_at(path: Path, seconds: float, max_side: int) -> bytes:
    """The picture at ``seconds`` as JPEG, at most ``max_side`` pixels wide or high."""
    output = await run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-ss", f"{max(0.0, seconds):.3f}", "-i", str(path),
        "-frames:v", "1", "-f", "image2pipe", "-c:v", "png", "-",
    ])  # fmt: skip
    if not output:
        raise VideoError(f"no picture at {seconds:.2f} s")
    picture = Image.open(io.BytesIO(output)).convert("RGB")
    picture.thumbnail((max_side, max_side))
    buffer = io.BytesIO()
    picture.save(buffer, format="JPEG", quality=FRAME_JPEG_QUALITY)
    return buffer.getvalue()


def sample_times(start: float, end: float, count: int) -> list[float]:
    """``count`` moments spread evenly over [start, end] (the middle of equal slices)."""
    step = (end - start) / count
    return [round(start + (index + 0.5) * step, 3) for index in range(count)]


async def frames_between(path: Path, start: float, end: float, count: int, max_side: int) -> list[tuple[float, bytes]]:
    times = sample_times(start, end, count)
    pictures = await asyncio.gather(*(frame_at(path, moment, max_side) for moment in times))
    return list(zip(times, pictures, strict=True))
