"""The video library (upload, list, play, rename, delete) and cutting videos."""

from __future__ import annotations

import base64
import mimetypes
import shutil
import tempfile
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Body, Form, Query, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, Field
from starlette.background import BackgroundTask

from app.api.dependencies import Library, Store
from app.live.adjustments import shift_adjustments
from app.media import ffmpeg
from app.media.cutting import CutMode, cut_video, output_suffix, safe_file_name
from app.media.library import LibraryVideo, VideoLibrary
from app.storage import HistoryStore

router = APIRouter(tags=["videos"])
PREVIEW_FRAME_MAX_SIDE = 320
MAX_SAMPLED_FRAMES = 16


def default_cut_name(source_name: str, start: float, end: float) -> str:
    return f"{Path(source_name).stem}-cut-{start:.1f}s-{end:.1f}s"


def _save_upload(upload: UploadFile, destination: Path) -> None:
    with destination.open("wb") as file:
        shutil.copyfileobj(upload.file, file, length=1024 * 1024)


def _carry_adjustments_over(store: HistoryStore, source_key: str | None, new_key: str, start: float, end: float) -> int:
    """Keypoint adjustments inside the kept part follow it into the new video."""
    if not source_key:
        return 0
    carried_over = shift_adjustments(store.list_adjustments(source_key), new_key, start, end)
    for adjustment in carried_over:
        store.save_adjustment(adjustment)
    return len(carried_over)


# --- library ------------------------------------------------------------------------
@router.get("/api/videos")
def list_videos(library: Library) -> list[dict]:
    return [video.to_api() for video in library.list()]


@router.post("/api/videos", status_code=201)
async def upload_videos(files: list[UploadFile], library: Library) -> dict:
    """Add videos to the library; each is checked with ffprobe and gets a thumbnail."""
    saved, errors = [], []
    for upload in files:
        name = Path(upload.filename or "video.mp4").name
        with tempfile.TemporaryDirectory(prefix="video-upload-") as workdir:
            temporary = Path(workdir) / "upload"
            await run_in_threadpool(_save_upload, upload, temporary)
            try:
                saved.append((await library.add(temporary, name)).to_api())
            except ffmpeg.FfmpegMissingError:
                raise
            except ffmpeg.VideoError as error:
                errors.append({"file": name, "error": str(error)})
    return {"saved": saved, "errors": errors}


@router.get("/api/videos/{video_id}")
def get_video(video_id: str, library: Library) -> dict:
    return library.get(video_id).to_api()


class VideoUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    notes: str | None = Field(default=None, max_length=5000)


@router.patch("/api/videos/{video_id}")
def update_video(video_id: str, update: VideoUpdate, library: Library) -> dict:
    return library.update(video_id, update.name, update.notes).to_api()


@router.delete("/api/videos/{video_id}", status_code=204)
def delete_video(video_id: str, library: Library) -> Response:
    library.delete(video_id)
    return Response(status_code=204)


@router.get("/api/videos/{video_id}/file")
def video_file(video_id: str, library: Library) -> FileResponse:
    """The video itself (byte ranges supported, so players can seek)."""
    video = library.get(video_id)
    return FileResponse(
        library.file_path(video_id),
        media_type=mimetypes.guess_type(video.name)[0] or "video/mp4",
        filename=video.name,
        content_disposition_type="inline",
    )


@router.get("/api/videos/{video_id}/thumbnail")
def video_thumbnail(video_id: str, library: Library) -> FileResponse:
    return FileResponse(library.thumbnail_path(video_id), media_type="image/jpeg")


@router.get("/api/videos/{video_id}/frames")
async def video_frames(
    video_id: str,
    library: Library,
    start: Annotated[float, Query(ge=0)] = 0,
    end: Annotated[float | None, Query(gt=0)] = None,
    count: Annotated[int, Query(ge=1, le=MAX_SAMPLED_FRAMES)] = 8,
) -> list[dict]:
    """Pictures spread evenly over a part of the video (what a VLM would be shown)."""
    video = library.get(video_id)
    end = min(end or video.duration, video.duration)
    frames = await ffmpeg.frames_between(library.file_path(video_id), start, end, count, PREVIEW_FRAME_MAX_SIDE)
    return [
        {"time": moment, "image": "data:image/jpeg;base64," + base64.b64encode(jpeg).decode()}
        for moment, jpeg in frames
    ]


class CutRequest(BaseModel):
    start: float = Field(ge=0)
    end: float = Field(gt=0)
    mode: CutMode = CutMode.PRECISE
    name: str | None = None


@router.post("/api/videos/{video_id}/cut", status_code=201)
async def cut_library_video(video_id: str, cut: Annotated[CutRequest, Body()], library: Library, store: Store) -> dict:
    """Cut a part of a library video into a new library video."""
    source = library.get(video_id)
    suffix = output_suffix(cut.mode, Path(source.name).suffix)
    file_name = safe_file_name(cut.name or default_cut_name(source.name, cut.start, cut.end), suffix)
    with tempfile.TemporaryDirectory(prefix="video-cut-") as workdir:
        target = Path(workdir) / file_name
        await cut_video(library.file_path(video_id), target, cut.start, min(cut.end, source.duration), cut.mode)
        video = await library.add(target, file_name, origin="cut", parent_id=source.id)
    copied = _carry_adjustments_over(store, source.media_key, video.media_key, cut.start, cut.end)
    return {**video.to_api(), "adjustments_copied": copied}


# --- cutting a video chosen in the browser ------------------------------------------
@router.post("/api/videos/cut")
async def cut(
    request: Request,
    video: UploadFile,
    start: Annotated[float, Form(ge=0, description="Start of the part to keep, in seconds")],
    end: Annotated[float, Form(gt=0, description="End of the part to keep, in seconds")],
    store: Store,
    mode: Annotated[CutMode, Form()] = CutMode.PRECISE,
    name: Annotated[str | None, Form(description="File name of the new video")] = None,
    media_key: Annotated[
        str | None, Form(description="The source's media key, to carry its keypoint adjustments over")
    ] = None,
    save_to_library: Annotated[bool, Form(description="Also keep the new video in the library")] = False,
) -> FileResponse:
    """The new video file. Keypoint adjustments saved inside the kept part are copied to
    the new file (with their times shifted), so its analysis uses them too."""
    source_name = video.filename or "video.mp4"
    suffix = output_suffix(mode, Path(source_name).suffix)
    file_name = safe_file_name(name or default_cut_name(source_name, start, end), suffix)
    workdir = Path(tempfile.mkdtemp(prefix="video-cut-"))
    try:
        source = workdir / f"source{Path(source_name).suffix.lower() or '.mp4'}"
        target = workdir / file_name
        await run_in_threadpool(_save_upload, video, source)
        await cut_video(source, target, start, end, mode)
        headers = {"X-File-Name": file_name}
        if save_to_library:
            library: VideoLibrary = request.app.state.library
            kept: LibraryVideo = await library.add(target, file_name, origin="cut")
            target = library.file_path(kept.id)
            headers["X-Video-Id"] = kept.id
    except Exception:
        shutil.rmtree(workdir, ignore_errors=True)
        raise

    new_media_key = f"{file_name}|{target.stat().st_size}"
    headers["X-Adjustments-Copied"] = str(_carry_adjustments_over(store, media_key, new_media_key, start, end))
    return FileResponse(
        target,
        media_type=mimetypes.guess_type(file_name)[0] or "application/octet-stream",
        filename=file_name,
        headers=headers,
        background=BackgroundTask(shutil.rmtree, workdir, ignore_errors=True),
    )
