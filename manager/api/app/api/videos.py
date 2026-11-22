"""Video tools: cut a part of a video into a new file."""

from __future__ import annotations

import mimetypes
import shutil
import tempfile
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Form, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask

from app.api.dependencies import Store
from app.live.adjustments import shift_adjustments
from app.video_cut import CutMode, cut_video, output_suffix, safe_file_name

router = APIRouter(tags=["videos"])


def default_cut_name(source_name: str, start: float, end: float) -> str:
    return f"{Path(source_name).stem}-cut-{start:.1f}s-{end:.1f}s"


@router.post("/api/videos/cut")
async def cut(
    video: UploadFile,
    start: Annotated[float, Form(ge=0, description="Start of the part to keep, in seconds")],
    end: Annotated[float, Form(gt=0, description="End of the part to keep, in seconds")],
    store: Store,
    mode: Annotated[CutMode, Form()] = CutMode.PRECISE,
    name: Annotated[str | None, Form(description="File name of the new video")] = None,
    media_key: Annotated[
        str | None, Form(description="The source's media key, to carry its keypoint adjustments over")
    ] = None,
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
    except Exception:
        shutil.rmtree(workdir, ignore_errors=True)
        raise

    new_media_key = f"{file_name}|{target.stat().st_size}"
    carried_over = shift_adjustments(store.list_adjustments(media_key), new_media_key, start, end) if media_key else []
    for adjustment in carried_over:
        store.save_adjustment(adjustment)
    return FileResponse(
        target,
        media_type=mimetypes.guess_type(file_name)[0] or "application/octet-stream",
        filename=file_name,
        headers={"X-File-Name": file_name, "X-Adjustments-Copied": str(len(carried_over))},
        background=BackgroundTask(shutil.rmtree, workdir, ignore_errors=True),
    )


def _save_upload(upload: UploadFile, destination: Path) -> None:
    with destination.open("wb") as file:
        shutil.copyfileobj(upload.file, file, length=1024 * 1024)
