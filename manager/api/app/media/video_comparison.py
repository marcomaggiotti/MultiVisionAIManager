"""Compare analysed library videos: the reference (the instruction video to follow) and
one or more performances of it.

The newest performance is the base: its analysed pictures are shown, and the dancers of
every other video, above all the reference, are drawn over it as skeletons. Each video
is aligned to the base in time (an offset in seconds, to line up the starts) and in space
(each skeleton is moved and scaled onto the base dancer's torso, so different framings
and distances compare). Each frame gets each performance's match score with the
reference (joint angles, as in the live comparison, with mirror detection).

``render_video`` draws all this on the base pictures and encodes an MP4 that is added to
the library.
"""

from __future__ import annotations

import asyncio
import functools
import io
import json
import math
import tempfile
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from app.ballet.comparison import MirrorMode, best_comparison
from app.ballet.keypoints import SKELETON
from app.ballet.measurements import JointAngles
from app.media import ffmpeg
from app.media.library import LibraryVideo, VideoLibrary

VISIBLE = 0.5
LEFT_SHOULDER, RIGHT_SHOULDER, LEFT_HIP, RIGHT_HIP = 5, 6, 11, 12
BASE_COLOR = "#3ddc84"
REFERENCE_COLOR = "#ffd23f"
OTHER_COLORS = ["#4f8cff", "#ff7ac6", "#5ee3e8", "#ff9f5a", "#a78bfa"]
MAX_VIDEOS = 6
COMPARISON_ORIGIN = "comparison"


class ComparisonError(ValueError):
    """The videos cannot be compared (not analysed, too few, unknown)."""


@dataclass
class ComparedVideo:
    video: LibraryVideo
    role: str  # "reference", "base" (the newest performance) or "performance"
    color: str
    offset: float  # seconds added to the base time to find this video's frame
    analysis: dict = field(repr=False)

    def to_api(self) -> dict:
        return {
            "id": self.video.id, "name": self.video.name, "created": self.video.created, "role": self.role,
            "color": self.color, "offset": self.offset, "run": self.analysis["run"],
            "duration": self.video.duration,
        }  # fmt: skip


# --- alignment --------------------------------------------------------------------------
def _midpoint(keypoints: list, first: int, second: int) -> tuple[float, float] | None:
    a, b = keypoints[first], keypoints[second]
    if a[2] < VISIBLE or b[2] < VISIBLE:
        return None
    return (a[0] + b[0]) / 2, (a[1] + b[1]) / 2


def torso(keypoints: list | None) -> tuple[tuple[float, float], float] | None:
    """The hips' centre and the torso length (shoulders' centre to hips' centre)."""
    if not keypoints:
        return None
    hips = _midpoint(keypoints, LEFT_HIP, RIGHT_HIP)
    shoulders = _midpoint(keypoints, LEFT_SHOULDER, RIGHT_SHOULDER)
    if not hips or not shoulders:
        return None
    length = math.dist(hips, shoulders)
    return (hips, length) if length > 1 else None


def align(keypoints: list | None, onto: list | None) -> list | None:
    """``keypoints`` moved and scaled so that its torso lies on ``onto``'s torso."""
    source, target = torso(keypoints), torso(onto)
    if not source or not target:
        return None
    (source_hips, source_length), (target_hips, target_length) = source, target
    scale = target_length / source_length
    return [
        [
            round(target_hips[0] + (x - source_hips[0]) * scale, 1),
            round(target_hips[1] + (y - source_hips[1]) * scale, 1),
            v,
        ]
        for x, y, v in keypoints
    ]


def nearest_frame(frames: list[dict], seconds: float, fps: float) -> dict | None:
    """The analysed frame at ``seconds`` (within half a frame), or None outside the video."""
    if not frames or seconds < -0.5 / fps:
        return None
    index = max(0, min(len(frames) - 1, round(seconds * fps)))
    frame = frames[index]
    return frame if abs(frame["source_time"] - seconds) <= 0.75 / fps else None


def _angles(frame: dict | None) -> JointAngles | None:
    angles = ((frame or {}).get("evaluation") or {}).get("angles")
    return JointAngles(**angles) if angles else None


