"""More about a library video: text notes on its moments, and its sound (extracted, cleaned)."""

from __future__ import annotations

import asyncio
import json
import uuid
from pathlib import Path
from typing import Annotated, Literal

from fastapi import APIRouter, HTTPException, Query, Request, Response
from pydantic import BaseModel, Field, field_validator

from app.api.dependencies import Library
from app.ballet.limb_motion import DEFAULT_MIN_DURATION, DEFAULT_THRESHOLD, LIMBS, analyse_limbs
from app.media import annotated_video
from app.media.frame_record import FrameRecords
from app.media.video_audio import AGENTS, GOALS, AudioError, VideoAudio
from app.media.video_comparison import temporary_target
from app.media.video_notes import MAX_NOTE_CHARACTERS, VideoNotes
from app.storage import RecordNotFoundError

router = APIRouter(tags=["video notes and audio"])


def get_notes(request: Request) -> VideoNotes:
    return request.app.state.video_notes


def get_audio(request: Request) -> VideoAudio:
    return request.app.state.video_audio


# --- notes ------------------------------------------------------------------------------
class NoteRequest(BaseModel):
    source_time: float = Field(ge=0, description="Seconds in the video")
    text: str = Field("", max_length=MAX_NOTE_CHARACTERS, description="Empty: the note is removed")


@router.get("/api/videos/{video_id}/notes")
def list_notes(video_id: str, library: Library, request: Request) -> list[dict]:
    library.get(video_id)
    return [note.to_api() for note in get_notes(request).list(video_id)]


@router.put("/api/videos/{video_id}/notes")
def save_note(video_id: str, note: NoteRequest, library: Library, request: Request) -> dict:
    """Write the note of a moment (an empty text removes it)."""
    library.get(video_id)
    saved = get_notes(request).save(video_id, note.source_time, note.text)
    return {"note": saved.to_api() if saved else None}


# --- limbs moving -----------------------------------------------------------------------
@router.get("/api/videos/{video_id}/limb-movements")
def limb_movements(
    video_id: str,
    library: Library,
    request: Request,
    threshold: Annotated[float, Query(gt=0, le=10, description="Torso lengths per second")] = DEFAULT_THRESHOLD,
    min_duration: Annotated[float, Query(ge=0, le=10, description="Seconds")] = DEFAULT_MIN_DURATION,
) -> dict:
    """Which limb moves when, from the video's analysed keypoints: every frame's speed per limb,
    the movements (a limb moving for a while) and the moments (limbs moving together)."""
    library.get(video_id)
    stored = request.app.state.video_analyses.result_bytes(video_id)
    if stored is None:
        raise RecordNotFoundError(f"video {video_id!r} is not analysed yet")
    return analyse_limbs(json.loads(stored), threshold, min_duration)


# --- captions and the annotated video ------------------------------------------------------
LIMB_IDS = {limb.id for limb in LIMBS}


class Caption(BaseModel):
    start: float = Field(ge=0)
    end: float = Field(ge=0)
    text: str = Field(max_length=500)
    limbs: list[str] = Field(default_factory=list)


class CaptionTrack(BaseModel):
    anticipation: float = Field(annotated_video.DEFAULT_ANTICIPATION, ge=0, le=10, description="Seconds shown before")
    threshold: float = Field(DEFAULT_THRESHOLD, gt=0, le=10)
    captions: list[Caption] = Field(default_factory=list, max_length=2000)
    allowed_limbs: list[str] | None = Field(
        None, description="The tags (limbs) allowed in the captions and lit up; None: not chosen yet (all)"
    )

    @field_validator("allowed_limbs")
    @classmethod
    def known_limbs(cls, value: list[str] | None) -> list[str] | None:
        return None if value is None else _known_limbs(value)


def _known_limbs(limbs: list[str]) -> list[str]:
    unknown = sorted(set(limbs) - LIMB_IDS)
    if unknown:
        raise ValueError(f"unknown limbs {unknown}: use {sorted(LIMB_IDS)}")
    return list(dict.fromkeys(limbs))


class ExportRequest(CaptionTrack):
    character: Literal["skeleton", "cat"] = Field("skeleton", description="Drawn on the dancer")
    hide_dancer: bool = Field(False, description="With the cat: blur the dancer out behind it")


