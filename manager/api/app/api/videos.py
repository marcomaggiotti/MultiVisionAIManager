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
from app.media.keypoint_tracks import KeypointTrackStore, TrackFrame
from app.media.library import LibraryVideo, VideoLibrary
from app.media.video_analysis import AnalysisSettings, VideoAnalyses
from app.storage import HistoryStore, RecordNotFoundError

router = APIRouter(tags=["videos"])
FRAME_MAX_SIDE = 1280
FRAME_CACHE_ENTRIES = 5000  # cached frame pictures kept on disk (the oldest go first)
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
def get_tracks(request: Request) -> KeypointTrackStore:
    return request.app.state.keypoint_tracks


def get_analyses(request: Request) -> VideoAnalyses:
    return request.app.state.video_analyses


def _with_analysis(video: LibraryVideo, request: Request, counts: dict[str, int] | None = None) -> dict:
    """A video for the API: its saved keypoint frames and the state of its analysis."""
    counts = counts if counts is not None else get_tracks(request).counts()
    state = get_analyses(request).state(video.id)
    return {
        **video.to_api(),
        "keypoint_frames": counts.get(video.media_key, 0),
        "analysis": state.to_api() if state else None,
    }


@router.get("/api/videos")
def list_videos(library: Library, request: Request) -> list[dict]:
    """The videos, with how many analysed frames (keypoints) each has, and their analysis."""
    counts = get_tracks(request).counts()
    return [_with_analysis(video, request, counts) for video in library.list()]


@router.post("/api/videos", status_code=201)
async def upload_videos(files: list[UploadFile], library: Library, request: Request) -> dict:
    """Add videos to the library; each is checked with ffprobe, gets a thumbnail and is
    queued for analysis (every frame's keypoints, movements and corrections)."""
    saved, errors = [], []
    for upload in files:
        name = Path(upload.filename or "video.mp4").name
        with tempfile.TemporaryDirectory(prefix="video-upload-") as workdir:
            temporary = Path(workdir) / "upload"
            await run_in_threadpool(_save_upload, upload, temporary)
            try:
                video = await library.add(temporary, name)
                get_analyses(request).enqueue(video.id)
                saved.append(_with_analysis(video, request))
            except ffmpeg.FfmpegMissingError:
                raise
            except ffmpeg.VideoError as error:
                errors.append({"file": name, "error": str(error)})
    return {"saved": saved, "errors": errors}


@router.get("/api/videos/{video_id}")
def get_video(video_id: str, library: Library, request: Request) -> dict:
    return _with_analysis(library.get(video_id), request)


class VideoUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    notes: str | None = Field(default=None, max_length=5000)


@router.patch("/api/videos/{video_id}")
def update_video(video_id: str, update: VideoUpdate, library: Library, store: Store, request: Request) -> dict:
    before = library.get(video_id)
    video = library.update(video_id, update.name, update.notes)
    if video.media_key != before.media_key:  # renamed: its keypoints and corrections follow it
        get_tracks(request).rename(before.media_key, video.media_key)
        store.rename_adjustments(before.media_key, video.media_key)
    return _with_analysis(video, request)


@router.delete("/api/videos/{video_id}", status_code=204)
def delete_video(video_id: str, library: Library, request: Request) -> Response:
    library.delete(video_id)
    get_analyses(request).forget(video_id)
    request.app.state.video_notes.delete_video(video_id)
    request.app.state.video_captions.delete(video_id)
    request.app.state.video_audio.forget(video_id)
    shutil.rmtree(library.folder.parent / "frame-cache" / Path(video_id).name, ignore_errors=True)
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
async def cut_library_video(
    video_id: str, cut: Annotated[CutRequest, Body()], library: Library, store: Store, request: Request
) -> dict:
    """Cut a part of a library video into a new library video."""
    source = library.get(video_id)
    suffix = output_suffix(cut.mode, Path(source.name).suffix)
    file_name = safe_file_name(cut.name or default_cut_name(source.name, cut.start, cut.end), suffix)
    with tempfile.TemporaryDirectory(prefix="video-cut-") as workdir:
        target = Path(workdir) / file_name
        await cut_video(library.file_path(video_id), target, cut.start, min(cut.end, source.duration), cut.mode)
        video = await library.add(target, file_name, origin="cut", parent_id=source.id)
    copied = _carry_adjustments_over(store, source.media_key, video.media_key, cut.start, cut.end)
    request.app.state.video_analyses.enqueue(video.id)  # after the adjustments: the analysis uses them
    return {**_with_analysis(video, request), "adjustments_copied": copied}


