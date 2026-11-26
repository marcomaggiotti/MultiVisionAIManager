"""Compare library videos (a reference and performances) and make the comparison video."""

from __future__ import annotations

import asyncio
import time
import uuid

from fastapi import APIRouter, Request
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

from app.api.dependencies import Library
from app.ballet.comparison import MirrorMode
from app.media import video_comparison as comparing
from app.storage import RecordNotFoundError

router = APIRouter(tags=["video comparison"])


class ComparisonRequest(BaseModel):
    video_ids: list[str] = Field(min_length=2, max_length=comparing.MAX_VIDEOS)
    reference_id: str | None = Field(None, description="The instruction video; default: the oldest")
    offsets: dict[str, float] = Field(default_factory=dict, description="Seconds added to the base time, per video")
    mirror: MirrorMode = MirrorMode.AUTO


def _compare(request: Request, library, comparison: ComparisonRequest) -> tuple[list, dict]:
    compared = comparing.load_videos(
        library, request.app.state.video_analyses, comparison.video_ids, comparison.reference_id, comparison.offsets
    )
    return compared, comparing.compare_videos(compared, comparison.mirror)


@router.post("/api/video-comparisons/preview")
def preview(comparison: ComparisonRequest, library: Library, request: Request) -> dict:
    """The newest performance's frames with every other video's aligned skeleton and the scores."""
    return _compare(request, library, comparison)[1]


@router.post("/api/video-comparisons/render", status_code=202)
async def render(comparison: ComparisonRequest, library: Library, request: Request) -> dict:
    """Start making the comparison video (it is added to the library); follow it with the job."""
    # problems (not analysed, too few videos) are reported now, not in the job
    compared, result = await run_in_threadpool(_compare, request, library, comparison)
    jobs: dict = request.app.state.comparison_jobs
    job = {
        "id": uuid.uuid4().hex[:12],
        "status": "running",
        "progress": 0.0,
        "video": None,
        "error": None,
        "started": time.time(),
    }
    jobs[job["id"]] = job
    analyses = request.app.state.video_analyses
    base = compared[0]

    async def run() -> None:
        folder, target = comparing.temporary_target()
        try:
            await comparing.render_video(
                result, lambda index: analyses.frame(base.video.id, base.analysis["run"], index), target,
                lambda share: job.update(progress=round(min(share, 0.99), 3)),
            )  # fmt: skip
            made = await library.add(
                target, comparing.comparison_name(compared), comparing.COMPARISON_ORIGIN, base.video.id
            )
            job.update(status="done", progress=1.0, video=made.to_api())
        except Exception as error:  # noqa: BLE001 - shown in the page
            job.update(status="failed", error=f"{type(error).__name__}: {error}")
        finally:
            folder.cleanup()

    job_task = asyncio.get_running_loop().create_task(run())
    request.app.state.background_jobs.add(job_task)
    job_task.add_done_callback(request.app.state.background_jobs.discard)
    return job


@router.get("/api/video-comparisons/jobs/{job_id}")
def job_state(job_id: str, request: Request) -> dict:
    job = request.app.state.comparison_jobs.get(job_id)
    if job is None:
        raise RecordNotFoundError(f"no comparison job {job_id!r}")
    return job