def _stored_analysis(video_id: str, request: Request) -> dict:
    stored = request.app.state.video_analyses.result_bytes(video_id)
    if stored is None:
        raise RecordNotFoundError(f"video {video_id!r} is not analysed yet")
    return json.loads(stored)


@router.get("/api/videos/{video_id}/captions")
def captions(
    video_id: str,
    library: Library,
    request: Request,
    threshold: Annotated[float, Query(gt=0, le=10)] = DEFAULT_THRESHOLD,
    allowed: Annotated[str | None, Query(description="Allowed tags (limb ids), comma separated")] = None,
    fresh: Annotated[bool, Query(description="Propose again, even when a track is saved")] = False,
) -> dict:
    """The caption track: the one saved (edited), else one proposed per movement found, made
    of the allowed tags (limbs) only."""
    library.get(video_id)
    saved = request.app.state.video_captions.get(video_id)
    if saved is not None and not fresh:
        return {"allowed_limbs": None, **saved, "saved": True}
    try:
        allowed_limbs = None if allowed is None else _known_limbs([limb for limb in allowed.split(",") if limb])
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    limbs = analyse_limbs(_stored_analysis(video_id, request), threshold, allowed=allowed_limbs)
    proposed = annotated_video.proposed_captions(limbs["moments"])
    return {
        "anticipation": saved["anticipation"] if saved else annotated_video.DEFAULT_ANTICIPATION,
        "threshold": threshold,
        "captions": proposed,
        "allowed_limbs": allowed_limbs,
        "saved": False,
    }


@router.put("/api/videos/{video_id}/captions")
def save_captions(video_id: str, track: CaptionTrack, library: Library, request: Request) -> dict:
    """Keep the edited captions (texts changed, captions removed) with the video."""
    library.get(video_id)
    data = track.model_dump()
    data["captions"] = sorted(
        (caption for caption in data["captions"] if caption["text"].strip()), key=lambda c: c["start"]
    )
    return {**request.app.state.video_captions.save(video_id, data), "saved": True}


@router.delete("/api/videos/{video_id}/captions", status_code=204)
def reset_captions(video_id: str, library: Library, request: Request) -> Response:
    """Forget the edits: the captions are proposed again from the movements found."""
    library.get(video_id)
    request.app.state.video_captions.delete(video_id)
    return Response(status_code=204)


@router.post("/api/videos/{video_id}/annotated-video", status_code=202)
async def export_annotated_video(video_id: str, track: ExportRequest, library: Library, request: Request) -> dict:
    """Make the annotated video (skeleton, moving limbs, captions, the video's sound): an MP4
    added to the library. Follow it with ``GET /api/render-jobs/{id}``."""
    video = library.get(video_id)
    analysis = _stored_analysis(video_id, request)
    limbs = analyse_limbs(analysis, track.threshold)
    if track.allowed_limbs is not None:  # only the allowed limbs light up
        limbs["speeds"] = {limb: values for limb, values in limbs["speeds"].items() if limb in track.allowed_limbs}
    captions_shown = [caption.model_dump() for caption in track.captions if caption.text.strip()]
    analyses = request.app.state.video_analyses
    job = {"id": uuid.uuid4().hex[:12], "status": "running", "progress": 0.0, "video": None, "error": None}
    request.app.state.comparison_jobs[job["id"]] = job

    async def run() -> None:
        folder, target = temporary_target()
        try:
            await annotated_video.render_annotated_video(
                analysis, limbs, captions_shown, track.anticipation,
                lambda index: analyses.frame(video.id, analysis["run"], index),
                library.file_path(video.id), target, lambda share: job.update(progress=round(min(share, 0.99), 3)),
                track.character, track.hide_dancer,
            )  # fmt: skip
            name = f"{Path(video.name).stem}-{'cat' if track.character == 'cat' else 'annotated'}.mp4"
            made = await library.add(target, name, annotated_video.ANNOTATED_ORIGIN, video.id)
            job.update(status="done", progress=1.0, video=made.to_api())
        except Exception as error:  # noqa: BLE001 - shown in the page
            job.update(status="failed", error=f"{type(error).__name__}: {error}")
        finally:
            folder.cleanup()

    task = asyncio.get_running_loop().create_task(run())
    request.app.state.background_jobs.add(task)
    task.add_done_callback(request.app.state.background_jobs.discard)
    return job