# --- analysis (done by the manager when a video is added; played by the live studio) ---
@router.get("/api/videos/{video_id}/analysis")
def video_analysis(video_id: str, library: Library, request: Request) -> Response:
    """Every analysed frame (keypoints, evaluation, movement), the movements and comments."""
    library.get(video_id)
    result = get_analyses(request).result_bytes(video_id)
    if result is None:
        raise RecordNotFoundError(f"video {video_id!r} is not analysed yet")
    return Response(result, media_type="application/json", headers={"Cache-Control": "no-store"})


@router.get("/api/videos/{video_id}/analysis/frames/{run}/{index}.jpg")
def analysed_frame(video_id: str, run: str, index: int, request: Request) -> Response:
    """One analysed picture (the size the keypoints are measured in), from the picture store.
    ``run`` is the analysis' ``run``: a new analysis gives new URLs, so they can be cached."""
    picture = get_analyses(request).frame(video_id, run, index)
    if picture is None:
        raise RecordNotFoundError(f"frame {index} of video {video_id!r} not found")
    return Response(picture, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=86400, immutable"})


class AnalysisRequest(BaseModel):
    fps: float = Field(15.0, ge=1, le=30)
    detection_confidence: float = Field(0.3, ge=0.05, le=0.95)
    confidence: float = Field(0.35, ge=0.05, le=0.95)
    hold: int = Field(4, ge=1, le=30)
    smoothing: float = Field(0.5, ge=0, le=0.95)


@router.post("/api/videos/{video_id}/analysis", status_code=202)
def analyse_again(video_id: str, library: Library, request: Request, settings: AnalysisRequest | None = None) -> dict:
    """Queue the video for a new analysis (e.g. with other settings)."""
    video = library.get(video_id)
    get_analyses(request).enqueue(video.id, AnalysisSettings(**(settings or AnalysisRequest()).model_dump()))
    return _with_analysis(video, request)


# --- keypoint tracks (written by the analysis, read by the Analysis tab) -----------
class TrackFrameIn(BaseModel):
    source_time: float = Field(ge=0)
    keypoints: list[list[float]] | None = None
    box: dict | None = None
    image: dict | None = None
    movement: str | None = None
    adjusted: bool = False


class TrackSave(BaseModel):
    media_key: str = Field(min_length=1)
    session_id: str | None = None
    frames: list[TrackFrameIn] = Field(max_length=20000)


@router.put("/api/keypoint-tracks")
def save_keypoint_track(track: TrackSave, request: Request) -> dict:
    """Associate the keypoints of each analysed frame with the video (at its time in it)."""
    frames = [TrackFrame(**frame.model_dump(), session_id=track.session_id) for frame in track.frames]
    total = get_tracks(request).save(track.media_key, frames)
    return {"saved": len(frames), "total": total}


@router.get("/api/videos/{video_id}/keypoints")
def video_keypoints(
    video_id: str,
    library: Library,
    request: Request,
    start: Annotated[float, Query(ge=0)] = 0,
    end: Annotated[float | None, Query(ge=0)] = None,
) -> dict:
    """The saved frames of the video between ``start`` and ``end`` (seconds), in time order."""
    video = library.get(video_id)
    frames = get_tracks(request).frames(video.media_key, start, end)
    return {"video": video.to_api(), "frames": [frame.to_api() for frame in frames]}


@router.delete("/api/videos/{video_id}/keypoints")
def delete_video_keypoints(video_id: str, library: Library, request: Request) -> dict:
    return {"deleted": get_tracks(request).delete(library.get(video_id).media_key)}


@router.get("/api/videos/{video_id}/frame")
async def video_frame(
    video_id: str,
    library: Library,
    t: Annotated[float, Query(ge=0, description="Time in the video, seconds")],
    max_side: Annotated[int, Query(ge=32, le=FRAME_MAX_SIDE)] = 640,
) -> Response:
    """The picture at time ``t`` (JPEG), cached on disk: thumbnails of many frames load fast."""
    video = library.get(video_id)
    cache = library.folder.parent / "frame-cache" / video.id
    path = cache / f"{t:.3f}-{max_side}.jpg"
    if not path.exists():
        jpeg = await ffmpeg.frame_at(library.file_path(video_id), min(t, video.duration), max_side)
        cache.mkdir(parents=True, exist_ok=True)
        path.write_bytes(jpeg)
        _trim_cache(cache.parent)
    return Response(path.read_bytes(), media_type="image/jpeg", headers={"Cache-Control": "public, max-age=86400"})


def _trim_cache(root: Path) -> None:
    files = sorted(root.glob("*/*.jpg"), key=lambda file: file.stat().st_mtime)
    for file in files[:-FRAME_CACHE_ENTRIES]:
        file.unlink(missing_ok=True)


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