# --- the comparison -------------------------------------------------------------------------
def choose_roles(videos: list[LibraryVideo], reference_id: str | None) -> tuple[LibraryVideo, LibraryVideo]:
    """The reference (given, else the oldest) and the base (the newest other video)."""
    if len(videos) < 2:
        raise ComparisonError("choose at least two videos: the reference and a performance")
    if len(videos) > MAX_VIDEOS:
        raise ComparisonError(f"at most {MAX_VIDEOS} videos at once")
    by_date = sorted(videos, key=lambda video: video.created)
    reference = next((video for video in videos if video.id == reference_id), by_date[0])
    base = max((video for video in videos if video.id != reference.id), key=lambda video: video.created)
    return reference, base


def load_videos(
    library: VideoLibrary, analyses, video_ids: list[str], reference_id: str | None, offsets: dict[str, float]
) -> list[ComparedVideo]:
    """The compared videos with their analyses: the base first, the reference second."""
    videos = [library.get(video_id) for video_id in dict.fromkeys(video_ids)]
    reference, base = choose_roles(videos, reference_id)
    others = [
        video for video in sorted(videos, key=lambda video: video.created) if video.id not in (reference.id, base.id)
    ]
    compared = []
    for position, (video, role) in enumerate(
        [(base, "base"), (reference, "reference")] + [(v, "performance") for v in others]
    ):
        stored = analyses.result_bytes(video.id)
        if stored is None:
            raise ComparisonError(f"{video.name} is not analysed yet: wait for its analysis in the Library")
        color = (
            BASE_COLOR
            if role == "base"
            else REFERENCE_COLOR
            if role == "reference"
            else OTHER_COLORS[(position - 2) % len(OTHER_COLORS)]
        )
        offset = 0.0 if role == "base" else float(offsets.get(video.id, 0.0))
        compared.append(ComparedVideo(video, role, color, offset, json.loads(stored)))
    return compared


def compare_videos(compared: list[ComparedVideo], mirror: MirrorMode = MirrorMode.AUTO) -> dict:
    """Every base frame with the aligned skeletons of the other videos and the scores."""
    base, reference = compared[0], compared[1]
    performances = [video for video in compared if video.role != "reference"]
    totals = {video.video.id: [0.0, 0] for video in performances}
    frames_out = []
    for frame in base.analysis["frames"]:
        t = frame["source_time"]
        base_keypoints = (frame.get("dancer") or {}).get("keypoints")
        overlays, scores = {}, {}
        matched = {
            video.video.id: nearest_frame(video.analysis["frames"], t + video.offset, video.analysis["fps"])
            for video in compared[1:]
        }
        matched[base.video.id] = frame
        reference_angles = _angles(matched[reference.video.id])
        for video in compared[1:]:
            other = matched[video.video.id]
            overlays[video.video.id] = align(
                (other.get("dancer") or {}).get("keypoints") if other else None, base_keypoints
            )
        for video in performances:
            angles = _angles(matched[video.video.id])
            if reference_angles and angles:
                score = best_comparison(reference_angles, angles, mode=mirror).score
                if score is not None:
                    scores[video.video.id] = round(score, 1)
                    totals[video.video.id][0] += score
                    totals[video.video.id][1] += 1
        frames_out.append({
            "index": frame["index"], "t": t, "keypoints": base_keypoints, "image": frame.get("image"),
            "overlays": overlays, "scores": scores,
        })  # fmt: skip
    return {
        "videos": [video.to_api() for video in compared],
        "base": base.video.id,
        "reference": reference.video.id,
        "fps": base.analysis["fps"],
        "frames": frames_out,
        "mean_scores": {
            video_id: round(total / count, 1) if count else None for video_id, (total, count) in totals.items()
        },
    }


# --- the comparison video -------------------------------------------------------------------
FONT_FILES = (  # bold, with the accents of the ballet terms (plié, relevé, développé)
    "DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
)


@functools.cache
def _font(size: int):
    for name in FONT_FILES:
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    try:  # no DejaVu: Pillow's own font (basic Latin letters only)
        return ImageFont.load_default(size=size)
    except TypeError:  # Pillow < 10.1
        return ImageFont.load_default()