@router.get("/api/render-jobs/{job_id}")
def render_job(job_id: str, request: Request) -> dict:
    """A video being made (comparison or annotated video): progress, then the library video."""
    job = request.app.state.comparison_jobs.get(job_id)
    if job is None:
        raise RecordNotFoundError(f"no render job {job_id!r}")
    return job


# --- audio ------------------------------------------------------------------------------
class Plan(BaseModel):
    """The filters of a manual cleaning (pauses are never shortened: the audio follows the video)."""

    declip: bool = False
    declick: bool = False
    dehum_hz: Literal[50, 60] | None = None
    highpass_hz: float | None = Field(None, ge=20, le=200)
    denoise: bool = False
    denoise_db: float = Field(10.0, ge=3, le=30)
    loudnorm: bool = False
    target_lufs: float = Field(-16.0, ge=-30, le=-10)


class CleanRequest(BaseModel):
    mode: Literal["auto", "manual"] = "auto"
    goal: str = Field("transcription", pattern=f"^({'|'.join(GOALS)})$")
    agent: str = Field("auto", pattern=f"^({'|'.join(AGENTS)})$")
    plan: Plan | None = None


def _state(video_id: str, request: Request) -> dict:
    audio = get_audio(request)
    state = audio.state(video_id)
    return {
        "state": state.to_api() if state else None,
        "original": f"/api/videos/{video_id}/audio/original.flac" if audio.has(video_id, "original") else None,
        "cleaned": f"/api/videos/{video_id}/audio/cleaned.flac" if audio.has(video_id, "cleaned") else None,
    }


@router.get("/api/videos/{video_id}/audio")
def audio_state(video_id: str, library: Library, request: Request) -> dict:
    """Whether the sound is extracted and cleaned, and the cleaning's report."""
    library.get(video_id)
    return _state(video_id, request)


@router.post("/api/videos/{video_id}/audio/extract")
async def extract(video_id: str, library: Library, request: Request) -> dict:
    """Extract the video's sound (to listen to it, or before cleaning it)."""
    video = library.get(video_id)
    await get_audio(request).extract(video)
    return _state(video_id, request)


@router.post("/api/videos/{video_id}/audio/clean", status_code=202)
async def clean(video_id: str, cleaning: CleanRequest, library: Library, request: Request) -> dict:
    """Clean the sound with the audio module (the agent's plan, or the filters chosen)."""
    video = library.get(video_id)
    if cleaning.mode == "manual" and cleaning.plan is None:
        raise AudioError("choose the filters of a manual cleaning")
    payload = cleaning.model_dump()
    if cleaning.plan is not None:
        payload["plan"] = {**cleaning.plan.model_dump(), "remove_silence": False}
    get_audio(request).start_cleaning(video, payload)
    return _state(video_id, request)


@router.get("/api/videos/{video_id}/audio/{version}.flac")
def audio_file(video_id: str, version: Literal["original", "cleaned"], request: Request) -> Response:
    data = get_audio(request).audio(video_id, version)
    if data is None:
        raise RecordNotFoundError(f"no {version} audio for video {video_id!r}")
    return Response(data, media_type="audio/flac", headers={"Cache-Control": "no-store"})


@router.get("/api/videos/{video_id}/audio/spectrogram")
async def spectrogram(
    video_id: str, request: Request, version: Annotated[Literal["original", "cleaned"], Query()] = "cleaned"
) -> Response:
    """The audio module's spectrogram (0–4 kHz) of the original or the cleaned sound."""
    state = get_audio(request).state(video_id)
    job_id = (state.report if state else {}).get("job_id")
    if not job_id:
        raise RecordNotFoundError("clean the audio first: the spectrograms come with the cleaning")
    return Response(await get_audio(request).spectrogram(version, job_id), media_type="image/png")


# --- everything stored about one frame -------------------------------------------------------
@router.get("/api/videos/{video_id}/frame-record")
def frame_record(
    video_id: str,
    request: Request,
    t: Annotated[float, Query(ge=0, description="The frame's time in the video (seconds)")],
) -> dict:
    """The analysed frame nearest to ``t``, as the databases hold it: one section per table
    (database file, table, query, rows), from the video's row to the frame's keypoints,
    corrections, notes, caption tags, snapshots and limb movement."""
    state = request.app.state
    records = FrameRecords(state.store.database_path, state.library, state.pictures, state.video_analyses)
    return records.frame_record(video_id, t)
