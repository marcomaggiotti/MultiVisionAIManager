"""What a question is about: frames sampled from (a part of) a library video, frames
chosen among a video's analysed frames, or pictures."""

from __future__ import annotations

import io
import json
from dataclasses import dataclass, field

from fastapi import UploadFile
from PIL import Image, UnidentifiedImageError
from pydantic import BaseModel, Field

from app.media import ffmpeg
from app.media.library import VideoLibrary

MAX_PICTURES = 16  # the VLM module's limit
PICTURE_MAX_SIDE = 640


class InvalidInputError(ValueError):
    """The pictures cannot be used (wrong range, not a picture, too many)."""


class VideoInput(BaseModel):
    video_id: str
    start: float = Field(0, ge=0)
    end: float | None = Field(None, gt=0, description="Default: the end of the video")
    frames: int = Field(8, ge=1, le=MAX_PICTURES, description="Pictures sampled evenly over the part")


class AnalysedFramesInput(BaseModel):
    """Frames chosen among a library video's analysed frames (by their index in the analysis)."""

    video_id: str
    indices: list[int] = Field(min_length=1, max_length=MAX_PICTURES)


@dataclass
class Pictures:
    jpegs: list[bytes] = field(default_factory=list)
    times: list[float] | None = None  # in the video, for frames
    description: str = "no picture"


async def pictures_from_video(library: VideoLibrary, request: VideoInput) -> Pictures:
    video = library.get(request.video_id)
    end = min(request.end or video.duration, video.duration)
    if end - request.start <= 0:
        raise InvalidInputError("the part of the video is empty: check start and end")
    frames = await ffmpeg.frames_between(
        library.file_path(video.id), request.start, end, request.frames, PICTURE_MAX_SIDE
    )
    return Pictures(
        jpegs=[jpeg for _, jpeg in frames],
        times=[moment for moment, _ in frames],
        description=f"{len(frames)} frames of {video.name} from {request.start:.1f} s to {end:.1f} s",
    )


async def pictures_from_uploads(uploads: list[UploadFile]) -> Pictures:
    if len(uploads) > MAX_PICTURES:
        raise InvalidInputError(f"at most {MAX_PICTURES} pictures")
    jpegs = []
    for upload in uploads:
        try:
            picture = Image.open(io.BytesIO(await upload.read())).convert("RGB")
        except UnidentifiedImageError as error:
            raise InvalidInputError(f"{upload.filename} is not a picture") from error
        picture.thumbnail((PICTURE_MAX_SIDE, PICTURE_MAX_SIDE))
        buffer = io.BytesIO()
        picture.save(buffer, format="JPEG", quality=90)
        jpegs.append(buffer.getvalue())
    return Pictures(
        jpegs=jpegs, description=f"{len(jpegs)} picture{'s' if len(jpegs) != 1 else ''}" if jpegs else "no picture"
    )


def pictures_from_analysis(library: VideoLibrary, analyses, request: AnalysedFramesInput) -> Pictures:
    """The chosen analysed frames, in time order, from the picture store (``analyses`` is
    the manager's ``VideoAnalyses``)."""
    video = library.get(request.video_id)
    stored = analyses.result_bytes(video.id)
    if stored is None:
        raise InvalidInputError(f"{video.name} is not analysed yet")
    analysis = json.loads(stored)
    frames = analysis["frames"]
    indices = sorted(set(request.indices))
    if any(index < 0 or index >= len(frames) for index in indices):
        raise InvalidInputError(f"{video.name} has {len(frames)} analysed frames (0 to {len(frames) - 1})")
    jpegs = []
    for index in indices:
        picture = analyses.frame(video.id, analysis["run"], index)
        if picture is None:
            raise InvalidInputError(f"the picture of frame {index} is missing: analyse the video again")
        jpegs.append(picture)
    times = [frames[index]["source_time"] for index in indices]
    moments = ", ".join(f"{moment:.2f} s" for moment in times)
    plural = "s" if len(indices) > 1 else ""
    return Pictures(
        jpegs=jpegs, times=times, description=f"{len(indices)} frame{plural} of {video.name} (at {moments})"
    )


async def load_pictures(
    library: VideoLibrary,
    video: VideoInput | None,
    uploads: list[UploadFile] | None,
    frames: AnalysedFramesInput | None = None,
    analyses=None,
) -> Pictures:
    """Chosen analysed frames, else the video's sampled frames, else the uploaded pictures (maybe none)."""
    if frames is not None:
        return pictures_from_analysis(library, analyses, frames)
    if video is not None:
        return await pictures_from_video(library, video)
    return await pictures_from_uploads(uploads or [])