def draw_skeleton(draw: ImageDraw.ImageDraw, keypoints: list, color: str, width: int, joints: bool = True) -> None:
    for start, end in SKELETON:
        a, b = keypoints[int(start)], keypoints[int(end)]
        if a[2] >= VISIBLE and b[2] >= VISIBLE:
            draw.line([(a[0], a[1]), (b[0], b[1])], fill=color, width=width)
    if joints:
        radius = max(2, width)
        for x, y, visibility in keypoints:
            if visibility >= VISIBLE:
                draw.ellipse([x - radius, y - radius, x + radius, y + radius], fill=color)


def draw_frame(picture: bytes, frame: dict, comparison: dict) -> bytes:
    """One frame of the comparison video: the base picture, every skeleton, names and scores."""
    image = Image.open(io.BytesIO(picture)).convert("RGB")
    overlay = Image.new("RGBA", image.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    side = max(image.size)
    videos = {video["id"]: video for video in comparison["videos"]}
    # the others first (thin), then the reference (thick, the one to follow), then the base dancer
    order = [video for video in comparison["videos"] if video["role"] == "performance"]
    order += [videos[comparison["reference"]]]
    for video in order:
        keypoints = frame["overlays"].get(video["id"])
        if keypoints:
            thick = video["role"] == "reference"
            draw_skeleton(
                draw, keypoints, video["color"] + ("ee" if thick else "bb"), max(2, side // (90 if thick else 160))
            )
    if frame.get("keypoints"):
        draw_skeleton(draw, frame["keypoints"], BASE_COLOR + "cc", max(2, side // 200))
    # legend: one line per video with its score at this frame
    font = _font(max(11, side // 48))
    line = max(14, side // 34)
    lines = []
    for video in comparison["videos"]:
        score = frame["scores"].get(video["id"])
        role = {"reference": "reference", "base": "this performance", "performance": "performance"}[video["role"]]
        lines.append(
            (
                video["color"],
                f"{Path(video['name']).stem[:28]} · {role}" + (f" · {score:.0f}" if score is not None else ""),
            )
        )
    box_height = line * len(lines) + line // 2
    draw.rectangle([0, 0, image.size[0], box_height], fill=(8, 12, 22, 170))
    for position, (color, text) in enumerate(lines):
        y = line // 4 + position * line
        draw.rectangle([8, y + line * 0.25, 8 + line * 0.5, y + line * 0.75], fill=color)
        draw.text((14 + line * 0.5, y), text, fill="#e8ecf5", font=font)
    draw.text((8, image.size[1] - line - 4), f"{frame['t']:.2f} s", fill="#e8ecf5", font=font)
    image = Image.alpha_composite(image.convert("RGBA"), overlay).convert("RGB")
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", quality=88)
    return buffer.getvalue()


async def render_video(
    comparison: dict, base_frame: Callable[[int], bytes | None], target: Path, progress: Callable[[float], None]
) -> None:
    """Draw every frame and encode an H.264 MP4 at the analysis frame rate."""
    ffmpeg.require_ffmpeg()
    process = await asyncio.create_subprocess_exec(
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-f", "image2pipe", "-framerate", f"{comparison['fps']:.4f}", "-c:v", "mjpeg", "-i", "-",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2",
        "-movflags", "+faststart", str(target),
        stdin=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )  # fmt: skip
    frames = comparison["frames"]
    try:
        for position, frame in enumerate(frames):
            picture = base_frame(frame["index"])
            if picture is None:
                continue
            process.stdin.write(await asyncio.to_thread(draw_frame, picture, frame, comparison))
            await process.stdin.drain()
            progress((position + 1) / len(frames))
        process.stdin.close()
        errors = await process.stderr.read()
        if await process.wait() != 0:
            raise ffmpeg.VideoError(f"ffmpeg could not encode the comparison: {errors.decode(errors='replace')[-300:]}")
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()


def comparison_name(compared: list[ComparedVideo]) -> str:
    base, reference = compared[0].video, compared[1].video
    return f"comparison-{Path(base.name).stem}-vs-{Path(reference.name).stem}.mp4"


def temporary_target() -> tuple[tempfile.TemporaryDirectory, Path]:
    folder = tempfile.TemporaryDirectory(prefix="comparison-")
    return folder, Path(folder.name) / "comparison.mp4"
