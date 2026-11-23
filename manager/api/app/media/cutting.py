"""Cut a part of a video into a new video file, with ffmpeg.

Two modes:

* ``precise`` re-encodes (H.264 + AAC in MP4): the cut is exact to the frame and the
  file plays everywhere, browsers and phones included. It takes a few seconds per minute.
* ``fast`` copies the streams without re-encoding: instant and lossless, but the start
  moves to the nearest keyframe before it (up to a few seconds early).
"""

from __future__ import annotations

import re
from enum import StrEnum
from pathlib import Path

from app.media import ffmpeg
from app.media.ffmpeg import VideoError

MIN_CUT_SECONDS = 0.1


class VideoCutError(VideoError):
    """The cut cannot be made (bad range, unreadable video)."""


class CutMode(StrEnum):
    PRECISE = "precise"
    FAST = "fast"


def output_suffix(mode: CutMode, source_suffix: str) -> str:
    """Precise cuts are MP4; fast cuts keep the source container (its codecs are copied)."""
    return ".mp4" if mode is CutMode.PRECISE else (source_suffix.lower() or ".mp4")


def safe_file_name(name: str, suffix: str) -> str:
    """A file name without paths or odd characters, ending with ``suffix``."""
    stem = Path(name).stem if Path(name).suffix.lower() == suffix else Path(name).name
    stem = re.sub(r"[^A-Za-z0-9._-]+", "-", stem).strip("-.") or "video"
    return f"{stem[:100]}{suffix}"


def ffmpeg_command(source: Path, target: Path, start: float, end: float, mode: CutMode) -> list[str]:
    duration = end - start
    command = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-ss", f"{start:.3f}", "-i", str(source)]
    command += ["-t", f"{duration:.3f}"]
    if mode is CutMode.PRECISE:
        command += ["-map", "0:v:0", "-map", "0:a:0?", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20"]
        command += ["-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart"]
    else:
        command += ["-map", "0", "-c", "copy", "-avoid_negative_ts", "make_zero"]
    return [*command, str(target)]


def check_range(start: float, end: float) -> None:
    if start < 0 or end - start < MIN_CUT_SECONDS:
        raise VideoCutError(f"the cut must start at 0 s or later and last at least {MIN_CUT_SECONDS} s")


async def cut_video(source: Path, target: Path, start: float, end: float, mode: CutMode) -> None:
    """Write the part of ``source`` between ``start`` and ``end`` (seconds) to ``target``."""
    check_range(start, end)
    try:
        await ffmpeg.run(ffmpeg_command(source, target, start, end, mode))
    except ffmpeg.FfmpegMissingError:
        raise
    except VideoError as error:
        raise VideoCutError(str(error)) from error
    if not target.exists() or target.stat().st_size == 0:
        raise VideoCutError("ffmpeg could not cut this video: no output")
